-- Control-plane schema: tenants, users, devices, vehicles + telemetry hypertable.
-- Requires PostGIS (spatial) and TimescaleDB (time-series). Applied at DB init.

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE EXTENSION IF NOT EXISTS pgcrypto; -- gen_random_uuid()

-- ---- Control plane (relational) --------------------------------------------

CREATE TABLE tenant (
  id          uuid PRIMARY KEY,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Departments / sub-orgs (tree via parent_id; created before referencing tables).
CREATE TABLE org_unit (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  name        text NOT NULL,
  parent_id   uuid REFERENCES org_unit(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON org_unit (tenant_id);

CREATE TABLE app_user (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  email         text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role          text NOT NULL CHECK (role IN ('admin','operator','viewer')),
  active        boolean NOT NULL DEFAULT true,
  mfa_enabled   boolean NOT NULL DEFAULT false,
  mfa_secret    text,
  department_id uuid REFERENCES org_unit(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON app_user (tenant_id);

CREATE TABLE vehicle (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  name        text NOT NULL,
  device_id   uuid,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON vehicle (tenant_id);

CREATE TABLE device (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  imei        varchar(15) NOT NULL UNIQUE,
  name        text,
  model       text NOT NULL,
  status      text NOT NULL CHECK (status IN ('provisioned','active','suspended','retired')),
  vehicle_id  uuid REFERENCES vehicle(id) ON DELETE SET NULL,
  department_id uuid REFERENCES org_unit(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON device (tenant_id);
CREATE INDEX ON device (status);
CREATE INDEX ON device (department_id);

-- ---- Telemetry (time-series + spatial) -------------------------------------

CREATE TABLE position (
  tenant_id   uuid NOT NULL,
  device_id   uuid NOT NULL,
  imei        varchar(15) NOT NULL,
  ts          timestamptz NOT NULL,
  geom        geography(Point,4326),
  speed_kph   real,
  heading     smallint,
  altitude    smallint,
  ignition    boolean,
  attrs       jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (device_id, ts)          -- idempotent: resends collide, DO NOTHING
);

-- Timescale hypertable partitioned by time (1-day chunks).
SELECT create_hypertable('position', 'ts', chunk_time_interval => INTERVAL '1 day');

CREATE INDEX ON position USING gist (geom);              -- spatial queries
CREATE INDEX ON position (tenant_id, device_id, ts DESC); -- history / latest

-- Row-Level Security: enforce tenant isolation in the database itself, so an
-- application query bug cannot cross tenants (ARCHITECTURE §8). The app sets
-- `SET app.tenant_id = '<uuid>'` per request/connection.
--
-- NOTE: TimescaleDB does not allow columnstore compression AND RLS on the same
-- table. The `position` hypertable is the high-volume table where compression
-- matters most, so it uses compression (below) and relies on the application's
-- mandatory `WHERE tenant_id = $1` filter + device-ownership checks for tenant
-- isolation. RLS still guards the low-volume relational tables.
ALTER TABLE device   ENABLE ROW LEVEL SECURITY;
ALTER TABLE vehicle  ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_unit ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_device   ON device   USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY tenant_isolation_vehicle  ON vehicle  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY tenant_isolation_org_unit ON org_unit USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- Positions: compress chunks > 7 days; drop raw positions > 400 days.
ALTER TABLE position SET (timescaledb.compress, timescaledb.compress_segmentby = 'device_id');
SELECT add_compression_policy('position', INTERVAL '7 days');
SELECT add_retention_policy('position', INTERVAL '400 days');

-- ---- Phase 2: geofences, alerts, trips -------------------------------------

CREATE TABLE geofence (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  name        text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('circle','polygon')),
  center      geography(Point,4326),      -- circle centre
  radius_m    integer,                     -- circle radius
  area        geometry(Polygon,4326),      -- polygon area
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON geofence (tenant_id);
CREATE INDEX ON geofence USING gist (area);

CREATE TABLE alert_event (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  device_id   uuid NOT NULL,
  imei        varchar(15) NOT NULL,
  type        text NOT NULL,
  ts          timestamptz NOT NULL,
  meta        jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX ON alert_event (tenant_id, ts DESC);
CREATE INDEX ON alert_event (tenant_id, device_id, ts DESC);

CREATE TABLE trip (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  device_id     uuid NOT NULL,
  start_ts      timestamptz NOT NULL,
  end_ts        timestamptz NOT NULL,
  distance_m    integer NOT NULL,
  max_speed_kph real NOT NULL,
  points        integer NOT NULL
);
CREATE INDEX ON trip (tenant_id, device_id, start_ts DESC);

CREATE TABLE alert_config (
  tenant_id         uuid PRIMARY KEY REFERENCES tenant(id) ON DELETE CASCADE,
  overspeed_kph     integer,
  ignition_alerts   boolean NOT NULL DEFAULT true,
  geofence_alerts   boolean NOT NULL DEFAULT true,
  offline_after_sec integer NOT NULL DEFAULT 600
);

-- Tenant isolation for the new tables.
ALTER TABLE geofence    ENABLE ROW LEVEL SECURITY;
ALTER TABLE alert_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE trip        ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_geofence ON geofence    USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY tenant_isolation_alert    ON alert_event USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY tenant_isolation_trip     ON trip        USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- ---- Phase 3: notifications ------------------------------------------------

CREATE TABLE notification_config (
  tenant_id        uuid PRIMARY KEY REFERENCES tenant(id) ON DELETE CASCADE,
  webhook_urls     text[] NOT NULL DEFAULT '{}',
  email_recipients text[] NOT NULL DEFAULT '{}',
  webhook_secret   text NOT NULL DEFAULT '',
  types            text[]                        -- null = all alert types
);

-- ---- Phase 4: billing ------------------------------------------------------

CREATE TABLE subscription (
  tenant_id  uuid PRIMARY KEY REFERENCES tenant(id) ON DELETE CASCADE,
  plan_id    text NOT NULL,
  status     text NOT NULL CHECK (status IN ('active','past_due','canceled')),
  created_at timestamptz NOT NULL DEFAULT now()
);

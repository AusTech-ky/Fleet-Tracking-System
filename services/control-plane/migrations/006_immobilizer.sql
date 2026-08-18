-- Remote immobilization: a per-device relay that cuts the starter/fuel circuit,
-- driven by a Teltonika digital output (DOUT) over Codec 12.
--
-- Off by default and per device: most trackers ship with no relay wired, and
-- immobilizing a vehicle with nothing on the DOUT is a no-op at best. An admin
-- must enable it (which DOUT, and whether the relay is active-high or -low),
-- then physically test it before it is trusted.

CREATE TABLE IF NOT EXISTS device_immobilizer (
  device_id     uuid PRIMARY KEY REFERENCES device(id) ON DELETE CASCADE,
  tenant_id     uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  -- Configuration (set once by an admin who knows the wiring):
  enabled       boolean NOT NULL DEFAULT false,   -- feature turned on for this device
  dout          smallint NOT NULL DEFAULT 1 CHECK (dout BETWEEN 1 AND 4), -- which DOUT drives the relay
  active_high   boolean NOT NULL DEFAULT true,     -- true = DOUT HIGH cuts the circuit; false = HIGH allows it
  -- Never engage the relay above this speed; the device enforces it too. km/h.
  max_engage_kph smallint NOT NULL DEFAULT 5 CHECK (max_engage_kph BETWEEN 0 AND 50),
  -- Current desired state, as last commanded from here:
  immobilized   boolean NOT NULL DEFAULT false,
  -- Audit of the last action:
  last_command  text,
  last_reply    text,
  last_by       uuid REFERENCES app_user(id) ON DELETE SET NULL,
  last_at       timestamptz,
  -- Has an admin confirmed a physical bench/standstill test since enabling?
  tested_at     timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS device_immobilizer_tenant_idx ON device_immobilizer (tenant_id);

-- Append-only log of every immobilize/mobilize/test action, for accountability.
CREATE TABLE IF NOT EXISTS immobilizer_event (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  device_id   uuid NOT NULL REFERENCES device(id) ON DELETE CASCADE,
  action      text NOT NULL CHECK (action IN ('immobilize','mobilize','test','enable','disable')),
  actor_id    uuid REFERENCES app_user(id) ON DELETE SET NULL,
  actor_email text,
  command     text,
  reply       text,
  ok          boolean NOT NULL,
  ts          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS immobilizer_event_device_idx ON immobilizer_event (device_id, ts DESC);

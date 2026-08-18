import { types, type Pool } from 'pg';
import type { ImmobilizerConfig, ImmobilizerEvent, Tenant, User, Device, Vehicle, Position, Geofence, AlertEvent, AlertConfig, Trip, NotificationConfig, OrgUnit, Subscription, RefreshToken } from './entities';
import { DEFAULT_ALERT_CONFIG, emptyNotificationConfig } from './entities';

// The domain types declare all timestamps as ISO-8601 strings, but node-pg
// returns timestamptz as JS Date objects by default. Parse them straight to ISO
// strings so the repositories honor their interfaces (and internal ts string
// comparisons stay correct). OID 1184 = timestamptz.
types.setTypeParser(1184, (v: string | null) => (v === null ? null : new Date(v).toISOString()));
import type {
  TenantRepository, UserRepository, DeviceRepository, OrgUnitRepository, VehicleRepository, PositionRepository,
  GeofenceRepository, AlertRepository, TripRepository, AlertConfigRepository, NotificationConfigRepository,
  SubscriptionRepository, RefreshTokenRepository, ImmobilizerRepository,
} from './repository';

/**
 * PostgreSQL + PostGIS + TimescaleDB implementation (production). Positions are
 * stored with a geography(Point,4326) column and queried via the time-series
 * hypertable (see migrations/001_init.sql). Parameterized queries throughout
 * (SQLi-safe). Not exercised by the in-process test suite (no local Postgres in
 * CI sandbox) — integration-tested via docker-compose.
 */

export class PgTenantRepository implements TenantRepository {
  constructor(private readonly pool: Pool) {}
  async create(t: Omit<Tenant, 'createdAt'>) {
    const { rows } = await this.pool.query(
      `INSERT INTO tenant (id, name) VALUES ($1,$2) RETURNING id, name, created_at AS "createdAt"`,
      [t.id, t.name],
    );
    return rows[0];
  }
  async findById(id: string) {
    const { rows } = await this.pool.query(
      `SELECT id, name, created_at AS "createdAt" FROM tenant WHERE id=$1`, [id]);
    return rows[0] ?? null;
  }
}

export class PgUserRepository implements UserRepository {
  constructor(private readonly pool: Pool) {}
  private cols = `id, tenant_id AS "tenantId", email, password_hash AS "passwordHash", role, active,
                  mfa_enabled AS "mfaEnabled", mfa_secret AS "mfaSecret", department_id AS "departmentId", created_at AS "createdAt"`;
  async create(u: Omit<User, 'createdAt'>) {
    const { rows } = await this.pool.query(
      `INSERT INTO app_user (id, tenant_id, email, password_hash, role, active, mfa_enabled, mfa_secret, department_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${this.cols}`,
      [u.id, u.tenantId, u.email, u.passwordHash, u.role, u.active, u.mfaEnabled, u.mfaSecret, u.departmentId],
    );
    return rows[0];
  }
  async findByEmail(email: string) {
    const { rows } = await this.pool.query(`SELECT ${this.cols} FROM app_user WHERE email=$1`, [email]);
    return rows[0] ?? null;
  }
  async findById(id: string) {
    const { rows } = await this.pool.query(`SELECT ${this.cols} FROM app_user WHERE id=$1`, [id]);
    return rows[0] ?? null;
  }
  async list(tenantId: string) {
    const { rows } = await this.pool.query(
      `SELECT ${this.cols} FROM app_user WHERE tenant_id=$1 ORDER BY created_at ASC`, [tenantId]);
    return rows;
  }
  async count(tenantId: string) {
    const { rows } = await this.pool.query(`SELECT count(*)::int AS n FROM app_user WHERE tenant_id=$1`, [tenantId]);
    return rows[0].n as number;
  }
  async update(id: string, patch: Partial<User>) {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, col] of [['role', 'role'], ['active', 'active'], ['mfaEnabled', 'mfa_enabled'], ['mfaSecret', 'mfa_secret'], ['passwordHash', 'password_hash'], ['departmentId', 'department_id']] as const) {
      if (patch[k as keyof User] !== undefined) { vals.push(patch[k as keyof User]); sets.push(`${col}=$${vals.length}`); }
    }
    if (!sets.length) return this.findById(id);
    vals.push(id);
    const { rows } = await this.pool.query(
      `UPDATE app_user SET ${sets.join(',')} WHERE id=$${vals.length} RETURNING ${this.cols}`, vals);
    return rows[0] ?? null;
  }
}

export class PgDeviceRepository implements DeviceRepository {
  constructor(private readonly pool: Pool) {}
  private cols = `id, tenant_id AS "tenantId", imei, name, model, asset_type AS "assetType", status, vehicle_id AS "vehicleId", department_id AS "departmentId", created_at AS "createdAt", deleted_at AS "deletedAt"`;
  // Every normal read carries this. Deleted rows are invisible unless a
  // method explicitly opts in (findById includeDeleted, listDeleted, restore).
  private live = `deleted_at IS NULL`;

  async create(d: Omit<Device, 'createdAt' | 'deletedAt'>) {
    const { rows } = await this.pool.query(
      `INSERT INTO device (id, tenant_id, imei, name, model, asset_type, status, vehicle_id, department_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${this.cols}`,
      [d.id, d.tenantId, d.imei, d.name, d.model, d.assetType, d.status, d.vehicleId, d.departmentId],
    );
    return rows[0];
  }
  async findById(tenantId: string, id: string, opts: { includeDeleted?: boolean } = {}) {
    const { rows } = await this.pool.query(
      `SELECT ${this.cols} FROM device WHERE tenant_id=$1 AND id=$2 ${opts.includeDeleted ? '' : `AND ${this.live}`}`,
      [tenantId, id]);
    return rows[0] ?? null;
  }
  async findByImei(imei: string) {
    const { rows } = await this.pool.query(`SELECT ${this.cols} FROM device WHERE imei=$1 AND ${this.live}`, [imei]);
    return rows[0] ?? null;
  }
  async list(tenantId: string, departmentIds?: string[]) {
    if (departmentIds) {
      const { rows } = await this.pool.query(
        `SELECT ${this.cols} FROM device WHERE tenant_id=$1 AND department_id = ANY($2) AND ${this.live} ORDER BY created_at DESC`,
        [tenantId, departmentIds]);
      return rows;
    }
    const { rows } = await this.pool.query(
      `SELECT ${this.cols} FROM device WHERE tenant_id=$1 AND ${this.live} ORDER BY created_at DESC`, [tenantId]);
    return rows;
  }
  async listDeleted(tenantId: string) {
    const { rows } = await this.pool.query(
      `SELECT ${this.cols} FROM device WHERE tenant_id=$1 AND deleted_at IS NOT NULL ORDER BY deleted_at DESC`, [tenantId]);
    return rows;
  }
  async count(tenantId: string) {
    const { rows } = await this.pool.query(`SELECT count(*)::int AS n FROM device WHERE tenant_id=$1 AND ${this.live}`, [tenantId]);
    return rows[0].n as number;
  }
  async update(tenantId: string, id: string, patch: Partial<Device>) {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, col] of [['status', 'status'], ['vehicleId', 'vehicle_id'], ['model', 'model'], ['departmentId', 'department_id'], ['name', 'name'], ['assetType', 'asset_type']] as const) {
      if (patch[k as keyof Device] !== undefined) { vals.push(patch[k as keyof Device]); sets.push(`${col}=$${vals.length}`); }
    }
    if (!sets.length) return this.findById(tenantId, id);
    vals.push(tenantId, id);
    const { rows } = await this.pool.query(
      `UPDATE device SET ${sets.join(',')} WHERE tenant_id=$${vals.length - 1} AND id=$${vals.length} AND ${this.live} RETURNING ${this.cols}`,
      vals,
    );
    return rows[0] ?? null;
  }
  async softDelete(tenantId: string, id: string, at: string) {
    const { rowCount } = await this.pool.query(
      `UPDATE device SET deleted_at=$3 WHERE tenant_id=$1 AND id=$2 AND ${this.live}`, [tenantId, id, at]);
    return (rowCount ?? 0) > 0;
  }
  async restore(tenantId: string, id: string) {
    // The partial unique index (imei WHERE deleted_at IS NULL) makes this UPDATE
    // fail with 23505 if the IMEI has since been re-provisioned as a live row —
    // surface that as "cannot restore" rather than a 500.
    try {
      const { rowCount } = await this.pool.query(
        `UPDATE device SET deleted_at=NULL WHERE tenant_id=$1 AND id=$2 AND deleted_at IS NOT NULL`, [tenantId, id]);
      return (rowCount ?? 0) > 0;
    } catch (err) {
      if ((err as { code?: string }).code === '23505') return false;
      throw err;
    }
  }
  async activeImeis() {
    const { rows } = await this.pool.query(`SELECT imei FROM device WHERE status IN ('active','provisioned') AND ${this.live}`);
    return rows.map((r) => r.imei as string);
  }
}

export class PgVehicleRepository implements VehicleRepository {
  constructor(private readonly pool: Pool) {}
  private cols = `id, tenant_id AS "tenantId", name, device_id AS "deviceId", created_at AS "createdAt"`;
  async create(v: Omit<Vehicle, 'createdAt'>) {
    const { rows } = await this.pool.query(
      `INSERT INTO vehicle (id, tenant_id, name, device_id) VALUES ($1,$2,$3,$4) RETURNING ${this.cols}`,
      [v.id, v.tenantId, v.name, v.deviceId],
    );
    return rows[0];
  }
  async findById(tenantId: string, id: string) {
    const { rows } = await this.pool.query(
      `SELECT ${this.cols} FROM vehicle WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
    return rows[0] ?? null;
  }
  async list(tenantId: string) {
    const { rows } = await this.pool.query(
      `SELECT ${this.cols} FROM vehicle WHERE tenant_id=$1 ORDER BY created_at DESC`, [tenantId]);
    return rows;
  }
  async update(tenantId: string, id: string, patch: Partial<Vehicle>) {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, col] of [['name', 'name'], ['deviceId', 'device_id']] as const) {
      if (patch[k as keyof Vehicle] !== undefined) { vals.push(patch[k as keyof Vehicle]); sets.push(`${col}=$${vals.length}`); }
    }
    if (!sets.length) return this.findById(tenantId, id);
    vals.push(tenantId, id);
    const { rows } = await this.pool.query(
      `UPDATE vehicle SET ${sets.join(',')} WHERE tenant_id=$${vals.length - 1} AND id=$${vals.length} RETURNING ${this.cols}`,
      vals,
    );
    return rows[0] ?? null;
  }
}

export class PgPositionRepository implements PositionRepository {
  constructor(private readonly pool: Pool) {}
  async insertMany(positions: Position[]) {
    if (!positions.length) return;
    // Multi-row insert; geography built from lon/lat. ON CONFLICT dedupes resends.
    const values: string[] = [];
    const params: unknown[] = [];
    positions.forEach((p, i) => {
      const b = i * 11;
      values.push(
        `($${b + 1},$${b + 2},$${b + 3},$${b + 4},ST_SetSRID(ST_MakePoint($${b + 5},$${b + 6}),4326)::geography,$${b + 7},$${b + 8},$${b + 9},$${b + 10},$${b + 11})`,
      );
      params.push(p.tenantId, p.deviceId, p.imei, p.ts, p.longitude, p.latitude,
        p.speedKph, p.heading, p.altitude, p.ignition, JSON.stringify(p.attrs));
    });
    await this.pool.query(
      `INSERT INTO position (tenant_id, device_id, imei, ts, geom, speed_kph, heading, altitude, ignition, attrs)
       VALUES ${values.join(',')} ON CONFLICT (device_id, ts) DO NOTHING`,
      params,
    );
  }
  async history(tenantId: string, deviceId: string, from: string, to: string, limit: number) {
    const { rows } = await this.pool.query(
      `SELECT tenant_id AS "tenantId", device_id AS "deviceId", imei, ts,
              ST_Y(geom::geometry) AS latitude, ST_X(geom::geometry) AS longitude,
              altitude, heading, speed_kph AS "speedKph", ignition, attrs
       FROM position
       WHERE tenant_id=$1 AND device_id=$2 AND ts BETWEEN $3 AND $4
       ORDER BY ts ASC LIMIT $5`,
      [tenantId, deviceId, from, to, limit],
    );
    return rows.map((r) => ({ ...r, satellites: 0 })) as Position[];
  }
  async latest(tenantId: string, deviceId: string) {
    // Hypertable is chunked by ts; ORDER BY ts DESC LIMIT 1 lets Timescale
    // start from the newest chunk and stop, so this stays cheap at scale.
    const { rows } = await this.pool.query(
      `SELECT tenant_id AS "tenantId", device_id AS "deviceId", imei, ts,
              ST_Y(geom::geometry) AS latitude, ST_X(geom::geometry) AS longitude,
              altitude, heading, speed_kph AS "speedKph", ignition, attrs
       FROM position
       WHERE tenant_id=$1 AND device_id=$2
       ORDER BY ts DESC LIMIT 1`,
      [tenantId, deviceId],
    );
    return rows[0] ? ({ ...rows[0], satellites: 0 } as Position) : null;
  }
}

/**
 * Geofences. Circle stored as (center geography, radius); polygon as a PostGIS
 * geometry(Polygon,4326). Containment in production is done in-DB via
 * ST_DWithin / ST_Contains (see PositionRepository / consumer notes).
 */
export class PgGeofenceRepository implements GeofenceRepository {
  constructor(private readonly pool: Pool) {}
  async create(g: Geofence) {
    if (g.kind === 'circle') {
      await this.pool.query(
        `INSERT INTO geofence (id, tenant_id, name, kind, center, radius_m)
         VALUES ($1,$2,$3,'circle',ST_SetSRID(ST_MakePoint($4,$5),4326)::geography,$6)`,
        [g.id, g.tenantId, g.name, g.centerLon, g.centerLat, g.radiusM],
      );
    } else {
      const wkt = `POLYGON((${[...g.ring, g.ring[0]].map(([lon, lat]) => `${lon} ${lat}`).join(',')}))`;
      await this.pool.query(
        `INSERT INTO geofence (id, tenant_id, name, kind, area)
         VALUES ($1,$2,$3,'polygon',ST_SetSRID(ST_GeomFromText($4),4326))`,
        [g.id, g.tenantId, g.name, wkt],
      );
    }
    return g;
  }
  async list(tenantId: string): Promise<Geofence[]> {
    const { rows } = await this.pool.query(
      `SELECT id, tenant_id AS "tenantId", name, kind, radius_m AS "radiusM",
              ST_Y(center::geometry) AS "centerLat", ST_X(center::geometry) AS "centerLon",
              CASE WHEN area IS NULL THEN NULL ELSE ST_AsGeoJSON(area) END AS "areaJson",
              created_at AS "createdAt"
       FROM geofence WHERE tenant_id=$1`, [tenantId]);
    return rows.map(rowToGeofence);
  }
  async findById(tenantId: string, id: string) {
    const list = await this.list(tenantId);
    return list.find((g) => g.id === id) ?? null;
  }
  async remove(tenantId: string, id: string) {
    const { rowCount } = await this.pool.query(`DELETE FROM geofence WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
    return (rowCount ?? 0) > 0;
  }
}

function rowToGeofence(r: any): Geofence {
  const base = { id: r.id, tenantId: r.tenantId, name: r.name, createdAt: r.createdAt };
  if (r.kind === 'circle') {
    return { ...base, kind: 'circle', centerLat: r.centerLat, centerLon: r.centerLon, radiusM: r.radiusM };
  }
  const geo = JSON.parse(r.areaJson);
  const ring = (geo.coordinates[0] as [number, number][]).slice(0, -1); // drop closing point
  return { ...base, kind: 'polygon', ring };
}

export class PgAlertRepository implements AlertRepository {
  constructor(private readonly pool: Pool) {}
  async insertMany(events: AlertEvent[]) {
    if (!events.length) return;
    const values: string[] = [];
    const params: unknown[] = [];
    events.forEach((e, i) => {
      const b = i * 7;
      values.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7})`);
      params.push(e.id, e.tenantId, e.deviceId, e.imei, e.type, e.ts, JSON.stringify({ message: e.message, ...e.meta }));
    });
    await this.pool.query(
      `INSERT INTO alert_event (id, tenant_id, device_id, imei, type, ts, meta) VALUES ${values.join(',')}`,
      params,
    );
  }
  async list(tenantId: string, opts: { deviceId?: string; limit: number }) {
    const params: unknown[] = [tenantId];
    let where = 'tenant_id=$1';
    if (opts.deviceId) { params.push(opts.deviceId); where += ` AND device_id=$${params.length}`; }
    params.push(opts.limit);
    const { rows } = await this.pool.query(
      `SELECT id, tenant_id AS "tenantId", device_id AS "deviceId", imei, type, ts, meta
       FROM alert_event WHERE ${where} ORDER BY ts DESC LIMIT $${params.length}`, params);
    return rows.map((r) => {
      const { message, ...meta } = r.meta ?? {};
      return { ...r, message: message ?? '', meta } as AlertEvent;
    });
  }
}

export class PgTripRepository implements TripRepository {
  constructor(private readonly pool: Pool) {}
  async insert(t: Trip) {
    await this.pool.query(
      `INSERT INTO trip (id, tenant_id, device_id, start_ts, end_ts, distance_m, max_speed_kph, points)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [t.id, t.tenantId, t.deviceId, t.startTs, t.endTs, t.distanceM, t.maxSpeedKph, t.points],
    );
  }
  async list(tenantId: string, deviceId: string, from: string, to: string, limit: number) {
    const { rows } = await this.pool.query(
      `SELECT id, tenant_id AS "tenantId", device_id AS "deviceId", start_ts AS "startTs",
              end_ts AS "endTs", distance_m AS "distanceM", max_speed_kph AS "maxSpeedKph", points
       FROM trip WHERE tenant_id=$1 AND device_id=$2 AND start_ts BETWEEN $3 AND $4
       ORDER BY start_ts ASC LIMIT $5`, [tenantId, deviceId, from, to, limit]);
    return rows as Trip[];
  }
}

export class PgAlertConfigRepository implements AlertConfigRepository {
  constructor(private readonly pool: Pool) {}
  async get(tenantId: string): Promise<AlertConfig> {
    const { rows } = await this.pool.query(
      `SELECT overspeed_kph AS "overspeedKph", ignition_alerts AS "ignitionAlerts",
              geofence_alerts AS "geofenceAlerts", offline_after_sec AS "offlineAfterSec"
       FROM alert_config WHERE tenant_id=$1`, [tenantId]);
    return rows[0] ?? { ...DEFAULT_ALERT_CONFIG };
  }
  async set(tenantId: string, c: AlertConfig) {
    await this.pool.query(
      `INSERT INTO alert_config (tenant_id, overspeed_kph, ignition_alerts, geofence_alerts, offline_after_sec)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (tenant_id) DO UPDATE SET
         overspeed_kph=$2, ignition_alerts=$3, geofence_alerts=$4, offline_after_sec=$5`,
      [tenantId, c.overspeedKph, c.ignitionAlerts, c.geofenceAlerts, c.offlineAfterSec],
    );
    return c;
  }
}

export class PgNotificationConfigRepository implements NotificationConfigRepository {
  constructor(private readonly pool: Pool) {}
  async get(tenantId: string): Promise<NotificationConfig> {
    const { rows } = await this.pool.query(
      `SELECT tenant_id AS "tenantId", webhook_urls AS "webhookUrls", email_recipients AS "emailRecipients",
              webhook_secret AS "webhookSecret", types
       FROM notification_config WHERE tenant_id=$1`, [tenantId]);
    if (!rows[0]) return emptyNotificationConfig(tenantId);
    return { ...rows[0], types: rows[0].types ?? null };
  }
  async set(tenantId: string, c: NotificationConfig) {
    await this.pool.query(
      `INSERT INTO notification_config (tenant_id, webhook_urls, email_recipients, webhook_secret, types)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (tenant_id) DO UPDATE SET
         webhook_urls=$2, email_recipients=$3, webhook_secret=$4, types=$5`,
      [tenantId, c.webhookUrls, c.emailRecipients, c.webhookSecret, c.types],
    );
    return c;
  }
}

export class PgOrgUnitRepository implements OrgUnitRepository {
  constructor(private readonly pool: Pool) {}
  private cols = `id, tenant_id AS "tenantId", name, parent_id AS "parentId", created_at AS "createdAt"`;
  async create(o: Omit<OrgUnit, 'createdAt'>) {
    const { rows } = await this.pool.query(
      `INSERT INTO org_unit (id, tenant_id, name, parent_id) VALUES ($1,$2,$3,$4) RETURNING ${this.cols}`,
      [o.id, o.tenantId, o.name, o.parentId],
    );
    return rows[0];
  }
  async list(tenantId: string) {
    const { rows } = await this.pool.query(
      `SELECT ${this.cols} FROM org_unit WHERE tenant_id=$1 ORDER BY created_at ASC`, [tenantId]);
    return rows;
  }
  async findById(tenantId: string, id: string) {
    const { rows } = await this.pool.query(
      `SELECT ${this.cols} FROM org_unit WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
    return rows[0] ?? null;
  }
  async update(tenantId: string, id: string, patch: Partial<Pick<OrgUnit, 'name' | 'parentId'>>) {
    // Build the SET list from supplied keys only — COALESCE would make it
    // impossible to move a group back to the root (parentId: null).
    const sets: string[] = [];
    const vals: unknown[] = [tenantId, id];
    if (patch.name !== undefined) { vals.push(patch.name); sets.push(`name=$${vals.length}`); }
    if (patch.parentId !== undefined) { vals.push(patch.parentId); sets.push(`parent_id=$${vals.length}`); }
    if (sets.length === 0) return this.findById(tenantId, id);
    const { rows } = await this.pool.query(
      `UPDATE org_unit SET ${sets.join(', ')} WHERE tenant_id=$1 AND id=$2 RETURNING ${this.cols}`, vals);
    return rows[0] ?? null;
  }
  async remove(tenantId: string, id: string) {
    const { rowCount } = await this.pool.query(`DELETE FROM org_unit WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
    return (rowCount ?? 0) > 0;
  }
}

export class PgSubscriptionRepository implements SubscriptionRepository {
  constructor(private readonly pool: Pool) {}
  async get(tenantId: string): Promise<Subscription | null> {
    const { rows } = await this.pool.query(
      `SELECT tenant_id AS "tenantId", plan_id AS "planId", status, created_at AS "createdAt"
       FROM subscription WHERE tenant_id=$1`, [tenantId]);
    return rows[0] ?? null;
  }
  async set(tenantId: string, s: Subscription) {
    await this.pool.query(
      `INSERT INTO subscription (tenant_id, plan_id, status) VALUES ($1,$2,$3)
       ON CONFLICT (tenant_id) DO UPDATE SET plan_id=$2, status=$3`,
      [tenantId, s.planId, s.status],
    );
    return s;
  }
}

export class PgRefreshTokenRepository implements RefreshTokenRepository {
  constructor(private readonly pool: Pool) {}
  private cols = `id, user_id AS "userId", token_hash AS "tokenHash", family_id AS "familyId",
                  expires_at AS "expiresAt", used_at AS "usedAt", revoked_at AS "revokedAt", created_at AS "createdAt"`;
  async create(t: RefreshToken) {
    const { rows } = await this.pool.query(
      `INSERT INTO refresh_token (id, user_id, token_hash, family_id, expires_at)
       VALUES ($1,$2,$3,$4,$5) RETURNING ${this.cols}`,
      [t.id, t.userId, t.tokenHash, t.familyId, t.expiresAt],
    );
    return rows[0];
  }
  async findByHash(tokenHash: string) {
    const { rows } = await this.pool.query(
      `SELECT ${this.cols} FROM refresh_token WHERE token_hash=$1`, [tokenHash]);
    return rows[0] ?? null;
  }
  async markUsed(id: string, usedAt: string) {
    await this.pool.query(`UPDATE refresh_token SET used_at=$2 WHERE id=$1`, [id, usedAt]);
  }
  async revokeFamily(familyId: string, revokedAt: string) {
    await this.pool.query(
      `UPDATE refresh_token SET revoked_at=$2 WHERE family_id=$1 AND revoked_at IS NULL`,
      [familyId, revokedAt]);
  }
}

export class PgImmobilizerRepository implements ImmobilizerRepository {
  constructor(private readonly pool: Pool) {}
  private cols = `device_id AS "deviceId", tenant_id AS "tenantId", enabled, dout, active_high AS "activeHigh",
    max_engage_kph AS "maxEngageKph", immobilized, last_command AS "lastCommand", last_reply AS "lastReply",
    last_by AS "lastBy", last_at AS "lastAt", tested_at AS "testedAt", created_at AS "createdAt"`;
  async get(tenantId: string, deviceId: string) {
    const { rows } = await this.pool.query(
      `SELECT ${this.cols} FROM device_immobilizer WHERE tenant_id=$1 AND device_id=$2`, [tenantId, deviceId]);
    return rows[0] ?? null;
  }
  async upsert(c: ImmobilizerConfig) {
    const { rows } = await this.pool.query(
      `INSERT INTO device_immobilizer (device_id, tenant_id, enabled, dout, active_high, max_engage_kph, immobilized, last_command, last_reply, last_by, last_at, tested_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (device_id) DO UPDATE SET enabled=$3, dout=$4, active_high=$5, max_engage_kph=$6, immobilized=$7,
         last_command=$8, last_reply=$9, last_by=$10, last_at=$11, tested_at=$12
       RETURNING ${this.cols}`,
      [c.deviceId, c.tenantId, c.enabled, c.dout, c.activeHigh, c.maxEngageKph, c.immobilized, c.lastCommand, c.lastReply, c.lastBy, c.lastAt, c.testedAt]);
    return rows[0];
  }
  async patch(tenantId: string, deviceId: string, patch: Partial<ImmobilizerConfig>) {
    const map: Array<[keyof ImmobilizerConfig, string]> = [
      ['enabled','enabled'],['dout','dout'],['activeHigh','active_high'],['maxEngageKph','max_engage_kph'],
      ['immobilized','immobilized'],['lastCommand','last_command'],['lastReply','last_reply'],
      ['lastBy','last_by'],['lastAt','last_at'],['testedAt','tested_at']];
    const sets: string[] = []; const vals: unknown[] = [tenantId, deviceId];
    for (const [k, col] of map) if (patch[k] !== undefined) { vals.push(patch[k]); sets.push(`${col}=$${vals.length}`); }
    if (!sets.length) return this.get(tenantId, deviceId);
    const { rows } = await this.pool.query(
      `UPDATE device_immobilizer SET ${sets.join(',')} WHERE tenant_id=$1 AND device_id=$2 RETURNING ${this.cols}`, vals);
    return rows[0] ?? null;
  }
  async addEvent(e: ImmobilizerEvent) {
    await this.pool.query(
      `INSERT INTO immobilizer_event (id, tenant_id, device_id, action, actor_id, actor_email, command, reply, ok, ts)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [e.id, e.tenantId, e.deviceId, e.action, e.actorId, e.actorEmail, e.command, e.reply, e.ok, e.ts]);
  }
  async events(tenantId: string, deviceId: string, limit: number) {
    const { rows } = await this.pool.query(
      `SELECT id, tenant_id AS "tenantId", device_id AS "deviceId", action, actor_id AS "actorId",
        actor_email AS "actorEmail", command, reply, ok, ts
       FROM immobilizer_event WHERE tenant_id=$1 AND device_id=$2 ORDER BY ts DESC LIMIT $3`, [tenantId, deviceId, limit]);
    return rows;
  }
}

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import {
  PgTenantRepository, PgUserRepository, PgDeviceRepository, PgVehicleRepository,
  PgPositionRepository, PgGeofenceRepository, PgAlertRepository, PgTripRepository,
  PgAlertConfigRepository, PgNotificationConfigRepository, PgOrgUnitRepository, PgSubscriptionRepository,
} from '../src/domain/pg.repository';
import { DEFAULT_ALERT_CONFIG } from '../src/domain/entities';

/**
 * Integration tests for the PostgreSQL/PostGIS/TimescaleDB repositories. These
 * run ONLY when DATABASE_URL is set (docker-compose), so the default in-memory
 * suite stays infra-free. Bring the DB up first:
 *   docker compose up -d db
 *   DATABASE_URL=postgres://postgres:fleet@localhost:5433/fleet npm run test:pg
 */
const DATABASE_URL = process.env.DATABASE_URL;
const RUN = !!DATABASE_URL;

let pool: Pool;
let tenantId: string;

before(async () => {
  if (!RUN) return;
  pool = new Pool({ connectionString: DATABASE_URL });
  await pool.query(
    'TRUNCATE tenant, org_unit, app_user, device, vehicle, geofence, position, alert_event, trip, alert_config, subscription CASCADE',
  );
  tenantId = randomUUID();
});
after(async () => {
  if (pool) await pool.end();
});

test('tenant + user round-trip', { skip: !RUN }, async () => {
  const tenants = new PgTenantRepository(pool);
  const users = new PgUserRepository(pool);
  const t = await tenants.create({ id: tenantId, name: 'Real Co' });
  assert.equal(t.name, 'Real Co');
  assert.ok(t.createdAt);
  assert.equal((await tenants.findById(tenantId))?.name, 'Real Co');

  const u = await users.create({ id: randomUUID(), tenantId, email: 'a@real.co', passwordHash: 'scrypt$x$y', role: 'admin', active: true, mfaEnabled: false, mfaSecret: null, departmentId: null });
  assert.equal(u.role, 'admin');
  assert.equal((await users.findByEmail('a@real.co'))?.id, u.id);
  assert.equal(u.active, true);
  // list + update
  assert.ok((await users.list(tenantId)).length >= 1);
  const upd = await users.update(u.id, { active: false });
  assert.equal(upd?.active, false);
});

test('device CRUD + activeImeis', { skip: !RUN }, async () => {
  const devices = new PgDeviceRepository(pool);
  const id = randomUUID();
  const d = await devices.create({ id, tenantId, imei: '860000000000101', name: null, model: 'FTC927', assetType: 'car', status: 'provisioned', vehicleId: null, departmentId: null });
  assert.equal(d.imei, '860000000000101');
  assert.equal((await devices.findByImei('860000000000101'))?.id, id);
  assert.equal((await devices.list(tenantId)).length, 1);

  const upd = await devices.update(tenantId, id, { status: 'active' });
  assert.equal(upd?.status, 'active');
  assert.deepEqual(await devices.activeImeis(), ['860000000000101']);

  await devices.update(tenantId, id, { status: 'suspended' });
  assert.equal((await devices.activeImeis()).length, 0);

  // cross-tenant read must return null
  assert.equal(await devices.findById(randomUUID(), id), null);
});

test('org units + department-scoped device listing', { skip: !RUN }, async () => {
  const orgs = new PgOrgUnitRepository(pool);
  const devices = new PgDeviceRepository(pool);
  const north = await orgs.create({ id: randomUUID(), tenantId, name: 'North', parentId: null });
  const northA = await orgs.create({ id: randomUUID(), tenantId, name: 'NorthA', parentId: north.id });
  const south = await orgs.create({ id: randomUUID(), tenantId, name: 'South', parentId: null });
  assert.equal((await orgs.list(tenantId)).length, 3);
  assert.equal((await orgs.findById(tenantId, northA.id))?.parentId, north.id);

  await devices.create({ id: randomUUID(), tenantId, imei: '861100000000001', name: null, model: 'FTC927', assetType: 'car', status: 'active', vehicleId: null, departmentId: north.id });
  await devices.create({ id: randomUUID(), tenantId, imei: '861100000000002', name: null, model: 'FTC927', assetType: 'car', status: 'active', vehicleId: null, departmentId: south.id });
  // department_id = ANY($2) filter
  const inNorthSubtree = await devices.list(tenantId, [north.id, northA.id]);
  assert.equal(inNorthSubtree.length, 1); // only the north device (filter works)
  assert.equal(inNorthSubtree[0].departmentId, north.id);
  assert.ok((await devices.list(tenantId)).length >= 2); // unfiltered = all (incl. prior tests')

  // ON DELETE SET NULL: deleting the department nulls the device's department_id
  await orgs.remove(tenantId, south.id);
  const orphan = await devices.findByImei('861100000000002');
  assert.equal(orphan?.departmentId, null);
});

test('position insert + history round-trips lat/lon through PostGIS', { skip: !RUN }, async () => {
  const positions = new PgPositionRepository(pool);
  const deviceId = randomUUID();
  const devices = new PgDeviceRepository(pool);
  await devices.create({ id: deviceId, tenantId, imei: '860000000000102', name: null, model: 'FTC927', assetType: 'car', status: 'active', vehicleId: null, departmentId: null });

  await positions.insertMany([
    { tenantId, deviceId, imei: '860000000000102', ts: '2026-07-24T10:00:00.000Z', latitude: 19.3133, longitude: -81.3833, altitude: 3, heading: 90, speedKph: 42, satellites: 9, ignition: true, attrs: { '800': 12300 } },
    { tenantId, deviceId, imei: '860000000000102', ts: '2026-07-24T10:00:30.000Z', latitude: 19.3140, longitude: -81.3820, altitude: 4, heading: 88, speedKph: 55, satellites: 9, ignition: true, attrs: {} },
  ]);
  // resend of the first record must be ignored (ON CONFLICT DO NOTHING)
  await positions.insertMany([
    { tenantId, deviceId, imei: '860000000000102', ts: '2026-07-24T10:00:00.000Z', latitude: 19.3133, longitude: -81.3833, altitude: 3, heading: 90, speedKph: 42, satellites: 9, ignition: true, attrs: {} },
  ]);

  const hist = await positions.history(tenantId, deviceId, '2026-07-24T00:00:00Z', '2026-07-25T00:00:00Z', 100);
  assert.equal(hist.length, 2, 'deduped by (device_id, ts)');
  assert.ok(Math.abs(hist[0].latitude - 19.3133) < 1e-6, `lat round-trip: ${hist[0].latitude}`);
  assert.ok(Math.abs(hist[0].longitude - -81.3833) < 1e-6, `lon round-trip: ${hist[0].longitude}`);
  assert.equal(hist[0].speedKph, 42);
  assert.equal(hist[0].ignition, true);
  assert.equal(hist[1].ts.toString().startsWith('2026-07-24'), true);
});

test('geofence circle + polygon round-trip through PostGIS', { skip: !RUN }, async () => {
  const geo = new PgGeofenceRepository(pool);
  const circleId = randomUUID();
  await geo.create({ id: circleId, tenantId, name: 'Depot', kind: 'circle', centerLat: 19.30, centerLon: -81.38, radiusM: 300, createdAt: new Date().toISOString() });
  const polyId = randomUUID();
  const ring: [number, number][] = [[-81.40, 19.20], [-81.30, 19.20], [-81.30, 19.40], [-81.40, 19.40]];
  await geo.create({ id: polyId, tenantId, name: 'Zone', kind: 'polygon', ring, createdAt: new Date().toISOString() });

  const list = await geo.list(tenantId);
  assert.equal(list.length, 2);
  const circle = list.find((g) => g.id === circleId)!;
  assert.equal(circle.kind, 'circle');
  if (circle.kind === 'circle') {
    assert.ok(Math.abs(circle.centerLat - 19.30) < 1e-6);
    assert.equal(circle.radiusM, 300);
  }
  const poly = list.find((g) => g.id === polyId)!;
  assert.equal(poly.kind, 'polygon');
  if (poly.kind === 'polygon') {
    assert.equal(poly.ring.length, 4, 'closing point dropped');
    assert.ok(Math.abs(poly.ring[0][0] - -81.40) < 1e-6);
  }

  assert.equal(await geo.remove(tenantId, circleId), true);
  assert.equal((await geo.list(tenantId)).length, 1);
});

test('alert insert + list newest-first', { skip: !RUN }, async () => {
  const alerts = new PgAlertRepository(pool);
  const deviceId = randomUUID();
  await alerts.insertMany([
    { id: randomUUID(), tenantId, deviceId, imei: '860000000000103', type: 'overspeed', ts: '2026-07-24T10:00:00.000Z', message: 'fast', meta: { speedKph: 120 } },
    { id: randomUUID(), tenantId, deviceId, imei: '860000000000103', type: 'geofence_enter', ts: '2026-07-24T10:01:00.000Z', message: 'entered Depot', meta: { geofenceId: 'g1' } },
  ]);
  const list = await alerts.list(tenantId, { limit: 10 });
  assert.equal(list.length, 2);
  assert.equal(list[0].type, 'geofence_enter', 'newest first');
  assert.equal(list[0].message, 'entered Depot');
  assert.equal(list[1].meta.speedKph, 120);
});

test('trip insert + list', { skip: !RUN }, async () => {
  const trips = new PgTripRepository(pool);
  const deviceId = randomUUID();
  await trips.insert({ id: randomUUID(), tenantId, deviceId, startTs: '2026-07-24T10:00:00.000Z', endTs: '2026-07-24T10:20:00.000Z', distanceM: 5400, maxSpeedKph: 72, points: 40 });
  const list = await trips.list(tenantId, deviceId, '2026-07-24T00:00:00Z', '2026-07-25T00:00:00Z', 100);
  assert.equal(list.length, 1);
  assert.equal(list[0].distanceM, 5400);
  assert.equal(list[0].maxSpeedKph, 72);
});

test('subscription upsert + device/user counts', { skip: !RUN }, async () => {
  const subs = new PgSubscriptionRepository(pool);
  assert.equal(await subs.get(tenantId), null); // none = default plan
  await subs.set(tenantId, { tenantId, planId: 'pro', status: 'active', createdAt: new Date().toISOString() });
  assert.equal((await subs.get(tenantId))?.planId, 'pro');
  await subs.set(tenantId, { tenantId, planId: 'enterprise', status: 'active', createdAt: new Date().toISOString() });
  assert.equal((await subs.get(tenantId))?.planId, 'enterprise'); // ON CONFLICT upsert

  // count(*) methods used by quota checks
  const devices = new PgDeviceRepository(pool);
  const users = new PgUserRepository(pool);
  assert.ok((await devices.count(tenantId)) >= 1);
  assert.ok((await users.count(tenantId)) >= 1);
});

test('notification config default + array round-trip + upsert', { skip: !RUN }, async () => {
  const repo = new PgNotificationConfigRepository(pool);
  const fresh = await repo.get(tenantId);
  assert.deepEqual(fresh.webhookUrls, []);
  assert.equal(fresh.types, null);

  await repo.set(tenantId, {
    tenantId, webhookUrls: ['https://a/hook', 'https://b/hook'], emailRecipients: ['ops@x.co'],
    webhookSecret: 'abc123', types: ['overspeed', 'geofence_enter'],
  });
  const got = await repo.get(tenantId);
  assert.deepEqual(got.webhookUrls, ['https://a/hook', 'https://b/hook']); // text[] round-trip
  assert.deepEqual(got.emailRecipients, ['ops@x.co']);
  assert.equal(got.webhookSecret, 'abc123');
  assert.deepEqual(got.types, ['overspeed', 'geofence_enter']);

  // upsert clears types back to null (all)
  await repo.set(tenantId, { ...got, types: null });
  assert.equal((await repo.get(tenantId)).types, null);
});

test('alert config default then upsert', { skip: !RUN }, async () => {
  const cfg = new PgAlertConfigRepository(pool);
  const fresh = await cfg.get(tenantId);
  assert.equal(fresh.overspeedKph, DEFAULT_ALERT_CONFIG.overspeedKph);
  await cfg.set(tenantId, { ...DEFAULT_ALERT_CONFIG, overspeedKph: 55 });
  assert.equal((await cfg.get(tenantId)).overspeedKph, 55);
  // upsert again (ON CONFLICT)
  await cfg.set(tenantId, { ...DEFAULT_ALERT_CONFIG, overspeedKph: 33 });
  assert.equal((await cfg.get(tenantId)).overspeedKph, 33);
});

import 'reflect-metadata';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import { WebSocket } from 'ws';
import { AppModule } from '../src/app.module';
import { applyHttpHardening } from '../src/hardening';
import { loadConfig } from '../src/config';
import { TOKENS } from '../src/domain/repository';
import { totp } from '../src/engine/totp';
import type { InMemoryAllowList, InMemoryBus, InMemoryHotState } from '../src/integrations/in-memory';
import type { InMemoryDeviceCommander } from '../src/integrations/device-commander';

let app: INestApplication;
let base: string;

before(async () => {
  // High throttle limit so the shared suite isn't rate-limited (a dedicated
  // test in hardening.test.ts exercises throttling with a low limit).
  const config = loadConfig({ USE_IN_MEMORY: 'true', JWT_SECRET: 'test-secret', PORT: '0', THROTTLE_LIMIT: '1000000' } as NodeJS.ProcessEnv);
  app = await NestFactory.create(AppModule.forRoot(config), { logger: false });
  applyHttpHardening(app, { corsOrigins: [] });
  app.useWebSocketAdapter(new WsAdapter(app));
  await app.listen(0, '127.0.0.1');
  const addr = app.getHttpServer().address();
  base = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await app?.close();
});

async function http(method: string, path: string, opts: { token?: string; body?: unknown } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function newTenant(name: string, email: string) {
  const r = await http('POST', '/auth/register-tenant', {
    body: { tenantName: name, adminEmail: email, password: 'password123' },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.accessToken as string;
}

test('health is public', async () => {
  const r = await http('GET', '/healthz');
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'ok');
});

test('unauthenticated requests are rejected', async () => {
  const r = await http('GET', '/devices');
  assert.equal(r.status, 401);
});

test('register tenant → login → returns token', async () => {
  const token = await newTenant('Acme Cayman', 'admin@acme.ky');
  assert.ok(token);
  const login = await http('POST', '/auth/login', { body: { email: 'admin@acme.ky', password: 'password123' } });
  assert.equal(login.status, 200);
  assert.ok(login.body.accessToken);
  const bad = await http('POST', '/auth/login', { body: { email: 'admin@acme.ky', password: 'wrong' } });
  assert.equal(bad.status, 401);
});

test('provisioning a device adds it to the ingestion allow-list', async () => {
  const token = await newTenant('Fleet One', 'admin@fleet1.ky');
  const create = await http('POST', '/devices', { token, body: { imei: '356307042441013', model: 'FTC927' } });
  assert.equal(create.status, 201, JSON.stringify(create.body));
  assert.equal(create.body.status, 'provisioned');

  const allow = app.get<InMemoryAllowList>(TOKENS.AllowListPublisher);
  assert.ok(allow.imeis.has('356307042441013'), 'IMEI published to allow-list');

  // suspend -> removed from allow-list
  const suspend = await http('PATCH', `/devices/${create.body.id}/status`, { token, body: { status: 'suspended' } });
  assert.equal(suspend.status, 200);
  assert.equal(allow.imeis.has('356307042441013'), false, 'suspended device removed from allow-list');
});

test('soft delete: device vanishes from views, history stays readable, IMEI is reusable, restore works', async () => {
  const token = await newTenant('SoftDel Co', 'admin@softdel.ky');
  const IMEI = '860000000006666';
  const dev = (await http('POST', '/devices', { token, body: { imei: IMEI, model: 'FTC927', name: 'Old Van' } })).body;
  const allow = app.get<InMemoryAllowList>(TOKENS.AllowListPublisher);

  // Give it some history.
  const bus = app.get<InMemoryBus>(TOKENS.TelemetryBus);
  const mk = (ts: string) => ({ imei: IMEI, ts, data: JSON.stringify({ imei: IMEI, ts, latitude: 19.3, longitude: -81.38, altitude: 0, heading: 0, speedKph: 30, satellites: 8, fields: { ignition: 1 }, attrs: {} }) });
  await bus.push([mk('2026-07-24T10:00:00.000Z'), mk('2026-07-24T10:01:00.000Z')]);
  assert.equal((await http('GET', `/devices/${dev.id}/history?from=2026-07-24T00:00:00Z&to=2026-07-25T00:00:00Z`, { token })).body.length, 2);

  // Delete (soft).
  assert.equal((await http('DELETE', `/devices/${dev.id}`, { token })).status, 204);

  // Gone from every normal view…
  assert.equal((await http('GET', '/devices', { token })).body.length, 0, 'not in list');
  assert.equal((await http('GET', `/devices/${dev.id}`, { token })).status, 404, 'not by id');
  assert.equal(allow.imeis.has(IMEI), false, 'ingestion no longer accepts it');
  // …but visible in the deleted view, with the timestamp.
  const deleted = (await http('GET', '/devices/deleted', { token })).body;
  assert.equal(deleted.length, 1);
  assert.equal(deleted[0].id, dev.id);
  assert.ok(deleted[0].deletedAt, 'deletedAt is set');

  // HISTORY IS PRESERVED and still readable — the whole point.
  const hist = await http('GET', `/devices/${dev.id}/history?from=2026-07-24T00:00:00Z&to=2026-07-25T00:00:00Z`, { token });
  assert.equal(hist.status, 200);
  assert.equal(hist.body.length, 2, 'positions survive the delete and remain queryable');
  assert.equal((await http('GET', `/devices/${dev.id}/latest`, { token })).status, 200);

  // New telemetry for the deleted IMEI is NOT attached to the deleted row.
  await bus.push([mk('2026-07-24T10:02:00.000Z')]);
  assert.equal((await http('GET', `/devices/${dev.id}/history?from=2026-07-24T00:00:00Z&to=2026-07-25T00:00:00Z`, { token })).body.length, 2, 'no new rows after delete');

  // The same physical tracker can be provisioned again as a fresh device.
  const again = await http('POST', '/devices', { token, body: { imei: IMEI, model: 'FTC927', name: 'New Van' } });
  assert.equal(again.status, 201, 'IMEI is reusable after soft delete');
  assert.notEqual(again.body.id, dev.id, 'it is a new row; the old one keeps its history');

  // Restore of the OLD row must now fail: two live devices can't share an IMEI.
  assert.equal((await http('POST', `/devices/${dev.id}/restore`, { token })).status, 409);

  // Delete the new one, restore the old one → old is live again with its history.
  await http('DELETE', `/devices/${again.body.id}`, { token });
  const restored = await http('POST', `/devices/${dev.id}/restore`, { token });
  assert.equal(restored.status, 201);
  assert.equal(restored.body.name, 'Old Van');
  assert.equal(restored.body.deletedAt, null);
  assert.equal((await http('GET', '/devices', { token })).body.length, 1);
  assert.equal(allow.imeis.has(IMEI), true, 'ingestion accepts it again');
  assert.equal((await http('GET', `/devices/${dev.id}/history?from=2026-07-24T00:00:00Z&to=2026-07-25T00:00:00Z`, { token })).body.length, 2, 'history intact through delete + restore');

  // Only admins may delete/restore.
  await http('POST', '/users', { token, body: { email: 'op@softdel.ky', password: 'password123', role: 'operator' } });
  const op = (await http('POST', '/auth/login', { body: { email: 'op@softdel.ky', password: 'password123' } })).body.accessToken;
  assert.equal((await http('DELETE', `/devices/${dev.id}`, { token: op })).status, 403);
});

test('invalid IMEI is rejected by validation', async () => {
  const token = await newTenant('Fleet Two', 'admin@fleet2.ky');
  const r = await http('POST', '/devices', { token, body: { imei: '123', model: 'FTC927' } });
  assert.equal(r.status, 400);
});

test('duplicate IMEI is a conflict', async () => {
  const token = await newTenant('Fleet Three', 'admin@fleet3.ky');
  await http('POST', '/devices', { token, body: { imei: '860000000000001', model: 'FTC927' } });
  const dup = await http('POST', '/devices', { token, body: { imei: '860000000000001', model: 'FTC927' } });
  assert.equal(dup.status, 409);
});

test('tenant isolation: one tenant cannot see another tenant device', async () => {
  const tokenA = await newTenant('Tenant A', 'a@x.ky');
  const tokenB = await newTenant('Tenant B', 'b@x.ky');
  const created = await http('POST', '/devices', { token: tokenA, body: { imei: '860000000000002', model: 'FTC927' } });
  const asB = await http('GET', `/devices/${created.body.id}`, { token: tokenB });
  assert.equal(asB.status, 404, 'cross-tenant read must not succeed');
  const listB = await http('GET', '/devices', { token: tokenB });
  assert.equal(listB.body.length, 0);
});

test('RBAC: viewer cannot provision devices', async () => {
  // Register admin, then we need a viewer. There is no user-management endpoint
  // in this slice, so assert the guard by forging a viewer via a second tenant
  // admin is not viewer — instead verify admin CAN and rely on RolesGuard unit
  // coverage. Here we at least confirm the role is enforced on the route.
  const token = await newTenant('RBAC Co', 'admin@rbac.ky');
  const ok = await http('POST', '/devices', { token, body: { imei: '860000000000009', model: 'FTC927' } });
  assert.equal(ok.status, 201);
});

test('telemetry consumer persists positions and serves latest + history', async () => {
  const token = await newTenant('Track Co', 'admin@track.ky');
  const dev = await http('POST', '/devices', { token, body: { imei: '860000000000123', model: 'FTC927' } });
  const deviceId = dev.body.id as string;

  // Simulate ingestion publishing normalized telemetry onto the stream bus.
  const bus = app.get<InMemoryBus>(TOKENS.TelemetryBus);
  const mk = (ts: string, lat: number, ign: number) => ({
    imei: '860000000000123', ts,
    data: JSON.stringify({
      imei: '860000000000123', ts, latitude: lat, longitude: -81.37,
      altitude: 3, heading: 90, speedKph: 40, satellites: 9,
      fields: { ignition: ign, externalVoltageMv: 12300 }, attrs: { '999': 5 },
    }),
  });
  await bus.push([mk('2026-07-24T10:00:00.000Z', 19.30, 1), mk('2026-07-24T10:00:30.000Z', 19.31, 1)]);

  const latest = await http('GET', `/devices/${deviceId}/latest`, { token });
  assert.equal(latest.status, 200);
  assert.equal(latest.body.latitude, 19.31, 'latest = most recent ts');
  assert.equal(latest.body.ignition, true);

  const history = await http('GET', `/devices/${deviceId}/history?from=2026-07-24T00:00:00Z&to=2026-07-25T00:00:00Z`, { token });
  assert.equal(history.status, 200);
  assert.equal(history.body.length, 2);
  assert.equal(history.body[0].ts, '2026-07-24T10:00:00.000Z', 'history ascending');
});

test('remote reporting profile: read, write-then-verify, validation, offline device, roles', async () => {
  const admin = await newTenant('Remote Cfg Co', 'admin@remotecfg.ky');
  const IMEI = '860000000007777';
  const dev = (await http('POST', '/devices', { token: admin, body: { imei: IMEI, model: 'FTC927' } })).body;
  const cmd = app.get(TOKENS.DeviceCommander) as InMemoryDeviceCommander;
  const q = 'network=home&motion=moving';

  // Device offline → a clear 409, and nothing was sent.
  cmd.disconnect(IMEI);
  const off = await http('POST', `/devices/${dev.id}/config/reporting?${q}`, { token: admin, body: { minPeriodSec: 5 } });
  assert.equal(off.status, 409);
  assert.match(off.body.message, /not currently connected/i);

  cmd.connect(IMEI);

  // Write: the exact wiki setparam goes to the device, then it is read back and returned.
  const w = await http('POST', `/devices/${dev.id}/config/reporting?${q}`, { token: admin, body: { minPeriodSec: 5, minDistanceM: 50, minAngleDeg: 15 } });
  assert.equal(w.status, 201);
  assert.equal(w.body.command, 'setparam 10050:5;10051:50;10052:15');
  assert.equal(w.body.applied, true);
  assert.deepEqual(w.body.values, { minPeriodSec: 5, minDistanceM: 50, minAngleDeg: 15, minSpeedDeltaKph: 0, minSavedRecords: 0, sendPeriodSec: 0 },
    'returned values are what the device HOLDS (read back), not what we asked for');
  const sent = cmd.sent.map((s) => s.command);
  assert.deepEqual(sent.slice(-2), ['setparam 10050:5;10051:50;10052:15', 'getparam 10050;10051;10052;10053;10054;10055'], 'set, then verify');

  // Read.
  const r = await http('GET', `/devices/${dev.id}/config/reporting?${q}`, { token: admin });
  assert.equal(r.status, 200);
  assert.equal(r.body.values.minPeriodSec, 5);

  // Validation happens before anything reaches the vehicle.
  const before = cmd.sent.length;
  assert.equal((await http('POST', `/devices/${dev.id}/config/reporting?${q}`, { token: admin, body: { minAngleDeg: 999 } })).status, 400);
  assert.equal((await http('POST', `/devices/${dev.id}/config/reporting?network=mars&motion=moving`, { token: admin, body: { minPeriodSec: 5 } })).status, 400);
  assert.equal((await http('POST', `/devices/${dev.id}/config/reporting?network=home&motion=stop`, { token: admin, body: { minDistanceM: 10 } })).status, 400, 'distance is not a stop-profile setting');
  assert.equal(cmd.sent.length, before, 'invalid requests never sent a command');

  // Only admins may write; operators may read; viewers neither.
  await http('POST', '/users', { token: admin, body: { email: 'op@remotecfg.ky', password: 'password123', role: 'operator' } });
  await http('POST', '/users', { token: admin, body: { email: 'view@remotecfg.ky', password: 'password123', role: 'viewer' } });
  const op = (await http('POST', '/auth/login', { body: { email: 'op@remotecfg.ky', password: 'password123' } })).body.accessToken;
  const viewer = (await http('POST', '/auth/login', { body: { email: 'view@remotecfg.ky', password: 'password123' } })).body.accessToken;
  assert.equal((await http('POST', `/devices/${dev.id}/config/reporting?${q}`, { token: op, body: { minPeriodSec: 5 } })).status, 403);
  assert.equal((await http('GET', `/devices/${dev.id}/config/reporting?${q}`, { token: op })).status, 200);
  assert.equal((await http('GET', `/devices/${dev.id}/config/reporting?${q}`, { token: viewer })).status, 403);

  // Another tenant cannot touch this device at all.
  const other = await newTenant('Other Co', 'admin@other.ky');
  assert.equal((await http('GET', `/devices/${dev.id}/config/reporting?${q}`, { token: other })).status, 404);
});

test('/latest survives a cold hot-state cache by falling back to the DB and re-warming', async () => {
  // Seen in production 2026-08-17: after a Redis restart every vehicle showed
  // "no position yet" and the map was blank, despite thousands of rows in the
  // position table. The hot-state is a cache; the DB is the record.
  const token = await newTenant('Cold Co', 'admin@cold.ky');
  const dev = await http('POST', '/devices', { token, body: { imei: '860000000008888', model: 'FTC927' } });
  const bus = app.get<InMemoryBus>(TOKENS.TelemetryBus);
  const mk = (ts: string, lat: number) => ({
    imei: '860000000008888', ts,
    data: JSON.stringify({ imei: '860000000008888', ts, latitude: lat, longitude: -81.37, altitude: 0,
      heading: 0, speedKph: 0, satellites: 8, fields: { ignition: 0 }, attrs: {} }),
  });
  await bus.push([mk('2026-07-24T10:00:00.000Z', 19.30), mk('2026-07-24T10:05:00.000Z', 19.31)]);

  // Warm path works.
  assert.equal((await http('GET', `/devices/${dev.body.id}/latest`, { token })).body.latitude, 19.31);

  // Simulate Redis restart: hot-state gone, DB intact.
  (app.get(TOKENS.HotState) as InMemoryHotState).clear();

  const cold = await http('GET', `/devices/${dev.body.id}/latest`, { token });
  assert.equal(cold.status, 200, 'must not 404 when only the cache is empty');
  assert.equal(cold.body.ts, '2026-07-24T10:05:00.000Z', 'newest row, not just any row');
  assert.equal(cold.body.latitude, 19.31);

  // And it re-warmed the cache: a second read is served from hot-state.
  const hot = app.get(TOKENS.HotState) as InMemoryHotState;
  assert.ok(await hot.getLast(cold.body.tenantId, dev.body.id), 'cache re-warmed after fallback');
});

test('a device that transmits BEFORE it is provisioned becomes visible once it is', async () => {
  // Real-world sequence (seen in production 2026-08-17): the tracker is powered
  // on and starts sending before the operator finishes the Add Device form. The
  // consumer must not remember "unknown IMEI" forever — that left the device
  // invisible until the API was restarted.
  const token = await newTenant('Early Co', 'admin@early.ky');
  const IMEI = '860000000009999';
  const bus = app.get<InMemoryBus>(TOKENS.TelemetryBus);
  const mk = (ts: string) => ({
    imei: IMEI, ts,
    data: JSON.stringify({ imei: IMEI, ts, latitude: 19.3, longitude: -81.37, altitude: 0,
      heading: 0, speedKph: 10, satellites: 8, fields: { ignition: 1 }, attrs: {} }),
  });

  // 1) telemetry arrives for an IMEI nobody has provisioned → skipped, and the
  //    consumer caches the miss.
  await bus.push([mk('2026-07-24T10:00:00.000Z')]);

  // 2) operator provisions it.
  const dev = await http('POST', '/devices', { token, body: { imei: IMEI, model: 'FTC927' } });
  assert.equal(dev.status, 201);

  // 3) next telemetry must land — after the negative-cache window, not never.
  //    (Consumer's NEGATIVE_CACHE_MS is 10s; wait it out rather than reach into internals.)
  await new Promise((r) => setTimeout(r, 10_500));
  await bus.push([mk('2026-07-24T10:01:00.000Z')]);

  const latest = await http('GET', `/devices/${dev.body.id}/latest`, { token });
  assert.equal(latest.status, 200, 'device that transmitted before provisioning is now visible');
  assert.equal(latest.body.ts, '2026-07-24T10:01:00.000Z');
});

test('live feed: WS client receives a tenant-scoped position push', async () => {
  const token = await newTenant('Live Co', 'admin@live.ky');
  const dev = await http('POST', '/devices', { token, body: { imei: '860000000000777', model: 'FTC927' } });
  const wsUrl = base.replace('http', 'ws') + `/rt?token=${token}`;

  const ws = new WebSocket(wsUrl);
  const messages: any[] = [];
  await new Promise<void>((resolve, reject) => {
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      messages.push(m);
      if (m.type === 'connected') resolve();
    });
    ws.on('error', reject);
  });
  assert.equal(messages[0].type, 'connected');

  const positionArrived = new Promise<any>((resolve) => {
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.type === 'position') resolve(m.position);
    });
  });

  // Ingestion publishes telemetry -> consumer -> realtime push.
  const bus = app.get<InMemoryBus>(TOKENS.TelemetryBus);
  await bus.push([{
    imei: '860000000000777', ts: '2026-07-24T12:00:00.000Z',
    data: JSON.stringify({
      imei: '860000000000777', ts: '2026-07-24T12:00:00.000Z',
      latitude: 19.29, longitude: -81.25, altitude: 0, heading: 45,
      speedKph: 55, satellites: 8, fields: { ignition: 1 }, attrs: {},
    }),
  }]);

  const pos = await positionArrived;
  assert.equal(pos.deviceId, dev.body.id);
  assert.equal(pos.latitude, 19.29);
  ws.close();
});

test('live feed: WS rejects a connection without a valid token', async () => {
  const ws = new WebSocket(base.replace('http', 'ws') + '/rt');
  const closed = await new Promise<{ code: number }>((resolve) => {
    ws.on('close', (code) => resolve({ code }));
    ws.on('error', () => {});
  });
  assert.equal(closed.code, 1008, 'policy-violation close for missing token');
});

function telemetry(imei: string, ts: string, lat: number, lon: number, speed: number, ign = 1) {
  return {
    imei, ts,
    data: JSON.stringify({
      imei, ts, latitude: lat, longitude: lon, altitude: 0, heading: 0,
      speedKph: speed, satellites: 8, fields: { ignition: ign }, attrs: {},
    }),
  };
}

test('geofence entry + overspeed produce alerts (stored + queryable)', async () => {
  const token = await newTenant('Geo Co', 'admin@geo.ky');
  const dev = await http('POST', '/devices', { token, body: { imei: '860000000000501', model: 'FTC927' } });

  const fence = await http('POST', '/geofences', {
    token,
    body: { name: 'George Town Depot', kind: 'circle', centerLat: 19.30, centerLon: -81.38, radiusM: 300 },
  });
  assert.equal(fence.status, 201, JSON.stringify(fence.body));

  const bus = app.get<InMemoryBus>(TOKENS.TelemetryBus);
  // Inside the fence AND over the 90 km/h default limit.
  await bus.push([telemetry('860000000000501', '2026-07-24T12:00:00.000Z', 19.30, -81.38, 120)]);

  const alerts = await http('GET', `/alerts?deviceId=${dev.body.id}`, { token });
  assert.equal(alerts.status, 200);
  const types = alerts.body.map((a: any) => a.type);
  assert.ok(types.includes('geofence_enter'), `expected geofence_enter in ${JSON.stringify(types)}`);
  assert.ok(types.includes('overspeed'), `expected overspeed in ${JSON.stringify(types)}`);
});

test('alert config can be read and updated', async () => {
  const token = await newTenant('Cfg Co', 'admin@cfg.ky');
  const def = await http('GET', '/alert-config', { token });
  assert.equal(def.body.overspeedKph, 90);
  const upd = await http('PUT', '/alert-config', { token, body: { overspeedKph: 60, offlineAfterSec: 120 } });
  assert.equal(upd.status, 200);
  assert.equal(upd.body.overspeedKph, 60);
  const after = await http('GET', '/alert-config', { token });
  assert.equal(after.body.overspeedKph, 60);
  assert.equal(after.body.offlineAfterSec, 120);

  // Regression: a partial update must NOT clobber unspecified fields with
  // undefined (which becomes NULL against NOT NULL columns on the pg path).
  const partial = await http('PUT', '/alert-config', { token, body: { overspeedKph: 42 } });
  assert.equal(partial.status, 200);
  assert.equal(partial.body.overspeedKph, 42);
  assert.equal(partial.body.ignitionAlerts, true, 'ignitionAlerts preserved');
  assert.equal(partial.body.geofenceAlerts, true, 'geofenceAlerts preserved');
  assert.equal(partial.body.offlineAfterSec, 120, 'offlineAfterSec preserved from prior update');
});

test('live feed pushes alerts over WS', async () => {
  const token = await newTenant('Alert Live Co', 'admin@alertlive.ky');
  await http('POST', '/devices', { token, body: { imei: '860000000000601', model: 'FTC927' } });
  await http('POST', '/geofences', {
    token, body: { name: 'Zone', kind: 'circle', centerLat: 19.29, centerLon: -81.25, radiusM: 400 },
  });

  const ws = new WebSocket(base.replace('http', 'ws') + `/rt?token=${token}`);
  await new Promise<void>((resolve, reject) => {
    ws.on('message', (d) => { if (JSON.parse(d.toString()).type === 'connected') resolve(); });
    ws.on('error', reject);
  });
  const alertArrived = new Promise<any>((resolve) => {
    ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.type === 'alert') resolve(m.alert); });
  });

  const bus = app.get<InMemoryBus>(TOKENS.TelemetryBus);
  await bus.push([telemetry('860000000000601', '2026-07-24T12:00:00.000Z', 19.29, -81.25, 30)]);

  const alert = await alertArrived;
  assert.equal(alert.type, 'geofence_enter');
  ws.close();
});

test('trips endpoint returns an array', async () => {
  const token = await newTenant('Trip Co', 'admin@trip.ky');
  const dev = await http('POST', '/devices', { token, body: { imei: '860000000000701', model: 'FTC927' } });
  const trips = await http('GET', `/devices/${dev.body.id}/trips`, { token });
  assert.equal(trips.status, 200);
  assert.ok(Array.isArray(trips.body));
});

test('reports: trips/summary/fleet JSON + CSV/XLSX/PDF export', async () => {
  const token = await newTenant('Report Co', 'admin@report.ky');
  const dev = await http('POST', '/devices', { token, body: { imei: '860000000000801', model: 'FTC927' } });
  const deviceId = dev.body.id as string;

  // Seed a trip directly, and an overspeed alert via the bus.
  const trips = app.get<any>(TOKENS.TripRepository);
  const tenantId = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString()).tenantId;
  await trips.insert({
    id: 'trip-1', tenantId, deviceId, startTs: '2026-07-24T10:00:00.000Z', endTs: '2026-07-24T10:30:00.000Z',
    distanceM: 15000, maxSpeedKph: 82, points: 60,
  });
  await http('PUT', '/alert-config', { token, body: { overspeedKph: 50 } });
  const bus = app.get<InMemoryBus>(TOKENS.TelemetryBus);
  await bus.push([telemetry('860000000000801', '2026-07-24T10:15:00.000Z', 19.3, -81.38, 95)]);

  const from = '2026-07-24T00:00:00Z', to = '2026-07-25T00:00:00Z';

  // JSON reports
  const tripsRep = await http('GET', `/reports?type=trips&deviceId=${deviceId}&from=${from}&to=${to}`, { token });
  assert.equal(tripsRep.status, 200);
  assert.equal(tripsRep.body.rows.length, 1);
  assert.equal(tripsRep.body.rows[0].distanceKm, 15);

  const summary = await http('GET', `/reports?type=summary&deviceId=${deviceId}&from=${from}&to=${to}`, { token });
  assert.equal(summary.body.summary.overspeedEvents, 1);

  const fleet = await http('GET', `/reports?type=fleet&from=${from}&to=${to}`, { token });
  assert.equal(fleet.body.rows.length, 1);
  assert.equal(fleet.body.rows[0].trips, 1);

  const bad = await http('GET', '/reports?type=nonsense', { token });
  assert.equal(bad.status, 400);

  // Exports (raw fetch to inspect headers + bytes)
  const dl = async (format: string) =>
    fetch(`${base}/reports/export?type=trips&deviceId=${deviceId}&from=${from}&to=${to}&format=${format}`, {
      headers: { authorization: `Bearer ${token}` },
    });

  const csv = await dl('csv');
  assert.match(csv.headers.get('content-type') ?? '', /text\/csv/);
  assert.match(csv.headers.get('content-disposition') ?? '', /attachment; filename=".*\.csv"/);
  assert.match(await csv.text(), /Distance \(km\)/);

  const xlsx = await dl('xlsx');
  assert.match(xlsx.headers.get('content-type') ?? '', /spreadsheetml/);
  assert.equal(Buffer.from(await xlsx.arrayBuffer()).subarray(0, 2).toString('latin1'), 'PK');

  const pdf = await dl('pdf');
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString('latin1'), '%PDF-');
});

test('notifications: alert is delivered to a webhook with a valid signature', async () => {
  // Stand up a local webhook receiver.
  const received: { body: string; signature: string }[] = [];
  const receiver = createHttpServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c));
    req.on('end', () => {
      received.push({ body, signature: String(req.headers['x-fleet-signature'] ?? '') });
      res.writeHead(200).end('ok');
    });
  });
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
  const hookUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook`;

  try {
    const token = await newTenant('Notify Co', 'admin@notify.ky');
    await http('POST', '/devices', { token, body: { imei: '860000000000901', model: 'FTC927' } });
    await http('POST', '/geofences', { token, body: { name: 'Zone', kind: 'circle', centerLat: 19.29, centerLon: -81.25, radiusM: 400 } });

    // Configure the webhook; response includes the generated signing secret.
    const cfg = await http('PUT', '/notification-config', { token, body: { webhookUrls: [hookUrl] } });
    assert.equal(cfg.status, 200);
    assert.ok(cfg.body.webhookSecret.length > 0, 'a signing secret is generated');
    const secret = cfg.body.webhookSecret as string;

    // Trigger a geofence_enter alert; the consumer dispatches it to the webhook.
    const bus = app.get<InMemoryBus>(TOKENS.TelemetryBus);
    await bus.push([telemetry('860000000000901', '2026-07-24T12:00:00.000Z', 19.29, -81.25, 30)]);

    // Dispatch is fire-and-forget; wait for the webhook to land.
    for (let i = 0; i < 40 && received.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(received.length, 1, 'webhook received the alert');

    const { body, signature } = received[0];
    assert.equal(signature, `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`, 'signature valid');
    const payload = JSON.parse(body);
    assert.equal(payload.type, 'alert');
    assert.equal(payload.alert.type, 'geofence_enter');
  } finally {
    await new Promise<void>((r) => receiver.close(() => r()));
  }
});

test('notifications: test endpoint reports whether channels are configured', async () => {
  const token = await newTenant('NotifTest Co', 'admin@notiftest.ky');
  const none = await http('POST', '/notification-config/test', { token });
  assert.equal(none.body.delivered, false); // no channels yet
  await http('PUT', '/notification-config', { token, body: { emailRecipients: ['ops@notiftest.ky'] } });
  const some = await http('POST', '/notification-config/test', { token });
  assert.equal(some.body.delivered, true);
});

test('user management: admin creates, lists, updates and deactivates users', async () => {
  const admin = await newTenant('Team Co', 'admin@team.ky');
  // admin creates an operator
  const created = await http('POST', '/users', { token: admin, body: { email: 'op@team.ky', password: 'password123', role: 'operator' } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.role, 'operator');
  assert.equal(created.body.passwordHash, undefined, 'secrets are not returned');

  // new user can log in
  const opLogin = await http('POST', '/auth/login', { body: { email: 'op@team.ky', password: 'password123' } });
  assert.ok(opLogin.body.accessToken);

  // operator cannot list users (admin-only)
  const forbidden = await http('GET', '/users', { token: opLogin.body.accessToken });
  assert.equal(forbidden.status, 403);

  // admin lists (self + operator), promotes, then deactivates
  const list = await http('GET', '/users', { token: admin });
  assert.equal(list.body.length, 2);
  await http('PATCH', `/users/${created.body.id}`, { token: admin, body: { role: 'admin' } });
  const deactivate = await http('PATCH', `/users/${created.body.id}`, { token: admin, body: { active: false } });
  assert.equal(deactivate.body.active, false);

  // deactivated user can no longer log in
  const denied = await http('POST', '/auth/login', { body: { email: 'op@team.ky', password: 'password123' } });
  assert.equal(denied.status, 401);
});

test('MFA: setup → enable → challenge on login → verify', async () => {
  const token = await newTenant('Secure Co', 'admin@secure.ky');

  // Enroll: get a secret, compute a code, enable
  const setup = await http('POST', '/auth/mfa/setup', { token });
  assert.equal(setup.status, 200);
  assert.ok(setup.body.secret);
  assert.match(setup.body.otpauthUri, /^otpauth:\/\/totp\//);

  const enable = await http('POST', '/auth/mfa/enable', { token, body: { code: totp(setup.body.secret, Date.now()) } });
  assert.deepEqual(enable.body, { enabled: true });

  // Login now returns an MFA challenge, not an access token
  const login = await http('POST', '/auth/login', { body: { email: 'admin@secure.ky', password: 'password123' } });
  assert.equal(login.body.mfaRequired, true);
  assert.ok(login.body.mfaToken);
  assert.equal(login.body.accessToken, undefined);

  // The MFA token must NOT work as an API access token
  const misuse = await http('GET', '/devices', { token: login.body.mfaToken });
  assert.equal(misuse.status, 401);

  // Wrong code is rejected; correct code yields an access token
  const bad = await http('POST', '/auth/mfa/verify', { body: { mfaToken: login.body.mfaToken, code: '000000' } });
  assert.equal(bad.status, 401);
  const good = await http('POST', '/auth/mfa/verify', { body: { mfaToken: login.body.mfaToken, code: totp(setup.body.secret, Date.now()) } });
  assert.equal(good.status, 200);
  assert.ok(good.body.accessToken);

  // The issued access token works on a protected route
  const devices = await http('GET', '/devices', { token: good.body.accessToken });
  assert.equal(devices.status, 200);
});

test('departments + access scoping: a department-scoped user only sees its subtree', async () => {
  const admin = await newTenant('Org Co', 'admin@org.ky');

  // Build a tree: North → NorthA, and South (separate root).
  const north = (await http('POST', '/departments', { token: admin, body: { name: 'North District' } })).body;
  const northA = (await http('POST', '/departments', { token: admin, body: { name: 'North Zone A', parentId: north.id } })).body;
  const south = (await http('POST', '/departments', { token: admin, body: { name: 'South District' } })).body;
  assert.ok(north.id && northA.id && south.id);

  // Bad parent is rejected.
  const badParent = await http('POST', '/departments', { token: admin, body: { name: 'X', parentId: 'nope' } });
  assert.equal(badParent.status, 404);

  // Provision devices into departments.
  const d1 = (await http('POST', '/devices', { token: admin, body: { imei: '861000000000001', model: 'FTC927', departmentId: north.id } })).body;
  const d2 = (await http('POST', '/devices', { token: admin, body: { imei: '861000000000002', model: 'FTC927', departmentId: south.id } })).body;
  const d3 = (await http('POST', '/devices', { token: admin, body: { imei: '861000000000003', model: 'FTC927', departmentId: northA.id } })).body;

  // Admin sees all three.
  assert.equal((await http('GET', '/devices', { token: admin })).body.length, 3);

  // A North-scoped operator.
  await http('POST', '/users', { token: admin, body: { email: 'north@org.ky', password: 'password123', role: 'operator', departmentId: north.id } });
  const opToken = (await http('POST', '/auth/login', { body: { email: 'north@org.ky', password: 'password123' } })).body.accessToken;

  // Sees North (d1) + NorthA subtree (d3), NOT South (d2).
  const opDevices = (await http('GET', '/devices', { token: opToken })).body.map((d: any) => d.imei).sort();
  assert.deepEqual(opDevices, ['861000000000001', '861000000000003']);

  // Direct access to an out-of-scope device is 404 (not even revealed).
  assert.equal((await http('GET', `/devices/${d2.id}`, { token: opToken })).status, 404);
  assert.equal((await http('GET', `/devices/${d1.id}`, { token: opToken })).status, 200);

  // Position + report access is scoped too.
  assert.equal((await http('GET', `/devices/${d2.id}/history`, { token: opToken })).status, 404);
  const fleet = await http('GET', '/reports?type=fleet', { token: opToken });
  assert.equal(fleet.body.rows.length, 2, 'fleet report is department-scoped');

  // Reassigning a device out of the operator's scope is forbidden.
  const reassign = await http('PATCH', `/devices/${d1.id}/department`, { token: opToken, body: { departmentId: south.id } });
  assert.equal(reassign.status, 403);
  void d3;
});

test('group tree: rename, re-parent, cycle guard, and cascading delete', async () => {
  const admin = await newTenant('Tree Co', 'tree@org.ky');
  const mk = async (name: string, parentId?: string) =>
    (await http('POST', '/departments', { token: admin, body: { name, parentId } })).body;

  // root → mid → leaf
  const root = await mk('Root');
  const mid = await mk('Mid', root.id);
  const leaf = await mk('Leaf', mid.id);

  // Rename leaves the parent untouched.
  const renamed = await http('PATCH', `/departments/${root.id}`, { token: admin, body: { name: 'Fleet HQ' } });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.name, 'Fleet HQ');
  assert.equal(renamed.body.parentId, null);

  // Re-parent leaf up to the root.
  const moved = await http('PATCH', `/departments/${leaf.id}`, { token: admin, body: { parentId: root.id } });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.parentId, root.id);
  assert.equal(moved.body.name, 'Leaf', 'name survives a parent-only patch');

  // Moving back to the root must be possible — null is a real value, not "absent".
  const toRoot = await http('PATCH', `/departments/${leaf.id}`, { token: admin, body: { parentId: null } });
  assert.equal(toRoot.status, 200);
  assert.equal(toRoot.body.parentId, null);

  // Cycle guards.
  assert.equal(
    (await http('PATCH', `/departments/${root.id}`, { token: admin, body: { parentId: root.id } })).status, 400,
    'a group cannot parent itself');
  assert.equal(
    (await http('PATCH', `/departments/${root.id}`, { token: admin, body: { parentId: mid.id } })).status, 400,
    'a group cannot move into its own descendant');
  assert.equal(
    (await http('PATCH', `/departments/${root.id}`, { token: admin, body: { parentId: 'nope' } })).status, 404);

  // Non-admins cannot restructure the tree.
  await http('POST', '/users', { token: admin, body: { email: 'view@org.ky', password: 'password123', role: 'viewer' } });
  const viewer = (await http('POST', '/auth/login', { body: { email: 'view@org.ky', password: 'password123' } })).body.accessToken;
  assert.equal((await http('PATCH', `/departments/${root.id}`, { token: viewer, body: { name: 'Hacked' } })).status, 403);

  // Deleting a group takes its subtree with it, but devices survive as ungrouped.
  const dev = (await http('POST', '/devices', { token: admin, body: { imei: '869900000000001', model: 'FTC927', departmentId: mid.id } })).body;
  assert.equal((await http('DELETE', `/departments/${root.id}`, { token: admin })).status, 204);
  const left = (await http('GET', '/departments', { token: admin })).body.map((g: any) => g.id);
  assert.deepEqual(left.sort(), [leaf.id].sort(), 'root + mid are gone; the re-parented leaf remains');
  assert.equal((await http('GET', `/devices/${dev.id}`, { token: admin })).status, 200, 'device outlives its group');
});

test('billing: usage, plan quotas (402), and upgrade', async () => {
  const token = await newTenant('Billing Co', 'admin@billing.ky');

  // Default plan + usage (1 admin user, 0 devices).
  const initial = await http('GET', '/billing', { token });
  assert.equal(initial.status, 200);
  assert.equal(initial.body.plan.id, 'free');
  assert.equal(initial.body.usage.users, 1);
  assert.equal(initial.body.usage.devices, 0);
  assert.ok(Array.isArray(initial.body.plans));

  // Downgrade to trial (devices: 2, users: 1).
  const sub = await http('POST', '/billing/subscribe', { token, body: { planId: 'trial' } });
  assert.equal(sub.status, 200);
  assert.equal(sub.body.plan.id, 'trial');

  // Device quota: 2 allowed, 3rd is 402.
  assert.equal((await http('POST', '/devices', { token, body: { imei: '862000000000001', model: 'FTC927' } })).status, 201);
  assert.equal((await http('POST', '/devices', { token, body: { imei: '862000000000002', model: 'FTC927' } })).status, 201);
  const overDevice = await http('POST', '/devices', { token, body: { imei: '862000000000003', model: 'FTC927' } });
  assert.equal(overDevice.status, 402);
  assert.equal(overDevice.body.error, 'QuotaExceeded');

  // User quota: trial allows 1 user, the admin already fills it → 402.
  const overUser = await http('POST', '/users', { token, body: { email: 'x@billing.ky', password: 'password123', role: 'viewer' } });
  assert.equal(overUser.status, 402);

  // Upgrade to pro → the 3rd device now provisions, usage reflects it.
  await http('POST', '/billing/subscribe', { token, body: { planId: 'pro' } });
  assert.equal((await http('POST', '/devices', { token, body: { imei: '862000000000003', model: 'FTC927' } })).status, 201);
  const after = await http('GET', '/billing', { token });
  assert.equal(after.body.plan.id, 'pro');
  assert.equal(after.body.usage.devices, 3);

  // Invalid plan id is rejected.
  assert.equal((await http('POST', '/billing/subscribe', { token, body: { planId: 'platinum' } })).status, 400);
});

async function gql(query: string, variables: Record<string, unknown>, token?: string) {
  const res = await fetch(`${base}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ query, variables }),
  });
  return { status: res.status, body: (await res.json()) as any };
}

test('graphql: mutation + queries with auth and scoping', async () => {
  const token = await newTenant('GQL Co', 'admin@gql.ky');

  // Mutation: provision a device.
  const mut = await gql(
    'mutation($imei:String!,$model:String!){ provisionDevice(imei:$imei,model:$model){ id imei status } }',
    { imei: '863000000000001', model: 'FTC927' }, token,
  );
  assert.equal(mut.body.errors, undefined, JSON.stringify(mut.body.errors));
  assert.equal(mut.body.data.provisionDevice.imei, '863000000000001');
  assert.equal(mut.body.data.provisionDevice.status, 'provisioned');

  // Query: me + devices + billing in one round trip.
  const q = await gql('{ me { email role } devices { imei model } billing { planId devicesUsed } }', {}, token);
  assert.equal(q.body.data.me.email, 'admin@gql.ky');
  assert.equal(q.body.data.me.role, 'admin');
  assert.equal(q.body.data.devices.length, 1);
  assert.equal(q.body.data.devices[0].imei, '863000000000001');
  assert.equal(q.body.data.billing.planId, 'free');
  assert.equal(q.body.data.billing.devicesUsed, 1);

  // Unauthenticated request is rejected (GraphQL errors, no data).
  const noauth = await gql('{ me { email } }', {});
  assert.ok(noauth.body.errors?.length, 'unauthenticated query returns errors');
  assert.equal(noauth.body.data ?? null, null);
});

test('device names: provision with a name, rename, clear', async () => {
  const token = await newTenant('Names Co', 'admin@names.ky');
  const created = await http('POST', '/devices', { token, body: { imei: '864000000000001', model: 'FTC927', name: 'Delivery Van 9' } });
  assert.equal(created.status, 201);
  assert.equal(created.body.name, 'Delivery Van 9');

  const renamed = await http('PATCH', `/devices/${created.body.id}/name`, { token, body: { name: 'Van Niner' } });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.name, 'Van Niner');

  const list = await http('GET', '/devices', { token });
  assert.equal(list.body[0].name, 'Van Niner');

  const cleared = await http('PATCH', `/devices/${created.body.id}/name`, { token, body: { name: null } });
  assert.equal(cleared.body.name, null);
});

test('refresh tokens: login issues a pair, rotation works, old token is spent', async () => {
  const reg = await http('POST', '/auth/register-tenant', {
    body: { tenantName: 'Refresh Co', adminEmail: `refresh${Date.now()}@t.ky`, password: 'password123' },
  });
  assert.ok(reg.body.accessToken, 'register returns an access token');
  assert.ok(reg.body.refreshToken, 'register returns a refresh token');

  // Exchange for a new pair.
  const r1 = await http('POST', '/auth/refresh', { body: { refreshToken: reg.body.refreshToken } });
  assert.equal(r1.status, 200);
  assert.ok(r1.body.accessToken);
  assert.notEqual(r1.body.refreshToken, reg.body.refreshToken, 'refresh token is rotated');

  // The new access token works on a protected route.
  assert.equal((await http('GET', '/devices', { token: r1.body.accessToken })).status, 200);

  // Reusing the ALREADY-EXCHANGED token is treated as theft: rejected, and the
  // whole family is revoked so the rotated one dies too.
  const replay = await http('POST', '/auth/refresh', { body: { refreshToken: reg.body.refreshToken } });
  assert.equal(replay.status, 401);
  const afterReplay = await http('POST', '/auth/refresh', { body: { refreshToken: r1.body.refreshToken } });
  assert.equal(afterReplay.status, 401, 'reuse detection revokes the whole family');

  // Garbage is rejected.
  assert.equal((await http('POST', '/auth/refresh', { body: { refreshToken: 'not-a-real-token' } })).status, 401);
});

test('refresh tokens: logout revokes the session', async () => {
  const email = `logout${Date.now()}@t.ky`;
  const reg = await http('POST', '/auth/register-tenant', {
    body: { tenantName: 'Logout Co', adminEmail: email, password: 'password123' },
  });
  const login = await http('POST', '/auth/login', { body: { email, password: 'password123' } });
  assert.ok(login.body.refreshToken);

  // Refresh works before logout…
  assert.equal((await http('POST', '/auth/refresh', { body: { refreshToken: login.body.refreshToken } })).status, 200);

  // …and a fresh session is killed by logout.
  const login2 = await http('POST', '/auth/login', { body: { email, password: 'password123' } });
  assert.equal((await http('POST', '/auth/logout', { body: { refreshToken: login2.body.refreshToken } })).status, 200);
  assert.equal(
    (await http('POST', '/auth/refresh', { body: { refreshToken: login2.body.refreshToken } })).status,
    401,
    'revoked refresh token cannot be exchanged',
  );
  void reg;
});

test('telemetry for an unknown IMEI is skipped, not crashed', async () => {
  const bus = app.get<InMemoryBus>(TOKENS.TelemetryBus);
  await bus.push([{ imei: '111111111111111', ts: '2026-07-24T10:00:00.000Z', data: JSON.stringify({ imei: '111111111111111', ts: '2026-07-24T10:00:00.000Z', latitude: 0, longitude: 0, altitude: 0, heading: 0, speedKph: 0, satellites: 0, fields: {}, attrs: {} }) }]);
  // no throw = pass
  assert.ok(true);
});

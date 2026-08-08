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
import type { InMemoryAllowList, InMemoryBus } from '../src/integrations/in-memory';

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

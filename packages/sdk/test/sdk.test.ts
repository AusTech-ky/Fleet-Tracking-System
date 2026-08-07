import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { FleetClient, FleetApiError } from '../src/index.ts';

let server: Server;
let baseUrl: string;
const received: { path: string; auth: string | undefined; body: any }[] = [];

before(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      received.push({ path: req.url!, auth: req.headers.authorization as string | undefined, body });
      res.setHeader('content-type', 'application/json');

      if (req.url === '/auth/login') {
        if (body.password === 'good') return void res.end(JSON.stringify({ accessToken: 'tok-123' }));
        res.statusCode = 401;
        return void res.end(JSON.stringify({ message: 'Invalid credentials' }));
      }
      if (req.url === '/graphql') {
        const q: string = body.query;
        if (q.includes('me {')) return void res.end(JSON.stringify({ data: { me: { userId: 'u1', tenantId: 't1', email: 'a@x.co', role: 'admin', departmentId: null } } }));
        if (q.includes('devices {')) return void res.end(JSON.stringify({ data: { devices: [{ id: 'd1', imei: '860000000000001', model: 'FTC927', status: 'active', departmentId: null, vehicleId: null }] } }));
        if (q.includes('provisionDevice')) return void res.end(JSON.stringify({ data: { provisionDevice: { id: 'd2', imei: body.variables.imei, model: body.variables.model, status: 'provisioned', departmentId: null, vehicleId: null } } }));
        if (q.includes('billing')) return void res.end(JSON.stringify({ data: { billing: { planId: 'free', planName: 'Free', limits: { devices: 25, users: 10 }, devicesUsed: 1, usersUsed: 1 } } }));
        if (q.includes('errorcase')) return void res.end(JSON.stringify({ errors: [{ message: 'boom' }] }));
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

test('login stores the token and later calls send it as a bearer', async () => {
  const c = new FleetClient({ baseUrl });
  await c.login('a@x.co', 'good');
  await c.me();
  const gqlReq = received.find((r) => r.path === '/graphql')!;
  assert.equal(gqlReq.auth, 'Bearer tok-123');
});

test('login failure throws FleetApiError', async () => {
  const c = new FleetClient({ baseUrl });
  await assert.rejects(() => c.login('a@x.co', 'bad'), FleetApiError);
});

test('typed queries return parsed data', async () => {
  const c = new FleetClient({ baseUrl, token: 't' });
  const me = await c.me();
  assert.equal(me.email, 'a@x.co');
  const devices = await c.devices();
  assert.equal(devices[0].imei, '860000000000001');
  const billing = await c.billing();
  assert.equal(billing.planId, 'free');
  assert.equal(billing.limits.devices, 25);
});

test('mutation sends variables and returns the created device', async () => {
  const c = new FleetClient({ baseUrl, token: 't' });
  const d = await c.provisionDevice('869000000000009', 'FTC927');
  assert.equal(d.imei, '869000000000009');
  assert.equal(d.status, 'provisioned');
  const mutReq = received.find((r) => r.body.query?.includes('provisionDevice'))!;
  assert.equal(mutReq.body.variables.model, 'FTC927');
});

test('GraphQL errors surface as FleetApiError', async () => {
  const c = new FleetClient({ baseUrl, token: 't' });
  await assert.rejects(
    () => (c as unknown as { gql: (q: string) => Promise<unknown> }).gql('{ errorcase }'),
    /boom/,
  );
});

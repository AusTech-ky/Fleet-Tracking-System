import 'reflect-metadata';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import { AppModule } from '../src/app.module';
import { applyHttpHardening } from '../src/hardening';
import { loadConfig } from '../src/config';

let app: INestApplication;
let base: string;

async function boot(throttleLimit: string): Promise<{ app: INestApplication; base: string }> {
  const config = loadConfig({ USE_IN_MEMORY: 'true', JWT_SECRET: 'test-secret', PORT: '0', THROTTLE_LIMIT: throttleLimit } as NodeJS.ProcessEnv);
  const a = await NestFactory.create(AppModule.forRoot(config), { logger: false });
  applyHttpHardening(a, { corsOrigins: [] });
  a.useWebSocketAdapter(new WsAdapter(a));
  await a.listen(0, '127.0.0.1');
  return { app: a, base: `http://127.0.0.1:${(a.getHttpServer().address() as AddressInfo).port}` };
}

before(async () => { ({ app, base } = await boot('1000000')); });
after(async () => { await app?.close(); });

test('helmet sets security headers and removes x-powered-by', async () => {
  const res = await fetch(`${base}/healthz`);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(res.headers.get('x-dns-prefetch-control') !== null);
  assert.equal(res.headers.get('x-powered-by'), null, 'express signature removed');
});

test('every response carries an x-request-id, echoing a provided one', async () => {
  const auto = await fetch(`${base}/healthz`);
  assert.ok(auto.headers.get('x-request-id'), 'auto-generated id present');
  const echoed = await fetch(`${base}/healthz`, { headers: { 'x-request-id': 'trace-abc' } });
  assert.equal(echoed.headers.get('x-request-id'), 'trace-abc');
});

test('OpenAPI spec is served at /openapi.json', async () => {
  const spec = await fetch(`${base}/openapi.json`).then((r) => r.json() as Promise<any>);
  assert.equal(spec.openapi?.startsWith('3.'), true);
  assert.equal(spec.info.title, 'FleetView API');
  const paths = Object.keys(spec.paths);
  assert.ok(paths.some((p) => p.includes('/auth/login')), 'documents auth routes');
  assert.ok(paths.some((p) => p.includes('/devices')), 'documents device routes');
});

test('errors use a consistent envelope with requestId + path', async () => {
  const res = await fetch(`${base}/devices`); // no auth
  assert.equal(res.status, 401);
  const body = await res.json() as any;
  assert.equal(body.statusCode, 401);
  assert.ok(body.error);
  assert.ok(body.message);
  assert.ok(body.requestId, 'requestId included');
  assert.equal(body.path, '/devices');
  assert.ok(body.timestamp);
});

test('rate limiting returns 429 once the per-IP limit is exceeded', async () => {
  const { app: limited, base: lbase } = await boot('5'); // 5 requests / window
  try {
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) codes.push((await fetch(`${lbase}/healthz`)).status);
    assert.equal(codes.slice(0, 5).every((c) => c === 200), true, 'first 5 allowed');
    assert.ok(codes.includes(429), `expected a 429 in ${codes.join(',')}`);
  } finally {
    await limited.close();
  }
});

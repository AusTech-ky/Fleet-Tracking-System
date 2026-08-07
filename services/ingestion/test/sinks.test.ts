import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WalSink, StreamBusSink, CompositeSink, type Sink, type StreamProducer } from '../src/sinks.ts';
import type { NormalizedTelemetry } from '../src/avl-map.ts';

function sample(imei: string, ts: string): NormalizedTelemetry {
  return {
    imei, ts, latitude: 19.3, longitude: -81.4, altitude: 0, heading: 0,
    speedKph: 0, satellites: 5, priority: 1, eventId: 0, fields: { ignition: 1 }, attrs: {},
  };
}

test('WalSink durably appends NDJSON and resolves only after write', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wal-'));
  try {
    const sink = new WalSink(dir, 'test.ndjson');
    await sink.write([sample('123', '2026-07-24T00:00:00.000Z')]);
    await sink.write([sample('123', '2026-07-24T00:00:01.000Z'), sample('123', '2026-07-24T00:00:02.000Z')]);
    await sink.close();
    const lines = readFileSync(join(dir, 'test.ndjson'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 3);
    assert.equal(JSON.parse(lines[0]).ts, '2026-07-24T00:00:00.000Z');
    assert.equal(JSON.parse(lines[2]).ts, '2026-07-24T00:00:02.000Z');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('WalSink write([]) is a no-op', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wal-'));
  try {
    const sink = new WalSink(dir, 'empty.ndjson');
    await sink.write([]);
    await sink.close();
    assert.equal(readFileSync(join(dir, 'empty.ndjson'), 'utf8'), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('StreamBusSink publishes one entry per record', async () => {
  const published: Record<string, string>[] = [];
  const producer: StreamProducer = { async append(_s, entries) { published.push(...entries); } };
  const sink = new StreamBusSink(producer);
  await sink.write([sample('123', 't1'), sample('123', 't2')]);
  assert.equal(published.length, 2);
  assert.equal(published[0].imei, '123');
});

test('CompositeSink resolves only when ALL sinks succeed', async () => {
  const calls: string[] = [];
  const ok: Sink = { async write() { calls.push('ok'); }, async close() {} };
  const comp = new CompositeSink([ok, ok]);
  await comp.write([sample('1', 't')]);
  assert.deepEqual(calls, ['ok', 'ok']);
});

test('CompositeSink rejects if any sink fails (so caller does NOT ack)', async () => {
  const ok: Sink = { async write() {}, async close() {} };
  const bad: Sink = { async write() { throw new Error('bus down'); }, async close() {} };
  const comp = new CompositeSink([ok, bad]);
  await assert.rejects(() => comp.write([sample('1', 't')]), /bus down/);
});

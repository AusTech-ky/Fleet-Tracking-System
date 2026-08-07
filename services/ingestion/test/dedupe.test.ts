import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryDeduper, RedisDeduper, dedupeKey, type RedisLike } from '../src/dedupe.ts';
import type { AvlRecord } from '@fleet/protocol-teltonika';

function rec(ms: number, lat = 0): AvlRecord {
  return {
    timestamp: new Date(ms),
    priority: 1,
    gps: { longitude: 0, latitude: lat, altitude: 0, angle: 0, satellites: 0, speed: 0 },
    io: { eventId: 0, values: { 239: 1 } },
  };
}

test('dedupeKey is stable for identical records and differs for distinct ones', () => {
  assert.equal(dedupeKey('123', rec(1000)), dedupeKey('123', rec(1000)));
  assert.notEqual(dedupeKey('123', rec(1000)), dedupeKey('123', rec(2000)));
  assert.notEqual(dedupeKey('123', rec(1000, 1)), dedupeKey('123', rec(1000, 2)));
  assert.notEqual(dedupeKey('123', rec(1000)), dedupeKey('456', rec(1000)));
});

test('InMemoryDeduper: first sighting new, repeat is duplicate', async () => {
  const d = new InMemoryDeduper(10_000);
  const k = dedupeKey('123', rec(1000));
  assert.equal(await d.checkAndSet(k), true);
  assert.equal(await d.checkAndSet(k), false);
});

test('InMemoryDeduper: entry expires after TTL', async () => {
  let clock = 0;
  const d = new InMemoryDeduper(1000, 1_000_000, () => clock);
  const k = dedupeKey('123', rec(1000));
  assert.equal(await d.checkAndSet(k), true);
  clock = 1001; // past TTL
  assert.equal(await d.checkAndSet(k), true); // treated as new again
});

test('InMemoryDeduper: bounded by maxEntries', async () => {
  const d = new InMemoryDeduper(10_000, 100);
  for (let i = 0; i < 500; i++) await d.checkAndSet(`k${i}`);
  // Should not have grown unbounded; oldest evicted. Newest still present.
  assert.equal(await d.checkAndSet('k499'), false);
});

test('RedisDeduper: NX semantics — OK = new, null = duplicate', async () => {
  const store = new Set<string>();
  const fake: RedisLike = {
    async set(key, _v, _nx, _ex, _ttl) {
      if (store.has(key)) return null;
      store.add(key);
      return 'OK';
    },
  };
  const d = new RedisDeduper(fake, 3600);
  assert.equal(await d.checkAndSet('abc'), true);
  assert.equal(await d.checkAndSet('abc'), false);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StaticAllowList, RedisAllowList, type RedisSetClient } from '../src/allowlist.ts';

test('StaticAllowList: empty set allows all (dev)', async () => {
  const a = new StaticAllowList(new Set());
  assert.equal(await a.isAllowed('123'), true);
});

test('StaticAllowList: non-empty set is an allow-list', async () => {
  const a = new StaticAllowList(new Set(['111']));
  assert.equal(await a.isAllowed('111'), true);
  assert.equal(await a.isAllowed('222'), false);
});

test('RedisAllowList: reflects Redis membership and caches lookups', async () => {
  let calls = 0;
  const members = new Set(['356307042441013']);
  const redis: RedisSetClient = {
    async sismember(_key, m) {
      calls++;
      return members.has(m) ? 1 : 0;
    },
  };
  let clock = 0;
  const a = new RedisAllowList(redis, 'ingest:allowed_imeis', 30_000, () => clock);

  assert.equal(await a.isAllowed('356307042441013'), true);
  assert.equal(await a.isAllowed('356307042441013'), true); // cached
  assert.equal(calls, 1, 'second lookup served from cache');

  assert.equal(await a.isAllowed('999'), false);
  assert.equal(calls, 2);

  // After TTL, cache expires and Redis is consulted again (revocation visible).
  members.delete('356307042441013');
  clock = 30_001;
  assert.equal(await a.isAllowed('356307042441013'), false);
  assert.equal(calls, 3);
});

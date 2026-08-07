import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PLANS, DEFAULT_PLAN, getPlan, isPlanId, wouldExceed } from '../src/billing/plans';

test('plan catalog is well-formed and default resolves', () => {
  assert.ok(isPlanId(DEFAULT_PLAN));
  assert.equal(getPlan('trial').limits.devices, 2);
  assert.ok(getPlan('pro').priceUsdMonthly > 0);
  for (const p of Object.values(PLANS)) {
    assert.ok(p.limits.devices > 0 && p.limits.users > 0);
  }
});

test('isPlanId guards unknown ids', () => {
  assert.equal(isPlanId('pro'), true);
  assert.equal(isPlanId('platinum'), false);
});

test('wouldExceed triggers exactly at the limit', () => {
  const trial = getPlan('trial'); // devices: 2
  assert.equal(wouldExceed(trial, { devices: 0, users: 0 }, 'devices'), false);
  assert.equal(wouldExceed(trial, { devices: 1, users: 0 }, 'devices'), false);
  assert.equal(wouldExceed(trial, { devices: 2, users: 0 }, 'devices'), true); // at limit → next add blocked
  assert.equal(wouldExceed(trial, { devices: 0, users: 1 }, 'users'), true); // trial users: 1
});

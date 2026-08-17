import { test } from 'node:test';
import assert from 'node:assert/strict';
import { motionState, INACTIVE_AFTER_SEC } from './motion.ts';
import type { Device, Position } from './types.ts';

const NOW = Date.parse('2026-08-17T22:00:00.000Z');
const device = (status: Device['status'] = 'active'): Device => ({
  id: 'd1', tenantId: 't1', imei: '868018077174095', name: 'Tesla', model: 'FTC927',
  status, vehicleId: null, departmentId: null, createdAt: '2026-08-01T00:00:00.000Z',
});
const pos = (over: Partial<Position>): Position => ({
  tenantId: 't1', deviceId: 'd1', imei: '868018077174095',
  ts: new Date(NOW - 30_000).toISOString(), // 30s ago: fresh
  latitude: 19.29, longitude: -81.38, altitude: 0, heading: 90,
  speedKph: 0, satellites: 9, ignition: null, attrs: {}, ...over,
});

test('moving: any speed > 0 is green, regardless of ignition', () => {
  assert.equal(motionState(device(), pos({ speedKph: 1 }), NOW), 'moving');
  assert.equal(motionState(device(), pos({ speedKph: 51, ignition: false }), NOW), 'moving');
});

test('stopped: speed 0 with ignition ON is yellow', () => {
  assert.equal(motionState(device(), pos({ speedKph: 0, ignition: true }), NOW), 'stopped');
});

test('parked: speed 0 with ignition OFF is red', () => {
  assert.equal(motionState(device(), pos({ speedKph: 0, ignition: false }), NOW), 'parked');
});

test('parked: speed 0 with UNKNOWN ignition is red, not yellow', () => {
  // We only call it "stopped" when we positively know the engine is running.
  assert.equal(motionState(device(), pos({ speedKph: 0, ignition: null }), NOW), 'parked');
});

test('inactive: no report at all is black', () => {
  assert.equal(motionState(device(), undefined, NOW), 'inactive');
});

test('inactive: report older than the threshold is black, even if it said moving', () => {
  const stale = new Date(NOW - (INACTIVE_AFTER_SEC + 1) * 1000).toISOString();
  assert.equal(motionState(device(), pos({ ts: stale, speedKph: 60 }), NOW), 'inactive');
});

test('inactive threshold is exact: one second inside is still live', () => {
  const edge = new Date(NOW - (INACTIVE_AFTER_SEC - 1) * 1000).toISOString();
  assert.equal(motionState(device(), pos({ ts: edge, speedKph: 60 }), NOW), 'moving');
});

test('inactive: a suspended or retired device is black whatever it last reported', () => {
  assert.equal(motionState(device('suspended'), pos({ speedKph: 60 }), NOW), 'inactive');
  assert.equal(motionState(device('retired'), pos({ speedKph: 60 }), NOW), 'inactive');
});

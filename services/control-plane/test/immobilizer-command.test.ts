import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSetDigout, assertSafeToImmobilize, ImmobilizeUnsafeError, ImmobilizerCommandError,
} from '../src/modules/devices/immobilizer-command';

const wiring = (over: Partial<{ dout: number; activeHigh: boolean; maxEngageKph: number }> = {}) =>
  ({ dout: 1, activeHigh: true, maxEngageKph: 5, ...over });

test('active-high wiring: immobilize drives the DOUT HIGH, mobilize drives it LOW', () => {
  assert.equal(buildSetDigout(true, wiring()), 'setdigout 1??? 0 ? ? ? 5 ? ? ?');
  assert.equal(buildSetDigout(false, wiring()), 'setdigout 0??? 0 ? ? ? 0 ? ? ?');
});

test('active-low wiring inverts the level — immobilize is LOW, mobilize is HIGH', () => {
  assert.equal(buildSetDigout(true, wiring({ activeHigh: false })), 'setdigout 0??? 0 ? ? ? 5 ? ? ?');
  assert.equal(buildSetDigout(false, wiring({ activeHigh: false })), 'setdigout 1??? 0 ? ? ? 0 ? ? ?');
});

test('only the configured DOUT is touched; others are left with ?', () => {
  assert.equal(buildSetDigout(true, wiring({ dout: 3 })), 'setdigout ??1? ? ? 0 ? ? ? 5 ?');
  assert.throws(() => buildSetDigout(true, wiring({ dout: 5 })), ImmobilizerCommandError);
  assert.throws(() => buildSetDigout(true, wiring({ dout: 0 })), ImmobilizerCommandError);
});

test('immobilize carries a non-zero speed threshold; mobilize carries 0 (never speed-gated)', () => {
  assert.match(buildSetDigout(true, wiring({ maxEngageKph: 8 })), / 8 \?/, 'engage gated at 8 km/h');
  // release must not be blocked by speed — a driver must always be able to regain the engine
  assert.match(buildSetDigout(false, wiring({ maxEngageKph: 8 })), / 0 \?/);
  // threshold clamped into 1..50
  assert.match(buildSetDigout(true, wiring({ maxEngageKph: 0 })), / 1 \?/);
  assert.match(buildSetDigout(true, wiring({ maxEngageKph: 999 })), / 50 \?/);
});

test('assertSafeToImmobilize refuses a moving vehicle, allows a stopped or unknown one', () => {
  assert.throws(() => assertSafeToImmobilize(42, 5), ImmobilizeUnsafeError);
  assert.throws(() => assertSafeToImmobilize(6, 5), ImmobilizeUnsafeError);
  assert.doesNotThrow(() => assertSafeToImmobilize(5, 5));   // at the threshold is allowed
  assert.doesNotThrow(() => assertSafeToImmobilize(0, 5));
  assert.doesNotThrow(() => assertSafeToImmobilize(null, 5)); // unknown speed — device threshold still guards
});

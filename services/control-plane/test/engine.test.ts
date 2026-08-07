import { test } from 'node:test';
import assert from 'node:assert/strict';
import { haversineMeters, pointInRing, pointInCircle } from '../src/engine/geometry';
import { geofenceContains } from '../src/engine/geofence';
import { AlertEngine } from '../src/engine/alerts';
import { TripDetector } from '../src/engine/trips';
import { DEFAULT_ALERT_CONFIG, type Geofence, type Position } from '../src/domain/entities';

function pos(over: Partial<Position> = {}): Position {
  return {
    tenantId: 't1', deviceId: 'd1', imei: '860000000000001', ts: '2026-07-24T10:00:00.000Z',
    latitude: 19.3, longitude: -81.38, altitude: 0, heading: 0, speedKph: 0, satellites: 8,
    ignition: true, attrs: {}, ...over,
  };
}
let n = 0;
const ids = () => `id${++n}`;

// ---- geometry --------------------------------------------------------------

test('haversine: ~1.11 km per 0.01° of latitude', () => {
  const d = haversineMeters(19.30, -81.38, 19.31, -81.38);
  assert.ok(Math.abs(d - 1112) < 15, `got ${d}`);
});

test('pointInRing: inside vs outside a square', () => {
  const square: [number, number][] = [[-81.4, 19.2], [-81.3, 19.2], [-81.3, 19.4], [-81.4, 19.4]];
  assert.equal(pointInRing(-81.35, 19.3, square), true);
  assert.equal(pointInRing(-81.5, 19.3, square), false);
});

test('pointInCircle: radius boundary', () => {
  assert.equal(pointInCircle(19.30, -81.38, 19.30, -81.38, 100), true);
  assert.equal(pointInCircle(19.32, -81.38, 19.30, -81.38, 100), false); // ~2.2km away
});

test('geofenceContains: circle and polygon', () => {
  const circle: Geofence = { id: 'g1', tenantId: 't1', name: 'Depot', kind: 'circle', centerLat: 19.3, centerLon: -81.38, radiusM: 500, createdAt: '' };
  assert.equal(geofenceContains(circle, 19.3, -81.38), true);
  assert.equal(geofenceContains(circle, 19.35, -81.38), false);
  const poly: Geofence = { id: 'g2', tenantId: 't1', name: 'Zone', kind: 'polygon', ring: [[-81.4, 19.2], [-81.3, 19.2], [-81.3, 19.4], [-81.4, 19.4]], createdAt: '' };
  assert.equal(geofenceContains(poly, 19.3, -81.35), true);
});

// ---- alerts ----------------------------------------------------------------

test('overspeed fires once per episode, not every packet', () => {
  const e = new AlertEngine(ids);
  const cfg = { ...DEFAULT_ALERT_CONFIG, overspeedKph: 90 };
  const a1 = e.evaluate(pos({ speedKph: 100 }), cfg, [], 1000);
  const a2 = e.evaluate(pos({ speedKph: 110 }), cfg, [], 2000); // still over → no new alert
  const a3 = e.evaluate(pos({ speedKph: 50 }), cfg, [], 3000); // back under
  const a4 = e.evaluate(pos({ speedKph: 120 }), cfg, [], 4000); // over again → new alert
  assert.equal(a1.filter((x) => x.type === 'overspeed').length, 1);
  assert.equal(a2.filter((x) => x.type === 'overspeed').length, 0);
  assert.equal(a4.filter((x) => x.type === 'overspeed').length, 1);
});

test('ignition change alerts on transition only', () => {
  const e = new AlertEngine(ids);
  const cfg = DEFAULT_ALERT_CONFIG;
  e.evaluate(pos({ ignition: true }), cfg, [], 1000); // first sighting: no alert
  const off = e.evaluate(pos({ ignition: false }), cfg, [], 2000);
  const same = e.evaluate(pos({ ignition: false }), cfg, [], 3000);
  assert.equal(off.filter((x) => x.type === 'ignition_off').length, 1);
  assert.equal(same.length, 0);
});

test('geofence enter then exit', () => {
  const e = new AlertEngine(ids);
  const fence: Geofence = { id: 'g1', tenantId: 't1', name: 'Depot', kind: 'circle', centerLat: 19.30, centerLon: -81.38, radiusM: 300, createdAt: '' };
  const cfg = DEFAULT_ALERT_CONFIG;
  const enter = e.evaluate(pos({ latitude: 19.30, longitude: -81.38 }), cfg, [fence], 1000);
  const stay = e.evaluate(pos({ latitude: 19.3005, longitude: -81.38 }), cfg, [fence], 2000);
  const exit = e.evaluate(pos({ latitude: 19.35, longitude: -81.38 }), cfg, [fence], 3000);
  assert.equal(enter.filter((x) => x.type === 'geofence_enter').length, 1);
  assert.equal(stay.length, 0);
  assert.equal(exit.filter((x) => x.type === 'geofence_exit').length, 1);
});

test('device offline sweep fires once after threshold, resets on new data', () => {
  const e = new AlertEngine(ids);
  const cfg = { ...DEFAULT_ALERT_CONFIG, offlineAfterSec: 60 };
  e.evaluate(pos(), cfg, [], 0);
  assert.equal(e.sweepOffline(30_000, cfg).length, 0); // within threshold
  const off = e.sweepOffline(61_000, cfg);
  assert.equal(off.length, 1);
  assert.equal(off[0].type, 'device_offline');
  assert.equal(e.sweepOffline(120_000, cfg).length, 0); // already alerted
  e.evaluate(pos({ ts: '2026-07-24T10:05:00.000Z' }), cfg, [], 130_000); // back online
  assert.equal(e.sweepOffline(140_000, cfg).length, 0); // within new threshold
});

// ---- trips -----------------------------------------------------------------

test('trip detection: movement then a long stop closes the trip', () => {
  const td = new TripDetector(ids, { moveSpeedKph: 5, stopSpeedKph: 3, stopMinSec: 120 });
  const base = Date.parse('2026-07-24T10:00:00.000Z');
  const at = (sec: number, lat: number, spd: number) =>
    pos({ ts: new Date(base + sec * 1000).toISOString(), latitude: lat, longitude: -81.38, speedKph: spd });

  assert.equal(td.update(at(0, 19.300, 0)), null); // idle
  assert.equal(td.update(at(30, 19.301, 40)), null); // trip starts
  assert.equal(td.update(at(60, 19.305, 50)), null); // moving
  assert.equal(td.update(at(90, 19.310, 0)), null); // stop begins
  const trip = td.update(at(220, 19.310, 0)); // stopped > 120s → trip ends
  assert.ok(trip, 'a trip should be emitted');
  assert.equal(trip!.startTs, new Date(base + 30_000).toISOString());
  assert.ok(trip!.distanceM > 500, `distance ${trip!.distanceM}`);
  assert.ok(trip!.maxSpeedKph >= 50);
});

test('trip detection: a brief stop does NOT end the trip', () => {
  const td = new TripDetector(ids, { moveSpeedKph: 5, stopSpeedKph: 3, stopMinSec: 120 });
  const base = Date.parse('2026-07-24T10:00:00.000Z');
  const at = (sec: number, spd: number) => pos({ ts: new Date(base + sec * 1000).toISOString(), speedKph: spd, latitude: 19.3 + sec * 0.0001 });
  td.update(at(0, 40)); // start
  td.update(at(30, 0)); // brief stop
  const resume = td.update(at(60, 45)); // resumes before stopMinSec
  const cont = td.update(at(90, 50));
  assert.equal(resume, null);
  assert.equal(cont, null);
});

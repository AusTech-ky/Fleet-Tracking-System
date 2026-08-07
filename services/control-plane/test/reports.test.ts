import { test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {
  tripsReport, speedingReport, geofenceActivityReport, deviceSummaryReport, fleetSummaryReport, deviceStats,
} from '../src/engine/reports';
import { toCsv, toXlsx, toPdf } from '../src/reports/exporters';
import type { Trip, AlertEvent } from '../src/domain/entities';

const trip = (over: Partial<Trip> = {}): Trip => ({
  id: 't', tenantId: 'T', deviceId: 'D', startTs: '2026-07-24T10:00:00.000Z',
  endTs: '2026-07-24T10:20:00.000Z', distanceM: 12000, maxSpeedKph: 72, points: 40, ...over,
});
const alert = (type: AlertEvent['type'], meta: AlertEvent['meta'] = {}, ts = '2026-07-24T10:05:00.000Z'): AlertEvent => ({
  id: 'a', tenantId: 'T', deviceId: 'D', imei: '860000000000001', type, ts, message: `${type}`, meta,
});
const NOW = '2026-07-25T00:00:00.000Z';
const FROM = '2026-07-24T00:00:00.000Z';
const TO = '2026-07-25T00:00:00.000Z';

test('deviceStats aggregates distance, drive time, overspeed, score', () => {
  const s = deviceStats([trip(), trip({ distanceM: 8000, maxSpeedKph: 90 })], [alert('overspeed'), alert('overspeed')]);
  assert.equal(s.distanceKm, 20); // 12000 + 8000 m
  assert.equal(s.tripCount, 2);
  assert.equal(s.driveMinutes, 40); // 20 + 20
  assert.equal(s.maxSpeedKph, 90);
  assert.equal(s.overspeedCount, 2);
  assert.equal(s.score, 94); // 100 - 2*3
});

test('tripsReport: rows + summary', () => {
  const r = tripsReport([trip(), trip({ distanceM: 3000 })], FROM, TO, NOW);
  assert.equal(r.title, 'Trips');
  assert.equal(r.rows.length, 2);
  assert.equal(r.rows[0].distanceKm, 12);
  assert.equal(r.rows[0].durationMin, 20);
  assert.equal(r.summary.trips, 2);
  assert.equal(r.summary.totalDistanceKm, 15);
  assert.equal(r.summary.totalDriveTime, '0h 40m');
});

test('speedingReport: only overspeed alerts', () => {
  const r = speedingReport([alert('overspeed', { speedKph: 110, limitKph: 90 }), alert('ignition_on')], FROM, TO, NOW);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].speedKph, 110);
  assert.equal(r.summary.events, 1);
  assert.equal(r.summary.maxSpeedKph, 110);
});

test('geofenceActivityReport: enters and exits', () => {
  const r = geofenceActivityReport([alert('geofence_enter'), alert('geofence_exit'), alert('overspeed')], FROM, TO, NOW);
  assert.equal(r.rows.length, 2);
  assert.equal(r.summary.entries, 1);
  assert.equal(r.summary.exits, 1);
});

test('deviceSummaryReport: metric/value rows', () => {
  const r = deviceSummaryReport([trip()], [alert('overspeed')], FROM, TO, NOW);
  const byMetric = Object.fromEntries(r.rows.map((row) => [row.metric, row.value]));
  assert.equal(byMetric['Distance (km)'], 12);
  assert.equal(byMetric['Overspeed events'], 1);
  assert.equal(byMetric['Safety score'], '97/100');
});

test('fleetSummaryReport: one row per device + totals', () => {
  const r = fleetSummaryReport(
    [
      { label: 'FTC927 111', trips: [trip()], alerts: [alert('overspeed')] },
      { label: 'FTC927 222', trips: [trip({ distanceM: 5000 })], alerts: [] },
    ],
    FROM, TO, NOW,
  );
  assert.equal(r.rows.length, 2);
  assert.equal(r.summary.devices, 2);
  assert.equal(r.summary.totalDistanceKm, 17); // 12 + 5
  assert.equal(r.summary.totalOverspeed, 1);
});

// ---- exporters -------------------------------------------------------------

test('toCsv: header, rows, and summary block, with RFC-4180 escaping', () => {
  const r = tripsReport([trip()], FROM, TO, NOW);
  const csv = toCsv(r);
  const lines = csv.split('\n');
  assert.equal(lines[0], 'Start,End,Duration (min),Distance (km),Max speed (km/h)');
  assert.ok(lines[1].includes('12')); // distance km
  assert.ok(csv.includes('trips,1'));
  // escaping
  const escaped = toCsv({ ...r, rows: [{ start: 'a,b', end: '"q"', durationMin: 1, distanceKm: 1, maxSpeedKph: 1 }] });
  assert.ok(escaped.includes('"a,b"'));
  assert.ok(escaped.includes('""q""'));
});

test('toXlsx: produces a real workbook that parses back', async () => {
  const r = tripsReport([trip(), trip({ distanceM: 3000 })], FROM, TO, NOW);
  const buf = await toXlsx(r);
  assert.ok(buf.length > 0);
  assert.equal(buf.subarray(0, 2).toString('latin1'), 'PK'); // xlsx = zip
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ExcelJS.Buffer);
  const ws = wb.getWorksheet(1)!;
  assert.equal(ws.getCell('A1').value, 'Trips');
  // header row is row 4 (title, range, blank, header)
  assert.equal(ws.getRow(4).getCell(1).value, 'Start');
});

test('toPdf: produces a valid PDF', async () => {
  const r = deviceSummaryReport([trip()], [alert('overspeed')], FROM, TO, NOW);
  const buf = await toPdf(r);
  assert.ok(buf.length > 0);
  assert.equal(buf.subarray(0, 5).toString('latin1'), '%PDF-');
});

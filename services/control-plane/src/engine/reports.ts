import type { Trip, AlertEvent } from '../domain/entities';

/**
 * Reporting engine — pure aggregation of stored trips/alerts into a generic
 * tabular Report. Keeping every report the same shape (columns + rows +
 * summary) lets one set of exporters (CSV/Excel/PDF) serve them all. Framework-
 * and DB-free, so it's directly unit-testable.
 */
export interface ReportColumn {
  key: string;
  label: string;
}
export interface Report {
  title: string;
  generatedAt: string;
  range: { from: string; to: string };
  columns: ReportColumn[];
  rows: Record<string, string | number>[];
  summary: Record<string, string | number>;
}

const km = (m: number) => Math.round(m / 100) / 10; // metres -> km, 1 decimal
const minutes = (fromTs: string, toTs: string) =>
  Math.round((Date.parse(toTs) - Date.parse(fromTs)) / 60000);
const hm = (min: number) => `${Math.floor(min / 60)}h ${min % 60}m`;
const time = (ts: string) => ts.replace('T', ' ').replace(/\..*/, ' UTC');

export interface DeviceStats {
  distanceKm: number;
  tripCount: number;
  driveMinutes: number;
  maxSpeedKph: number;
  overspeedCount: number;
  geofenceEvents: number;
  /** illustrative 0–100 safety score (penalises overspeed events) */
  score: number;
}

export function deviceStats(trips: Trip[], alerts: AlertEvent[]): DeviceStats {
  const distanceKm = km(trips.reduce((s, t) => s + t.distanceM, 0));
  const driveMinutes = trips.reduce((s, t) => s + minutes(t.startTs, t.endTs), 0);
  const maxSpeedKph = trips.reduce((m, t) => Math.max(m, t.maxSpeedKph), 0);
  const overspeedCount = alerts.filter((a) => a.type === 'overspeed').length;
  const geofenceEvents = alerts.filter((a) => a.type === 'geofence_enter' || a.type === 'geofence_exit').length;
  const score = Math.max(0, 100 - overspeedCount * 3);
  return { distanceKm, tripCount: trips.length, driveMinutes, maxSpeedKph, overspeedCount, geofenceEvents, score };
}

const meta = (title: string, from: string, to: string, generatedAt: string) =>
  ({ title, generatedAt, range: { from, to } });

export function tripsReport(trips: Trip[], from: string, to: string, generatedAt: string): Report {
  return {
    ...meta('Trips', from, to, generatedAt),
    columns: [
      { key: 'start', label: 'Start' },
      { key: 'end', label: 'End' },
      { key: 'durationMin', label: 'Duration (min)' },
      { key: 'distanceKm', label: 'Distance (km)' },
      { key: 'maxSpeedKph', label: 'Max speed (km/h)' },
    ],
    rows: trips.map((t) => ({
      start: time(t.startTs),
      end: time(t.endTs),
      durationMin: minutes(t.startTs, t.endTs),
      distanceKm: km(t.distanceM),
      maxSpeedKph: t.maxSpeedKph,
    })),
    summary: {
      trips: trips.length,
      totalDistanceKm: km(trips.reduce((s, t) => s + t.distanceM, 0)),
      totalDriveTime: hm(trips.reduce((s, t) => s + minutes(t.startTs, t.endTs), 0)),
    },
  };
}

export function speedingReport(alerts: AlertEvent[], from: string, to: string, generatedAt: string): Report {
  const over = alerts.filter((a) => a.type === 'overspeed');
  return {
    ...meta('Speeding events', from, to, generatedAt),
    columns: [
      { key: 'time', label: 'Time' },
      { key: 'speedKph', label: 'Speed (km/h)' },
      { key: 'limitKph', label: 'Limit (km/h)' },
    ],
    rows: over.map((a) => ({
      time: time(a.ts),
      speedKph: Number(a.meta.speedKph ?? 0),
      limitKph: Number(a.meta.limitKph ?? 0),
    })),
    summary: {
      events: over.length,
      maxSpeedKph: over.reduce((m, a) => Math.max(m, Number(a.meta.speedKph ?? 0)), 0),
    },
  };
}

export function geofenceActivityReport(alerts: AlertEvent[], from: string, to: string, generatedAt: string): Report {
  const geo = alerts.filter((a) => a.type === 'geofence_enter' || a.type === 'geofence_exit');
  return {
    ...meta('Geofence activity', from, to, generatedAt),
    columns: [
      { key: 'time', label: 'Time' },
      { key: 'event', label: 'Event' },
      { key: 'detail', label: 'Detail' },
    ],
    rows: geo.map((a) => ({
      time: time(a.ts),
      event: a.type === 'geofence_enter' ? 'Enter' : 'Exit',
      detail: a.message,
    })),
    summary: {
      entries: geo.filter((a) => a.type === 'geofence_enter').length,
      exits: geo.filter((a) => a.type === 'geofence_exit').length,
    },
  };
}

/** Per-device scorecard as a metric/value table. */
export function deviceSummaryReport(
  trips: Trip[], alerts: AlertEvent[], from: string, to: string, generatedAt: string,
): Report {
  const s = deviceStats(trips, alerts);
  const metric = (name: string, value: string | number) => ({ metric: name, value });
  return {
    ...meta('Device summary', from, to, generatedAt),
    columns: [
      { key: 'metric', label: 'Metric' },
      { key: 'value', label: 'Value' },
    ],
    rows: [
      metric('Distance (km)', s.distanceKm),
      metric('Trips', s.tripCount),
      metric('Drive time', hm(s.driveMinutes)),
      metric('Max speed (km/h)', s.maxSpeedKph),
      metric('Overspeed events', s.overspeedCount),
      metric('Geofence events', s.geofenceEvents),
      metric('Safety score', `${s.score}/100`),
    ],
    summary: { safetyScore: s.score, distanceKm: s.distanceKm, overspeedEvents: s.overspeedCount },
  };
}

/** Fleet roll-up: one row per device. */
export function fleetSummaryReport(
  perDevice: { label: string; trips: Trip[]; alerts: AlertEvent[] }[],
  from: string, to: string, generatedAt: string,
): Report {
  const rows = perDevice.map(({ label, trips, alerts }) => {
    const s = deviceStats(trips, alerts);
    return { device: label, distanceKm: s.distanceKm, trips: s.tripCount, overspeed: s.overspeedCount, score: s.score };
  });
  return {
    ...meta('Fleet summary', from, to, generatedAt),
    columns: [
      { key: 'device', label: 'Device' },
      { key: 'distanceKm', label: 'Distance (km)' },
      { key: 'trips', label: 'Trips' },
      { key: 'overspeed', label: 'Overspeed' },
      { key: 'score', label: 'Score' },
    ],
    rows,
    summary: {
      devices: rows.length,
      totalDistanceKm: Math.round(rows.reduce((s, r) => s + r.distanceKm, 0) * 10) / 10,
      totalOverspeed: rows.reduce((s, r) => s + r.overspeed, 0),
    },
  };
}

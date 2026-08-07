/** Small display formatters shared by the device list and detail panel. */

/** "just now" / "42s ago" / "5m ago" / "2h ago" / "3d ago" */
export function relativeTime(iso: string, now = Date.now()): string {
  const sec = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (sec < 5) return 'just now';
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

/** A device is "stale" if we haven't heard from it recently. */
export function isStale(iso: string, thresholdSec = 120, now = Date.now()): boolean {
  return (now - Date.parse(iso)) / 1000 > thresholdSec;
}

/** 19.31331, -81.38334 */
export function formatCoords(lat: number, lon: number): string {
  return `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
}

/** Compass point from a heading in degrees. */
export function compass(deg: number): string {
  const points = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return points[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
}

/** Volts from millivolts, 1dp — e.g. 12300 → "12.3 V" */
export function millivoltsToVolts(mv: number): string {
  return `${(mv / 1000).toFixed(1)} V`;
}

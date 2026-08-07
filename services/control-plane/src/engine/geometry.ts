/**
 * Pure geospatial primitives. Framework- and DB-free so they are trivially
 * unit-testable and reusable. Coordinates follow GeoJSON order: [lon, lat].
 *
 * At fleet-geofence scale (a town, a depot, a route corridor) a planar
 * ray-cast on lon/lat is accurate enough; the production PostGIS path uses
 * true spherical `ST_Contains`/`ST_DWithin` (see pg.repository / migration).
 * Distances use the haversine formula (spherical earth) — good to ~0.5%.
 */

const EARTH_RADIUS_M = 6_371_000;
const toRad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance between two lat/lon points, in metres. */
export function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Point-in-polygon via ray casting. `ring` is a closed or open GeoJSON ring of
 * [lon, lat] pairs. Returns true if [lon, lat] is inside.
 */
export function pointInRing(lon: number, lat: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersects = yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/** True if the point is within `radiusM` metres of the circle centre. */
export function pointInCircle(
  lat: number,
  lon: number,
  centerLat: number,
  centerLon: number,
  radiusM: number,
): boolean {
  return haversineMeters(lat, lon, centerLat, centerLon) <= radiusM;
}

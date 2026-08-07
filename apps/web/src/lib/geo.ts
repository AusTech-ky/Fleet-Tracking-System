/** Great-circle distance between two [lat,lon] points, in metres. */
export function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6_371_000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Approximate a geographic circle (center + radius in metres) as a polygon ring
 *  of [lon,lat] points, for drawing geofence circles on the map. */
export function circleToPolygon(
  centerLon: number,
  centerLat: number,
  radiusM: number,
  steps = 64,
): [number, number][] {
  const coords: [number, number][] = [];
  const latRad = (centerLat * Math.PI) / 180;
  const dLat = (radiusM / 111_320) ; // metres per degree latitude
  const dLon = radiusM / (111_320 * Math.cos(latRad));
  for (let i = 0; i <= steps; i++) {
    const theta = (i / steps) * 2 * Math.PI;
    coords.push([centerLon + dLon * Math.cos(theta), centerLat + dLat * Math.sin(theta)]);
  }
  return coords;
}

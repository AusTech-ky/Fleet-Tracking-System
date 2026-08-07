import type { Geofence, Position } from '../domain/entities';
import { pointInCircle, pointInRing } from './geometry';

/** True if a position lies inside a geofence (circle or polygon). */
export function geofenceContains(g: Geofence, lat: number, lon: number): boolean {
  if (g.kind === 'circle') return pointInCircle(lat, lon, g.centerLat, g.centerLon, g.radiusM);
  return pointInRing(lon, lat, g.ring);
}

/** IDs of all geofences that contain the given position. */
export function geofencesContaining(geofences: Geofence[], p: Position): Set<string> {
  const inside = new Set<string>();
  for (const g of geofences) if (geofenceContains(g, p.latitude, p.longitude)) inside.add(g.id);
  return inside;
}

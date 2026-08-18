import type { StyleSpecification } from 'maplibre-gl';

/**
 * Basemap layers. All are raster tile sources requiring no API key, so switching
 * is done by toggling layer visibility rather than swapping the whole style —
 * which keeps our custom sources/layers (geofences, routes, playback, markers)
 * intact across a switch.
 *
 * Providers (attribution is mandatory and wired into each source):
 *  - Streets:   OpenStreetMap raster
 *  - Satellite: Esri World Imagery
 *  - Hybrid:    Esri World Imagery + Esri boundaries/places reference overlay
 *  - Terrain:   Esri World Topo
 */
export type BasemapId = 'streets' | 'satellite' | 'hybrid' | 'terrain';

export const BASEMAPS: { id: BasemapId; label: string }[] = [
  { id: 'streets', label: 'Streets' },
  { id: 'satellite', label: 'Satellite' },
  { id: 'hybrid', label: 'Hybrid' },
  { id: 'terrain', label: 'Terrain' },
];

const OSM_ATTR = '© OpenStreetMap contributors';
const ESRI_ATTR = 'Powered by Esri — Esri, Maxar, Earthstar Geographics';
const esri = (service: string) =>
  `https://server.arcgisonline.com/ArcGIS/rest/services/${service}/MapServer/tile/{z}/{y}/{x}`;

/** All basemap raster layer ids, in draw order (bottom of the stack). */
export const BASEMAP_LAYER_IDS = ['bm-osm', 'bm-topo', 'bm-sat', 'bm-ref'] as const;

/** Which layer ids are visible for each basemap option. */
export const BASEMAP_VISIBLE: Record<BasemapId, string[]> = {
  streets: ['bm-osm'],
  satellite: ['bm-sat'],
  hybrid: ['bm-sat', 'bm-ref'],
  terrain: ['bm-topo'],
};

/** Build the initial map style with every basemap present; only `active` shown. */
export function buildBaseStyle(active: BasemapId): StyleSpecification {
  const visible = new Set(BASEMAP_VISIBLE[active]);
  const vis = (id: string) => ({ visibility: (visible.has(id) ? 'visible' : 'none') as 'visible' | 'none' });
  return {
    version: 8,
    sources: {
      'src-osm': { type: 'raster', tiles: ['a', 'b', 'c'].map((s) => `https://${s}.tile.openstreetmap.org/{z}/{x}/{y}.png`), tileSize: 256, maxzoom: 19, attribution: OSM_ATTR },
      // Esri World Imagery only has real tiles to z18 over the Cayman Islands
      // (z19+ returns an identical "map data not available" placeholder). Capping
      // the source maxzoom at 18 makes MapLibre OVERZOOM — upscale the z18 tile —
      // for deeper zoom, so imagery stays continuous (slightly soft) instead of
      // going blank. The map itself can still zoom past 18. Verified 2026-08-18.
      'src-sat': { type: 'raster', tiles: [esri('World_Imagery')], tileSize: 256, maxzoom: 18, attribution: ESRI_ATTR },
      'src-topo': { type: 'raster', tiles: [esri('World_Topo_Map')], tileSize: 256, maxzoom: 19, attribution: ESRI_ATTR },
      // Same reason: the hybrid label overlay's deep tiles are blank here too.
      'src-ref': { type: 'raster', tiles: [esri('Reference/World_Boundaries_and_Places')], tileSize: 256, maxzoom: 18, attribution: ESRI_ATTR },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#0b1220' } },
      { id: 'bm-osm', type: 'raster', source: 'src-osm', layout: vis('bm-osm') },
      { id: 'bm-topo', type: 'raster', source: 'src-topo', layout: vis('bm-topo') },
      { id: 'bm-sat', type: 'raster', source: 'src-sat', layout: vis('bm-sat') },
      { id: 'bm-ref', type: 'raster', source: 'src-ref', layout: vis('bm-ref') },
    ],
  };
}

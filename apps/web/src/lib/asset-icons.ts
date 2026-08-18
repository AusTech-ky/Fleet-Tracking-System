/**
 * Asset-type icons — one glyph per category, as SVG path data on a 24×24
 * viewBox. Kept as plain strings (not React components) so the same glyph is
 * used by the React picker AND by the map's raw-DOM markers, and it can be
 * embedded in innerHTML without a renderer.
 *
 * Every glyph is drawn to read at 20px on a coloured disc: solid silhouettes,
 * no fine strokes.
 */
export type AssetType = 'car' | 'motorcycle' | 'bus' | 'truck' | 'boat' | 'trailer' | 'equipment' | 'other';

export const ASSET_TYPES: AssetType[] = ['car', 'motorcycle', 'bus', 'truck', 'boat', 'trailer', 'equipment', 'other'];

export const ASSET_LABEL: Record<AssetType, string> = {
  car: 'Car', motorcycle: 'Motorcycle', bus: 'Bus', truck: 'Truck',
  boat: 'Boat', trailer: 'Trailer', equipment: 'Equipment', other: 'Other',
};

/** SVG path `d` per type, 24×24, fill-only. */
export const ASSET_PATH: Record<AssetType, string> = {
  // sedan silhouette, side-on
  car: 'M5 11l1.5-4.5A2 2 0 0 1 8.4 5h7.2a2 2 0 0 1 1.9 1.5L19 11h1a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-1a2 2 0 1 1-4 0H9a2 2 0 1 1-4 0H4a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h1zm2.1 0h9.8l-1-3H8.1l-1 3z',
  // motorbike: two wheels, frame, rider-less
  motorcycle: 'M5 13a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm14 0a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM5 15.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zm14 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zM8 8h3l2 4h4l-1.5-3H17V7h-2.5l-.5-1H12l1 2h-2L9 6H7v2z',
  // bus: tall body, windows, wheels
  bus: 'M5 4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h1a2 2 0 1 0 4 0h6a2 2 0 1 0 4 0h1a1 1 0 0 0 1-1V6a2 2 0 0 0-2-2H5zm0 3h14v5H5V7zm1 7a1 1 0 1 1 0 2 1 1 0 0 1 0-2zm12 0a1 1 0 1 1 0 2 1 1 0 0 1 0-2z',
  // truck: cab + box
  truck: 'M2 6a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v3h3l3 3v4a1 1 0 0 1-1 1h-1a2 2 0 1 1-4 0H8a2 2 0 1 1-4 0H3a1 1 0 0 1-1-1V6zm12 5h5.2l-1.7-2H14v2zM6 16.5a1 1 0 1 0 0 2 1 1 0 0 0 0-2zm10 0a1 1 0 1 0 0 2 1 1 0 0 0 0-2z',
  // boat: hull + sail
  boat: 'M12 3l6 8h-5V3h-1zm-1 1v7H6l5-7zM3 14h18l-2 4H5l-2-4zm1 6h16v1.5H4V20z',
  // trailer: box on wheels with tongue
  trailer: 'M2 12h1V7a1 1 0 0 1 1-1h13a1 1 0 0 1 1 1v6h4v2h-4v1a2 2 0 1 1-4 0H9a2 2 0 1 1-4 0H3v-2H2v-2zm4 5a1 1 0 1 0 0 2 1 1 0 0 0 0-2zm7 0a1 1 0 1 0 0 2 1 1 0 0 0 0-2z',
  // equipment: tractor / mower silhouette
  equipment: 'M4 15a4 4 0 1 0 8 0 4 4 0 0 0-8 0zm2 0a2 2 0 1 1 4 0 2 2 0 0 1-4 0zm10 2a2.5 2.5 0 1 0 5 0 2.5 2.5 0 0 0-5 0zM7 5h4l2 5h3V7h2v3h1.5a1 1 0 0 1 1 1v3h-2.6a3.5 3.5 0 0 0-4.8 2H12.9A5 5 0 0 0 4 12.1V7h3V5z',
  // other: crossed wrench + hammer
  other: 'M14.7 3.3a4.5 4.5 0 0 0-5.1 6.4L3 16.3V21h4.7l6.6-6.6a4.5 4.5 0 0 0 6.4-5.1l-2.6 2.6-2.4-.6-.6-2.4 2.6-2.6zM6.5 19.5H5v-1.5l5.6-5.6 1.5 1.5-5.6 5.6z',
};

/** Standalone SVG string for raw-DOM use (map markers). `fill` defaults to white. */
export function assetSvg(type: AssetType, size = 14, fill = '#fff'): string {
  const d = ASSET_PATH[type] ?? ASSET_PATH.other;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true"><path d="${d}" fill="${fill}"/></svg>`;
}

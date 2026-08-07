/** Client config. NEXT_PUBLIC_* are inlined at build time. */
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';

/** WS base derived from the API URL (http->ws, https->wss). */
export const WS_URL =
  process.env.NEXT_PUBLIC_WS_URL ?? API_URL.replace(/^http/, 'ws');

/**
 * Default basemap shown on first load. Users switch between Streets / Satellite
 * / Hybrid / Terrain from the on-map control (see lib/basemaps.ts). Providers
 * are swappable without touching map code (ARCHITECTURE §3).
 */
export const DEFAULT_BASEMAP = (process.env.NEXT_PUBLIC_DEFAULT_BASEMAP ?? 'streets') as
  | 'streets' | 'satellite' | 'hybrid' | 'terrain';

/** Default map center — George Town, Cayman Islands. */
export const DEFAULT_CENTER: [number, number] = [-81.3833, 19.3133];
export const DEFAULT_ZOOM = 11;

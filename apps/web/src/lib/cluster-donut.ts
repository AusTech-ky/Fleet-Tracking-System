import { MOTION_HEX, type MotionState } from './motion.ts';

/**
 * Builds the SVG for a cluster donut: a ring whose arcs are proportional to
 * how many vehicles in the cluster are in each motion state, with the total
 * count in the middle. Pure function — the map wraps the string in a DOM
 * element; tests can assert on the geometry.
 */

export const STATE_ORDER: MotionState[] = ['moving', 'stopped', 'parked', 'inactive'];

export interface DonutCounts { moving: number; stopped: number; parked: number; inactive: number }

/** Radius scales gently with count so a 46-vehicle cluster reads bigger than a 3. */
export function donutRadius(total: number): number {
  if (total >= 100) return 30;
  if (total >= 25) return 26;
  if (total >= 10) return 23;
  return 20;
}

/** Point on a circle, 0° at 12 o'clock, clockwise. */
function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const rad = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

/** SVG arc path from startDeg to endDeg (clockwise). Full circles are drawn as two halves. */
function arcPath(cx: number, cy: number, r: number, startDeg: number, endDeg: number): string {
  const sweep = endDeg - startDeg;
  if (sweep >= 360) {
    const [ax, ay] = polar(cx, cy, r, 0), [bx, by] = polar(cx, cy, r, 180);
    return `M ${ax} ${ay} A ${r} ${r} 0 1 1 ${bx} ${by} A ${r} ${r} 0 1 1 ${ax} ${ay}`;
  }
  const [sx, sy] = polar(cx, cy, r, startDeg), [ex, ey] = polar(cx, cy, r, endDeg);
  return `M ${sx} ${sy} A ${r} ${r} 0 ${sweep > 180 ? 1 : 0} 1 ${ex} ${ey}`;
}

/** Segments in drawing order: [state, startDeg, endDeg], skipping zero-count states. */
export function donutSegments(counts: DonutCounts): Array<[MotionState, number, number]> {
  const total = STATE_ORDER.reduce((s, k) => s + counts[k], 0);
  if (total === 0) return [];
  const out: Array<[MotionState, number, number]> = [];
  let acc = 0;
  for (const k of STATE_ORDER) {
    if (counts[k] === 0) continue;
    const start = (acc / total) * 360;
    acc += counts[k];
    out.push([k, start, (acc / total) * 360]);
  }
  return out;
}

export function donutSvg(counts: DonutCounts): { svg: string; size: number; total: number } {
  const total = STATE_ORDER.reduce((s, k) => s + counts[k], 0);
  const r = donutRadius(total);
  const stroke = 6;
  const size = (r + stroke) * 2;
  const c = size / 2;
  const ringR = r - stroke / 2;
  const segs = donutSegments(counts);

  const arcs = segs
    .map(([k, a, b]) => `<path d="${arcPath(c, c, ringR, a, b)}" stroke="${MOTION_HEX[k]}" stroke-width="${stroke}" fill="none"/>`)
    .join('');
  const fontSize = total >= 100 ? 15 : total >= 10 ? 16 : 17;

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true">` +
    // white halo so the ring reads on satellite imagery
    `<circle cx="${c}" cy="${c}" r="${r + 1}" fill="none" stroke="rgba(255,255,255,0.9)" stroke-width="2"/>` +
    // dark disc behind the number
    `<circle cx="${c}" cy="${c}" r="${r - stroke}" fill="#111827"/>` +
    arcs +
    `<text x="${c}" y="${c}" text-anchor="middle" dominant-baseline="central" font-family="system-ui, sans-serif" font-size="${fontSize}" font-weight="700" fill="#fff">${total}</text>` +
    `</svg>`;
  return { svg, size, total };
}

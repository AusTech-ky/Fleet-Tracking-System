import { test } from 'node:test';
import assert from 'node:assert/strict';
import { donutSegments, donutSvg, donutRadius } from './cluster-donut.ts';

test('segments are proportional, ordered moving→stopped→parked→inactive, and skip empty states', () => {
  const segs = donutSegments({ moving: 1, stopped: 0, parked: 1, inactive: 2 });
  assert.deepEqual(segs.map(([k]) => k), ['moving', 'parked', 'inactive'], 'zero-count "stopped" is skipped');
  // 4 vehicles → 90° each. moving 0-90, parked 90-180, inactive 180-360.
  assert.deepEqual(segs.map(([, a, b]) => [Math.round(a), Math.round(b)]), [[0, 90], [90, 180], [180, 360]]);
});

test('a single-state cluster is a full ring (drawn as two half-arcs, the SVG full-circle pitfall)', () => {
  const { svg } = donutSvg({ moving: 0, stopped: 0, parked: 3, inactive: 0 });
  // one path, containing two arc commands (A ... A ...) — a single 360° arc collapses to nothing in SVG
  const paths = svg.match(/<path /g) ?? [];
  assert.equal(paths.length, 1);
  const arcCmds = (svg.match(/ A /g) ?? []).length;
  assert.equal(arcCmds, 2, 'full circle must be two arcs');
});

test('empty cluster produces no arcs but still renders (count 0)', () => {
  const { svg, total } = donutSvg({ moving: 0, stopped: 0, parked: 0, inactive: 0 });
  assert.equal(total, 0);
  assert.equal((svg.match(/<path /g) ?? []).length, 0);
  assert.match(svg, />0<\/text>/);
});

test('count is rendered in the middle and radius grows with size', () => {
  assert.match(donutSvg({ moving: 4, stopped: 1, parked: 1, inactive: 1 }).svg, />7<\/text>/);
  assert.ok(donutRadius(3) < donutRadius(12));
  assert.ok(donutRadius(12) < donutRadius(46));
  assert.ok(donutRadius(46) < donutRadius(150));
});

test('svg is self-contained and sized to its radius', () => {
  const { svg, size } = donutSvg({ moving: 2, stopped: 2, parked: 0, inactive: 0 });
  assert.match(svg, new RegExp(`width="${size}" height="${size}"`));
  assert.ok(svg.startsWith('<svg') && svg.endsWith('</svg>'));
});

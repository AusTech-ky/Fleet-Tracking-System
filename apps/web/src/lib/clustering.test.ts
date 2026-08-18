import { test } from 'node:test';
import assert from 'node:assert/strict';
// supercluster is the engine MapLibre uses for GeoJSON `cluster: true`; driving
// it directly with the SAME options + clusterProperties MapView passes proves
// the clustering behaviour without a WebGL renderer.
// @ts-expect-error — deep import; the package has no exports map for ESM consumers
import Supercluster from '../../node_modules/supercluster/index.js';
import { donutSvg, donutSegments } from './cluster-donut.ts';

type State = 'moving' | 'stopped' | 'parked' | 'inactive';
const oneHot = (s: State) => ({ moving: +(s === 'moving'), stopped: +(s === 'stopped'), parked: +(s === 'parked'), inactive: +(s === 'inactive') });

// The same scatter used for manual testing: an 8-vehicle downtown knot within
// ~150m, a 6-vehicle ring 1.3km out, four far outliers across the island.
function fleet() {
  const f: any[] = [];
  const push = (name: string, lat: number, lon: number, st: State) =>
    f.push({ type: 'Feature', properties: { deviceId: name, name, state: st, ...oneHot(st) }, geometry: { type: 'Point', coordinates: [lon, lat] } });
  for (let i = 0; i < 8; i++) push(`Downtown ${i + 1}`, 19.2946 + (i % 3) * 0.0005, -81.3811 + Math.floor(i / 3) * 0.0006, (['moving', 'stopped', 'parked', 'inactive'] as State[])[i % 4]);
  for (let i = 0; i < 6; i++) { const a = (i / 6) * 2 * Math.PI; push(`Ring ${i + 1}`, 19.2946 + 0.012 * Math.cos(a), -81.3811 + 0.012 * Math.sin(a), (['moving', 'parked', 'stopped'] as State[])[i % 3]); }
  push('Airport', 19.2928, -81.3577, 'moving'); push('West Bay', 19.375, -81.415, 'parked');
  push('Bodden Town', 19.283, -81.25, 'inactive'); push('Rum Point', 19.365, -81.27, 'stopped');
  return f;
}

// Mirror of MapView's source options. clusterProperties in MapLibre's expression
// form ['+', ['get','moving']] == supercluster map/reduce summing that field.
function index() {
  const sc = new Supercluster({
    radius: 48, maxZoom: 17,
    map: (p: any) => ({ moving: p.moving, stopped: p.stopped, parked: p.parked, inactive: p.inactive }),
    reduce: (acc: any, p: any) => { acc.moving += p.moving; acc.stopped += p.stopped; acc.parked += p.parked; acc.inactive += p.inactive; },
  });
  sc.load(fleet());
  return sc;
}
const WORLD: [number, number, number, number] = [-180, -85, 180, 85];

test('zoomed out (island, z10): everything collapses into a few donuts, and every donut sums to its members', () => {
  const sc = index();
  const items = sc.getClusters(WORLD, 10);
  const clusters = items.filter((i: any) => i.properties.cluster);
  const singles = items.filter((i: any) => !i.properties.cluster);
  assert.ok(clusters.length >= 1 && clusters.length <= 6, `expected a handful of donuts, got ${clusters.length}`);
  let covered = singles.length;
  for (const c of clusters) {
    const p = c.properties;
    const sum = p.moving + p.stopped + p.parked + p.inactive;
    assert.equal(sum, p.point_count, 'per-state counts add up to the cluster size');
    covered += p.point_count;
  }
  assert.equal(covered, 18, 'no vehicle is lost or double-counted across donuts + singles');
});

test('the downtown knot is ONE donut at town zoom, with the right colour split (2 each of 4 states)', () => {
  const sc = index();
  // 8 vehicles within ~150m: at z13 they must be a single cluster.
  const near = sc.getClusters([-81.39, 19.29, -81.375, 19.30], 13).filter((i: any) => i.properties.cluster && i.properties.point_count === 8);
  assert.equal(near.length, 1, 'exactly one 8-vehicle donut over downtown');
  const p = near[0].properties;
  assert.deepEqual({ m: p.moving, s: p.stopped, pk: p.parked, i: p.inactive }, { m: 2, s: 2, pk: 2, i: 2 });
  // And its donut has four equal 90° arcs.
  const segs = donutSegments({ moving: p.moving, stopped: p.stopped, parked: p.parked, inactive: p.inactive });
  assert.deepEqual(segs.map(([k, a, b]) => [k, Math.round(b - a)]), [['moving', 90], ['stopped', 90], ['parked', 90], ['inactive', 90]]);
  assert.match(donutSvg(p).svg, />8<\/text>/);
});

test('zooming in breaks the knot into individual vehicles with their names (pills)', () => {
  const sc = index();
  const items = sc.getClusters([-81.39, 19.29, -81.375, 19.30], 18);
  const singles = items.filter((i: any) => !i.properties.cluster);
  const names = singles.map((i: any) => i.properties.name).filter((n: string) => n.startsWith('Downtown')).sort();
  assert.equal(names.length, 8, 'all 8 downtown vehicles are individual at street zoom');
  assert.deepEqual(names, ['Downtown 1','Downtown 2','Downtown 3','Downtown 4','Downtown 5','Downtown 6','Downtown 7','Downtown 8']);
  // each single carries what the pill + dot need
  for (const s of singles) { assert.ok(s.properties.name); assert.ok(['moving','stopped','parked','inactive'].includes(s.properties.state)); }
});

test('two vehicles side by side are enough to form a donut ("two or more")', () => {
  const sc = new Supercluster({ radius: 48, maxZoom: 17,
    map: (p: any) => ({ moving: p.moving, stopped: p.stopped, parked: p.parked, inactive: p.inactive }),
    reduce: (a: any, p: any) => { a.moving += p.moving; a.stopped += p.stopped; a.parked += p.parked; a.inactive += p.inactive; } });
  sc.load([
    { type: 'Feature', properties: { name: 'A', state: 'moving', ...oneHot('moving') }, geometry: { type: 'Point', coordinates: [-81.3811, 19.2946] } },
    { type: 'Feature', properties: { name: 'B', state: 'parked', ...oneHot('parked') }, geometry: { type: 'Point', coordinates: [-81.3810, 19.2947] } },
  ] as any);
  const at12 = sc.getClusters(WORLD, 12);
  assert.equal(at12.length, 1); assert.equal(at12[0].properties.point_count, 2);
  assert.deepEqual([at12[0].properties.moving, at12[0].properties.parked], [1, 1]);
  const segs = donutSegments({ moving: 1, stopped: 0, parked: 1, inactive: 0 });
  assert.deepEqual(segs.map(([k, a, b]) => [k, Math.round(b - a)]), [['moving', 180], ['parked', 180]], 'half green, half red');
  const at19 = sc.getClusters(WORLD, 19);
  assert.equal(at19.filter((i: any) => !i.properties.cluster).length, 2, 'split into two pills when zoomed in');
});

test('cluster expansion zoom: a donut knows the zoom at which it breaks apart', () => {
  const sc = index();
  const knot = sc.getClusters([-81.39, 19.29, -81.375, 19.30], 13).find((i: any) => i.properties.cluster && i.properties.point_count === 8);
  const z = sc.getClusterExpansionZoom(knot.properties.cluster_id);
  assert.ok(z > 13 && z <= 18, `expansion zoom ${z} is deeper than the current view`);
});

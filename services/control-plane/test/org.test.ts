import { test } from 'node:test';
import assert from 'node:assert/strict';
import { descendantIds, wouldCreateCycle, buildTree } from '../src/engine/org';

// Tree:  A → B → D,  A → C,  E (separate root)
const units = [
  { id: 'A', parentId: null, name: 'A' },
  { id: 'B', parentId: 'A', name: 'B' },
  { id: 'C', parentId: 'A', name: 'C' },
  { id: 'D', parentId: 'B', name: 'D' },
  { id: 'E', parentId: null, name: 'E' },
];

test('descendantIds returns the inclusive subtree', () => {
  assert.deepEqual([...descendantIds(units, 'A')].sort(), ['A', 'B', 'C', 'D']);
  assert.deepEqual([...descendantIds(units, 'B')].sort(), ['B', 'D']);
  assert.deepEqual([...descendantIds(units, 'D')], ['D']);
  assert.deepEqual([...descendantIds(units, 'E')], ['E']);
});

test('wouldCreateCycle catches self and descendant parents', () => {
  assert.equal(wouldCreateCycle(units, 'B', 'A'), false); // valid re-parent
  assert.equal(wouldCreateCycle(units, 'B', 'B'), true); // self
  assert.equal(wouldCreateCycle(units, 'A', 'D'), true); // D is a descendant of A
  assert.equal(wouldCreateCycle(units, 'A', null), false); // making a root
  assert.equal(wouldCreateCycle(units, 'C', 'E'), false); // different subtree
});

test('buildTree nests correctly with two roots', () => {
  const roots = buildTree(units);
  assert.equal(roots.length, 2);
  const a = roots.find((r) => r.id === 'A')!;
  assert.equal(a.children.length, 2); // B, C
  const b = a.children.find((c) => c.id === 'B')!;
  assert.equal(b.children[0].id, 'D');
});

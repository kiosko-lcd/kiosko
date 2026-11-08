import assert from 'node:assert/strict';
import { test } from 'node:test';
import { autoPack, cellsFor, collisions, compact, fit, findSpot, fromPx, inBounds, place, rescale, suggestGrid, toPx, type GridItem, type GridSpec } from './grid.ts';

const G: GridSpec = { cols: 24, rows: 6, gap: 10, padding: 10 };

test('suggestGrid gives square-ish cells for common panels', () => {
  assert.deepEqual([suggestGrid(1920, 462).cols, suggestGrid(1920, 462).rows], [24, 6]);
  assert.deepEqual([suggestGrid(480, 480).cols, suggestGrid(480, 480).rows], [6, 6]);
  assert.deepEqual([suggestGrid(320, 240).cols, suggestGrid(320, 240).rows], [4, 3]);
  assert.deepEqual([suggestGrid(1280, 480).cols, suggestGrid(1280, 480).rows], [16, 6]);
});

test('toPx covers the panel edge to edge minus padding, and gaps between tiles', () => {
  const all = toPx({ x: 0, y: 0, w: 24, h: 6 }, G, 1920, 462);
  assert.deepEqual(all, { x: 10, y: 10, w: 1900, h: 442 });
  const a = toPx({ x: 0, y: 0, w: 12, h: 6 }, G, 1920, 462);
  const b = toPx({ x: 12, y: 0, w: 12, h: 6 }, G, 1920, 462);
  assert.equal(b.x - (a.x + a.w), 10);
  assert.equal(b.x + b.w, 1910);
});

test('fromPx and cellsFor invert toPx', () => {
  const r = toPx({ x: 5, y: 2, w: 3, h: 2 }, G, 1920, 462);
  assert.deepEqual(fromPx(r.x + 1, r.y + 1, G, 1920, 462), { x: 5, y: 2 });
  assert.deepEqual(cellsFor({ w: r.w, h: r.h }, G, 1920, 462), { w: 3, h: 2 });
});

test('fit clamps into the grid and shrinks what is too big', () => {
  assert.deepEqual(fit({ x: 30, y: -2, w: 4, h: 9 }, G), { x: 20, y: 0, w: 4, h: 6 });
});

test('place pushes along the gravity and compacts', () => {
  const items: GridItem[] = [
    { id: 'a', x: 0, y: 0, w: 4, h: 6 },
    { id: 'b', x: 4, y: 0, w: 4, h: 6 },
  ];
  // Drop a new 4-wide tile at x=2 with left gravity: b is pushed right, then all compact left.
  const next = place([...items, { id: 'c', x: 20, y: 0, w: 4, h: 6 }], 'c', { x: 4, y: 0, w: 4, h: 6 }, G, 'left');
  assert.ok(next);
  assert.equal(collisions(next!, next!.find((i) => i.id === 'c')!, 'c').length, 0);
  assert.deepEqual(next!.map((i) => i.x).sort((x, y) => x - y), [0, 4, 8]);
});

test('place rejects moves that would push a tile out of the grid', () => {
  const items: GridItem[] = [
    { id: 'a', x: 0, y: 0, w: 12, h: 6 },
    { id: 'b', x: 12, y: 0, w: 12, h: 6 },
  ];
  assert.equal(place(items, 'a', { x: 0, y: 0, w: 14, h: 6 }, G, 'left'), null);
});

test('place never moves a locked tile', () => {
  const items: GridItem[] = [
    { id: 'a', x: 0, y: 0, w: 4, h: 3 },
    { id: 'lock', x: 0, y: 3, w: 4, h: 3, locked: true },
  ];
  assert.equal(place(items, 'a', { x: 0, y: 2, w: 4, h: 3 }, G, 'none'), null);
});

test('compact up closes vertical gaps, keeps order', () => {
  const out = compact([{ id: 'a', x: 0, y: 3, w: 2, h: 2 }, { id: 'b', x: 0, y: 5, w: 2, h: 1 }], 'up');
  assert.deepEqual(out.map((i) => [i.id, i.y]), [['a', 0], ['b', 2]]);
});

test('findSpot scans rows or columns', () => {
  const items: GridItem[] = [{ id: 'a', x: 0, y: 0, w: 4, h: 3 }];
  assert.deepEqual(findSpot(items, G, 4, 3, 'rows'), { x: 4, y: 0 });
  assert.deepEqual(findSpot(items, G, 4, 3, 'cols'), { x: 0, y: 3 });
  assert.equal(findSpot(items, G, 25, 1), null);
});

test('autoPack places everything that fits and shrinks the rest', () => {
  const items: GridItem[] = Array.from({ length: 5 }, (_, i) => ({ id: `t${i}`, x: 0, y: 0, w: 8, h: 6 }));
  const r = autoPack(items, G, 'left');
  assert.equal(r.items.length + r.overflow.length, 5);
  for (const it of r.items) {
    assert.ok(inBounds(it, G));
    assert.equal(collisions(r.items, it, it.id).length, 0);
  }
});

test('rescale keeps proportions across densities', () => {
  const out = rescale([{ id: 'a', x: 12, y: 3, w: 12, h: 3 }], G, { cols: 12, rows: 3, gap: 6, padding: 6 });
  assert.deepEqual(out[0], { id: 'a', x: 6, y: 2, w: 6, h: 1 });
});

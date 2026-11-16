import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectedPicture, isPortrait, isQuarterTurn, newScreen, newTile, panelSize, setPanelSize, setRotation, transposePage, turnScreen, newPage } from './model.ts';

const strip = () => {
  const s = newScreen('Strip', 1920, 462);
  const p = s.pages[0]!;
  // Three columns, the middle one split: the starter layout.
  p.tiles = [newTile({ x: 0, y: 0, w: 11, h: 6 }), newTile({ x: 11, y: 0, w: 5, h: 4 }), newTile({ x: 11, y: 4, w: 5, h: 2 }), newTile({ x: 16, y: 0, w: 8, h: 6 })];
  p.gravity = 'left';
  return s;
};

test('panelSize: the panel keeps its own resolution whatever way it is mounted', () => {
  assert.deepEqual(panelSize({ width: 1920, height: 462, rotate: 0 }), { width: 1920, height: 462 });
  assert.deepEqual(panelSize({ width: 1920, height: 462, rotate: 180 }), { width: 1920, height: 462 });
  assert.deepEqual(panelSize({ width: 462, height: 1920, rotate: 90 }), { width: 1920, height: 462 });
  assert.deepEqual(panelSize({ width: 462, height: 1920, rotate: 270 }), { width: 1920, height: 462 });
  assert.equal(isQuarterTurn(90), true);
  assert.equal(isQuarterTurn(180), false);
  assert.equal(isPortrait({ width: 462, height: 1920 }), true);
});

test('turnScreen: a quarter turn swaps the orientation, a half turn only the angle', () => {
  const s = strip();
  turnScreen(s, 180);
  assert.deepEqual([s.width, s.height, s.rotate], [1920, 462, 180]);
  turnScreen(s, 90);
  assert.deepEqual([s.width, s.height, s.rotate], [462, 1920, 270]);
  turnScreen(s, 180);
  assert.deepEqual([s.width, s.height, s.rotate], [462, 1920, 90]);
  turnScreen(s, 270);
  assert.deepEqual([s.width, s.height, s.rotate], [1920, 462, 0]);
});

test('detectedPicture: relative to the angle the firmware asks for', () => {
  // A Trofeo Vision: 1920×462 at 180°.
  assert.deepEqual(detectedPicture({ width: 1920, height: 462, rotate: 180 }, 180), { width: 1920, height: 462 });
  assert.deepEqual(detectedPicture({ width: 1920, height: 462, rotate: 180 }, 0), { width: 1920, height: 462 });
  assert.deepEqual(detectedPicture({ width: 1920, height: 462, rotate: 180 }, 90), { width: 462, height: 1920 });
  // A model whose firmware wants 90°: at 90° it is upright.
  assert.deepEqual(detectedPicture({ width: 1280, height: 480, rotate: 90 }, 90), { width: 1280, height: 480 });
  assert.deepEqual(detectedPicture({ width: 1280, height: 480, rotate: 90 }, 0), { width: 480, height: 1280 });
  // trcc doesn't say: from 0°.
  assert.deepEqual(detectedPicture({ width: 1920, height: 462 }, 270), { width: 462, height: 1920 });
});

test('setRotation to a quarter turn: the picture becomes portrait and columns become bands', () => {
  const s = strip();
  setRotation(s, 90);
  assert.deepEqual([s.width, s.height, s.rotate], [462, 1920, 90]);
  const p = s.pages[0]!;
  assert.deepEqual([p.grid.cols, p.grid.rows], [6, 24]);
  assert.equal(p.gravity, 'up');
  assert.deepEqual(p.tiles.map((t) => [t.x, t.y, t.w, t.h]), [[0, 0, 6, 11], [0, 11, 4, 5], [4, 11, 2, 5], [0, 16, 6, 8]]);
  // The panel still gets its own resolution.
  assert.deepEqual(panelSize(s), { width: 1920, height: 462 });
});

test('setRotation back and forth gives the same layout; a half turn changes nothing but the angle', () => {
  const s = strip();
  const before = s.pages[0]!.tiles.map((t) => [t.x, t.y, t.w, t.h]);
  setRotation(s, 270);
  setRotation(s, 90);
  assert.deepEqual([s.width, s.height], [462, 1920]);
  setRotation(s, 0);
  assert.deepEqual([s.width, s.height, s.rotate], [1920, 462, 0]);
  assert.deepEqual(s.pages[0]!.tiles.map((t) => [t.x, t.y, t.w, t.h]), before);
  assert.equal(s.pages[0]!.gravity, 'left');
  setRotation(s, 180);
  assert.deepEqual([s.width, s.height, s.rotate], [1920, 462, 180]);
  assert.deepEqual(s.pages[0]!.tiles.map((t) => [t.x, t.y, t.w, t.h]), before);
});

test('transposePage: a summary strip across the top stays across the top', () => {
  const p = newPage('p', 1920, 462, [
    newTile({ x: 0, y: 0, w: 24, h: 1 }), // summary
    newTile({ x: 0, y: 1, w: 13, h: 5 }), // sessions
    newTile({ x: 13, y: 1, w: 6, h: 5 }), // vitals
    newTile({ x: 19, y: 1, w: 5, h: 5 }), // usage
  ]);
  transposePage(p, 462, 1920);
  assert.deepEqual([p.grid.cols, p.grid.rows], [6, 24]);
  const [summary, sessions, vitals, usage] = p.tiles.map((t) => [t.x, t.y, t.w, t.h]);
  // About as tall as before (77 px then, 80 px a row now): one row, across the top.
  assert.deepEqual(summary, [0, 0, 6, 1]);
  // The columns under it become bands under it, in the same order, filling the rest.
  assert.deepEqual(sessions, [0, 1, 6, 12]);
  assert.deepEqual(vitals, [0, 13, 6, 6]);
  assert.deepEqual(usage, [0, 19, 6, 5]);
});

test('transposePage: a full-width tile that is the whole page, or a tall one, is not a header', () => {
  const p = newPage('p', 1920, 462, [newTile({ x: 0, y: 0, w: 24, h: 6 })]);
  transposePage(p, 462, 1920);
  assert.deepEqual(p.tiles.map((t) => [t.x, t.y, t.w, t.h]), [[0, 0, 6, 24]]);
  const q = newPage('q', 1920, 462, [newTile({ x: 0, y: 0, w: 24, h: 3 }), newTile({ x: 0, y: 3, w: 24, h: 3 })]);
  transposePage(q, 462, 1920);
  // Two halves, top and bottom, turn into two halves, left and right.
  assert.deepEqual(q.tiles.map((t) => [t.x, t.y, t.w, t.h]), [[0, 0, 3, 24], [3, 0, 3, 24]]);
});

test('transposePage keeps the gap and padding of the page', () => {
  const p = newPage('p', 1920, 462, [newTile({ x: 0, y: 0, w: 24, h: 6 })]);
  p.grid.gap = 6;
  p.grid.padding = 4;
  transposePage(p, 462, 1920);
  assert.deepEqual([p.grid.cols, p.grid.rows, p.grid.gap, p.grid.padding], [6, 24, 6, 4]);
  assert.deepEqual(p.tiles.map((t) => [t.x, t.y, t.w, t.h]), [[0, 0, 6, 24]]);
});

test('setPanelSize takes the resolution the panel reports and keeps the orientation', () => {
  const s = strip();
  setRotation(s, 90);
  setPanelSize(s, 1280, 480);
  assert.deepEqual([s.width, s.height, s.rotate], [480, 1280, 90]);
  assert.deepEqual(panelSize(s), { width: 1280, height: 480 });
  const upright = strip();
  setPanelSize(upright, 1280, 480);
  assert.deepEqual([upright.width, upright.height], [1280, 480]);
  // The same size again changes nothing.
  const tiles = JSON.stringify(upright.pages[0]!.tiles);
  setPanelSize(upright, 1280, 480);
  assert.equal(JSON.stringify(upright.pages[0]!.tiles), tiles);
});

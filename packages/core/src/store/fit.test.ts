import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PANEL_PRESETS } from '../config/model.ts';
import { biggestTile, fitsPresets, fitsScreen, fitsScreens, panelClass } from './fit.ts';

test('panelClass: every preset in its class', () => {
  const cls = Object.fromEntries(PANEL_PRESETS.map((p) => [p.id, panelClass(p.width, p.height, p.shape)]));
  assert.deepEqual(cls, {
    'trofeo-916': 'bar', 'trofeo-113': 'bar', 'wide-1280x480': 'bar', 'wide-1920x480': 'bar', 'fan-frame-vision-1': 'bar',
    'fan-bracket-vision-1': 'landscape', 'wide-1600x720': 'landscape', 'small-320x240': 'landscape',
    'square-480': 'square', 'square-320': 'square',
    'round-480': 'round',
    'gpu-bracket-458': 'portrait',
  });
  // A bar stood on its side is portrait.
  assert.equal(panelClass(462, 1920), 'portrait');
});

test('fitsScreen: the minimum must fit the biggest tile, the preferred makes it ideal', () => {
  const room = biggestTile(1920, 462);
  assert.deepEqual(room, { w: 1900, h: 442 });
  assert.equal(fitsScreen({ min: { w: 240, h: 120 }, preferred: { w: 480, h: 200 } }, 1920, 462), 'ideal');
  assert.equal(fitsScreen({ min: { w: 240, h: 120 }, preferred: { w: 900, h: 300 } }, 480, 480), 'fits');
  assert.equal(fitsScreen({ min: { w: 600, h: 120 } }, 480, 480), null);
  assert.equal(fitsScreen({}, 320, 240), 'ideal');
});

test('fitsPresets: classes (any way it can be mounted) and presets as sold', () => {
  const wide = fitsPresets({ min: { w: 600, h: 300 }, preferred: { w: 900, h: 400 } });
  assert.deepEqual(wide.fits, ['bar', 'landscape', 'portrait']);
  assert.ok(wide.presets.includes('trofeo-916') && !wide.presets.includes('square-480') && !wide.presets.includes('gpu-bracket-458'));
  // A small square widget fits everything.
  const small = fitsPresets({ min: { w: 120, h: 70 }, preferred: { w: 300, h: 160 } });
  assert.deepEqual(small.fits, ['bar', 'landscape', 'square', 'round', 'portrait']);
  assert.equal(small.presets.length, PANEL_PRESETS.length);
});

test('fitsScreens: per screen of the user, which widgets fit (a bar and a round one)', () => {
  const screens = [{ id: 'a', name: 'Bar', width: 1920, height: 462 }, { id: 'b', name: 'Round', width: 480, height: 480, shape: 'round' as const }];
  const r = fitsScreens([{ type: 'x/wide', min: { w: 800, h: 200 } }, { type: 'x/small', min: { w: 100, h: 100 }, preferred: { w: 600, h: 200 } }], screens);
  assert.deepEqual(r, [
    { screen: 'a', name: 'Bar', fits: ['x/wide', 'x/small'], ideal: ['x/wide', 'x/small'] },
    { screen: 'b', name: 'Round', fits: ['x/small'], ideal: [] },
  ]);
});

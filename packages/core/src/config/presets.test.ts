import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PANEL_PRESETS, mmPerPx } from './model.ts';

test('panel presets: one id each, makers’ models first, and only what Kiosko ran on is tested', () => {
  const ids = PANEL_PRESETS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
  const firstPlain = PANEL_PRESETS.findIndex((p) => !p.maker);
  assert.ok(PANEL_PRESETS.slice(firstPlain).every((p) => !p.maker), 'models before plain sizes');
  assert.deepEqual(PANEL_PRESETS.filter((p) => p.tested).map((p) => p.id), ['trofeo-916']);
});

test('Thermalright’s LCDs, as its accessories page lists them', () => {
  const tr = Object.fromEntries(PANEL_PRESETS.filter((p) => p.maker === 'Thermalright').map((p) => [p.name, `${p.width}×${p.height} ${p.diagonalIn}″`]));
  assert.deepEqual(tr, {
    'Trofeo Vision 9.16″': '1920×462 9.16″',
    'Trofeo Vision 11.3″': '1920×400 11.3″',
    'Trofeo Vision 6.86″': '1280×480 6.86″',
    'Fan Bracket Vision-1': '854×480 5.66″',
    'GPU Bracket LCD 4.58″': '320×960 4.58″',
    'Fan Frame Vision-1 3.69″': '640×172 3.69″',
  });
});

test('a model’s diagonal sizes its pixels, either way round', () => {
  // 11.3″ over 1920×400: ~0.146 mm per pixel; the GPU bracket on its side the same as upright.
  assert.ok(Math.abs(mmPerPx({ width: 1920, height: 400 }) - (11.3 * 25.4) / Math.hypot(1920, 400)) < 1e-9);
  assert.equal(mmPerPx({ width: 960, height: 320 }), mmPerPx({ width: 320, height: 960 }));
});

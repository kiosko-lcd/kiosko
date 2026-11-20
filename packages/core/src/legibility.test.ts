import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCanvas } from '@napi-rs/canvas';
import { FONT_FAMILIES } from '@kiosko/sdk';
import * as kit from '@loksly/lcd-canvas-kit';
import { legibleCjkPx, mmPerPx } from './config/model.ts';
import { cjkFonts, registerFonts, setFontLocale } from './fonts.ts';

test('legibleCjkPx: the smallest readable Hanzi for each panel and distance (the study’s table)', () => {
  assert.equal(legibleCjkPx({ width: 1920, height: 462 }), 17, 'Trofeo Vision 9.16″ at 60 cm');
  assert.equal(legibleCjkPx({ width: 320, height: 240 }), 13, '2.4″ at 60 cm');
  assert.equal(legibleCjkPx({ width: 1920, height: 462, readingDistance: 'far' }), 25);
  assert.equal(legibleCjkPx({ width: 1920, height: 462, readingDistance: 'near' }), 11);
  assert.ok(Math.abs(mmPerPx({ width: 462, height: 1920 }) - mmPerPx({ width: 1920, height: 462 })) < 1e-9, 'on its side too');
  assert.equal(legibleCjkPx({ width: 1000, height: 1000, diagonalIn: 10 }), Math.round((600 * Math.tan((10 / 60) * Math.PI / 180)) / 0.88 / ((10 * 25.4) / Math.hypot(1000, 1000))));
});

registerFonts();
const cjk = cjkFonts('zh-TW').families.length > 0;

test('the kit raises CJK text below the minimum, counting the zoom, and leaves Latin alone', { skip: !cjk && 'no CJK font' }, () => {
  setFontLocale('zh-TW');
  const g = createCanvas(400, 100).getContext('2d');
  const o = { size: 9, family: FONT_FAMILIES.sans };
  kit.setMinCjkPx(0);
  const small = kit.measureTracked(g, '記憶體', o);
  const latin = kit.measureTracked(g, 'CPU', o);
  kit.setMinCjkPx(17);
  kit.takeCjkEnlarged();
  assert.ok(Math.abs(kit.measureTracked(g, '記憶體', o) - small * (17 / 9)) < 1.5, 'drawn at 17 px');
  assert.equal(kit.takeCjkEnlarged(), 9);
  assert.equal(kit.measureTracked(g, 'CPU', o), latin, 'Latin keeps its size');
  g.scale(2, 2);
  kit.measureTracked(g, '記憶體', o);
  assert.equal(kit.takeCjkEnlarged(), null, 'at zoom 2 a 9 px text is 18 px on the panel: readable');
  kit.setMinCjkPx(0);
});

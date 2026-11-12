import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCanvas } from '@napi-rs/canvas';
import { encodeFit } from './runtime.ts';

/** A frame full of noise: the worst case for JPEG, like a photo. */
function noisy(w = 480, h = 240) {
  const c = createCanvas(w, h);
  const g = c.getContext('2d');
  const img = g.createImageData(w, h);
  let seed = 7;
  for (let i = 0; i < img.data.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    img.data[i] = i % 4 === 3 ? 255 : seed & 0xff;
  }
  g.putImageData(img, 0, 0);
  return c;
}

test('encodeFit: a frame under the limit goes out at the asked quality', () => {
  const c = noisy();
  const r = encodeFit(c, 'jpeg', 90, 10_000_000);
  assert.equal(r.quality, 90);
  assert.equal(r.over, false);
});

test('encodeFit: a frame over the limit is re-encoded lower until it fits', () => {
  const c = noisy();
  const full = encodeFit(c, 'jpeg', 100, 0).out.length;
  const limit = Math.round(full * 0.6);
  const r = encodeFit(c, 'jpeg', 100, limit);
  assert.ok(r.out.length <= limit, `${r.out.length} ≤ ${limit}`);
  assert.ok(r.quality < 100 && r.quality >= 20);
  assert.equal(r.over, false);
});

test('encodeFit: when nothing fits it sends the smallest and says so; PNG and 0 are left alone', () => {
  const c = noisy();
  const r = encodeFit(c, 'jpeg', 90, 1_000);
  assert.equal(r.over, true);
  assert.equal(r.quality, 20);
  assert.equal(encodeFit(c, 'png', 90, 1_000).over, false, 'PNG has no quality to lower');
  assert.equal(encodeFit(c, 'jpeg', 90, 0).quality, 90, '0 = no limit');
});

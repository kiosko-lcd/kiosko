import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { loadImageScaled, scaledSize } from './scaled-images.ts';

test('scaledSize: cover is at least the box, contain at most; never larger than the image', () => {
  assert.deepEqual(scaledSize(3072, 4608, { width: 600, height: 462 }), { width: 600, height: 900 });
  assert.deepEqual(scaledSize(3072, 4608, { width: 600, height: 462, fit: 'contain' }), { width: 308, height: 462 });
  assert.deepEqual(scaledSize(400, 300, { width: 1920, height: 1080 }), { width: 400, height: 300 });
});

const photo = (w: number, h: number, png = false) => {
  const c = createCanvas(w, h);
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, '#c33');
  grad.addColorStop(1, '#33c');
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
  return png ? c.toBuffer('image/png') : c.toBuffer('image/jpeg', 90);
};

test('loadImageScaled: a big photo comes back shrunk, from a buffer or a file; a small one as it is', async () => {
  const big = await loadImageScaled(photo(3000, 2000), { width: 600, height: 462 });
  assert.deepEqual([big.width, big.height], [693, 462]);
  const dir = mkdtempSync(join(tmpdir(), 'kiosko-scaled-'));
  writeFileSync(join(dir, 'p.jpg'), photo(2000, 3000));
  const fromFile = await loadImageScaled(join(dir, 'p.jpg'), { width: 1920, height: 1080 });
  assert.deepEqual([fromFile.width, fromFile.height], [1920, 2880]);
  const small = await loadImageScaled(photo(320, 200), { width: 1920, height: 1080 });
  assert.deepEqual([small.width, small.height], [320, 200]);
  // Transparency survives (PNG in, PNG out).
  const png = await loadImageScaled(photo(1200, 800, true), { width: 300, height: 200, fit: 'contain' });
  assert.deepEqual([png.width, png.height], [300, 200]);
  await assert.rejects(loadImageScaled(Buffer.from('not an image'), { width: 10, height: 10 }));
});

test('loadImageScaled: the JS thread stays free while a big photo is scaled', async () => {
  const bytes = photo(4000, 6000);
  // What it saves, on this machine: the full-size photo prepared on this thread, as a widget's
  // first paint of it would. CI runners are slow and uneven, so the bar is relative to this, not
  // a number of ms.
  const t0 = performance.now();
  createCanvas(600, 900).getContext('2d').drawImage(await loadImage(bytes), 0, 0, 600, 900);
  const onThisThread = performance.now() - t0;
  // The worker starts once, on first use: that is not scaling.
  await loadImageScaled(photo(1200, 800), { width: 300, height: 200 });
  let worst = 0;
  let last = performance.now();
  const iv = setInterval(() => {
    const n = performance.now();
    worst = Math.max(worst, n - last);
    last = n;
  }, 5);
  await loadImageScaled(bytes, { width: 600, height: 462 });
  clearInterval(iv);
  assert.ok(worst < Math.max(40, onThisThread / 2), `the thread was held ${worst.toFixed(0)} ms at once; on this thread it would have been ${onThisThread.toFixed(0)} ms`);
});

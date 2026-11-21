import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FPS_WINDOW_MS, FrameStats } from './frame-stats.ts';

test('frame stats: fps counts the frames sent in the last window; paint and encode are running averages', () => {
  const s = new FrameStats();
  const t0 = 1_000_000;
  for (let i = 0; i < 60; i++) s.sentAt(t0 + i * 100);
  // 50 of the 60 were sent in the last 5 s.
  assert.equal(s.read(t0 + 5_950).fps, (50 * 1000) / FPS_WINDOW_MS);
  assert.equal(s.read(t0 + 60_000).fps, 0, 'nothing sent lately');
  s.painted(10, 40);
  assert.deepEqual({ ...s.read(t0), fps: 0 }, { fps: 0, paintMs: 10, encodeMs: 40, frames: 1 });
  s.painted(20, 40);
  assert.equal(s.read(t0).paintMs, 11, 'recent frames weigh more, but one frame does not rule');
  assert.equal(s.read(t0).frames, 2);
});

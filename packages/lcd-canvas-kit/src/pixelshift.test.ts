import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pixelShift } from './pixelshift.ts';
import { FileSink } from './sink.ts';

test('pixelShift: off means no offset; on, a slow cycle that comes back to the start', () => {
  const o = { enabled: true, amplitude: 2, periodMs: 1000 };
  assert.deepEqual(pixelShift(5000, { ...o, enabled: false }), { x: 0, y: 0 });
  const steps = Array.from({ length: 7 }, (_, i) => pixelShift(i * 1000, o));
  assert.deepEqual(steps[0], { x: 0, y: 0 });
  assert.deepEqual(steps[6], steps[0], 'six steps per cycle');
  assert.ok(steps.every((s) => Math.abs(s.x) <= 2 && Math.abs(s.y) <= 2));
  assert.deepEqual(pixelShift(999, o), pixelShift(0, o), 'constant within a period');
});

test('FileSink: writes the frame atomically, leaving no temporary file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sink-'));
  const sink = new FileSink(join(dir, 'frame.jpg'));
  await sink.send(Buffer.from([1, 2, 3]));
  await sink.send(Buffer.from([4, 5]));
  assert.deepEqual([...readFileSync(sink.path)], [4, 5]);
  assert.deepEqual(readdirSync(dir), ['frame.jpg']);
});

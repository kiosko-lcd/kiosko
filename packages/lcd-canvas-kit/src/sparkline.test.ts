import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sparkBars } from './sparkline.ts';

test('Sparkline: scale is relative to the series maximum', () => {
  const bars = sparkBars([1, 2, 4], 90, 40);
  assert.equal(bars.length, 3);
  assert.equal(bars[2]!.h, 40); // the maximum fills the height
  assert.equal(bars[1]!.h, 20); // half the value, half the height
  assert.equal(bars[0]!.h, 10);
  assert.ok(bars[0]!.x < bars[1]!.x && bars[1]!.x < bars[2]!.x);
});

test('Sparkline: bars grow from the bottom', () => {
  for (const b of sparkBars([3, 9, 1], 60, 30)) {
    assert.equal(b.y + b.h, 30, 'the foot of every bar touches the bottom of the box');
  }
});

test('Sparkline: a flat series does not divide by zero', () => {
  const bars = sparkBars([5, 5, 5], 60, 30);
  assert.equal(bars.length, 3);
  for (const b of bars) assert.ok(Number.isFinite(b.h) && b.h === 30);
});

test('Sparkline: all zeros leaves the minimum height, not NaN', () => {
  for (const b of sparkBars([0, 0], 60, 30)) {
    assert.equal(b.h, 1);
    assert.ok(Number.isFinite(b.y));
  }
});

test('Sparkline: degenerate cases do not blow up', () => {
  assert.deepEqual(sparkBars([], 60, 30), []);
  assert.deepEqual(sparkBars([1, 2], 0, 30), []);
  assert.deepEqual(sparkBars([1, 2], 60, 0), []);
  assert.equal(sparkBars([7], 60, 30).length, 1);
});

test('Sparkline: with an explicit max the scale is absolute', () => {
  // Without `max`, an idle machine would look saturated: the busiest core
  // would read 100 % even if it were at 5 %.
  const relative = sparkBars([0.05, 0.02], 60, 40);
  assert.equal(relative[0]!.h, 40, 'without max, the largest value fills the height');

  const absolute = sparkBars([0.05, 0.02], 60, 40, { max: 1 });
  assert.equal(absolute[0]!.h, 2);
  assert.equal(absolute[1]!.h, 1);
});

test('Sparkline: with many bars the gap is sacrificed, not the bar', () => {
  const bars = sparkBars(Array(60).fill(1), 100, 20);
  assert.equal(bars.length, 60);
  for (const b of bars) assert.ok(b.w >= 1, 'no bar disappears');
});

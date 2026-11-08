import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clock, countdown, elapsed, gigabytes, shortId } from './format.ts';

test('elapsed: minute granularity, localized "now"', () => {
  assert.equal(elapsed(0), 'now');
  assert.equal(elapsed(45 * 1000, 'ahora'), 'ahora');
  assert.equal(elapsed(90 * 1000), '1 min');
  assert.equal(elapsed(15 * 60 * 1000), '15 min');
  assert.equal(elapsed(3 * 3600 * 1000 + 4 * 60 * 1000), '3h 04');
  assert.equal(elapsed(2 * 24 * 3600 * 1000 + 5 * 3600 * 1000), '2d 05h');
  assert.equal(elapsed(-5000), 'now', 'a clock skew never shows a negative time');
});

test('countdown', () => {
  assert.equal(countdown(45 * 1000), '1m');
  assert.equal(countdown(15 * 60 * 1000), '15m');
  assert.equal(countdown(2 * 3600 * 1000 + 10 * 60 * 1000), '2h 10m');
});

test('shortId', () => {
  assert.equal(shortId('a1b2c3d4-1111-2222-3333-444455556666'), 'A1B2C3');
  assert.equal(shortId('abc-def-ghi'), 'ABCDEF');
});

test('clock and gigabytes', () => {
  assert.equal(clock(new Date(2026, 0, 1, 7, 5)), '07:05');
  assert.equal(gigabytes(44 * 1024 ** 3), '44GB');
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { countdown, money, percent, tokens } from './format.ts';
import { level, railRatios } from './draw.ts';
import { usageApi, usageMax } from './demo.ts';

test('tokens', () => {
  assert.equal(tokens(450), '450');
  assert.equal(tokens(2500), '3k');
  assert.equal(tokens(1_350_000), '1.4M');
  assert.equal(tokens(2_900_000_000), '2.90B');
});

test('money, percent, countdown', () => {
  assert.equal(money(0.45), '$0.45');
  assert.equal(money(12.5), '$12.50');
  assert.equal(money(125.75), '$126');
  assert.equal(percent(0.42), '42%');
  assert.equal(countdown(2 * 3600 * 1000 + 10 * 60 * 1000), '2h 10m');
});

test('rail semaphore', () => {
  const t = { warn: 0.6, alert: 0.85 };
  assert.deepEqual(railRatios(usageMax(0)).map((r) => level(r, t)), ['info', 'alert']);
  assert.deepEqual(railRatios(usageApi(0)).map((r) => level(r, t)), ['info', 'warn']);
});

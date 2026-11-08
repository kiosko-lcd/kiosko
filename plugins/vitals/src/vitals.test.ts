import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEMO_VITALS } from './index.ts';
import { anyAlert, diskRatio, gigabytes, statsOf, tempLevel, vitalLevel, type VitalThresholds } from './vitals.ts';

const T: VitalThresholds = { warn: 0.85, alert: 0.95, tempWarn: 85, tempAlert: 95 };

test('levels: normal is dim, only past the thresholds it lights', () => {
  assert.equal(vitalLevel(0.65, T), 'normal', 'RAM at 65 % is any Tuesday');
  assert.equal(vitalLevel(0.9, T), 'warn');
  assert.equal(vitalLevel(0.95, T), 'alert');
  assert.equal(tempLevel(71, T), 'normal');
  assert.equal(tempLevel(88, T), 'warn');
  assert.equal(tempLevel(99, T), 'alert');
});

test('stats: only what could be read, in a fixed order', () => {
  assert.deepEqual(statsOf(DEMO_VITALS, T).map((s) => [s.key, s.value, s.level]), [
    ['temp', '71°', 'normal'],
    ['cpu', '23%', 'normal'],
    ['ram', '42%', 'normal'],
    ['disk', '91%', 'warn'],
  ]);
  assert.deepEqual(statsOf({ mem: { used: 1, total: 4 } }, T).map((s) => s.key), ['ram']);
  assert.deepEqual(statsOf({ mem: { used: 1, total: 0 } }, T)[0]?.value, '0%', 'a zero total never divides by zero');
});

test('idle unless something is in the red; cores do not count', () => {
  assert.equal(anyAlert(DEMO_VITALS, T), false);
  assert.equal(anyAlert(undefined, T), false);
  assert.equal(anyAlert({ cpuTemp: 97 }, T), true);
  assert.equal(anyAlert({ cores: [1, 1, 1] }, T), false);
});

test('disk helpers', () => {
  assert.ok(Math.abs(diskRatio(DEMO_VITALS)! - 240 / 265) < 1e-9);
  assert.equal(diskRatio({}), null);
  assert.equal(gigabytes(265 * 1024 ** 3), '265GB');
});

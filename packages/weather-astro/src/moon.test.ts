import { test } from 'node:test';
import assert from 'node:assert';
import { moonPhase, SYNODIC } from './moon.ts';

const REF = Date.UTC(2000, 0, 6, 18, 14);
const DAY = 86_400_000;

test('moon: the reference new moon is phase 0', () => {
  const m = moonPhase(REF);
  assert.ok(m.phase < 0.001, `phase ${m.phase}`);
  assert.ok(m.illumination < 0.001, 'nothing lit');
  assert.strictEqual(m.name, 'new');
});

test('moon: half a cycle later it is full', () => {
  const m = moonPhase(REF + (SYNODIC / 2) * DAY);
  assert.ok(Math.abs(m.phase - 0.5) < 0.001);
  assert.ok(m.illumination > 0.999, 'fully lit');
  assert.strictEqual(m.name, 'full');
  assert.strictEqual(m.daysToFull, 0);
});

test('moon: quarters are half lit and go the right way', () => {
  const first = moonPhase(REF + (SYNODIC / 4) * DAY);
  assert.ok(Math.abs(first.illumination - 0.5) < 0.01);
  assert.strictEqual(first.waxing, true, 'before full it waxes');
  assert.strictEqual(first.name, 'first-quarter');

  const last = moonPhase(REF + SYNODIC * 0.75 * DAY);
  assert.ok(Math.abs(last.illumination - 0.5) < 0.01);
  assert.strictEqual(last.waxing, false);
  assert.strictEqual(last.name, 'last-quarter');
});

test('moon: checked against Open-Meteo on 2026-09-04', () => {
  // The API said 0.753 for that day; this textbook model says 0.751. The
  // difference is the orbital perturbations this calculation ignores.
  const m = moonPhase(Date.UTC(2026, 8, 4, 12));
  assert.ok(Math.abs(m.phase - 0.753) < 0.01, `phase ${m.phase.toFixed(3)}`);
  assert.strictEqual(m.name, 'last-quarter');
});

test('moon: a date before the reference does not give a negative phase', () => {
  const m = moonPhase(Date.UTC(1969, 6, 20));
  assert.ok(m.phase >= 0 && m.phase < 1, `phase ${m.phase}`);
  assert.ok(m.illumination >= 0 && m.illumination <= 1);
});

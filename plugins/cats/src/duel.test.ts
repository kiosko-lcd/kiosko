import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { registerFonts } from '@tessera/core';
import { useCanvas } from './canvas.ts';
import { COATS } from './cat.ts';
import { beatAt, crossing, drawDuel, duration, ik, longDuel, shortDuel } from './duel.ts';
import { duelFrames, duelPlayer, planDuel } from './duel-egg.ts';
import type { SessionView } from './types.ts';
import { wordsFor } from './words.ts';

registerFonts();
useCanvas({ createCanvas, loadImage });
const T0 = Date.parse('2026-11-05T10:42:00');
const es = wordsFor('es');

test('duel: joints keep the length of the bones', () => {
  const root: [number, number] = [0, 0];
  for (const target of [[60, 80], [10, 30], [-40, 90]] as [number, number][]) {
    const j = ik(root, target, 70, 64, 1);
    assert.ok(Math.abs(Math.hypot(j[0], j[1]) - 70) < 0.01);
    if (Math.hypot(...target) < 133) assert.ok(Math.abs(Math.hypot(target[0] - j[0], target[1] - j[1]) - 64) < 0.05);
  }
  const far = ik(root, [500, 0], 70, 64, 1);
  assert.ok(far[0] > 60 && Math.abs(far[1]) < 15, 'out of reach, it stretches towards the target');
});

test('duel: two blades that cross, and two that do not', () => {
  assert.deepEqual(crossing([0, 0, 10, 10], [0, 10, 10, 0]), [5, 5]);
  assert.equal(crossing([0, 0, 1, 1], [5, 0, 6, 1]), null);
});

test('duel: the choreography starts off and ends with its winner', () => {
  assert.equal(beatAt(shortDuel(), 0).on, 0, 'blades start off');
  const l = longDuel('b');
  assert.ok(duration(l) > 18);
  assert.equal(beatAt(l, duration(l)).winner, 'b');
  for (let t = 0; t <= duration(l); t += 0.25) {
    const b = beatAt(l, t);
    for (const v of [b.a.x, b.b.x, b.a.st.blade, b.b.st.blade]) assert.ok(Number.isFinite(v), `t=${t}`);
  }
});

test('duel: there are real clashes (blades cross many times)', () => {
  const c = createCanvas(1920, 462).getContext('2d');
  const s = shortDuel();
  let flashes = 0;
  for (let t = 0; t <= duration(s); t += 1 / 8) {
    if (drawDuel(c, s, t, 860, 445, 0.78, { coats: [COATS.carbon!, COATS.canela!], collars: ['#D9663A', '#3F7FE0'] }) > 0) flashes++;
  }
  assert.ok(flashes >= 3, `flashes: ${flashes}`);
});

const rec = (id: string, dirty: number): SessionView => ({
  schemaVersion: 1, session_id: id, provider: 'claude', state: 'active', detail: 'Bash: ls', project: id, cwd: `/r/${id}`,
  since: T0 - 60_000, updated: T0 - 2_000, event: 'x', dirty,
});

test('duel: the one with fewer uncommitted files wins', () => {
  const plan = planDuel([rec('gd', 7), rec('web', 0)], T0, es)!;
  assert.deepEqual(plan.names.slice().sort(), ['gd', 'web']);
  assert.equal(plan.names[plan.winner === 'a' ? 0 : 1], 'web');
  assert.match(plan.reason, /ningún fichero/);
  assert.match(planDuel([rec('gd', 7), rec('web', 0)], T0, wordsFor('en'))!.reason, /no uncommitted files/);
  assert.notEqual(plan.coats[0], plan.coats[1], 'two different cats');
});

test('duel: a lone session fights the bug; with none, no duel', () => {
  const solo = planDuel([rec('gd', 3)], T0, es)!;
  assert.equal(solo.names[1], 'el bug');
  assert.equal(solo.names[solo.winner === 'a' ? 0 : 1], 'gd');
  assert.equal(planDuel([], T0, es), null);
});

test('duel: frames paint at the panel size', () => {
  const plan = planDuel([rec('gd', 7), rec('web', 0)], T0, es)!;
  const p = duelPlayer({ plan, width: 960, height: 231, now: T0, room: 'estudio', words: es, weather: null, sun: null });
  assert.equal(p.frames, duelFrames(plan));
  const c = createCanvas(960, 231);
  for (const i of [0, Math.floor(p.frames / 2), p.frames - 1]) p.draw(c.getContext('2d'), i);
  assert.deepEqual([...c.toBuffer('image/jpeg').subarray(0, 2)], [0xff, 0xd8]);
});

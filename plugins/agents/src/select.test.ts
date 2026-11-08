import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assignWeights, plan, spareWidth, usedWidth, type PlanOptions } from './select.ts';
import type { SessionView } from './types.ts';

const t0 = Date.parse('2026-11-05T10:42:00');

const rec = (id: string, state: SessionView['state'], sinceAgo = 0, extra: Partial<SessionView> = {}): SessionView => ({
  schemaVersion: 1,
  session_id: id,
  provider: 'claude',
  state,
  detail: 'test tool',
  project: 'test-project',
  since: t0 - sinceAgo,
  updated: t0 - sinceAgo,
  event: 'Notification',
  ...extra,
});

/** The original layout: 1920 px, 14 px margins, a 356 px rail and its 18 px gap. */
const OLD: PlanOptions = { min: 320, max: 430, gap: 12, summaryWidth: 150 };
const AVAILABLE = 1920 - 2 * 14 - (356 + 18);
const many = (n: number) => Array.from({ length: n }, (_, i) => rec(`s${i}`, 'active'));

test('weights: at most one solid tile, the most urgent claiming one', () => {
  const tiles = assignWeights([rec('1', 'permission'), rec('2', 'waiting'), rec('3', 'active')]);
  assert.deepEqual(tiles.map((t) => t.weight), ['solid', 'marked', 'quiet']);
  assert.equal(assignWeights([rec('a', 'active'), rec('b', 'idle')]).filter((t) => t.weight === 'solid').length, 0);
});

test('weights: a claiming meeting takes the solid weight ahead of a permission prompt', () => {
  const meeting = rec('m', 'waiting', 0, { startsAt: t0 + 4 * 60_000, provider: 'calendar' });
  const tiles = assignWeights([rec('p', 'permission'), meeting]);
  assert.equal(tiles.find((t) => t.record.session_id === 'm')?.weight, 'solid');
  assert.equal(tiles.find((t) => t.record.session_id === 'p')?.weight, 'marked');
});

test('plan: everything fits, or collapses into the overflow column', () => {
  const five = [rec('1', 'permission'), rec('2', 'waiting'), rec('3', 'ready'), rec('4', 'active'), rec('5', 'idle')];
  const large = plan(five, 1920, OLD);
  assert.equal(large.tiles.length, 5);
  assert.equal(large.overflow.length, 0);
  assert.equal(large.summaryWidth, 0);
  const tight = plan(five, 800, OLD);
  assert.ok(tight.tiles.length < 5);
  assert.ok(tight.overflow.length > 0);
  assert.ok(tight.summaryWidth > 0);
  assert.equal(tight.tiles[0]?.record.session_id, '1', 'the most urgent always gets a tile');
});

test('plan: spare width on the original layout (where the vitals column lived)', () => {
  assert.equal(AVAILABLE, 1518);
  const spare = (n: number) => spareWidth(plan(many(n), AVAILABLE, OLD), AVAILABLE, OLD.gap);
  assert.equal(spare(1), 1088);
  assert.equal(spare(2), 646);
  assert.equal(spare(3), 204);
  assert.ok(spare(4) < 190, 'four tiles leave no room');
});

test('plan: overflow and spare width never coincide', () => {
  const p = plan(many(9), AVAILABLE, OLD);
  assert.ok(p.overflow.length > 0);
  assert.ok(spareWidth(p, AVAILABLE, OLD.gap) < 190);
});

test('plan: tile widths of the original layout are unchanged', () => {
  assert.equal(plan(many(1), AVAILABLE, OLD).tileWidth, OLD.max);
  assert.equal(plan(many(4), AVAILABLE, OLD).tileWidth, 370);
});

test('plan: with overflow the width cap is lifted, so no dead gap is left', () => {
  const p = plan(many(4), 1100, OLD);
  assert.equal(p.tiles.length, 2);
  assert.ok(p.tileWidth > OLD.max);
  assert.equal(usedWidth(p, OLD.gap), 1100);
});

test('plan: no sessions, no tiles', () => {
  const p = plan([], 1000, OLD);
  assert.equal(p.tiles.length, 0);
  assert.equal(usedWidth(p, OLD.gap), 0);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextTurnAt, pickInStack, pickPage, pickTurn } from './stack.ts';

const e = (id: string, visible = true, urgent = false) => ({ id, visible, urgent });

test('an urgent widget keeps the tile', () => {
  assert.equal(pickInStack([e('a'), e('b', true, true), e('c')], 0, 1000), 'b');
});

test('visible widgets take turns against the wall clock', () => {
  const s = [e('a'), e('b', false), e('c')];
  assert.equal(pickInStack(s, 0, 30_000), 'a');
  assert.equal(pickInStack(s, 30_000, 30_000), 'c');
  assert.equal(pickInStack(s, 60_000, 30_000), 'a');
  assert.equal(nextTurnAt(45_000, 30_000), 60_000);
});

test('nothing visible → null', () => {
  assert.equal(pickInStack([e('a', false)], 0, 1000), null);
});

test('pages rotate by their own durations, or stay pinned', () => {
  const pages = [{ id: 'p1', durationMs: 60_000 }, { id: 'p2', durationMs: 30_000 }, { id: 'off', enabled: false }];
  assert.equal(pickPage(pages, 10_000)?.id, 'p1');
  assert.equal(pickPage(pages, 70_000)?.id, 'p2');
  assert.equal(pickPage(pages, 95_000)?.id, 'p1');
  assert.equal(pickPage(pages, 10_000, 'p2')?.id, 'p2');
  assert.equal(pickPage(pages, 10_000, 'off')?.id, 'p1');
});

test('pickTurn: without memory it is pickInStack; widgets with nothing to show pass their turn', () => {
  const s = [e('a'), { ...e('b'), live: false }, e('c')];
  assert.equal(pickTurn(s, 0, 10_000).id, 'a');
  assert.equal(pickTurn(s, 10_000, 10_000).id, 'c');
  assert.equal(pickInStack(s, 10_000, 10_000), 'c');
  // None has anything: the first visible one.
  assert.equal(pickTurn([{ ...e('a', false) }, { ...e('b'), live: false }, { ...e('c'), live: false }], 10_000, 10_000).id, 'b');
});

test('pickTurn: a widget picked late in a turn keeps the tile through the next one', () => {
  const s = [{ ...e('a'), live: false }, e('b'), e('c')];
  // a was shown since 0, emptied: it leaves at half a turn, b comes at 5 s…
  let r = pickTurn(s, 4000, 10_000, { id: 'a', since: 0, turn: 0 });
  assert.equal(r.id, 'a');
  assert.equal(r.wakeAt, 5000);
  r = pickTurn(s, 5000, 10_000, r.memo!);
  assert.equal(r.id, 'b');
  // …and b shown at 9 s would stay past the beat at 10 s, until 20 s.
  r = pickTurn(s, 10_000, 10_000, { id: 'b', since: 9000, turn: 0 });
  assert.equal(r.id, 'b');
  assert.equal(pickTurn(s, 19_000, 10_000, r.memo!).id, 'b');
  assert.equal(pickTurn(s, 20_000, 10_000, r.memo!).id, 'c');
});

test('pickTurn: urgent takes the tile at once and gives it back at once; a long gap goes back to the wall clock', () => {
  const memo = { id: 'a', since: 0, turn: 0 };
  const u = pickTurn([e('a'), e('b', true, true)], 1000, 10_000, memo);
  assert.equal(u.id, 'b');
  assert.equal(pickTurn([e('a'), e('b')], 2000, 10_000, u.memo!).id, 'a');
  assert.equal(pickTurn([e('a'), e('b'), e('c')], 50_000, 10_000, memo).id, 'c', 'turn 5 of 3: the wall clock');
});

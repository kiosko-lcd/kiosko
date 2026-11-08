import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextTurnAt, pickInStack, pickPage } from './stack.ts';

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

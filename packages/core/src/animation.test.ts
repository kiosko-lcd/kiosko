import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AnimationPlan } from '@kiosko/sdk';
import { AnimationScheduler, DEFAULT_GAP, MAX_FRAMES, checkPlan } from './animation.ts';
import type { Animatable } from './compositor.ts';

const plan = (over: Partial<AnimationPlan> = {}): AnimationPlan => ({ id: 'wag', frames: 10, fps: 12, ...over });

/** A shown widget whose `ask` records why it was asked and answers `answer`. */
function widget(over: Partial<Animatable> & { answer?: (trigger: 'idle' | 'data') => AnimationPlan | null; asked?: unknown[] } = {}): Animatable {
  const { answer = () => plan(), asked = [], ...rest } = over;
  return {
    tileId: 't1',
    instanceId: 'w1',
    type: 'test/cat',
    def: {},
    data: { n: 1 },
    sources: { 'a/b': { v: 1 } },
    ended: () => undefined,
    ask: (trigger, _rnd, prev) => {
      asked.push({ trigger, prev });
      return answer(trigger);
    },
    ...rest,
  };
}

test('checkPlan: what plays, what is cut down and what is refused', () => {
  const ok = checkPlan(plan({ fps: 30 }), 12);
  assert.ok(typeof ok !== 'string');
  assert.equal(ok.fps, 12, 'the screen ceiling wins');
  assert.equal(ok.interruptible, true);
  assert.equal((checkPlan(plan({ interruptible: false }), 12) as { interruptible: boolean }).interruptible, false);
  for (const bad of [null, 'x', { frames: 10, fps: 12 }, plan({ frames: 2 }), plan({ frames: 5.5 }), plan({ frames: MAX_FRAMES + 1 }), plan({ fps: 0 }), plan({ fps: Number.NaN })]) {
    assert.equal(typeof checkPlan(bad, 12), 'string', JSON.stringify(bad));
  }
  const held = checkPlan(plan({ frames: 11, hold: { at: 0.86, ms: 5000 } }), 12);
  assert.ok(typeof held !== 'string');
  assert.deepEqual(held.hold, { index: 9, ms: 5000 });
  // A hold at the very ends would sit on the still picture, which isn't sent: it moves inside.
  assert.equal((checkPlan(plan({ frames: 11, hold: { at: 0, ms: 1 } }), 12) as { hold: { index: number } }).hold.index, 1);
  assert.equal((checkPlan(plan({ frames: 11, hold: { at: 1, ms: 1 } }), 12) as { hold: { index: number } }).hold.index, 9);
});

test('a widget seen for the first time is not asked: starting up sets nothing off', () => {
  const s = new AnimationScheduler(() => 0);
  const asked: unknown[] = [];
  assert.deepEqual(s.next([widget({ asked })], 1000, 12), []);
  assert.equal(asked.length, 0);
});

test('idle questions come after the gap, and the next one waits for another gap', () => {
  const s = new AnimationScheduler(() => 0); // rnd 0: the shortest gap
  const asked: unknown[] = [];
  const w = widget({ asked, def: { animationGap: { minMs: 5000, maxMs: 9000 } } });
  s.next([w], 0, 12); // seen
  assert.deepEqual(s.next([w], 4999, 12), []);
  assert.equal(asked.length, 0);
  const due = s.next([w], 5000, 12);
  assert.equal(due.length, 1);
  assert.equal(due[0]!.play.plan.id, 'wag');
  assert.deepEqual(asked, [{ trigger: 'idle', prev: undefined }]);
  // Asked again only after another gap, even if the last answer was a plan.
  assert.deepEqual(s.next([w], 5001, 12), []);
  assert.equal(asked.length, 1);
  assert.equal(s.next([w], 10_000, 12).length, 1);
});

test('the default gap is used when the widget declares none, and rnd picks within it', () => {
  const asked: unknown[] = [];
  const hi = new AnimationScheduler(() => 0.999999);
  const w = widget({ asked });
  hi.next([w], 0, 12);
  assert.deepEqual(hi.next([w], DEFAULT_GAP.minMs, 12), [], 'with a high rnd it is not due at the minimum');
  assert.equal(hi.next([w], DEFAULT_GAP.maxMs, 12).length, 1);
});

test('a null answer is fine and schedules the next question just the same', () => {
  const s = new AnimationScheduler(() => 0);
  const asked: unknown[] = [];
  const w = widget({ asked, answer: () => null, def: { animationGap: { minMs: 1000, maxMs: 1000 } } });
  s.next([w], 0, 12);
  assert.deepEqual(s.next([w], 1000, 12), []);
  assert.deepEqual(s.next([w], 1500, 12), []);
  assert.equal(asked.length, 1);
  assert.deepEqual(s.next([w], 2000, 12), []);
  assert.equal(asked.length, 2);
});

test('a change of data or of a source asks with trigger data and the previous state, without waiting for the gap', () => {
  const s = new AnimationScheduler(() => 0);
  const asked: { trigger: string; prev: { data: unknown; sources: Record<string, unknown> } }[] = [];
  const before = widget({ asked: asked as unknown[] });
  s.next([before], 0, 12);
  const afterData = widget({ asked: asked as unknown[], data: { n: 2 }, sources: before.sources });
  assert.equal(s.next([afterData], 100, 12).length, 1);
  assert.equal(asked[0]!.trigger, 'data');
  assert.equal(asked[0]!.prev.data, before.data);
  s.ended('w1', 200);
  // Same data again: nothing changed, nothing asked.
  assert.deepEqual(s.next([afterData], 300, 12), []);
  assert.equal(asked.length, 1);
  // A source replaced: asked, with the old source in prev.
  const afterSource = widget({ asked: asked as unknown[], data: afterData.data, sources: { 'a/b': { v: 2 } } });
  assert.equal(s.next([afterSource], 400, 12).length, 1);
  assert.equal(asked[1]!.trigger, 'data');
  assert.deepEqual(asked[1]!.prev.sources, { 'a/b': { v: 1 } });
});

test('the cooldown holds a data reaction back after an animation ended', () => {
  const s = new AnimationScheduler(() => 0);
  const asked: unknown[] = [];
  const w0 = widget({ asked, def: { animationCooldownMs: 10_000, animationGap: { minMs: 1e9, maxMs: 1e9 } } });
  s.next([w0], 0, 12);
  const w1 = { ...w0, data: { n: 2 } };
  assert.equal(s.next([w1], 100, 12).length, 1);
  s.ended('w1', 1000);
  const w2 = { ...w0, data: { n: 3 } };
  assert.deepEqual(s.next([w2], 5000, 12), [], 'within the cooldown');
  assert.equal(asked.length, 1);
  const w3 = { ...w0, data: { n: 4 } };
  assert.equal(s.next([w3], 11_000, 12).length, 1, 'after it');
});

test('an invalid plan is reported and ignored, and a widget that throws is just not animated', () => {
  const bad: string[] = [];
  const s = new AnimationScheduler(() => 0, (type, why) => bad.push(`${type}: ${why}`));
  const w = widget({ answer: () => plan({ frames: 1 }), def: { animationGap: { minMs: 0, maxMs: 0 } } });
  s.next([w], 0, 12);
  assert.deepEqual(s.next([w], 1, 12), []);
  assert.equal(bad.length, 1);
  assert.match(bad[0]!, /test\/cat: frames must be/);
});

test('by default one animation per call, the one that waited longest goes first, and the other keeps its turn', () => {
  const s = new AnimationScheduler(() => 0);
  const mk = (id: string, gap: number) => widget({ instanceId: id, def: { animationGap: { minMs: gap, maxMs: gap } } });
  const a = mk('a', 10), b = mk('b', 5);
  s.next([a, b], 0, 12);
  // Both are due at 20; b has been due since 5 and a since 10: b first, though a is first on the page.
  assert.deepEqual(s.next([a, b], 20, 12).map((d) => d.animatable.instanceId), ['b']);
  // a still has its question pending, and gets it next.
  assert.deepEqual(s.next([a, b], 21, 12).map((d) => d.animatable.instanceId), ['a']);
  // Not shown for a while: when it shows again it is a first sight, not asked.
  s.next([a], 30, 12);
  assert.deepEqual(s.next([b], 100, 12), []);
});

test('with a higher limit, several are asked at once', () => {
  const s = new AnimationScheduler(() => 0);
  const gap = { animationGap: { minMs: 10, maxMs: 10 } };
  const list = ['a', 'b', 'c'].map((id) => widget({ instanceId: id, def: gap }));
  s.next(list, 0, 12, 2);
  assert.deepEqual(s.next(list, 10, 12, 2).map((d) => d.animatable.instanceId), ['a', 'b']);
  assert.deepEqual(s.next(list, 11, 12, 2).map((d) => d.animatable.instanceId), ['c']);
});

test('a data change that has to wait its turn is not lost, and it keeps the state from before it', () => {
  const s = new AnimationScheduler(() => 0);
  const asked: { id: string; trigger: string; prev: { data: unknown } | undefined }[] = [];
  const mk = (id: string, n: number) => widget({ instanceId: id, data: { n }, def: { animationGap: { minMs: 1e9, maxMs: 1e9 } }, ask: (trigger, _rnd, prev) => { asked.push({ id, trigger, prev }); return plan(); } } as Partial<Animatable>);
  s.next([mk('a', 1), mk('b', 1)], 0, 12);
  const changed = [mk('a', 2), mk('b', 2)];
  const first = s.next(changed, 100, 12);
  assert.equal(first.length, 1);
  // Same data now, nothing new changed, but the second widget's reaction is still owed.
  const second = s.next(changed, 200, 12);
  assert.equal(second.length, 1);
  assert.notEqual(second[0]!.animatable.instanceId, first[0]!.animatable.instanceId);
  assert.deepEqual(asked.map((x) => x.trigger), ['data', 'data']);
  assert.deepEqual((asked[1]!.prev!.data as { n: number }).n, 1, 'what it had before the change, not the same data');
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalize } from '../config/normalize.ts';
import { planThreads } from './plan.ts';

const cfg = (threads: unknown, screens: Record<string, unknown>[]) => normalize({ threads, screens });
const plan = (c: ReturnType<typeof cfg>, cores: number) => Object.fromEntries([...planThreads(c, cores)].map(([id, x]) => [id, `${x.thread ? 'thread' : 'main'} ${x.why}`]));

test('threads: auto gives each screen a thread with two or more on and a core for each plus one', () => {
  const three = cfg(undefined, [{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
  assert.deepEqual(plan(three, 4), { a: 'thread auto', b: 'thread auto', c: 'thread auto' });
  assert.deepEqual(plan(three, 3), { a: 'main fewCores', b: 'main fewCores', c: 'main fewCores' });
  assert.deepEqual(plan(cfg('auto', [{ id: 'a' }]), 16), { a: 'main fewScreens' });
  // A switched-off screen neither counts nor gets one.
  assert.deepEqual(plan(cfg(undefined, [{ id: 'a' }, { id: 'b', enabled: false }]), 16), { a: 'main fewScreens', b: 'main off' });
});

test('threads: always and never, everywhere or per screen; the screen says last', () => {
  assert.deepEqual(plan(cfg('never', [{ id: 'a' }, { id: 'b' }]), 16), { a: 'main setting', b: 'main setting' });
  assert.deepEqual(plan(cfg('always', [{ id: 'a' }]), 1), { a: 'thread setting' }, 'always is always, even with one screen and one core');
  assert.deepEqual(plan(cfg('never', [{ id: 'a', thread: 'always' }, { id: 'b' }]), 16), { a: 'thread always', b: 'main setting' });
  // One left on the main thread (no animations there) and the other two on threads of their own.
  assert.deepEqual(plan(cfg('auto', [{ id: 'a', thread: 'never' }, { id: 'b' }, { id: 'c' }]), 4), { a: 'main never', b: 'thread auto', c: 'thread auto' });
  // The forced ones take their cores first.
  assert.deepEqual(plan(cfg('auto', [{ id: 'a', thread: 'always' }, { id: 'b' }, { id: 'c' }]), 3), { a: 'thread always', b: 'main fewCores', c: 'main fewCores' });
});

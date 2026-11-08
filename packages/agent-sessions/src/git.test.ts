import { test } from 'node:test';
import assert from 'node:assert';
import { repoRootCache } from './git.ts';

test('Repo root: asked once per directory', async () => {
  let calls = 0;
  const root = repoRootCache(async () => (calls++, '/srv/app\n'));
  assert.strictEqual(await root('/srv/app/apps/server/src'), '/srv/app');
  assert.strictEqual(await root('/srv/app/apps/server/src'), '/srv/app');
  assert.strictEqual(calls, 1);
});

test('Repo root: non-repos are remembered, but only for a while', async () => {
  let calls = 0, t = 0;
  const root = repoRootCache(async () => (calls++, null), () => t);
  assert.strictEqual(await root('/tmp/x'), null);
  assert.strictEqual(await root('/tmp/x'), null);
  assert.strictEqual(calls, 1);
  t += 11 * 60_000; // someone may have run git init
  await root('/tmp/x');
  assert.strictEqual(calls, 2);
});

test('HEAD: branch, detached and per-minute cache', async () => {
  const { headCache, parseHead } = await import('./git.ts');
  assert.deepStrictEqual(parseHead('1700000000\nHEAD -> main, origin/main\n'), { detached: false, lastCommit: 1700000000000 });
  assert.deepStrictEqual(parseHead('1700000000\nHEAD, tag: v1\n'), { detached: true, lastCommit: 1700000000000 });
  assert.strictEqual(parseHead(''), null);
  let calls = 0, t = 0;
  const head = headCache(async () => (calls++, '1\nHEAD -> x'), 60_000, () => t);
  await head('/r');
  await head('/r');
  t = 61_000;
  await head('/r');
  assert.strictEqual(calls, 2);
});

test('git status --porcelain: count and paths, renames keep the new path', async () => {
  const { parseStatus } = await import('./git.ts');
  assert.deepStrictEqual(parseStatus(' M src/a.ts\nR  old.ts -> new.ts\n?? "with space.ts"\n\n'), { count: 3, files: ['src/a.ts', 'new.ts', 'with space.ts'] });
});

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

test('git status: one run per repository every few seconds, whatever the sessions in it and the reloads', async () => {
  const { createGitEnricher, STATUS_TTL_MS } = await import('./git.ts');
  const { mkdtempSync, mkdirSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const repo = mkdtempSync(join(tmpdir(), 'as-git-'));
  mkdirSync(join(repo, 'sub'));
  const other = mkdtempSync(join(tmpdir(), 'as-git-'));
  const calls: string[] = [];
  let t = 1_000_000;
  let dirty = ' M a.ts\n';
  const enrich = createGitEnricher((args) => async (cwd) => {
    if (args[0] === 'status') {
      calls.push(cwd);
      return dirty;
    }
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return cwd.startsWith(repo) ? repo : null;
    return null;
  }, () => t);
  const rec = (id: string, cwd: string) => ({ schemaVersion: 1 as const, session_id: id, provider: 'claude', state: 'active' as const, detail: '', project: 'x', cwd, since: 0, updated: 0, event: 'x' });
  const reload = () => Promise.all([rec('a', repo), rec('b', repo), rec('c', join(repo, 'sub')), rec('d', other)].map((r) => enrich(r)));
  const first = await reload();
  assert.deepStrictEqual(first.map((s) => s.dirty), [1, 1, 1, 1]);
  assert.deepStrictEqual(first[2]!.dirtyFiles, ['a.ts']);
  assert.deepStrictEqual(calls.sort(), [other, repo].sort(), 'the repository once (its root), the other directory once');
  // Reloads within the TTL (the hook writing on every tool call): no git.
  dirty = '';
  for (let i = 0; i < 5; i++) {
    t += 2000;
    await reload();
  }
  assert.strictEqual(calls.length, 2);
  // After it, what changed shows.
  t += STATUS_TTL_MS;
  const later = await reload();
  assert.deepStrictEqual(later.map((s) => s.dirty), [0, 0, 0, 0]);
  assert.strictEqual(calls.length, 4);
  assert.ok(STATUS_TTL_MS <= 30_000, 'the uncommitted count follows within seconds');
});

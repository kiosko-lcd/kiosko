import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadSessions, resolveDir, watchSessions } from './source.ts';
import type { SessionsData } from './types.ts';

const record = (id: string, state: string, updatedAgo: number, now: number) => ({
  schemaVersion: 1,
  session_id: id,
  provider: 'claude',
  state,
  detail: 'Bash: npm test',
  project: id,
  since: now - updatedAgo,
  updated: now - updatedAgo,
  event: 'PreToolUse',
});

function dirWith(records: object[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'agents-src-'));
  for (const r of records) writeFileSync(join(dir, `${(r as { session_id: string }).session_id}.json`), JSON.stringify(r));
  writeFileSync(join(dir, 'broken.json'), '{ half written');
  return dir;
}

test('resolveDir: expands ~ and falls back to the protocol default', () => {
  assert.equal(resolveDir('~/.aimonitor/sessions', '/home/u'), '/home/u/.aimonitor/sessions');
  assert.equal(resolveDir('~', '/home/u'), '/home/u');
  assert.equal(resolveDir('/srv/sessions', '/home/u'), '/srv/sessions');
  assert.ok(resolveDir('  ').length > 0);
});

test('loadSessions: drops zombies and stale records, deletes them when reaping', async () => {
  const now = Date.now();
  const dir = dirWith([record('alive', 'active', 60_000, now), record('zombie', 'active', 40 * 60_000, now), record('waits', 'permission', 50 * 60_000, now), record('stale', 'ready', 5 * 3_600_000, now)]);
  try {
    const opts = { dir, zombieMs: 15 * 60_000, staleMs: 2 * 3_600_000, reap: false };
    const kept = await loadSessions(opts, undefined, now);
    assert.deepEqual(kept.map((s) => s.session_id).sort(), ['alive', 'waits']);
    assert.ok(existsSync(join(dir, 'zombie.json')), 'without reap nothing is deleted');
    const reaped: string[] = [];
    await loadSessions({ ...opts, reap: true }, undefined, now, (r) => reaped.push(r.session_id));
    assert.deepEqual(reaped.sort(), ['stale', 'zombie']);
    assert.ok(!existsSync(join(dir, 'zombie.json')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadSessions: a missing directory is no sessions, not an error', async () => {
  assert.deepEqual(await loadSessions({ dir: join(tmpdir(), 'agents-src-missing-xyz'), zombieMs: 1, staleMs: 1, reap: true }), []);
});

test('watchSessions: emits at start and again when a session file changes', async () => {
  const now = Date.now();
  const dir = dirWith([record('one', 'active', 1000, now)]);
  const seen: SessionsData[] = [];
  const stop = watchSessions({ dir, git: false, zombieMs: 15 * 60_000, staleMs: 3_600_000, reap: false, debounceMs: 20, pollMs: 60_000 }, { emit: (d) => seen.push(d), log: () => {} });
  try {
    const until = async (pred: () => boolean) => {
      for (let i = 0; i < 100 && !pred(); i++) await new Promise((r) => setTimeout(r, 20));
      assert.ok(pred());
    };
    await until(() => seen.length >= 1);
    assert.equal(seen[0]!.sessions.length, 1);
    writeFileSync(join(dir, 'two.json'), JSON.stringify(record('two', 'permission', 0, Date.now())));
    await until(() => seen.some((d) => d.sessions.length === 2));
  } finally {
    stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

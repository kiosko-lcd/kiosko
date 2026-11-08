import { test } from 'node:test';
import assert from 'node:assert';
import { claims, order, pruneZombies } from './select.ts';
import { SCHEMA_VERSION, type SessionRecord, type SessionState } from './protocol.ts';

const t0 = Date.now();
const rec = (id: string, state: SessionState, sinceAgo: number, updatedAgo = sinceAgo): SessionRecord => ({
  schemaVersion: SCHEMA_VERSION, session_id: id, provider: 'claude', state, detail: '', project: 'p',
  since: t0 - sinceAgo, updated: t0 - updatedAgo, event: 'Notification',
});

test('claims: permission, waiting and ready ask for the operator; active and idle do not', () => {
  assert.deepStrictEqual((['permission', 'waiting', 'ready', 'active', 'idle'] as const).map((s) => claims(rec('x', s, 0))), [true, true, true, false, false]);
});

test('pruneZombies: a silent active session dies soon; one waiting for you does not', () => {
  const pruned = pruneZombies([rec('fresh', 'active', 5000), rec('silent', 'active', 60000, 45000), rec('asking', 'permission', 60000, 45000)], t0, 30000, 3600_000);
  assert.deepStrictEqual(pruned.map((r) => r.session_id), ['fresh', 'asking']);
});

test('pruneZombies: an orphan record goes eventually, whatever its state', () => {
  // SessionEnd does not arrive if the terminal is killed or the machine sleeps.
  const old = 10 * 3600_000;
  const pruned = pruneZombies([rec('a', 'ready', old), rec('b', 'idle', old), rec('c', 'permission', old), rec('recent', 'ready', 60000)], t0, 15 * 60_000, 2 * 3600_000);
  assert.deepStrictEqual(pruned.map((r) => r.session_id), ['recent']);
});

test('order: claiming first by urgency, the longest waiting first; then the most recent activity', () => {
  const sorted = order([rec('w10', 'waiting', 10000), rec('p5', 'permission', 5000), rec('w20', 'waiting', 20000), rec('a1', 'active', 1000, 1000), rec('a0', 'active', 500, 500)]);
  assert.deepStrictEqual(sorted.map((r) => r.session_id), ['p5', 'w20', 'w10', 'a0', 'a1']);
});

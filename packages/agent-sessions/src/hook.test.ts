import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, readFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleEvent, runHook } from './hook.ts';
import { isSessionRecord, type SessionRecord } from './protocol.ts';
import { readSessions, reap } from './reader.ts';

const cwd = '/work/repo';
const ev = (o: Record<string, unknown>) => ({ session_id: 's1', cwd, ...o });

/**
 * Conformance: a whole Claude Code session, event by event, with the state and
 * signals each one must leave. A new provider adapter should be able to replay
 * the same story from its own payloads.
 */
const STORY: [Record<string, unknown>, Partial<SessionRecord>][] = [
  [ev({ hook_event_name: 'SessionStart', source: 'startup' }), { state: 'idle', detail: 'Startup' }],
  [ev({ hook_event_name: 'UserPromptSubmit', prompt: 'fix the tests, token ghp_abcdefghijklmnopqrstuvwxyz0123456789' }), { state: 'active', detail: 'fix the tests, token <hidden>' }],
  [ev({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' } }), { state: 'active', detail: 'Bash: npm test' }],
  [ev({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: { stdout: 'ℹ fail 1', exit_code: 1 } }), { testsFailed: true, lastFailed: true, failStreak: 1 }],
  [ev({ hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'git rebase main' } }), { failStreak: 2 }],
  [ev({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/a.ts', new_string: '// TODO: x\n// FIXME y' } }), { todos: 2, files: [join(cwd, 'src/a.ts')] }],
  [ev({ hook_event_name: 'Notification', notification_type: 'permission_prompt' }), { state: 'permission', detail: 'Permission prompt' }],
  [ev({ hook_event_name: 'Notification', notification_type: 'idle_prompt' }), { state: 'waiting', detail: 'Idle prompt' }],
  [ev({ hook_event_name: 'Stop', last_assistant_message: 'Done.' }), { state: 'ready', detail: 'Done.' }],
  [ev({ hook_event_name: 'UserPromptSubmit', prompt: 'thanks' }), { state: 'active' }],
  [ev({ hook_event_name: 'Stop', last_assistant_message: 'You are welcome.' }), { talkStreak: 1 }],
  [ev({ hook_event_name: 'UserPromptSubmit', prompt: 'one more thing' }), {}],
  [ev({ hook_event_name: 'Stop', last_assistant_message: 'Sure.' }), { talkStreak: 2, duck: true }],
  [ev({ hook_event_name: 'PreCompact' }), { state: 'active', detail: 'Compacting context' }],
  // Resuming or compacting keeps what the session has accumulated.
  [ev({ hook_event_name: 'SessionStart', source: 'compact' }), { state: 'active', duck: true, todos: 2 }],
  [ev({ hook_event_name: 'SessionStart', source: 'resume' }), { state: 'idle', duck: true, todos: 2 }],
  // A real new start (or /clear) resets it.
  [ev({ hook_event_name: 'SessionStart', source: 'clear' }), { state: 'idle', duck: undefined, todos: undefined, testsFailed: undefined, failStreak: undefined }],
];

test('hook: a whole session, event by event (conformance)', () => {
  let prev: SessionRecord | null = null;
  let now = 1_000_000;
  for (const [data, want] of STORY) {
    now += 1000;
    const out = handleEvent('claude', data, prev, now);
    assert.ok('record' in out);
    const rec = out.record;
    assert.ok(isSessionRecord(rec), `${String(data.hook_event_name)}: valid record`);
    for (const [k, v] of Object.entries(want)) assert.deepStrictEqual(rec[k as keyof SessionRecord], v, `${String(data.hook_event_name)}: ${k}`);
    prev = rec;
  }
});

test('hook: `since` is kept while the state does not change', () => {
  const a = handleEvent('claude', ev({ hook_event_name: 'PreToolUse', tool_name: 'Read' }), null, 1000);
  assert.ok('record' in a);
  const b = handleEvent('claude', ev({ hook_event_name: 'PostToolUse', tool_name: 'Read' }), a.record, 5000);
  assert.ok('record' in b);
  assert.strictEqual(b.record.since, 1000);
  const c = handleEvent('claude', ev({ hook_event_name: 'Stop' }), b.record, 9000);
  assert.ok('record' in c);
  assert.strictEqual(c.record.since, 9000);
});

test('hook: SessionEnd removes the record; runHook writes and deletes the file atomically', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sessions-'));
  runHook(JSON.stringify(ev({ hook_event_name: 'UserPromptSubmit', prompt: 'hi' })), 'gemini', dir, 1000);
  const file = join(dir, 's1.json');
  const rec = JSON.parse(readFileSync(file, 'utf8')) as SessionRecord;
  assert.strictEqual(rec.provider, 'gemini');
  assert.deepStrictEqual(readdirSync(dir), ['s1.json'], 'no temporary file left behind');
  runHook('not json', 'claude', dir);
  runHook('', 'claude', dir);
  assert.ok(existsSync(file), 'garbage input changes nothing');
  runHook(JSON.stringify(ev({ hook_event_name: 'SessionEnd' })), 'claude', dir);
  assert.ok(!existsSync(file));
});

test('reader: skips broken and foreign files; reap deletes the dead ones', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sessions-'));
  runHook(JSON.stringify({ session_id: 'live', cwd, hook_event_name: 'Stop' }), 'claude', dir, 10_000);
  runHook(JSON.stringify({ session_id: 'dead', cwd, hook_event_name: 'PreToolUse', tool_name: 'Read' }), 'claude', dir, 1_000);
  writeFileSync(join(dir, 'half.json'), '{"session_id": "ha');
  writeFileSync(join(dir, 'old.json'), JSON.stringify({ session_id: 'old', state: 'listo' }));
  const all = readSessions(dir);
  assert.deepStrictEqual(all.map((r) => r.session_id).sort(), ['dead', 'live']);
  const reaped: string[] = [];
  const alive = reap(all, 20_000, { zombieMs: 5_000, staleMs: 60_000 }, dir, (r) => reaped.push(r.session_id));
  assert.deepStrictEqual(alive.map((r) => r.session_id), ['live']);
  assert.deepStrictEqual(reaped, ['dead']);
  assert.ok(!existsSync(join(dir, 'dead.json')));
  assert.deepStrictEqual(readSessions(join(dir, 'missing')), []);
});

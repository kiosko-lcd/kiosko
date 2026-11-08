/**
 * The hook: turns one event from an AI coding CLI into the session's record.
 *
 * It runs on the path of every tool call, so: no network, no heavy imports,
 * and it never fails loudly. `handleEvent` is the pure part (state machine and
 * counters); `runHook` adds reading the previous record and the atomic write.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { todosAdded } from './craft.ts';
import { defaultSessionsDir, sessionFile } from './paths.ts';
import { SCHEMA_VERSION, TALKS_TO_DUCK, type SessionRecord, type SessionState } from './protocol.ts';
import { adapterFor } from './providers.ts';
import { redact } from './redact.ts';
import { commandFailed, testOutcome } from './testsignal.ts';
import { touchedFiles } from './touched.ts';

/** Field of `tool_input` that best identifies the call, by tool. */
const TOOL_ARG_KEYS = ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'prompt'] as const;

/** Summarises `tool_input` into a readable fragment. */
function summarizeToolInput(input: unknown): string {
  if (typeof input === 'string') return input;
  if (typeof input !== 'object' || input === null) return '';
  const obj = input as Record<string, unknown>;
  for (const key of TOOL_ARG_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return '';
}

/** `permission_prompt` → `Permission prompt`. */
function humanize(value: string): string {
  const spaced = value.replace(/[_-]+/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Storage cap, not a display one: clients know their real width and can wrap
 * over several lines; cutting here at one line's length would lose the rest
 * for good. Secrets are redacted **before** cutting, so that an ellipsis can
 * never leave half a secret in sight.
 */
function truncate(text: string, max = 240): string {
  const flat = redact(text).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export type HookResult = { remove: true; sessionId: string } | { record: SessionRecord };

/**
 * The new record for this event, given the previous one (or that the session
 * ended). `since` is kept while the state does not change: clients show "how
 * long has it been waiting", which would reset on every event otherwise.
 */
export function handleEvent(provider: string, data: Record<string, any>, prev: SessionRecord | null, now: number, cwd = process.cwd()): HookResult {
  const e = adapterFor(provider).normalize(data, cwd);
  const event = e.event;
  if (event === 'SessionEnd') return { remove: true, sessionId: e.sessionId };

  // SessionStart also arrives on resume and right after compacting the
  // context: the session is the same one and must not lose what it has
  // accumulated (duck, streaks, TODOs). Only a real start or a `/clear` resets.
  const source = e.source.toLowerCase();
  const continued = event === 'SessionStart' && (source === 'compact' || source === 'resume');

  let state: SessionState = 'active';
  let detail = '';
  switch (event) {
    case 'SessionStart':
      state = source === 'compact' ? 'active' : 'idle';
      detail = humanize(e.source);
      break;
    case 'PreCompact':
      detail = 'Compacting context';
      break;
    case 'UserPromptSubmit':
      detail = e.prompt;
      break;
    case 'PreToolUse':
    case 'PostToolUse':
    case 'PostToolUseFailure': {
      const arg = summarizeToolInput(e.toolInput);
      detail = arg ? `${e.tool}: ${arg}` : e.tool;
      break;
    }
    case 'Notification': {
      // Documented matchers: permission_prompt | idle_prompt | auth_success |
      // elicitation_* | agent_*.
      const kind = e.notification.toLowerCase();
      if (kind.includes('permission') || kind.includes('elicitation')) state = 'permission';
      else if (kind.includes('idle') || kind.includes('wait')) state = 'waiting';
      detail = humanize(e.notification);
      break;
    }
    case 'Stop':
    case 'SubagentStop':
      state = 'ready';
      detail = e.lastMessage;
      break;
    default:
      detail = e.fallback;
  }

  const record: SessionRecord = {
    schemaVersion: SCHEMA_VERSION,
    session_id: e.sessionId,
    provider: adapterFor(provider).name,
    state,
    detail: truncate(detail),
    project: basename(e.cwd),
    cwd: e.cwd,
    since: prev && prev.state === state && typeof prev.since === 'number' ? prev.since : now,
    updated: now,
    event: event || 'Unknown',
  };
  const files = touchedFiles(prev?.files, event, e.tool, e.toolInput, e.cwd);
  if (files?.length) record.files = files;
  record.started = event === 'SessionStart' && !continued ? now : prev?.started ?? prev?.since ?? now;
  // Red tests are remembered until the next run; a new session starts clean.
  const outcome = testOutcome(event, e.tool, e.toolInput, e.toolResponse);
  const failed = outcome ? outcome === 'fail' : event === 'SessionStart' && !continued ? false : prev?.testsFailed;
  if (failed) record.testsFailed = true;
  const bad = commandFailed(event, e.tool, e.toolInput, e.toolResponse);
  if (bad ?? (event === 'PreToolUse' ? false : prev?.lastFailed)) record.lastFailed = true;
  const fresh = event === 'SessionStart' && !continued;
  const streak = bad === true ? (prev?.failStreak ?? 0) + 1 : bad === false || fresh ? 0 : prev?.failStreak ?? 0;
  if (streak) record.failStreak = streak;
  // A turn ends with Stop; any tool call in between resets the talk streak.
  const talk = fresh || event === 'PreToolUse' ? 0 : event === 'Stop' ? (prev?.talkStreak ?? 0) + (prev?.event === 'UserPromptSubmit' ? 1 : 0) : prev?.talkStreak ?? 0;
  if (talk) record.talkStreak = talk;
  if (!fresh && (talk >= TALKS_TO_DUCK || prev?.duck)) record.duck = true;
  const compactAt = event === 'PreCompact' ? now : fresh ? undefined : prev?.compactAt;
  if (compactAt) record.compactAt = compactAt;
  const todos = (fresh ? 0 : prev?.todos ?? 0) + (event === 'PostToolUse' ? todosAdded(e.tool, e.toolInput) : 0);
  if (todos) record.todos = todos;
  return { record };
}

/** The previous record, if it is readable. */
function previous(path: string): SessionRecord | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as SessionRecord;
  } catch {
    return null;
  }
}

/** `--provider <name>` from the command line; `claude` by default. */
export function providerFromArgs(argv: string[]): string {
  const i = argv.indexOf('--provider');
  return i >= 0 && argv[i + 1] ? argv[i + 1]!.toLowerCase() : 'claude';
}

/**
 * Applies one event (the JSON text a CLI sends on stdin) to the sessions
 * directory. The write is atomic (temporary file in the same directory, then
 * rename), so readers never see half a JSON file.
 *
 * Returns what it did, so a wrapper can also keep its own log of the event;
 * null when the input was empty or not JSON.
 */
export function runHook(input: string, provider: string, dir = defaultSessionsDir(), now = Date.now()): HookResult | null {
  const text = input.trim();
  if (!text) return null;
  let data: Record<string, any>;
  try {
    data = JSON.parse(text);
  } catch {
    return null; // Not JSON: ignore quietly.
  }
  const id = adapterFor(provider).normalize(data, process.cwd()).sessionId;
  const path = sessionFile(dir, id);
  const result = handleEvent(provider, data, previous(path), now);
  if ('remove' in result) {
    rmSync(path, { force: true });
    return result;
  }
  mkdirSync(dir, { recursive: true });
  const temp = join(dir, `.${id}.${process.pid}.tmp`);
  try {
    writeFileSync(temp, JSON.stringify(result.record, null, 2), 'utf8');
    renameSync(temp, path);
  } catch {
    rmSync(temp, { force: true });
  }
  return result;
}

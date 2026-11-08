/**
 * The session protocol: what a hook writes for each AI coding session, one
 * JSON file per session, and what any client (a panel, a status bar, a
 * microcontroller) can read. `schema/session-record.schema.json` describes the
 * same record for clients in other languages.
 */

/** Version of the record format. Bumped on any incompatible change. */
export const SCHEMA_VERSION = 1;

/** The CLIs this package knows how to read events from (see providers.ts). */
export type KnownProvider = 'claude' | 'gemini';
/** A provider name; known ones get their event names translated. */
export type Provider = KnownProvider | (string & {});

/**
 * What the session needs from you, from most to least urgent:
 *
 *   - `permission`: blocked on a permission prompt;
 *   - `waiting`: idle, waiting for your input;
 *   - `ready`: finished its turn;
 *   - `active`: working;
 *   - `idle`: just started (or resumed), nothing asked yet.
 */
export type SessionState = 'permission' | 'waiting' | 'ready' | 'active' | 'idle';

export const SESSION_STATES: readonly SessionState[] = ['permission', 'waiting', 'ready', 'active', 'idle'];

/** Higher = more urgent. Decides which session leads. */
export const STATE_PRIORITY: Readonly<Record<SessionState, number>> = {
  permission: 4,
  waiting: 3,
  ready: 2,
  active: 1,
  idle: 0,
};

/** States in which the session is asking for the operator. */
export const CLAIMS: ReadonlySet<SessionState> = new Set<SessionState>(['permission', 'waiting', 'ready']);

/** Consecutive talk-only turns (no tools) that set `duck`. */
export const TALKS_TO_DUCK = 2;

/** One session, as the hook writes it to `<sessions dir>/<session_id>.json`. */
export interface SessionRecord {
  schemaVersion: typeof SCHEMA_VERSION;
  session_id: string;
  provider: Provider;
  state: SessionState;
  /** Tool call or message, secrets redacted, at most 240 characters. */
  detail: string;
  /** Basename of `cwd`. */
  project: string;
  /** Full working directory of the session. */
  cwd?: string;
  /** When it entered the current state, ms epoch. Kept while the state does not change. */
  since: number;
  /** When the session started, ms epoch. */
  started?: number;
  /** Last write, ms epoch. */
  updated: number;
  /** Name of the hook event that produced the record. */
  event: string;
  /** Files the session edited or wrote, absolute, most recent first (at most 20). */
  files?: string[];
  /** The last shell command failed. */
  lastFailed?: boolean;
  /** Consecutive failed shell commands. */
  failStreak?: number;
  /** Consecutive turns with talk only, no tools. */
  talkStreak?: number;
  /** `talkStreak` reached `TALKS_TO_DUCK` at some point in this session. */
  duck?: boolean;
  /** Last context compaction (PreCompact), ms epoch. */
  compactAt?: number;
  /** TODO/FIXME added during the session. */
  todos?: number;
  /** The last test run of the session failed (see testsignal.ts). */
  testsFailed?: boolean;
}

/** Does `x` look like a record of this schema version? Checks the fields clients rely on. */
export function isSessionRecord(x: unknown): x is SessionRecord {
  if (typeof x !== 'object' || x === null) return false;
  const r = x as Record<string, unknown>;
  return (
    r.schemaVersion === SCHEMA_VERSION &&
    typeof r.session_id === 'string' &&
    typeof r.provider === 'string' &&
    SESSION_STATES.includes(r.state as SessionState) &&
    typeof r.detail === 'string' &&
    typeof r.project === 'string' &&
    typeof r.since === 'number' &&
    typeof r.updated === 'number' &&
    typeof r.event === 'string'
  );
}

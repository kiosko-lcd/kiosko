/**
 * Reading the sessions directory, for clients.
 */
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { defaultSessionsDir, sessionFile } from './paths.ts';
import { isSessionRecord, type SessionRecord } from './protocol.ts';
import { pruneZombies } from './select.ts';

/**
 * Every valid record in the directory. Files that are half-written,
 * unreadable or of another schema version are skipped, never thrown.
 */
export function readSessions(dir = defaultSessionsDir()): SessionRecord[] {
  if (!existsSync(dir)) return [];
  const out: SessionRecord[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const rec: unknown = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      if (isSessionRecord(rec)) out.push(rec);
    } catch {
      // Skip it: the hook rewrites it on the next event.
    }
  }
  return out;
}

export interface ReapOptions {
  /** An `active` session silent for longer than this is dead. */
  zombieMs: number;
  /** Any session silent for longer than this is dead, whatever its state. */
  staleMs: number;
}

/**
 * Drops dead sessions **and deletes their files**. `SessionEnd` does not
 * arrive when a terminal is killed or the machine sleeps; without this, those
 * records would stay forever. Deleting is safe: if the session is alive after
 * all, its next event writes the file again. Returns the live ones.
 */
export function reap<T extends SessionRecord>(records: T[], now: number, o: ReapOptions, dir = defaultSessionsDir(), onReap: (r: T) => void = () => {}): T[] {
  const alive = pruneZombies(records, now, o.zombieMs, o.staleMs);
  if (alive.length === records.length) return alive;
  const keep = new Set(alive.map((r) => r.session_id));
  for (const r of records) {
    if (keep.has(r.session_id)) continue;
    try {
      rmSync(sessionFile(dir, r.session_id), { force: true });
      onReap(r);
    } catch {
      // Filtering it out is enough to show the right thing.
    }
  }
  return alive;
}

/**
 * Generic choices any client makes over a set of sessions.
 */
import { CLAIMS, STATE_PRIORITY, type SessionRecord } from './protocol.ts';

type Timed = Pick<SessionRecord, 'state' | 'since' | 'updated'>;

/** Is this session asking for the operator? */
export function claims(r: Pick<SessionRecord, 'state'>): boolean {
  return CLAIMS.has(r.state);
}

/**
 * Drops sessions that no longer exist. There are two deadlines because the
 * signals differ: an `active` session says it is working, so a silent one is
 * dead soon; the others legitimately wait for the operator and deserve much
 * more slack, but not eternity.
 */
export function pruneZombies<T extends Timed>(records: T[], now: number, zombieMs: number, staleMs: number): T[] {
  return records.filter((r) => now - r.updated <= (r.state === 'active' ? zombieMs : staleMs));
}

/**
 * Display order: first the ones asking for you, by state priority and, within
 * a state, the one waiting longest. Then the rest, most recent activity first.
 */
export function order<T extends Timed>(records: T[]): T[] {
  return [...records].sort((a, b) => {
    const ca = claims(a) ? 1 : 0;
    const cb = claims(b) ? 1 : 0;
    if (ca !== cb) return cb - ca;
    const pa = STATE_PRIORITY[a.state];
    const pb = STATE_PRIORITY[b.state];
    if (pa !== pb) return pb - pa;
    if (ca === 1) return a.since - b.since;
    return b.updated - a.updated;
  });
}

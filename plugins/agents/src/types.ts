/**
 * What the agents plugin passes around. The session protocol itself (states,
 * the record the hook writes) lives in @loksly/agent-sessions; this adds what
 * the panel paints.
 */
import type { EnrichedSession } from '@loksly/agent-sessions/git';

export type { Provider, SessionState } from '@loksly/agent-sessions';

/**
 * One tile: the session as the hook writes it, plus what git says about it
 * (see EnrichedSession). `startsAt` turns it into a meeting tile, so a
 * calendar source can reuse the same ordering, weights and layout; the
 * sessions source never sets it.
 */
export interface SessionView extends EnrichedSession {
  /** A meeting: the big number counts down to this instant instead of up. */
  startsAt?: number;
  /** End of the meeting, ms epoch. */
  endsAt?: number;
}

/** Data of the `agents/sessions` source. */
export interface SessionsData {
  sessions: SessionView[];
}

/** Visual weight of a tile. At most one is `solid`. */
export type Weight = 'solid' | 'marked' | 'quiet';

/** Full type of the shared source, as widgets declare it. */
export const SESSIONS_SOURCE = 'agents/sessions';

/** The sessions handed to a widget, or none if the source has no data yet. */
export function sessionsOf(sources: Record<string, unknown>): SessionView[] {
  const data = sources[SESSIONS_SOURCE] as Partial<SessionsData> | undefined;
  return Array.isArray(data?.sessions) ? data.sessions : [];
}

/** A session is blocked on a permission prompt: the one thing that can't wait. */
export function needsPermission(sessions: SessionView[]): boolean {
  return sessions.some((s) => s.state === 'permission');
}

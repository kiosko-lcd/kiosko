/**
 * What the scene paints. A session is the record the agent hook writes, plus
 * what git says about its working directory (`EnrichedSession`, read by the
 * `agents/sessions` source) and, for calendar meetings travelling as one more
 * session, their start and end.
 */
import type { EnrichedSession } from '@loksly/agent-sessions/git';

export type { Provider, SessionState } from '@loksly/agent-sessions';

export interface SessionView extends EnrichedSession {
  /** Present when the "session" is a meeting: when it starts, ms epoch. */
  startsAt?: number;
  /** End of the meeting, ms epoch. */
  endsAt?: number;
}

/** Data of the `agents/sessions` source. */
export interface SessionsData {
  sessions: SessionView[];
}

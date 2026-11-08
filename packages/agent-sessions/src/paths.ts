import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Where session files live: `$AGENT_SESSIONS_DIR`, or `sessions/` inside
 * `$AIMONITOR_DIR` (default `~/.aimonitor`), where the first client of this
 * protocol has always kept them.
 */
export function defaultSessionsDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.AGENT_SESSIONS_DIR ?? join(env.AIMONITOR_DIR ?? join(homedir(), '.aimonitor'), 'sessions');
}

/** The file of one session. */
export function sessionFile(dir: string, sessionId: string): string {
  return join(dir, `${sessionId}.json`);
}

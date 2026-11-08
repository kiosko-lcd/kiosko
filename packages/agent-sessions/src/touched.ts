/**
 * Files a session has touched, so that a client can tell when two sessions
 * step on each other. Called by the hook on every event, so it is pure and
 * cheap: no I/O, it only merges the event into the previous list.
 */
import { isAbsolute, join } from 'node:path';

/** Cap of the list: enough to spot recent clashes without bloating the JSON. */
export const MAX_FILES = 20;

/** Tools that write, from Claude Code and Gemini CLI. */
const WRITERS = /^(edit|multiedit|write|notebookedit|write_file|replace|edit_file)$/i;

/**
 * The list after this event, or the previous one unchanged. Emptied when a
 * session starts: a new session has touched nothing yet, and inheriting the
 * previous list would report phantom clashes.
 */
export function touchedFiles(prev: string[] | undefined, event: string, tool: string, input: unknown, cwd: string): string[] | undefined {
  if (event === 'SessionStart') return undefined;
  if (event !== 'PreToolUse' && event !== 'PostToolUse') return prev;
  if (!WRITERS.test(tool)) return prev;
  if (typeof input !== 'object' || input === null) return prev;
  const o = input as Record<string, unknown>;
  const raw = [o.file_path, o.notebook_path, o.path].find((v): v is string => typeof v === 'string' && v.length > 0);
  if (!raw) return prev;
  const file = isAbsolute(raw) ? raw : join(cwd, raw);
  return [file, ...(prev ?? []).filter((f) => f !== file)].slice(0, MAX_FILES);
}

/**
 * `kiosko editor`: opens the editor of the Kiosko running on this computer
 * in the browser, at the address and port of its config (`server`), or says
 * how to start it when nothing answers there.
 *
 *   kiosko editor [--print] [--port 7420] [--host 127.0.0.1] [--config file]
 */
import type { Config } from '@kiosko/core';

/** The editor's address for a config's `server` (or the flags): a wildcard host is reached at 127.0.0.1. */
export function editorUrl(server: Config['server'], over: { host?: string; port?: string } = {}): string {
  let host = over.host ?? server.host;
  if (host === '0.0.0.0' || host === '') host = '127.0.0.1';
  if (host === '::') host = '::1';
  const port = Number(over.port ?? server.port);
  return `http://${host.includes(':') ? `[${host}]` : host}:${port}/`;
}

/** The version of the Kiosko answering at `url`, or null if none does (soon: it is local). */
export async function runningAt(url: string, timeoutMs = 1500): Promise<string | null> {
  try {
    const res = await fetch(new URL('api/state', url), { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === 'string' ? body.version : null;
  } catch {
    return null;
  }
}

export interface EditorCommand {
  server: Config['server'];
  flags: { host?: string; port?: string; print: boolean };
  open: (url: string) => void;
  log: (line: string) => void;
}

/** Exit code: 0 opened (or printed), 1 nothing running there. */
export async function editorCommand({ server, flags, open, log }: EditorCommand): Promise<number> {
  const url = editorUrl(server, flags);
  const version = await runningAt(url);
  if (!version) {
    log(`Kiosko isn't running at ${url}`);
    log('  start it:                     kiosko start --open');
    log('  or with your session, always: kiosko service install');
    return 1;
  }
  log(`Kiosko ${version} — editor at ${url}`);
  if (!flags.print) open(url);
  return 0;
}

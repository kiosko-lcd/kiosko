/**
 * Small helpers for what differs between operating systems, shared by Kiosko
 * and by plugins (`import { expandPath, commandFor } from '@kiosko/sdk'`).
 */
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, win32 } from 'node:path';

/**
 * `~`, `~/x` (and `~\x`), `$VAR`, `${VAR}` and, on Windows, `%VAR%` expanded.
 * A variable that isn't set stays as written. `os` and `env` are for tests.
 */
export function expandPath(p: string, o: { os?: NodeJS.Platform; env?: Record<string, string | undefined>; home?: string } = {}): string {
  const env = o.env ?? process.env;
  let v = p.replace(/\$(?:\{(\w+)\}|(\w+))/g, (whole, a?: string, b?: string) => env[a ?? b ?? ''] ?? whole);
  // `%VAR%` is a Windows thing; on other systems a `%` is just a character.
  if ((o.os ?? process.platform) === 'win32') v = v.replace(/%([^%\r\n]+)%/g, (whole, name: string) => env[name] ?? whole);
  const home = o.home ?? homedir();
  if (v === '~') return home;
  return v.startsWith('~/') || v.startsWith('~\\') ? join(home, v.slice(2)) : v;
}

/** What to hand to `execFile` to run `cmd` with `args`. */
export interface Command {
  file: string;
  args: string[];
  /** Pass as `windowsVerbatimArguments` to `execFile`/`spawn`. */
  windowsVerbatimArguments?: boolean;
}

/** Characters cmd.exe would interpret inside a batch shim's arguments. */
const CMD_UNSAFE = /["%\r\n\0]/;

/**
 * On Windows, tools installed with npm (`ccusage`, `npx`, `claude`…) are
 * `.cmd` shims, and `execFile('ccusage')` neither finds them (no `PATHEXT`
 * search) nor, since Node 18.20 / 20.12, runs a `.cmd` without a shell.
 * `commandFor` returns the pair to pass to `execFile`: for a `.cmd`/`.bat`
 * (looked up on `PATH`), `cmd.exe /d /s /c "…"` with each argument quoted; for
 * anything else, the command as it was. Elsewhere it changes nothing.
 *
 *   const c = commandFor('ccusage', ['daily', '--json']);
 *   execFile(c.file, c.args, { windowsHide: true, windowsVerbatimArguments: c.windowsVerbatimArguments }, cb);
 *
 * Throws if an argument holds a quote, a `%` or a line break and the command needs
 * cmd.exe: there is no safe way to pass those through a batch file.
 */
export function commandFor(
  cmd: string,
  args: string[],
  o: { os?: NodeJS.Platform; env?: Record<string, string | undefined>; exists?: (path: string) => boolean } = {},
): Command {
  if ((o.os ?? process.platform) !== 'win32') return { file: cmd, args };
  const env = o.env ?? process.env;
  const exists = o.exists ?? defaultExists;
  const shim = findShim(cmd, env, exists);
  if (!shim) return { file: cmd, args };
  for (const a of args) if (CMD_UNSAFE.test(a)) throw new Error(`argument not allowed for ${cmd}: ${JSON.stringify(a)}`);
  const quote = (s: string) => (/^[\w@+=:,./\\-]+$/.test(s) ? s : `"${s}"`);
  return { file: env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${[shim, ...args].map(quote).join(' ')}"`], windowsVerbatimArguments: true };
}

function defaultExists(path: string): boolean {
  try {
    // Sync and tiny: a handful of PATH entries, once per call.
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The `.cmd`/`.bat` that `cmd` names on Windows, or null if it is (or may be) an executable. */
function findShim(cmd: string, env: Record<string, string | undefined>, exists: (p: string) => boolean): string | null {
  if (/\.(exe|com)$/i.test(cmd)) return null;
  if (/\.(cmd|bat)$/i.test(cmd) && /[\\/]/.test(cmd)) return exists(cmd) ? cmd : null;
  const dirs = /[\\/]/.test(cmd) ? [''] : (env.PATH ?? env.Path ?? '').split(';').filter(Boolean);
  const exts = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  for (const dir of dirs) {
    const base = dir ? win32.join(dir, cmd) : cmd;
    for (const ext of /\.\w+$/.test(cmd) ? [''] : exts) {
      const p = base + ext.toLowerCase();
      if (!exists(p)) continue;
      return /\.(cmd|bat)$/i.test(p) ? p : null;
    }
  }
  return null;
}

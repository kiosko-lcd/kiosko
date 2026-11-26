/**
 * The names of the programs running on this machine, for the `app` rules of
 * context pages (context.ts). Listed every few seconds, only while some rule
 * needs it, with what every user may read and nothing to install:
 *
 * - Linux: `/proc/<pid>/comm` (the kernel's name, cut at 15 characters) and
 *   the base name of `argv[0]` from `/proc/<pid>/cmdline` (the full name, and
 *   what `exec -a` sets). Processes of other users count too, unless /proc is
 *   mounted with `hidepid`; then only one's own are seen.
 * - macOS (and the BSDs): `ps -axo comm=`, the executable's path: its base
 *   name and, inside an app bundle, the bundle's name (`zoom.us`, `OBS`).
 * - Windows: `tasklist /fo csv /nh`, the image names (`steam.exe`), with and
 *   without `.exe`. Every user's processes on the machine; it takes a tenth
 *   of a second or so, hence the interval.
 *
 * Names only: no command lines are kept (they may carry secrets).
 */
import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';

/** Lists the names of the running processes (duplicates removed). */
export interface ProcessLister {
  list(): Promise<string[]>;
}

/** How often the processes are listed while a rule needs them. */
export const APPS_EVERY_MS = 3_000;

const base = (p: string) => p.split(/[\\/]/).pop() ?? p;
const uniq = (xs: string[]) => [...new Set(xs.map((x) => x.trim()).filter(Boolean))];

/** Linux: each process' `comm` and its `cmdline` (NUL-separated argv) → names. */
export function parseLinuxProc(procs: { comm?: string; cmdline?: string }[]): string[] {
  const out: string[] = [];
  for (const p of procs) {
    if (p.comm) out.push(p.comm.trim());
    const argv = (p.cmdline ?? '').split('\0').filter(Boolean);
    const argv0 = argv[0];
    if (!argv0) continue;
    if (argv.length > 1 || !argv0.includes(' ')) {
      out.push(base(argv0));
      continue;
    }
    // One string with spaces: a path with spaces in it ("/games/Hollow Knight/hollow_knight"), or a whole
    // command line rewritten as one ("/opt/chrome/chrome --type=renderer", "python3 bot.py"). Up to the
    // first option, and a bare first word too.
    out.push(base(argv0.split(' -')[0]!.trim()));
    const first = argv0.split(' ')[0]!;
    if (!first.includes('/')) out.push(first);
  }
  return uniq(out);
}

/** macOS / BSD: `ps -axo comm=` → names (base names, and app bundles' names). */
export function parsePs(stdout: string): string[] {
  const out: string[] = [];
  for (const line of stdout.split('\n')) {
    const path = line.trim();
    if (!path) continue;
    out.push(base(path));
    const bundle = /\/([^/]+)\.app\//.exec(path);
    if (bundle) out.push(bundle[1]!);
  }
  return uniq(out);
}

/** Windows: `tasklist /fo csv /nh` → image names, with and without `.exe`. */
export function parseTasklist(stdout: string): string[] {
  const out: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^"([^"]+)"/.exec(line.trim());
    if (!m) continue;
    out.push(m[1]!);
    if (/\.exe$/i.test(m[1]!)) out.push(m[1]!.slice(0, -4));
  }
  return uniq(out);
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 5_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });
}

async function linuxList(root = '/proc'): Promise<string[]> {
  const pids = (await readdir(root)).filter((d) => /^\d+$/.test(d));
  const procs = await Promise.all(
    pids.map(async (pid) => {
      const [comm, cmdline] = await Promise.all([readFile(`${root}/${pid}/comm`, 'utf8').catch(() => ''), readFile(`${root}/${pid}/cmdline`, 'utf8').catch(() => '')]);
      return { comm, cmdline };
    }),
  );
  return parseLinuxProc(procs);
}

/** The lister for this system (`platform`: tests). */
export function systemProcesses(platform: NodeJS.Platform = process.platform): ProcessLister {
  if (platform === 'linux') return { list: () => linuxList() };
  if (platform === 'win32') return { list: async () => parseTasklist(await run('tasklist', ['/fo', 'csv', '/nh'])) };
  return { list: async () => parsePs(await run('ps', ['-axo', 'comm='])) };
}

/**
 * Keeps the latest list, asking the lister at most every `everyMs` and
 * never twice at once. `names` is null until the first answer (and after a
 * failure, said once in the log until it works again).
 */
export class ProcessWatch {
  names: string[] | null = null;
  private askedAt = Number.NEGATIVE_INFINITY;
  private busy = false;
  private failed: string | null = null;
  private readonly lister: ProcessLister;
  private readonly log: (m: string) => void;
  private readonly everyMs: number;
  constructor(lister: ProcessLister, log: (m: string) => void = () => {}, everyMs = APPS_EVERY_MS) {
    this.lister = lister;
    this.log = log;
    this.everyMs = everyMs;
  }

  /** Asks again if due; `changed` is called when the names changed. */
  poll(now: number, changed: () => void = () => {}): void {
    if (this.busy || now - this.askedAt < this.everyMs) return;
    this.busy = true;
    this.askedAt = now;
    this.lister.list().then(
      (names) => {
        this.busy = false;
        this.failed = null;
        const before = this.names?.join('\0');
        this.names = names;
        if (before !== names.join('\0')) changed();
      },
      (err: unknown) => {
        this.busy = false;
        const m = err instanceof Error ? err.message : String(err);
        if (this.failed !== m) this.log(`could not list the running programs: ${m}`);
        this.failed = m;
        this.names = null;
      },
    );
  }

  /** No rule needs it any more: forgets the list. */
  stop(): void {
    this.names = null;
    this.askedAt = Number.NEGATIVE_INFINITY;
  }
}

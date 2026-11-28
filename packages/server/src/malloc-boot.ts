/**
 * The very first thing `kiosko start` does on Linux (cli.ts imports it
 * before anything else): start again, in the same process (`execve`: same
 * pid, so systemd, a launcher or a shell see nothing), with glibc's malloc
 * told to keep fewer free pages (`MALLOC_ENV`). glibc reads these only when
 * the process starts, so they can't be set from inside.
 *
 * Why: Kiosko's native memory comes and goes in big blocks (a 1920×462
 * frame is 3.5 MB, a decoded photo up to 8 MB), allocated from many threads
 * (the JS one, each screen's, libuv's pool, the canvas library's decoders).
 * glibc gives each thread an arena of its own (up to 8 per core) and keeps
 * what is freed there for later; it also raises its mmap threshold to 32 MB
 * after the first big block is freed, so those blocks come from the arenas
 * too. After two hours a Kiosko with 31 plugins and one 1920×462 panel
 * had 321 MB free in its arenas next to 329 MB in use.
 *
 * - MALLOC_ARENA_MAX=2: two arenas for every thread, instead of one each.
 * - MALLOC_MMAP_THRESHOLD_=1 MB, fixed: blocks of 1 MB and more (frames,
 *   photos) get pages of their own, given back to the system when freed.
 *
 * With both, the same Kiosko settled at ~530 MB instead of ~850 MB, for
 * 0.1–0.3 % of a core more (the pages of each frame are mapped afresh).
 * jemalloc did about as well, but it isn't there everywhere; a periodic
 * malloc_trim() gave back only ~150 MB, and fewer canvas-library threads
 * (TOKIO_WORKER_THREADS) nothing.
 *
 * Not done when any of these is already set (whoever set it knows better),
 * with KIOSKO_MALLOC=system, without glibc (musl, macOS, Windows), or on a
 * Node without `process.execve` (before 23.11).
 */
import { parseSandboxArgs } from './sandbox-args.ts';

/** What Kiosko starts with (see above). */
export const MALLOC_ENV: Readonly<Record<string, string>> = { MALLOC_ARENA_MAX: '2', MALLOC_MMAP_THRESHOLD_: '1048576' };

/** Variables that already say how malloc should behave: if one is set, Kiosko leaves malloc alone. */
const OWN = ['MALLOC_ARENA_MAX', 'MALLOC_ARENA_TEST', 'MALLOC_MMAP_THRESHOLD_', 'MALLOC_TRIM_THRESHOLD_', 'MALLOC_TOP_PAD_', 'GLIBC_TUNABLES', 'KIOSKO_MALLOC'];

export interface MallocBootInput {
  platform: NodeJS.Platform;
  /** glibc's version at run time, or undefined (not glibc). */
  glibc: string | undefined;
  env: NodeJS.ProcessEnv;
  /** process.argv without node and the script. */
  args: string[];
  hasExecve: boolean;
}

/** The environment to start again with, or null to go on as is. */
export function mallocRestartEnv(o: MallocBootInput): NodeJS.ProcessEnv | null {
  if (o.platform !== 'linux' || !o.glibc || !o.hasExecve) return null;
  if (OWN.some((k) => o.env[k] !== undefined && o.env[k] !== '')) return null;
  // An allocator of its own (jemalloc, mimalloc…) ignores glibc's settings.
  if (/malloc/i.test(o.env.LD_PRELOAD ?? '')) return null;
  const argv = parseSandboxArgs(o.args, o.env).argv;
  // As cli.ts decides: flags alone mean `start`.
  const cmd = argv.includes('--help') || argv.includes('-h') ? 'help' : argv[0] && (!argv[0].startsWith('-') || argv[0] === '--version' || argv[0] === '-v') ? argv[0] : 'start';
  if (cmd !== 'start') return null;
  // KIOSKO_MALLOC marks the second start (and so never a third).
  return { ...o.env, ...MALLOC_ENV, KIOSKO_MALLOC: 'tuned' };
}

function glibcVersion(): string | undefined {
  try {
    return (process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined)?.header?.glibcVersionRuntime;
  } catch {
    return undefined;
  }
}

const execve = (process as unknown as { execve?: (file: string, args: string[], env: NodeJS.ProcessEnv) => never }).execve;
// Cheap checks first: getReport() takes a few ms, and only Linux needs it.
if (process.platform === 'linux' && typeof execve === 'function' && !process.env.KIOSKO_MALLOC) {
  const env = mallocRestartEnv({ platform: process.platform, glibc: glibcVersion(), env: process.env, args: process.argv.slice(2), hasExecve: true });
  if (env) {
    try {
      execve.call(process, process.execPath, [process.execPath, ...process.execArgv, ...process.argv.slice(1)], env);
    } catch {
      // Couldn't: go on with malloc as it is.
    }
  }
}

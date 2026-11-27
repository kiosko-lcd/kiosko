/**
 * Optional enrichment from git: which repository a session is in, its HEAD,
 * uncommitted files and a few craft signals. Kept out of the main entry point
 * (import `@loksly/agent-sessions/git`) because it runs `git` and the hook
 * must stay light.
 */
import { execFile } from 'node:child_process';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { basename } from 'node:path';
import { promisify } from 'node:util';
import { longestDefinition, SPAGHETTI_LINES } from './craft.ts';
import type { SessionRecord } from './protocol.ts';

const execFileAsync = promisify(execFile);

/** Runs a git query in a directory; null if it fails. */
export type Runner = (cwd: string) => Promise<string | null>;

const NEGATIVE_TTL_MS = 10 * 60_000;

/**
 * Root of the git repository containing a directory, cached. A session opened
 * in `repo/apps/server/src` belongs to `repo`, and two sessions in different
 * subdirectories of the same repository are recognised as one project. A
 * directory's root does not change, so it is asked once; directories that are
 * not repositories are remembered only for a while (someone may `git init`).
 */
export function repoRootCache(run: Runner, now: () => number = Date.now) {
  const known = new Map<string, { root: string | null; at: number }>();
  return async (cwd: string): Promise<string | null> => {
    const hit = known.get(cwd);
    if (hit && (hit.root !== null || now() - hit.at < NEGATIVE_TTL_MS)) return hit.root;
    const out = (await run(cwd))?.trim() || null;
    known.set(cwd, { root: out, at: now() });
    return out;
  };
}

export interface HeadInfo {
  /** Detached HEAD (not on any branch). */
  detached: boolean;
  /** Date of the last commit, ms epoch; absent in a repository without commits. */
  lastCommit?: number;
}

/**
 * `git log -1 --format=%ct%n%D` → HeadInfo. The second line holds the refs:
 * "HEAD -> main, origin/main" on a branch, "HEAD, …" when detached.
 */
export function parseHead(out: string): HeadInfo | null {
  const [ct, refs = ''] = out.trim().split('\n');
  const secs = Number(ct);
  if (!ct || !Number.isFinite(secs)) return null;
  return { detached: !/\bHEAD -> /.test(refs), lastCommit: secs * 1000 };
}

/** HEAD of each repository, asked at most once per `ttlMs`. */
export function headCache(run: Runner, ttlMs = 60_000, now: () => number = Date.now) {
  const known = new Map<string, { info: HeadInfo | null; at: number }>();
  return async (root: string): Promise<HeadInfo | null> => {
    const hit = known.get(root);
    if (hit && now() - hit.at < ttlMs) return hit.info;
    const out = await run(root);
    const info = out ? parseHead(out) : null;
    known.set(root, { info, at: now() });
    return info;
  };
}

/**
 * How long a repository's `git status` is kept. Every reload of the sessions
 * (each time the hook writes, and every poll) enriches every session, and
 * each `git status` is a program started from the reader's (often busy)
 * thread: five sessions in one repository asked it five times per reload.
 */
export const STATUS_TTL_MS = 15_000;

/**
 * `git status --porcelain` of each repository (or directory), asked at most
 * once per `ttlMs`; sessions asking at the same moment share one run.
 */
export function statusCache(run: Runner, ttlMs = STATUS_TTL_MS, now: () => number = Date.now) {
  const known = new Map<string, { out: Promise<string | null>; at: number }>();
  return (dir: string): Promise<string | null> => {
    const t = now();
    const hit = known.get(dir);
    if (hit && t - hit.at < ttlMs && t >= hit.at) return hit.out;
    if (known.size > 200) known.clear();
    const out = run(dir);
    known.set(dir, { out, at: t });
    return out;
  };
}

/** A session record plus what git says about its working directory. */
export interface EnrichedSession extends SessionRecord {
  /** Root of the git repository containing `cwd`; `project` is then its name. */
  repo?: string;
  /** Detached HEAD in its repository. */
  detached?: boolean;
  /** Date of the last commit on its branch, ms epoch. */
  lastCommit?: number;
  /** Date of the repository's first commit, ms epoch (unknown in shallow clones). */
  repoBorn?: number;
  /** Some file it touched has a definition longer than `SPAGHETTI_LINES`. */
  spaghetti?: boolean;
  /** Uncommitted files. */
  dirty?: number;
  /** Paths of those files, relative to the repository root, as `git status` gives them. */
  dirtyFiles?: string[];
}

const git = (args: string[], timeout = 2000): Runner => async (cwd) => {
  try {
    return (await execFileAsync('git', args, { cwd, timeout })).stdout;
  } catch {
    return null;
  }
};

/** Parses `git status --porcelain` into a count and paths (renames keep the new path). */
export function parseStatus(out: string): { count: number; files: string[] } {
  const lines = out.split('\n').filter((l) => l.trim().length > 0);
  const files = lines.map((l) => l.slice(3).split(' -> ').pop()!.replace(/^"|"$/g, ''));
  return { count: lines.length, files };
}

/**
 * An enricher with its own caches: repository roots (forever), HEAD (one
 * minute), first commit (six hours), long definitions (per file version) and
 * `git status`, what changes, for `STATUS_TTL_MS` per repository (its paths
 * are relative to the repository's root, wherever in it it runs).
 */
export function createGitEnricher(run: (args: string[]) => Runner = (args) => git(args), now: () => number = Date.now) {
  const repoRoot = repoRootCache(run(['rev-parse', '--show-toplevel']), now);
  const headOf = headCache(run(['log', '-1', '--format=%ct%n%D']), 60_000, now);
  const statusOf = statusCache(run(['status', '--porcelain']), STATUS_TTL_MS, now);
  const born = new Map<string, { born: number | null; at: number }>();
  const long = new Map<string, { mtime: number; long: boolean }>();

  async function bornOf(root: string): Promise<number | null> {
    const hit = born.get(root);
    if (hit && Date.now() - hit.at < 6 * 3_600_000) return hit.born;
    let value: number | null = null;
    // In a shallow clone the root commit is a graft with the wrong date.
    if ((await run(['rev-parse', '--is-shallow-repository'])(root))?.trim() === 'false') {
      const out = await run(['log', '--max-parents=0', '--format=%at', 'HEAD'], )(root);
      const times = (out ?? '').split('\n').map(Number).filter((n) => n > 0);
      if (times.length) value = Math.min(...times) * 1000;
    }
    born.set(root, { born: value, at: Date.now() });
    return value;
  }

  function isSpaghetti(path: string): boolean {
    if (!/\.(ts|tsx|js|jsx|mjs|py|go|rs|java|kt|cs|php|rb|c|cc|cpp|h|swift)$/.test(path)) return false;
    try {
      const st = statSync(path);
      const hit = long.get(path);
      if (hit && hit.mtime === st.mtimeMs) return hit.long;
      const value = st.size < 2_000_000 && longestDefinition(readFileSync(path, 'utf8')) > SPAGHETTI_LINES;
      if (long.size > 500) long.clear();
      long.set(path, { mtime: st.mtimeMs, long: value });
      return value;
    } catch {
      return false;
    }
  }

  return async function enrich<T extends SessionRecord>(rec: T): Promise<T & EnrichedSession> {
    const out: T & EnrichedSession = { ...rec };
    if (!rec.cwd || !existsSync(rec.cwd)) return out;
    const root = await repoRoot(rec.cwd);
    if (root) {
      out.repo = root;
      out.project = basename(root);
      const head = await headOf(root);
      if (head?.detached) out.detached = true;
      if (head?.lastCommit) out.lastCommit = head.lastCommit;
      const b = await bornOf(root);
      if (b) out.repoBorn = b;
    }
    if (rec.files?.some(isSpaghetti)) out.spaghetti = true;
    const status = await statusOf(root ?? rec.cwd);
    if (status !== null) {
      const s = parseStatus(status);
      out.dirty = s.count;
      out.dirtyFiles = s.files;
    }
    return out;
  };
}

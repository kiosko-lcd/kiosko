/**
 * The `agents/sessions` source: reads the session files the hook writes,
 * drops (and optionally deletes) dead ones and enriches the rest with git.
 *
 * Push-based: an `fs.watch` on the directory, debounced, repaints as soon as
 * a session changes state. A slow poll runs underneath because inotify is not
 * the whole story: the directory may not exist yet, the watcher can die, and
 * a commit changes the uncommitted-files count without touching any session
 * file.
 */
import { existsSync, watch, type FSWatcher } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defaultSessionsDir, pruneZombies, readSessions, reap } from '@loksly/agent-sessions';
import { createGitEnricher } from '@loksly/agent-sessions/git';
import type { SessionsData, SessionView } from './types.ts';

/** `~` and `~/…` → the home directory. Empty → the protocol's default location. */
export function resolveDir(dir: string, home = homedir()): string {
  const d = dir.trim();
  if (!d) return defaultSessionsDir();
  if (d === '~') return home;
  if (d.startsWith('~/')) return join(home, d.slice(2));
  return d;
}

export interface LoadOptions {
  dir: string;
  zombieMs: number;
  staleMs: number;
  /** Delete the files of dead sessions (see `reap`). */
  reap: boolean;
}

type Enricher = (rec: SessionView) => Promise<SessionView>;

/**
 * Live sessions of `o.dir`, enriched with `enrich` if given. Dead ones are
 * dropped before enriching: each costs a `git status`, and a corpse would pay
 * it on every reload forever.
 */
export async function loadSessions(o: LoadOptions, enrich?: Enricher, now = Date.now(), onReap?: (r: SessionView) => void): Promise<SessionView[]> {
  const records: SessionView[] = readSessions(o.dir);
  const alive = o.reap ? reap(records, now, o, o.dir, onReap) : pruneZombies(records, now, o.zombieMs, o.staleMs);
  if (!enrich) return alive;
  return Promise.all(alive.map((r) => enrich(r).catch(() => r)));
}

export interface WatchOptions extends LoadOptions {
  git: boolean;
  debounceMs: number;
  pollMs: number;
}

export interface WatchHooks {
  emit: (data: SessionsData) => void;
  log: (msg: string) => void;
  signal?: AbortSignal;
  /** Injectable for tests. */
  now?: () => number;
}

/** Starts watching; returns the function that stops it. */
export function watchSessions(o: WatchOptions, h: WatchHooks): () => void {
  const enrich: Enricher | undefined = o.git ? createGitEnricher() : undefined;
  const now = h.now ?? Date.now;
  let stopped = false;
  let running = false;
  let again = false;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let watcher: FSWatcher | undefined;

  const reload = async (): Promise<void> => {
    if (stopped) return;
    // One reload at a time; a burst of events during one queues a single rerun.
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      const t = now();
      const sessions = await loadSessions(o, enrich, t, (r) => h.log(`dropped dead session ${r.project} (${r.state}, silent for ${Math.round((t - r.updated) / 60_000)} min)`));
      if (!stopped) h.emit({ sessions });
    } catch (err) {
      h.log(`reading ${o.dir} failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      running = false;
      if (again && !stopped) {
        again = false;
        void reload();
      }
    }
  };

  const schedule = () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => void reload(), o.debounceMs);
  };

  // The directory may not exist until the hook writes its first session: the
  // poll keeps trying to arm the watcher instead of creating it here.
  const arm = () => {
    if (watcher || stopped || !existsSync(o.dir)) return;
    try {
      const w = watch(o.dir, (_event, name) => {
        if (!name || String(name).endsWith('.json')) schedule();
      });
      w.on('error', () => {
        w.close();
        if (watcher === w) watcher = undefined;
      });
      watcher = w;
    } catch (err) {
      h.log(`cannot watch ${o.dir}: ${err instanceof Error ? err.message : String(err)}; polling only`);
    }
  };

  arm();
  void reload();
  const poll = setInterval(() => {
    arm();
    void reload();
  }, Math.max(1000, o.pollMs));
  poll.unref?.();

  const stop = () => {
    stopped = true;
    if (debounce) clearTimeout(debounce);
    clearInterval(poll);
    watcher?.close();
    watcher = undefined;
  };
  h.signal?.addEventListener('abort', stop, { once: true });
  return stop;
}

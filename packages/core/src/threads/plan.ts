/**
 * Which screens paint in a thread of their own (see thread-runner.ts): the
 * config's `threads` and each screen's `thread`, with the machine's cores.
 */
import { availableParallelism } from 'node:os';
import type { Config, Screen, ThreadsMode } from '../config/model.ts';

/**
 * Why a screen is where it is: its own `thread` setting (`always`, `never`),
 * the config's (`setting`: `threads` is always or never), or `auto` and the
 * machine (`auto` yes; `fewScreens`: fewer than two on; `fewCores`: no core
 * to spare for each). A screen switched off never gets one (`off`).
 */
export type ThreadWhy = 'always' | 'never' | 'setting' | 'auto' | 'fewScreens' | 'fewCores' | 'off';

export interface ThreadChoice {
  thread: boolean;
  why: ThreadWhy;
}

export function threadsMode(cfg: Pick<Config, 'threads'>): ThreadsMode {
  return cfg.threads ?? 'auto';
}

/**
 * `auto` gives every screen on a thread of its own when there are two or
 * more and a core for each of them plus one for the main thread (the server,
 * the data, the encoding of the frames): with fewer they would only take
 * turns on the same cores, with the memory of a thread each.
 */
export function planThreads(cfg: Pick<Config, 'threads' | 'screens'>, cores = availableParallelism()): Map<string, ThreadChoice> {
  const mode = threadsMode(cfg);
  const out = new Map<string, ThreadChoice>();
  const on = cfg.screens.filter((s) => s.enabled);
  const own = (s: Screen) => s.thread ?? (mode === 'auto' ? null : mode);
  const sure = on.filter((s) => own(s) === 'always').length;
  const auto = on.filter((s) => own(s) === null);
  const autoWhy: ThreadWhy = on.length < 2 ? 'fewScreens' : cores < sure + auto.length + 1 ? 'fewCores' : 'auto';
  for (const s of cfg.screens) {
    if (!s.enabled) out.set(s.id, { thread: false, why: 'off' });
    else if (s.thread) out.set(s.id, { thread: s.thread === 'always', why: s.thread });
    else if (mode !== 'auto') out.set(s.id, { thread: mode === 'always', why: 'setting' });
    else out.set(s.id, { thread: autoWhy === 'auto', why: autoWhy });
  }
  return out;
}

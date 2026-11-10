/**
 * Data for widgets: shared sources and per-widget fetches, each at its own
 * pace, never blocking a frame. A change in any of them marks the screens
 * that show it as dirty (see Runtime).
 */
import { validate, type SourceDefinition, type WidgetDefinition } from '@kiosko/sdk';
import type { Config, WidgetInstance } from './config/model.ts';
import { DEFAULT_TIMEOUT_MS, sourceOptionsField, sourceTimes } from './config/sources.ts';
import { CANVAS, baseContext, type LogFn } from './env.ts';
import type { Registry } from './registry.ts';

const DEFAULT_FETCH_MS = 10 * 60_000;
/** After a failure, retry sooner than the normal interval but not in a loop. */
const RETRY_MS = 60_000;

/**
 * A signal for one read or fetch: aborted with `parent`, or after `ms` with a
 * TimeoutError. `done()` clears the timer once the work settles.
 */
export function deadline(parent: AbortSignal, ms: number): { signal: AbortSignal; timedOut: () => boolean; done: () => void } {
  const ctrl = new AbortController();
  const follow = () => ctrl.abort(parent.reason);
  if (parent.aborted) follow();
  else parent.addEventListener('abort', follow, { once: true });
  let late = false;
  const timer = setTimeout(() => {
    late = true;
    ctrl.abort(Object.assign(new Error(timedOutMsg(ms)), { name: 'TimeoutError' }));
  }, ms);
  (timer as { unref?: () => void }).unref?.();
  return {
    signal: ctrl.signal,
    timedOut: () => late && !parent.aborted,
    done: () => {
      clearTimeout(timer);
      parent.removeEventListener('abort', follow);
    },
  };
}

const timedOutMsg = (ms: number) => `timed out after ${ms < 1000 ? `${ms} ms` : `${Math.round(ms / 1000)} s`}`;

const same = (a: unknown, b: unknown) => {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
};

interface SourceState {
  type: string;
  def: SourceDefinition<any, any>;
  key: string;
  /** Validated options, Kiosko's `intervalMs` and `timeoutMs` included. */
  options: Record<string, unknown>;
  intervalMs: number;
  timeoutMs: number;
  data: unknown;
  nextAt: number;
  inflight: boolean;
  stop?: () => void;
  abort: AbortController;
  error?: string;
  updatedAt?: number;
}

export class SourceHub {
  private states = new Map<string, SourceState>();
  private readonly registry: Registry;
  private readonly log: LogFn;
  private readonly onChange: (type: string) => void;
  constructor(registry: Registry, log: LogFn, onChange: (type: string) => void) {
    this.registry = registry;
    this.log = log;
    this.onChange = onChange;
  }

  /** Keeps exactly the sources in `wanted` running (with current options). */
  retain(wanted: Set<string>, cfg: Config): void {
    for (const [type, st] of this.states) {
      if (!wanted.has(type) || this.optionsKey(cfg, type) !== st.key) {
        st.stop?.();
        st.abort.abort();
        this.states.delete(type);
      }
    }
    for (const type of wanted) {
      if (this.states.has(type)) continue;
      const def = this.registry.source(type);
      if (!def) continue;
      const field = sourceOptionsField(def);
      const options = field ? (validate(field, cfg.sources[type] ?? {}).value as Record<string, unknown>) : {};
      const { intervalMs, timeoutMs } = sourceTimes(def, options);
      const st: SourceState = { type, def, key: this.optionsKey(cfg, type), options, intervalMs, timeoutMs, data: undefined, nextAt: 0, inflight: false, abort: new AbortController() };
      this.states.set(type, st);
      if (def.watch) {
        try {
          st.stop = def.watch(this.ctx(cfg, st), (data) => this.set(st, data));
        } catch (err) {
          st.error = msg(err);
          this.log(type, `watch failed: ${st.error}`);
        }
      }
    }
  }

  private optionsKey(cfg: Config, type: string): string {
    return JSON.stringify(cfg.sources[type] ?? {});
  }

  private ctx(cfg: Config, st: SourceState, signal = st.abort.signal) {
    const [plugin] = st.type.split('/');
    return { ...baseContext(cfg, plugin!, this.log, Date.now()), options: st.options, signal, intervalMs: st.intervalMs, timeoutMs: st.timeoutMs };
  }

  private set(st: SourceState, data: unknown): void {
    st.updatedAt = Date.now();
    st.error = undefined;
    if (same(st.data, data)) return;
    st.data = data;
    this.onChange(st.type);
  }

  /**
   * Starts the reads that are due. A read gets its own signal, aborted after
   * the source's `timeoutMs`: the read then counts as failed, but the next
   * one waits until it settles, so a source that ignores its signal can't
   * pile up reads.
   */
  tick(cfg: Config, now: number): void {
    for (const st of this.states.values()) {
      if (!st.def.read || st.inflight || now < st.nextAt) continue;
      st.inflight = true;
      const d = deadline(st.abort.signal, st.timeoutMs);
      const fail = (err: unknown) => {
        st.error = d.timedOut() ? timedOutMsg(st.timeoutMs) : msg(err);
        this.log(st.type, `read failed: ${st.error}`);
        st.nextAt = Date.now() + Math.min(RETRY_MS, st.intervalMs);
      };
      // Report a timeout when it happens, not when (or if) the read gives up.
      d.signal.addEventListener('abort', () => d.timedOut() && fail(null), { once: true });
      let read: Promise<unknown>;
      try {
        read = Promise.resolve(st.def.read(this.ctx(cfg, st, d.signal)));
      } catch (err) {
        read = Promise.reject(err);
      }
      read
        .then((data) => {
          if (d.timedOut()) return;
          this.set(st, data);
          st.nextAt = Date.now() + st.intervalMs;
        })
        .catch((err) => {
          if (st.abort.signal.aborted || d.timedOut()) return;
          fail(err);
        })
        .finally(() => {
          d.done();
          st.inflight = false;
        });
    }
  }

  data(type: string): unknown {
    return this.states.get(type)?.data;
  }

  pick(types: readonly string[] | undefined): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const t of types ?? []) out[t] = this.data(t);
    return out;
  }

  status() {
    return [...this.states.values()].map((s) => ({ type: s.type, ok: !s.error, error: s.error ?? null, updatedAt: s.updatedAt ?? null, ...(s.def.read ? { intervalMs: s.intervalMs } : {}) }));
  }

  stop(): void {
    for (const st of this.states.values()) {
      st.stop?.();
      st.abort.abort();
    }
    this.states.clear();
  }
}

/** The interval a widget asks for after a fetch (`intervalOf`), or its `intervalMs`. */
function ownInterval(st: FetchState, data: unknown): number {
  let ms: number | undefined;
  try {
    ms = st.def.intervalOf!({ options: st.options, data });
  } catch {
    ms = undefined;
  }
  return typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? Math.max(MIN_FETCH_MS, ms) : (st.def.intervalMs ?? DEFAULT_FETCH_MS);
}

interface FetchState {
  id: string;
  type: string;
  def: WidgetDefinition<any, any>;
  key: string;
  options: Record<string, unknown>;
  data: unknown;
  nextAt: number;
  inflight: boolean;
  intervalMs: number;
  /** The interval the user set on the instance, if any: it wins over the widget's own. */
  userIntervalMs: number | undefined;
  timeoutMs: number;
  abort: AbortController;
  error?: string;
  updatedAt?: number;
}

/** Shortest interval a widget may ask for with `intervalOf`. */
const MIN_FETCH_MS = 5_000;

/** Per-instance `fetch` of widgets, keyed by the instance id. */
export class FetchHost {
  private states = new Map<string, FetchState>();
  private readonly hub: SourceHub;
  private readonly log: LogFn;
  private readonly onChange: (instanceId: string) => void;
  constructor(hub: SourceHub, log: LogFn, onChange: (instanceId: string) => void) {
    this.hub = hub;
    this.log = log;
    this.onChange = onChange;
  }

  retain(instances: { inst: WidgetInstance; def: WidgetDefinition<any, any> }[]): void {
    const keep = new Set<string>();
    for (const { inst, def } of instances) {
      if (!def.fetch) continue;
      keep.add(inst.id);
      const key = JSON.stringify([inst.type, inst.options, inst.intervalMs]);
      const old = this.states.get(inst.id);
      if (old && old.key === key) continue;
      old?.abort.abort();
      const options = def.options ? (validate(def.options, inst.options).value as Record<string, unknown>) : {};
      this.states.set(inst.id, { id: inst.id, type: inst.type, def, key, options, data: old?.type === inst.type ? old.data : undefined, nextAt: 0, inflight: false, intervalMs: inst.intervalMs ?? def.intervalMs ?? DEFAULT_FETCH_MS, userIntervalMs: inst.intervalMs, timeoutMs: def.timeoutMs ?? DEFAULT_TIMEOUT_MS, abort: new AbortController() });
    }
    for (const [id, st] of this.states) {
      if (!keep.has(id)) {
        st.abort.abort();
        this.states.delete(id);
      }
    }
  }

  tick(cfg: Config, now: number): void {
    for (const st of this.states.values()) {
      if (st.inflight || now < st.nextAt) continue;
      st.inflight = true;
      const [plugin] = st.type.split('/');
      const d = deadline(st.abort.signal, st.timeoutMs);
      const ctx = { ...baseContext(cfg, plugin!, (_s, m) => this.log(st.type, m), now), options: st.options, canvas: CANVAS, signal: d.signal, timeoutMs: st.timeoutMs, sources: this.hub.pick(st.def.sources) };
      let run: Promise<unknown>;
      try {
        run = Promise.resolve(st.def.fetch!(ctx));
      } catch (err) {
        run = Promise.reject(err);
      }
      run
        .then((data: unknown) => {
          st.updatedAt = Date.now();
          st.error = undefined;
          if (st.userIntervalMs === undefined && st.def.intervalOf) st.intervalMs = ownInterval(st, data);
          st.nextAt = Date.now() + st.intervalMs;
          if (!same(data, st.data)) {
            st.data = data;
            this.onChange(st.id);
          }
        })
        .catch((err: unknown) => {
          if (st.abort.signal.aborted) return;
          st.error = d.timedOut() ? timedOutMsg(st.timeoutMs) : msg(err);
          this.log(st.type, `fetch failed: ${st.error}`);
          st.nextAt = Date.now() + Math.min(RETRY_MS, st.intervalMs);
        })
        .finally(() => {
          d.done();
          st.inflight = false;
        });
    }
  }

  data(id: string): unknown {
    return this.states.get(id)?.data;
  }

  /** Ask for fresh data on the next tick (the editor's "refresh" button). */
  refresh(id: string): void {
    const st = this.states.get(id);
    if (st) st.nextAt = 0;
  }

  status() {
    return [...this.states.values()].map((s) => ({ id: s.id, type: s.type, ok: !s.error, error: s.error ?? null, updatedAt: s.updatedAt ?? null }));
  }

  stop(): void {
    for (const st of this.states.values()) st.abort.abort();
    this.states.clear();
  }
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

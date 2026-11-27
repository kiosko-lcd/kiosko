/**
 * Data for widgets: shared sources and per-widget fetches, each at its own
 * pace, never blocking a frame. A change in any of them marks the screens
 * that show it as dirty (see Runtime).
 */
import { errorMessage, validate, type SourceDefinition, type WidgetDefinition } from '@kiosko/sdk';
import type { Config, WidgetInstance } from './config/model.ts';
import { parseSourceKey, sourceKeysOf, sourceOptionsOf } from './config/profiles.ts';
import { DEFAULT_TIMEOUT_MS, sourceOptionsField, sourceTimes } from './config/sources.ts';
import { CANVAS, baseContext, resolveLocale, type LogFn } from './env.ts';
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

/**
 * Identities for objects JSON can't see into: a decoded image stringifies as
 * `{}`, so every new picture looked like the old one and was never shown.
 * Such objects (anything but plain objects and arrays, after `toJSON`) compare
 * by identity instead.
 */
const opaqueIds = new WeakMap<object, number>();
let nextOpaqueId = 0;
const opaque = (_key: string, v: unknown): unknown => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
  const proto = Object.getPrototypeOf(v);
  if (proto === Object.prototype || proto === null) return v;
  let id = opaqueIds.get(v);
  if (id === undefined) opaqueIds.set(v, (id = ++nextOpaqueId));
  return `\u0000opaque#${id}`;
};

export const same = (a: unknown, b: unknown) => {
  if (a === b) return true;
  try {
    return JSON.stringify(a, opaque) === JSON.stringify(b, opaque);
  } catch {
    return false;
  }
};

interface SourceState {
  /** What it runs under: the type for the default profile, `type#profile` for another (see config/profiles.ts). */
  key: string;
  type: string;
  /** Its profile, or null for the default one. */
  profile: string | null;
  def: SourceDefinition<any, any>;
  /** Its options as written, to restart it when they change. */
  optionsKey: string;
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

/**
 * The shared sources that run, one per source key: a source's default
 * profile runs under its type (`news/deck`), every other profile under a key
 * of its own (`news/deck#tech`), with its own options, data, interval and
 * errors (see config/profiles.ts).
 */
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

  /** Keeps exactly the source keys in `wanted` running (with current options). */
  retain(wanted: Set<string>, cfg: Config): void {
    for (const [key, st] of this.states) {
      if (!wanted.has(key) || this.optionsKey(cfg, key) !== st.optionsKey) {
        st.stop?.();
        st.abort.abort();
        this.states.delete(key);
      }
    }
    for (const key of wanted) {
      if (this.states.has(key)) continue;
      const { type, profile } = parseSourceKey(key);
      const def = this.registry.source(type);
      if (!def) continue;
      const field = sourceOptionsField(def);
      const options = field ? (validate(field, sourceOptionsOf(cfg, key)).value as Record<string, unknown>) : {};
      const { intervalMs, timeoutMs } = sourceTimes(def, options);
      const st: SourceState = { key, type, profile, def, optionsKey: this.optionsKey(cfg, key), options, intervalMs, timeoutMs, data: undefined, nextAt: 0, inflight: false, abort: new AbortController() };
      this.states.set(key, st);
      if (def.watch) {
        try {
          st.stop = def.watch(this.ctx(cfg, st), (data) => this.set(st, data));
        } catch (err) {
          st.error = msg(err, cfg);
          this.log(key, `watch failed: ${st.error}`);
        }
      }
    }
  }

  private optionsKey(cfg: Config, key: string): string {
    return JSON.stringify(sourceOptionsOf(cfg, key));
  }

  private ctx(cfg: Config, st: SourceState, signal = st.abort.signal) {
    const [plugin] = st.type.split('/');
    return { ...baseContext(cfg, plugin!, st.profile ? (_scope, m) => this.log(st.key, m) : this.log, Date.now()), options: st.options, signal, intervalMs: st.intervalMs, timeoutMs: st.timeoutMs, ...(st.profile ? { profile: st.profile } : {}) };
  }

  private set(st: SourceState, data: unknown): void {
    st.updatedAt = Date.now();
    const recovered = st.error !== undefined;
    st.error = undefined;
    if (same(st.data, data)) {
      // Same data, but it isn't failing any more: what is shown may change (see `failed`).
      if (recovered) this.onChange(st.key);
      return;
    }
    st.data = data;
    this.onChange(st.key);
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
        const was = st.error !== undefined;
        st.error = d.timedOut() ? timedOutMsg(st.timeoutMs) : msg(err, cfg);
        this.log(st.key, `read failed: ${st.error}`);
        st.nextAt = Date.now() + Math.min(RETRY_MS, st.intervalMs);
        // Its widgets pass their turn while it fails (see compositor's `tileState`).
        if (!was) this.onChange(st.key);
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

  /** The latest data of a source key (a bare type: its default profile). */
  data(key: string): unknown {
    return this.states.get(key)?.data;
  }

  /** Whether a source key's last read (or its watch) failed. */
  failed(key: string): boolean {
    return this.states.get(key)?.error !== undefined;
  }

  /** The sources running now, with their options. */
  running(): { key: string; type: string; profile: string | null; options: Record<string, unknown> }[] {
    return [...this.states.values()].map((s) => ({ key: s.key, type: s.type, profile: s.profile, options: s.options }));
  }

  /**
   * The data a widget (or interlude) gets in `ctx.sources`, by type: of the
   * profile `profile` where the source has it, else of the default one.
   */
  pick(types: readonly string[] | undefined, cfg?: Pick<Config, 'sourceProfiles'>, profile?: string | null): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (!cfg || !profile) {
      for (const t of types ?? []) out[t] = this.data(t);
      return out;
    }
    for (const [t, key] of sourceKeysOf(cfg, types, profile, (x) => this.registry.source(x))) out[t] = this.data(key);
    return out;
  }

  status() {
    return [...this.states.values()].map((s) => ({ type: s.type, key: s.key, profile: s.profile, ok: !s.error, error: s.error ?? null, updatedAt: s.updatedAt ?? null, ...(s.def.read ? { intervalMs: s.intervalMs } : {}) }));
  }

  stop(): void {
    for (const st of this.states.values()) {
      st.stop?.();
      st.abort.abort();
    }
    this.states.clear();
  }

  /** Stops the sources of a plugin whose code changed (reloaded, removed); the next `retain` starts them again with the new code. */
  forget(pluginId: string): void {
    for (const [key, st] of this.states) {
      if (st.type.split('/')[0] !== pluginId) continue;
      st.stop?.();
      st.abort.abort();
      this.states.delete(key);
    }
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
  /** The widget instances that show it: the same widget with the same options fetches once for all. */
  ids: Set<string>;
  type: string;
  def: WidgetDefinition<any, any>;
  key: string;
  /** The source profile it reads (`WidgetInstance.profile`). */
  profile: string | undefined;
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

/**
 * The `fetch` of widgets. Instances of the same widget with the same options
 * (and interval and profile) share one: what `fetch` gets doesn't depend on
 * the instance, so two screens showing the same news column, or the same
 * system health in three stacks, made the same requests (and ran the same
 * commands) two or three times for the same data.
 */
export class FetchHost {
  /** By fetch key (`[type, options, intervalMs, profile]`). */
  private states = new Map<string, FetchState>();
  /** Instance id → its fetch key. */
  private keyOf = new Map<string, string>();
  private readonly hub: SourceHub;
  private readonly log: LogFn;
  private readonly onChange: (instanceId: string) => void;
  constructor(hub: SourceHub, log: LogFn, onChange: (instanceId: string) => void) {
    this.hub = hub;
    this.log = log;
    this.onChange = onChange;
  }

  retain(instances: { inst: WidgetInstance; def: WidgetDefinition<any, any> }[]): void {
    const keyOf = new Map<string, string>();
    for (const { inst, def } of instances) {
      if (!def.fetch) continue;
      const key = JSON.stringify([inst.type, inst.options, inst.intervalMs, inst.profile ?? null]);
      keyOf.set(inst.id, key);
      const st = this.states.get(key);
      if (st) {
        st.ids.add(inst.id);
        continue;
      }
      // Its options changed: what it showed stays until the new fetch comes, if it is the same widget.
      const old = this.states.get(this.keyOf.get(inst.id) ?? '');
      const options = def.options ? (validate(def.options, inst.options).value as Record<string, unknown>) : {};
      this.states.set(key, { ids: new Set([inst.id]), type: inst.type, def, key, profile: inst.profile, options, data: old?.type === inst.type ? old.data : undefined, nextAt: 0, inflight: false, intervalMs: inst.intervalMs ?? def.intervalMs ?? DEFAULT_FETCH_MS, userIntervalMs: inst.intervalMs, timeoutMs: def.timeoutMs ?? DEFAULT_TIMEOUT_MS, abort: new AbortController() });
    }
    this.keyOf = keyOf;
    for (const [key, st] of this.states) {
      for (const id of st.ids) if (keyOf.get(id) !== key) st.ids.delete(id);
      if (!st.ids.size) {
        st.abort.abort();
        this.states.delete(key);
      }
    }
  }

  tick(cfg: Config, now: number): void {
    for (const st of this.states.values()) {
      if (st.inflight || now < st.nextAt) continue;
      st.inflight = true;
      const [plugin] = st.type.split('/');
      const d = deadline(st.abort.signal, st.timeoutMs);
      const ctx = { ...baseContext(cfg, plugin!, (_s, m) => this.log(st.type, m), now), options: st.options, canvas: CANVAS, signal: d.signal, timeoutMs: st.timeoutMs, sources: this.hub.pick(st.def.sources, cfg, st.profile) };
      let run: Promise<unknown>;
      try {
        run = Promise.resolve(st.def.fetch!(ctx));
      } catch (err) {
        run = Promise.reject(err);
      }
      run
        .then((data: unknown) => {
          st.updatedAt = Date.now();
          const recovered = st.error !== undefined;
          st.error = undefined;
          if (st.userIntervalMs === undefined && st.def.intervalOf) st.intervalMs = ownInterval(st, data);
          st.nextAt = Date.now() + st.intervalMs;
          if (!same(data, st.data)) {
            st.data = data;
            for (const id of st.ids) this.onChange(id);
          } else if (recovered) for (const id of st.ids) this.onChange(id);
        })
        .catch((err: unknown) => {
          if (st.abort.signal.aborted) return;
          const was = st.error !== undefined;
          st.error = d.timedOut() ? timedOutMsg(st.timeoutMs) : msg(err, cfg);
          this.log(st.type, `fetch failed: ${st.error}`);
          st.nextAt = Date.now() + Math.min(RETRY_MS, st.intervalMs);
          // Its instances pass their turn while it fails (see compositor's `tileState`).
          if (!was) for (const id of st.ids) this.onChange(id);
        })
        .finally(() => {
          d.done();
          st.inflight = false;
        });
    }
  }

  private of(id: string): FetchState | undefined {
    const key = this.keyOf.get(id);
    return key === undefined ? undefined : this.states.get(key);
  }

  data(id: string): unknown {
    return this.of(id)?.data;
  }

  /** Whether the instance's last fetch failed. */
  failed(id: string): boolean {
    return this.of(id)?.error !== undefined;
  }

  /** Ask for fresh data on the next tick (the editor's "refresh" button). */
  refresh(id: string): void {
    const st = this.of(id);
    if (st) st.nextAt = 0;
  }

  /** One line per widget instance (those sharing a fetch say the same). */
  status() {
    return [...this.keyOf].flatMap(([id, key]) => {
      const s = this.states.get(key);
      return s ? [{ id, type: s.type, ok: !s.error, error: s.error ?? null, updatedAt: s.updatedAt ?? null }] : [];
    });
  }

  stop(): void {
    for (const st of this.states.values()) st.abort.abort();
    this.states.clear();
    this.keyOf.clear();
  }

  /** Drops the fetches of a plugin whose code changed; the next `retain` starts them again. Their last data is lost. */
  forget(pluginId: string): void {
    for (const [key, st] of this.states) {
      if (st.type.split('/')[0] !== pluginId) continue;
      st.abort.abort();
      this.states.delete(key);
      for (const id of st.ids) this.keyOf.delete(id);
    }
  }
}

/** The error to show, in the user's language when the plugin threw a PluginError. */
function msg(err: unknown, cfg: Config): string {
  return errorMessage(err, resolveLocale(cfg));
}

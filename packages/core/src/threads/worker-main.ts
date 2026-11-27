/**
 * A screen's own thread: loads the plugins again (its own copies of them),
 * keeps a copy of the data the screen shows, sent by the main thread as it
 * changes, and runs the same ScreenRunner the main thread would, on its own
 * clock. What it paints goes back to the main thread, which sends it to the
 * panel; so do its logs, paint times and state.
 *
 * An entry point calls `runScreenThread` with the plugins built into it (see
 * screen-thread.ts, and the server's, which brings Kiosko's built-in ones).
 */
import { parentPort, workerData } from 'node:worker_threads';
import { PAD_KEYS, themeById, type PluginDefinition, type Theme } from '@kiosko/sdk';
import type { Image, Canvas } from '@napi-rs/canvas';
import { isWorking, sourceKeysOf, widgetsOf, type Config, type Screen } from '../config/model.ts';
import type { Device, DeviceStatus } from '../devices.ts';
import type { LogFn } from '../env.ts';
import { Registry } from '../registry.ts';
import { ScreenRunner, TICK_MS, type FrameInfo, type RunnerHost } from '../screen-runner.ts';
import { installSdkResolver } from '../sdk-resolver.ts';
import { unpack } from './clone.ts';
import type { FromThread, ThreadInit, ThreadState, ToThread } from './protocol.ts';

/** How often the thread tells its memory, at most. */
const HEAP_EVERY_MS = 5_000;

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The plugins of the main thread, loaded here: the built-in ones from `builtins`, the rest from their modules. */
export async function loadThreadPlugins(list: ThreadInit['plugins'], builtins: PluginDefinition[]): Promise<{ registry: Registry; problems: string[] }> {
  installSdkResolver();
  const registry = new Registry();
  const problems: string[] = [];
  for (const p of list) {
    if (p.origin === 'builtin') {
      const def = builtins.find((d) => d.id === p.id);
      if (def) registry.add(def);
      else problems.push(`${p.id}: not built into the thread`);
      continue;
    }
    if (!p.module) {
      problems.push(`${p.id}: its code can't be loaded again in a thread`);
      continue;
    }
    try {
      const mod = (await import(p.module)) as { default?: PluginDefinition };
      if (mod.default) registry.add(mod.default, p.origin, p.module);
      else problems.push(`${p.id}: no default export`);
    } catch (err) {
      problems.push(`${p.id}: ${errorText(err)}`);
    }
  }
  return { registry, problems };
}

/** The panel, as seen from the thread: frames go to the main thread, which has the real one. */
class RelayDevice implements Device {
  readonly status: DeviceStatus = { driver: 'virtual', ok: true, message: 'sent through the main thread', code: 'virtual', framesSent: 0, lastSentAt: null };
  private seq = 0;
  private waiting = new Map<number, () => void>();
  private readonly post: (m: FromThread) => void;
  constructor(post: (m: FromThread) => void) {
    this.post = post;
  }
  send(frame: Buffer): Promise<void> {
    const seq = ++this.seq;
    return new Promise((resolve) => {
      this.waiting.set(seq, resolve);
      this.post({ t: 'send', seq, frame });
    });
  }
  sent(seq: number): void {
    this.waiting.get(seq)?.();
    this.waiting.delete(seq);
  }
  close(): void {
    for (const done of this.waiting.values()) done();
    this.waiting.clear();
  }
}

class Host implements RunnerHost {
  config: Config;
  readonly registry: Registry;
  readonly demoMode: boolean;
  readonly maxConcurrent: number;
  readonly playIdleMs: number;
  readonly welcome: boolean;
  readonly startedAt: number;
  readonly editorUrl: string | undefined;
  rnd = Math.random;
  readonly data = new Map<string, unknown>();
  readonly sources = new Map<string, unknown>();
  /** Instance ids and source keys whose last fetch or read failed. */
  readonly failedInstances = new Set<string>();
  readonly failedSources = new Set<string>();
  /** Pictures already made from the bytes they came as (see clone.ts). */
  readonly pictures = new Map<number, Image | Canvas>();
  runner: ScreenRunner | null = null;
  /** Called after each frame: the state may have changed with it (an interlude starting). */
  afterFrame: () => void = () => undefined;
  readonly device: RelayDevice;
  private readonly post: (m: FromThread) => void;

  constructor(init: ThreadInit, registry: Registry, post: (m: FromThread) => void) {
    this.config = init.config;
    this.registry = registry;
    this.demoMode = init.demo;
    this.maxConcurrent = init.maxConcurrent;
    this.playIdleMs = init.playIdleMs;
    this.welcome = init.welcome;
    this.startedAt = init.startedAt;
    this.editorUrl = init.editorUrl;
    this.post = post;
    this.device = new RelayDevice(post);
  }

  log: LogFn = (scope, message) => this.post({ t: 'log', scope, message });
  theme(): Theme {
    return themeById(this.config.theme);
  }
  working(now: number): boolean {
    return isWorking(this.config.workday, now);
  }
  dataOf(instanceId: string): unknown {
    return this.data.get(instanceId);
  }
  sourcesOf(types: readonly string[] | undefined, profile?: string | null): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [t, key] of this.sourceKeys(types, profile)) out[t] = this.sources.get(key);
    return out;
  }
  failedOf(instanceId: string, types: readonly string[] | undefined, profile?: string | null): boolean {
    return this.failedInstances.has(instanceId) || this.sourceKeys(types, profile).some(([, key]) => this.failedSources.has(key));
  }
  /** The source keys a widget with `profile` reads, by type (see config/profiles.ts). */
  sourceKeys(types: readonly string[] | undefined, profile?: string | null): [string, string][] {
    return sourceKeysOf(this.config, types, profile, (t) => this.registry.source(t));
  }
  paintTime(instance: string, type: string, ms: number, now: number): void {
    this.post({ t: 'paintTime', instance, type, ms, now });
  }
  frame(info: FrameInfo): void {
    const { image: _, ...rest } = info;
    this.post({ t: 'frame', info: rest });
    this.afterFrame();
  }
  pageChanged(): void {
    this.visible();
  }
  openDevice(): Device {
    return this.device;
  }

  /** What on the current page counts as visible, as `Runtime.refreshWanted` does on the main thread. */
  visible(): void {
    const r = this.runner;
    if (!r) return;
    r.visibleIds.clear();
    r.sourceTypes.clear();
    for (const { page, widget } of widgetsOf(r.screen)) {
      const def = this.registry.widget(widget.type);
      if (!def || widget.disabled) continue;
      if (!r.page || r.page.id === page.id) {
        r.visibleIds.add(widget.id);
        for (const [, key] of this.sourceKeys(def.sources, widget.profile)) r.sourceTypes.add(key);
      }
    }
  }
}

export async function runScreenThread(builtins: PluginDefinition[] = []): Promise<void> {
  const port = parentPort;
  if (!port) throw new Error('runScreenThread runs in a worker thread');
  const init = workerData as ThreadInit;
  const post = (m: FromThread) => port.postMessage(m);
  // Messages that come while the plugins load wait for them.
  const early: ToThread[] = [];
  let handle: ((m: ToThread) => void) | null = null;
  port.on('message', (m: ToThread) => (handle ? handle(m) : early.push(m)));

  const { registry, problems } = await loadThreadPlugins(init.plugins, builtins);
  registry.setDisabled(init.config.plugins.disabled);
  const host = new Host(init, registry, post);
  const runner = new ScreenRunner(init.screen, host);
  host.runner = runner;
  if (init.pinned !== runner.pinned) runner.setPinned(init.pinned);
  if (init.context) runner.setContext(init.context);
  if (init.off) runner.setOff(true);
  if (init.paused) runner.setPaused(true);
  host.visible();

  let lastState = '';
  let heapAt = 0;
  let heapBytes = 0;
  const tellState = () => {
    if (Date.now() - heapAt >= HEAP_EVERY_MS) {
      heapAt = Date.now();
      // In a worker these are its own isolate's, not the process' (rss is the process').
      const m = process.memoryUsage();
      heapBytes = m.heapUsed + m.external;
    }
    const state: ThreadState = {
      page: runner.page?.id ?? null,
      interlude: runner.interlude ? { type: runner.interlude.type, play: runner.interlude.play } : null,
      animating: runner.animating,
      stats: runner.stats.read(),
      heapBytes,
    };
    const key = JSON.stringify(state);
    if (key === lastState) return;
    lastState = key;
    post({ t: 'state', state });
  };

  host.afterFrame = tellState;
  let timer: NodeJS.Timeout | null = null;
  const close = () => {
    if (timer) clearInterval(timer);
    timer = null;
    runner.close();
    host.device.close();
    port.close();
  };

  handle = (m) => {
    switch (m.t) {
      case 'apply': {
        host.config = m.config;
        registry.setDisabled(m.config.plugins.disabled);
        runner.reconfigure(m.screen as Screen);
        host.visible();
        return;
      }
      case 'data': {
        const value = unpack(m.value, host.pictures);
        if (m.instance) {
          if (value === undefined) host.data.delete(m.instance);
          else host.data.set(m.instance, value);
          if (m.failed) host.failedInstances.add(m.instance);
          else host.failedInstances.delete(m.instance);
        }
        if (m.source) {
          if (value === undefined) host.sources.delete(m.source);
          else host.sources.set(m.source, value);
          if (m.failed) host.failedSources.add(m.source);
          else host.failedSources.delete(m.source);
        }
        runner.dataChanged({ ...(m.instance ? { instance: m.instance } : {}), ...(m.source ? { source: m.source } : {}) });
        return;
      }
      case 'alert':
        runner.setAlert(m.shown, Date.now());
        return;
      case 'pin':
        runner.setPinned(m.page);
        return;
      case 'context':
        runner.setContext(m.pick);
        return;
      case 'off':
        runner.setOff(m.off);
        return;
      case 'paused':
        runner.setPaused(m.paused);
        tellState();
        return;
      case 'play':
        void runner.playNow(m.slot, m.play).then(tellState);
        tellState();
        return;
      case 'stop':
        runner.stopInterlude();
        return;
      case 'press':
        if (PAD_KEYS.includes(m.e.key)) runner.press(m.e);
        return;
      case 'sent':
        host.device.sent(m.seq);
        return;
      case 'image': {
        let image: Uint8Array | null = null;
        void (async () => {
          try {
            const info = runner.lastInfo;
            if (info) image = await info.image();
          } catch {
            image = null;
          }
          post({ t: 'image', req: m.req, image });
        })();
        return;
      }
      case 'close':
        close();
        return;
    }
  };
  for (const m of early.splice(0)) handle(m);
  post({ t: 'ready', problems });

  const loop = async () => {
    await runner.update(Date.now());
    tellState();
  };
  timer = setInterval(() => void loop(), TICK_MS);
  void loop();
}

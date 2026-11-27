/**
 * A screen painted in a thread of its own, seen from the main thread: the
 * Runtime drives it like any runner (see `Runner` in screen-runner.ts), and
 * it passes everything on to the thread (worker-main.ts), which runs the
 * real ScreenRunner. Here stay the panel itself (the frames come back and
 * are sent from here: one owner for each USB handle or trcc connection, and
 * its status where the editor reads it), and a mirror of what the thread
 * says it is doing, for `status()`.
 *
 * The thread gets the data of every widget and source of its screen (all its
 * pages and interludes, not only the one shown), and then each change as it
 * happens: never the whole registry of data again.
 */
import { existsSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { PAD_KEYS, type PadEvent } from '@kiosko/sdk';
import type { ShownAlert } from '../alerts.ts';
import { widgetsOf, type Config, type Page, type Screen } from '../config/model.ts';
import type { ContextPick } from '../context.ts';
import type { Device } from '../devices.ts';
import type { LogFn } from '../env.ts';
import type { ScreenFrameStats } from '../frame-stats.ts';
import type { Registry } from '../registry.ts';
import type { FrameInfo, Runner } from '../screen-runner.ts';
import { Unclonable, pack } from './clone.ts';
import type { FromThread, ThreadInit, ThreadState, ToThread } from './protocol.ts';

/** What a ThreadRunner needs from the Runtime. */
export interface ThreadOwner {
  readonly config: Config;
  readonly registry: Registry;
  readonly demoMode: boolean;
  readonly maxConcurrent: number;
  readonly playIdleMs: number;
  readonly welcome: boolean;
  readonly startedAt: number;
  readonly editorUrl?: string | undefined;
  log: LogFn;
  dataOf(instanceId: string): unknown;
  /** The latest data of a source key (see config/profiles.ts). */
  sourceData(key: string): unknown;
  /** Whether an instance's fetch, or a source key, is failing now (sent along with the data). Missing: never. */
  instanceFailed?(instanceId: string): boolean;
  sourceFailed?(key: string): boolean;
  /** The source keys a widget with `profile` reads. */
  sourceKeys(types: readonly string[] | undefined, profile?: string | null): string[];
  paintTime(instance: string, type: string, ms: number, now: number): void;
  frame(info: FrameInfo): void;
  pageChanged(): void;
  openDevice(screen: Screen, log: (m: string) => void): Device;
  /** The screen can't paint in a thread (`reason`): it goes back to the main thread. */
  threadFailed(screenId: string, reason: string): void;
}

/** The thread's entry point that comes with core: plugins from their modules only. Compiled (.js) or not (.ts). */
export function defaultThreadEntry(): URL {
  return ['./screen-thread.js', './screen-thread.ts'].map((f) => new URL(f, import.meta.url)).find((u) => existsSync(u)) ?? new URL('./screen-thread.ts', import.meta.url);
}

const NO_STATS: ScreenFrameStats = { fps: 0, paintMs: 0, encodeMs: 0, frames: 0 };

export class ThreadRunner implements Runner {
  screen: Screen;
  device: Device;
  private deviceKey: string;
  pinned: string | null;
  context: ContextPick | null = null;
  off = false;
  /** Its panel is missing (presence.ts): the thread paints nothing and is sent no data meanwhile. */
  paused = false;
  alert: ShownAlert | null = null;
  lastInfo: FrameInfo | null = null;
  visibleIds = new Set<string>();
  sourceTypes = new Set<string>();
  private state: ThreadState = { page: null, interlude: null, animating: null, stats: NO_STATS, heapBytes: 0 };
  private alertKey = 'null';
  private worker: Worker | null = null;
  /** Bumped with each worker started: messages from an older one are ignored. */
  private generation = 0;
  private closed = false;
  private failed = false;
  private need = { ids: new Set<string>(), sources: new Set<string>() };
  private images = new Map<number, (b: Buffer | null) => void>();
  private nextReq = 0;
  readonly stats = { read: (): ScreenFrameStats => this.state.stats };
  private readonly owner: ThreadOwner;
  private readonly entry: URL;

  constructor(screen: Screen, owner: ThreadOwner, entry: URL = defaultThreadEntry(), device?: Device) {
    this.screen = screen;
    this.owner = owner;
    this.entry = entry;
    this.pinned = screen.pinnedPage ?? null;
    this.deviceKey = JSON.stringify(screen.device);
    this.device = device ?? owner.openDevice(screen, (m) => owner.log(`screen:${screen.name}`, m));
    // A panel already known to be missing: the thread starts paused (a message would come after its first paint).
    this.paused = screen.enabled && this.device.presence?.state === 'absent';
    this.start();
  }

  get page(): Page | null {
    return this.state.page ? (this.screen.pages.find((p) => p.id === this.state.page) ?? null) : null;
  }
  get interlude() {
    return this.state.interlude;
  }
  get animating() {
    return this.state.animating;
  }
  /** What the thread's JavaScript holds, in bytes (see `ThreadState.heapBytes`). */
  get heapBytes(): number {
    return this.state.heapBytes;
  }

  private post(m: ToThread): void {
    if (this.worker && !this.failed) this.worker.postMessage(m);
  }

  private start(): void {
    const generation = ++this.generation;
    const init: ThreadInit = {
      config: this.owner.config,
      screen: this.screen,
      plugins: this.owner.registry.threadPlugins(),
      demo: this.owner.demoMode,
      maxConcurrent: this.owner.maxConcurrent,
      playIdleMs: this.owner.playIdleMs,
      welcome: this.owner.welcome,
      startedAt: this.owner.startedAt,
      ...(this.owner.editorUrl ? { editorUrl: this.owner.editorUrl } : {}),
      pinned: this.pinned,
      context: this.context,
      off: this.off,
      paused: this.paused,
    };
    const w = new Worker(this.entry, { workerData: init, name: `kiosko screen ${this.screen.id}` } as ConstructorParameters<typeof Worker>[1]);
    this.worker = w;
    w.on('message', (m: FromThread) => generation === this.generation && this.onMessage(m));
    w.on('error', (err) => generation === this.generation && this.fail(`the thread failed: ${err instanceof Error ? err.message : String(err)}`));
    w.on('exit', (code) => {
      if (generation !== this.generation || this.closed || this.failed) return;
      this.fail(`the thread stopped (exit code ${code})`);
    });
    // The data it shows now; then each change (`dataChanged`).
    this.need = { ids: new Set(), sources: new Set() };
    this.sendNeeded();
    if (this.alert) this.post({ t: 'alert', shown: this.alert });
  }

  /** What the screen shows, on any page or interlude: the data its thread must have. */
  private needed(): { ids: Set<string>; sources: Set<string> } {
    const ids = new Set<string>();
    const sources = new Set<string>();
    const reg = this.owner.registry;
    for (const { widget } of widgetsOf(this.screen)) {
      const def = reg.widget(widget.type);
      if (!def || widget.disabled) continue;
      ids.add(widget.id);
      for (const s of this.owner.sourceKeys(def.sources, widget.profile)) sources.add(s);
    }
    for (const slot of this.screen.interludes) for (const s of reg.interlude(slot.type)?.sources ?? []) sources.add(s);
    return { ids, sources };
  }

  /** Sends what is needed now and wasn't before. */
  private sendNeeded(): void {
    const now = this.needed();
    const old = this.need;
    this.need = now;
    for (const id of now.ids) if (!old.ids.has(id)) this.sendData({ instance: id }, true);
    for (const s of now.sources) if (!old.sources.has(s)) this.sendData({ source: s }, true);
  }

  /** `fresh`: the thread has nothing for it yet, so nothing need be said when there is nothing. */
  private sendData(change: { instance?: string; source?: string }, fresh = false): void {
    if (this.failed) return;
    const value = change.instance ? this.owner.dataOf(change.instance) : this.owner.sourceData(change.source!);
    const failed = !!(change.instance ? this.owner.instanceFailed?.(change.instance) : this.owner.sourceFailed?.(change.source!));
    if (value === undefined && !failed && fresh) return;
    let packed: unknown;
    try {
      packed = pack(value);
    } catch (err) {
      if (!(err instanceof Unclonable)) throw err;
      this.fail(`the data of ${change.instance ? `widget ${change.instance}` : change.source} can't go to another thread: ${err.message}`);
      return;
    }
    this.post({ t: 'data', ...change, value: packed, ...(failed ? { failed } : {}) });
  }

  private onMessage(m: FromThread): void {
    switch (m.t) {
      case 'ready': {
        // A plugin this screen uses that the thread could not load: back to the main thread.
        const used = new Set([...[...widgetsOf(this.screen)].map((x) => x.widget.type), ...this.screen.interludes.map((s) => s.type)].map((t) => t.split('/')[0]!));
        const bad = m.problems.find((p) => used.has(p.split(':')[0]!));
        if (bad) this.fail(`plugin ${bad}`);
        return;
      }
      case 'log':
        this.owner.log(m.scope, m.message);
        return;
      case 'paintTime':
        this.owner.paintTime(m.instance, m.type, m.ms, m.now);
        return;
      case 'frame': {
        const info: FrameInfo = { ...m.info, image: () => this.image() };
        this.lastInfo = info;
        this.owner.frame(info);
        return;
      }
      case 'state': {
        const pageBefore = this.state.page;
        this.state = m.state;
        if (m.state.page !== pageBefore) this.owner.pageChanged();
        return;
      }
      case 'send': {
        const frame = Buffer.from(m.frame.buffer, m.frame.byteOffset, m.frame.byteLength);
        const seq = m.seq;
        void this.device.send(frame).finally(() => this.post({ t: 'sent', seq }));
        return;
      }
      case 'image': {
        const done = this.images.get(m.req);
        this.images.delete(m.req);
        done?.(m.image ? Buffer.from(m.image.buffer, m.image.byteOffset, m.image.byteLength) : null);
        return;
      }
    }
  }

  /** The last frame's picture, asked of the thread, which has it. */
  private image(): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      if (!this.worker || this.failed) return reject(new Error('the screen\'s thread is gone'));
      const req = ++this.nextReq;
      this.images.set(req, (b) => (b ? resolve(b) : reject(new Error('no frame yet'))));
      this.post({ t: 'image', req });
    });
  }

  private fail(reason: string): void {
    if (this.failed || this.closed) return;
    this.failed = true;
    this.stopWorker();
    this.owner.threadFailed(this.screen.id, reason);
  }

  private stopWorker(): void {
    const w = this.worker;
    this.worker = null;
    this.generation++;
    for (const done of this.images.values()) done(null);
    this.images.clear();
    if (!w) return;
    try {
      w.postMessage({ t: 'close' } satisfies ToThread);
    } catch {
      /* already gone */
    }
    // A moment to finish what it was doing; then it goes, whatever it is doing.
    const t = setTimeout(() => void w.terminate(), 1_000);
    t.unref();
    w.once('exit', () => clearTimeout(t));
    w.unref();
  }

  /** The panel, for whoever paints the screen next (the main thread, when this one failed); closing this runner leaves it open. */
  takeDevice(): Device {
    const d = this.device;
    this.deviceKey = '';
    return d;
  }

  update(): Promise<void> {
    // The thread runs on its own clock.
    return Promise.resolve();
  }

  reconfigure(screen: Screen): void {
    const key = JSON.stringify(screen.device);
    if (key !== this.deviceKey) {
      if (this.deviceKey) this.device.close();
      this.device = this.owner.openDevice(screen, (m) => this.owner.log(`screen:${screen.name}`, m));
      this.deviceKey = key;
    }
    if (screen.pinnedPage !== this.screen.pinnedPage) this.pinned = screen.pinnedPage ?? null;
    this.screen = screen;
    this.post({ t: 'apply', config: this.owner.config, screen });
    this.sendNeeded();
  }

  /** A plugin's code changed: a new thread loads them all again (an ES module can't be unloaded). */
  invalidate(): void {
    if (this.closed || this.failed) return;
    this.stopWorker();
    this.start();
  }

  dataChanged(change: { source?: string; instance?: string }): void {
    if (this.paused) return;
    if ((change.instance && this.need.ids.has(change.instance)) || (change.source && this.need.sources.has(change.source))) this.sendData(change);
  }

  setAlert(shown: ShownAlert | null): void {
    const key = JSON.stringify(shown);
    this.alert = shown;
    if (key === this.alertKey) return;
    this.alertKey = key;
    this.post({ t: 'alert', shown });
  }

  setPinned(pageId: string | null): void {
    this.pinned = pageId;
    this.post({ t: 'pin', page: pageId });
  }

  setContext(pick: ContextPick | null): void {
    const same = JSON.stringify(pick) === JSON.stringify(this.context);
    this.context = pick;
    if (!same) this.post({ t: 'context', pick });
  }

  setOff(off: boolean): void {
    this.off = off;
    if (off) this.state = { ...this.state, interlude: null };
    this.post({ t: 'off', off });
  }

  setPaused(paused: boolean): void {
    if (paused === this.paused) return;
    this.paused = paused;
    if (paused) this.state = { ...this.state, interlude: null, animating: null };
    this.post({ t: 'paused', paused });
    // Back: the data it missed meanwhile, all of it again.
    if (!paused) {
      this.need = { ids: new Set(), sources: new Set() };
      this.sendNeeded();
    }
  }

  async playNow(slotId: string, play = false): Promise<void> {
    if (this.off || this.alert || this.paused) return;
    this.post({ t: 'play', slot: slotId, play });
  }

  stopInterlude(): void {
    this.state = { ...this.state, interlude: null };
    this.post({ t: 'stop' });
  }

  press(e: PadEvent): boolean {
    if (!this.state.interlude?.play || !PAD_KEYS.includes(e.key)) return false;
    this.post({ t: 'press', e: { key: e.key, pressed: !!e.pressed } });
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopWorker();
    if (this.deviceKey) this.device.close();
  }
}

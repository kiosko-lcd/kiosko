/**
 * The runtime: loads the config, keeps the data flowing, paints each screen
 * when something visible changes and sends the frame to its panel. Emits
 * events for the editor (new frame, logs, status).
 *
 * Painting is event-driven, not a fixed frame rate: a frame is painted when
 * the data of a widget on screen changes, when a widget asks for it (a clock
 * every second or minute), when a tile's turn or the page changes, and on
 * config edits. An identical frame isn't sent again: every frame costs USB
 * time and, with `trcc serve`, a copy on disk.
 */
import { EventEmitter } from 'node:events';
import { themeById, validate, type Theme } from '@kiosko/sdk';
import type { Canvas } from '@napi-rs/canvas';
import { AnimationScheduler, type PlayablePlan } from './animation.ts';
import { composePage, composeWidget, rotateCanvas, type Animatable, type ComposeResult, type TileCache } from './compositor.ts';
import { isWorking, whenMatches, widgetsOf, type Config, type Page, type Screen, type WidgetInstance } from './config/model.ts';
import { FetchHost, SourceHub } from './data.ts';
import { encodeFor, openDevice, type Device, type DeviceStatus } from './devices.ts';
import { CANVAS, baseContext, type LogFn } from './env.ts';
import { pickPage } from './layout/stack.ts';
import type { Registry } from './registry.ts';

export interface LogEntry {
  at: number;
  scope: string;
  message: string;
}

export interface FrameInfo {
  screenId: string;
  pageId: string | null;
  at: number;
  /**
   * JPEG of the logical (unrotated) frame, for the editor: encoded only if
   * someone asks for it. Encoding every frame as PNG "just in case" was ~80%
   * of the daemon's CPU.
   */
  image: () => Buffer;
  tiles: ComposeResult['tiles'];
  interlude: string | null;
  /** Type of the widget whose animation is playing (a frame of it), if any. */
  animation?: string;
  sleeping: boolean;
}

const TICK_MS = 250;

function lazyJpeg(c: Canvas): () => Buffer {
  let b: Buffer | null = null;
  return () => (b ??= c.toBuffer('image/jpeg', 88));
}

function encode(c: Canvas, kind: 'png' | 'jpeg', quality: number): Buffer {
  return kind === 'jpeg' ? c.toBuffer('image/jpeg', Math.max(1, Math.min(100, quality || 90))) : c.toBuffer('image/png');
}

class ScreenRunner {
  device: Device;
  private deviceKey: string;
  private last: Buffer | null = null;
  lastInfo: FrameInfo | null = null;
  dirty = true;
  private nextAt = 0;
  private busy = false;
  pinned: string | null = null;
  private playedSlot = new Map<string, number>();
  interlude: { slotId: string; type: string; stopAt: number } | null = null;
  /** Instance ids on the current page, to know if a data change concerns us. */
  visibleIds = new Set<string>();
  sourceTypes = new Set<string>();
  page: Page | null = null;
  /** Rendered tiles reused between frames (see compositor's TileCache). */
  private tiles: TileCache = new Map();
  /** The widgets of the last painted page that can animate, and when to ask them (see animation.ts). */
  private animatable: Animatable[] = [];
  private scheduler: AnimationScheduler;
  /** Set while a widget's animation plays: its widget type. */
  animating: string | null = null;
  private closed = false;

  screen: Screen;
  private readonly rt: Runtime;
  constructor(screen: Screen, rt: Runtime) {
    this.screen = screen;
    this.rt = rt;
    this.deviceKey = JSON.stringify(screen.device);
    this.device = openDevice(screen.device, (m) => rt.log(`screen:${screen.name}`, m));
    this.pinned = screen.pinnedPage ?? null;
    this.scheduler = new AnimationScheduler(() => rt.rnd(), (type, why) => rt.log(type, `animation ignored: ${why}`));
  }

  reconfigure(screen: Screen): void {
    const key = JSON.stringify(screen.device);
    if (key !== this.deviceKey) {
      this.device.close();
      this.device = openDevice(screen.device, (m) => this.rt.log(`screen:${screen.name}`, m));
      this.deviceKey = key;
      this.last = null;
    }
    if (screen.pinnedPage !== this.screen.pinnedPage) this.pinned = screen.pinnedPage ?? null;
    this.screen = screen;
    this.tiles.clear();
    this.dirty = true;
  }

  currentPage(now: number): Page | null {
    const working = this.rt.working(now);
    const pages = this.screen.pages.filter((p) => whenMatches(p.when, working));
    return pickPage(pages, now, this.pinned);
  }

  async update(now: number): Promise<void> {
    if (this.busy || !this.screen.enabled) return;
    this.busy = true;
    try {
      if (await this.maybeInterlude(now)) return;
      const page = this.currentPage(now);
      if (page?.id !== this.page?.id) {
        this.page = page;
        this.dirty = true;
        this.rt.refreshWanted();
      }
      if (!this.dirty && now < this.nextAt) {
        await this.maybeAnimate(now);
        return;
      }
      this.dirty = false;
      await this.paint(page, now);
      await this.maybeAnimate(now);
    } catch (err) {
      this.rt.log(`screen:${this.screen.name}`, `paint failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.busy = false;
    }
  }

  private async paint(page: Page | null, now: number): Promise<void> {
    const { screen } = this;
    const theme = this.rt.theme();
    let result: ComposeResult | null = null;
    let canvas: Canvas;
    if (page) {
      result = composePage({
        cfg: this.rt.config,
        screen,
        page,
        theme,
        registry: this.rt.registry,
        now,
        working: this.rt.working(now),
        dataOf: (inst) => this.rt.fetches.data(inst.id),
        sourcesOf: (types) => this.rt.hub.pick(types),
        log: this.rt.log,
        demo: this.rt.demoMode,
        cache: this.tiles,
      });
      canvas = result.canvas;
      this.animatable = result.animatable;
      this.nextAt = Math.min(result.nextAt, now + 60_000);
      // Pages and work hours change by the clock: check at least every minute.
    } else {
      canvas = CANVAS.createCanvas(screen.width, screen.height);
      const g = canvas.getContext('2d');
      g.fillStyle = '#000';
      g.fillRect(0, 0, screen.width, screen.height);
      this.animatable = [];
      this.nextAt = now + 60_000;
    }
    const sleeping = !!(screen.sleepWhenIdle && result?.idle);
    if (sleeping) {
      const g = canvas.getContext('2d');
      g.fillStyle = '#000';
      g.fillRect(0, 0, screen.width, screen.height);
    }
    const kind = encodeFor(screen.device, screen.jpegQuality);
    const out = encode(rotateCanvas(canvas, screen.rotate), kind, screen.jpegQuality);
    this.lastInfo = { screenId: screen.id, pageId: page?.id ?? null, at: now, image: lazyJpeg(canvas), tiles: result?.tiles ?? [], interlude: null, sleeping };
    this.rt.emit('frame', this.lastInfo);
    if (this.last?.equals(out)) return;
    this.last = out;
    await this.device.send(out);
  }

  /** Plays an interlude if one is due. Returns true while it played (no normal paint this tick). */
  private async maybeInterlude(now: number, force?: string): Promise<boolean> {
    const due = this.screen.interludes.find((s) => {
      if (force) return s.id === force;
      if (!s.enabled || s.everyMs < 60_000) return false;
      const slot = Math.floor(now / s.everyMs);
      // Only during the first minute of its slot, and once per slot.
      return now - slot * s.everyMs < 60_000 && this.playedSlot.get(s.id) !== slot;
    });
    if (!due) return false;
    this.playedSlot.set(due.id, Math.floor(now / Math.max(1, due.everyMs)));
    const def = this.rt.registry.interlude(due.type);
    if (!def) return false;
    const sources = this.rt.hub.pick(def.sources);
    const options = def.options ? validate(def.options, due.options).value : {};
    if (!force && def.skip?.({ sources, now, options })) {
      this.rt.log(`screen:${this.screen.name}`, `interlude ${due.type} skipped (busy)`);
      return false;
    }
    const [plugin] = due.type.split('/');
    const seed = Math.floor(now / Math.max(60_000, due.everyMs));
    const player = await def.prepare({ ...baseContext(this.rt.config, plugin!, this.rt.log, now), options, width: this.screen.width, height: this.screen.height, seed, theme: this.rt.theme(), canvas: CANVAS, sources });
    if (!player || player.frames <= 0) return false;
    const fps = Math.max(1, Math.min(def.fps, this.screen.maxFps));
    const frames = Math.min(player.frames, Math.round(due.maxSeconds * fps));
    this.interlude = { slotId: due.id, type: due.type, stopAt: now + (frames / fps) * 1000 };
    this.rt.log(`screen:${this.screen.name}`, `playing ${due.type}: ${frames} frames at ${fps} fps`);
    const kind = encodeFor(this.screen.device, this.screen.jpegQuality || 85);
    const canvas = CANVAS.createCanvas(this.screen.width, this.screen.height);
    const g = canvas.getContext('2d');
    const start = Date.now();
    for (let i = 0; i < frames && this.interlude; i++) {
      g.save();
      try {
        await player.draw(g, i);
      } catch (err) {
        this.rt.log(due.type, `frame ${i} failed: ${err instanceof Error ? err.message : String(err)}`);
        break;
      } finally {
        g.restore();
      }
      const out = encode(rotateCanvas(canvas, this.screen.rotate), kind, this.screen.jpegQuality || 85);
      await this.device.send(out);
      if (i % 3 === 0) {
        // The interlude draws every frame on the same canvas: snapshot it.
        const snap = CANVAS.createCanvas(canvas.width, canvas.height);
        snap.getContext('2d').drawImage(canvas, 0, 0);
        this.lastInfo = { screenId: this.screen.id, pageId: this.page?.id ?? null, at: Date.now(), image: lazyJpeg(snap), tiles: [], interlude: due.type, sleeping: false };
        this.rt.emit('frame', this.lastInfo);
      }
      const wait = start + ((i + 1) * 1000) / fps - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
    this.interlude = null;
    this.last = null;
    this.dirty = true;
    return true;
  }

  /**
   * Plays the animation a shown widget asks for, if one is due (see
   * animation.ts). Like an interlude it runs inside `update`, so nothing else
   * is painted meanwhile, but unlike it the page stays in place: only the
   * widget's tile changes from frame to frame.
   */
  private async maybeAnimate(now: number): Promise<void> {
    if (!this.screen.enabled || this.closed || this.lastInfo?.sleeping || !this.animatable.length) return;
    const due = this.scheduler.next(this.animatable, now, this.screen.maxFps);
    if (!due) return;
    const { animatable: a, play } = due;
    this.animating = a.type;
    try {
      await this.playAnimation(a, play, now);
    } finally {
      this.animating = null;
      // Whatever happened, the next paint is a real one with the current data.
      this.last = null;
      this.dirty = true;
      this.scheduler.ended(a.instanceId, Date.now(), a);
    }
  }

  private async playAnimation(a: Animatable, play: PlayablePlan, now: number): Promise<void> {
    const page = this.page;
    if (!page) return;
    const { screen } = this;
    const { frames, fps, interruptible } = play;
    const abort = () => this.closed || (interruptible && this.dirty) || !this.screen.enabled;
    this.dirty = false;
    // The page as it was at the start: same clock, same data for every frame, so
    // only the animated tile moves (a changing clock would flicker) and, if it
    // can't be cut short, a data change during it doesn't leak in.
    const memoData = new Map<string, unknown>();
    const memoSources = new Map<string, Record<string, unknown>>();
    const working = this.rt.working(now);
    const kind = encodeFor(screen.device, screen.jpegQuality || 85);
    const sent: { out: Buffer; snap: Canvas | null }[] = [];
    const t0 = Date.now();
    // Every frame is painted before the first is sent: painting and sending
    // at once is slower than either, and the panel drops what comes late.
    for (let i = 1; i < frames - 1; i++) {
      if (abort()) return;
      const result = composePage({
        cfg: this.rt.config,
        screen,
        page,
        theme: this.rt.theme(),
        registry: this.rt.registry,
        now,
        working,
        dataOf: (inst) => {
          if (!memoData.has(inst.id)) memoData.set(inst.id, this.rt.fetches.data(inst.id));
          return memoData.get(inst.id);
        },
        sourcesOf: (types) => {
          const k = JSON.stringify(types ?? []);
          if (!memoSources.has(k)) memoSources.set(k, this.rt.hub.pick(types));
          return memoSources.get(k)!;
        },
        log: this.rt.log,
        demo: this.rt.demoMode,
        cache: this.tiles,
        animate: { tileId: a.tileId, instanceId: a.instanceId, frame: { plan: play.plan, i, t: i / (frames - 1) } },
      });
      sent.push({ out: encode(rotateCanvas(result.canvas, screen.rotate), kind, screen.jpegQuality || 85), snap: i % 3 === 1 ? result.canvas : null });
      // Let the loop breathe: a long animation must not freeze the timers and the other screens.
      await new Promise((r) => setImmediate(r));
    }
    this.rt.log(`screen:${screen.name}`, `animating ${a.type} ${play.plan.id}: ${sent.length} frames at ${fps} fps (painted in ${Date.now() - t0} ms)`);
    const holdAt = play.hold ? play.hold.index - 1 : -1;
    let start = Date.now();
    for (let k = 0; k < sent.length; k++) {
      if (abort()) return;
      // Late: skip the frame rather than let the delay pile up.
      const due = Math.floor(((Date.now() - start) * fps) / 1000);
      if (k < due - 1 && k !== holdAt && k < sent.length - 1) continue;
      await this.device.send(sent[k]!.out);
      const snap = sent[k]!.snap;
      if (snap) {
        this.lastInfo = { screenId: screen.id, pageId: page.id, at: Date.now(), image: lazyJpeg(snap), tiles: [], interlude: null, animation: a.type, sleeping: false };
        this.rt.emit('frame', this.lastInfo);
      }
      if (k === holdAt && play.hold) {
        // Still: the panel keeps the picture without being sent it again.
        const until = Date.now() + play.hold.ms;
        while (Date.now() < until && !abort()) await new Promise((r) => setTimeout(r, Math.min(250, until - Date.now())));
        start = Date.now() - ((k + 1) * 1000) / fps;
        continue;
      }
      const wait = start + ((k + 1) * 1000) / fps - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
  }

  async playNow(slotId: string): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.maybeInterlude(Date.now(), slotId);
    } finally {
      this.busy = false;
    }
  }

  stopInterlude(): void {
    this.interlude = null;
  }

  close(): void {
    this.closed = true;
    this.interlude = null;
    this.device.close();
  }
}

export class Runtime extends EventEmitter {
  config: Config;
  readonly hub: SourceHub;
  readonly fetches: FetchHost;
  private runners = new Map<string, ScreenRunner>();
  private timer: NodeJS.Timeout | null = null;
  readonly logs: LogEntry[] = [];
  /** Random numbers for the animations; tests replace it with a seeded one. */
  rnd: () => number = Math.random;

  readonly registry: Registry;
  /**
   * Demo mode: no source or fetch runs, every widget paints its sample data.
   * For trying Kiosko without any setup, screenshots and kiosks at fairs.
   */
  readonly demoMode: boolean;
  constructor(registry: Registry, config: Config, o: { demo?: boolean } = {}) {
    super();
    this.registry = registry;
    this.demoMode = !!o.demo;
    this.setMaxListeners(100);
    this.config = config;
    this.hub = new SourceHub(registry, this.log, (type) => this.onData({ source: type }));
    this.fetches = new FetchHost(this.hub, this.log, (id) => this.onData({ instance: id }));
  }

  log: LogFn = (scope, message) => {
    const e = { at: Date.now(), scope, message };
    this.logs.push(e);
    if (this.logs.length > 500) this.logs.splice(0, this.logs.length - 500);
    this.emit('log', e);
    if (process.env.KIOSKO_QUIET !== '1') console.log(`[${new Date(e.at).toISOString().slice(11, 19)}] ${scope}: ${message}`);
  };

  theme(): Theme {
    return themeById(this.config.theme);
  }

  working(now: number): boolean {
    return isWorking(this.config.workday, now);
  }

  private onData(change: { source?: string; instance?: string }): void {
    for (const r of this.runners.values()) {
      if ((change.instance && r.visibleIds.has(change.instance)) || (change.source && r.sourceTypes.has(change.source))) r.dirty = true;
    }
    this.emit('data', change);
  }

  /**
   * Starts the sources and fetches the enabled screens need. Every page's
   * widgets keep fetching (not just the visible page) so switching pages
   * shows fresh data at once.
   */
  refreshWanted(): void {
    const instances: { inst: WidgetInstance; def: NonNullable<ReturnType<Registry['widget']>> }[] = [];
    const sources = new Set<string>();
    for (const r of this.runners.values()) {
      r.visibleIds.clear();
      r.sourceTypes.clear();
      for (const { page, widget } of widgetsOf(r.screen)) {
        const def = this.registry.widget(widget.type);
        if (!def || widget.disabled) continue;
        instances.push({ inst: widget, def });
        for (const s of def.sources ?? []) sources.add(s);
        if (!r.page || r.page.id === page.id) {
          r.visibleIds.add(widget.id);
          for (const s of def.sources ?? []) r.sourceTypes.add(s);
        }
      }
      for (const slot of r.screen.interludes) for (const s of this.registry.interlude(slot.type)?.sources ?? []) if (slot.enabled) sources.add(s);
    }
    if (this.demoMode) {
      sources.clear();
      instances.length = 0;
    }
    this.hub.retain(sources, this.config);
    this.fetches.retain(instances);
  }

  /** Applies a new config: screens added, removed or changed; data kept where possible. */
  apply(config: Config): void {
    this.config = config;
    this.registry.setDisabled(config.plugins.disabled);
    const ids = new Set(config.screens.map((s) => s.id));
    for (const [id, r] of this.runners) {
      if (!ids.has(id)) {
        r.close();
        this.runners.delete(id);
      }
    }
    for (const s of config.screens) {
      const r = this.runners.get(s.id);
      if (r) r.reconfigure(s);
      else this.runners.set(s.id, new ScreenRunner(s, this));
    }
    this.refreshWanted();
    this.emit('config', config);
  }

  start(): void {
    this.apply(this.config);
    const loop = async () => {
      const now = Date.now();
      this.hub.tick(this.config, now);
      this.fetches.tick(this.config, now);
      await Promise.all([...this.runners.values()].map((r) => r.update(now)));
    };
    this.timer = setInterval(() => void loop(), TICK_MS);
    void loop();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const r of this.runners.values()) r.close();
    this.hub.stop();
    this.fetches.stop();
  }

  lastFrame(screenId: string): FrameInfo | null {
    return this.runners.get(screenId)?.lastInfo ?? null;
  }

  pin(screenId: string, pageId: string | null): void {
    const r = this.runners.get(screenId);
    if (!r) return;
    r.pinned = pageId;
    r.dirty = true;
  }

  playInterlude(screenId: string, slotId: string): void {
    void this.runners.get(screenId)?.playNow(slotId);
  }

  stopInterlude(screenId: string): void {
    this.runners.get(screenId)?.stopInterlude();
  }

  refreshWidget(instanceId: string): void {
    this.fetches.refresh(instanceId);
  }

  status() {
    return {
      screens: [...this.runners.values()].map((r) => ({
        id: r.screen.id,
        name: r.screen.name,
        page: r.page?.id ?? null,
        pinned: r.pinned,
        interlude: r.interlude?.type ?? null,
        animation: r.animating,
        device: r.device.status as DeviceStatus,
        lastFrameAt: r.lastInfo?.at ?? null,
        sleeping: r.lastInfo?.sleeping ?? false,
      })),
      sources: this.hub.status(),
      fetches: this.fetches.status(),
      problems: this.registry.problems,
    };
  }

  /**
   * Paints any page (saved or being edited) with live data, falling back to
   * demo data, for the editor. Doesn't touch the panel.
   */
  preview(screen: Screen, page: Page, o: { now?: number; forceShown?: Record<string, string>; demo?: boolean } = {}): ComposeResult {
    return composePage({
      cfg: this.config,
      screen,
      page,
      theme: this.theme(),
      registry: this.registry,
      now: o.now ?? Date.now(),
      working: this.working(o.now ?? Date.now()),
      dataOf: (inst) => this.fetches.data(inst.id),
      sourcesOf: (types) => this.hub.pick(types),
      preview: true,
      demo: o.demo ?? true,
      ...(o.forceShown ? { forceShown: o.forceShown } : {}),
      log: this.log,
    });
  }

  /**
   * A widget alone with its demo data. `look` paints it in a theme and
   * language other than the current config's: the editor asks for the ones
   * it is showing, which may not have reached the runtime yet.
   */
  thumbnail(type: string, width: number, height: number, options: Record<string, unknown> = {}, title?: string, look: ThumbnailLook = {}): Buffer {
    const cfg = withLook(this.config, look);
    return composeWidget({ cfg, registry: this.registry, theme: themeById(cfg.theme), type, width, height, options, ...(title ? { title } : {}) }).canvas.toBuffer('image/png');
  }
}

/** Theme and language for a thumbnail; unset ones come from the config. */
export interface ThumbnailLook {
  theme?: string;
  locale?: string;
}

export function withLook<C extends { theme: string; locale: string }>(cfg: C, look: ThumbnailLook): C {
  return { ...cfg, ...(look.theme ? { theme: look.theme } : {}), ...(look.locale ? { locale: look.locale } : {}) };
}

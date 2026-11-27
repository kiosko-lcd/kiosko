/**
 * A screen's runner: paints its pages when something visible changes, plays
 * its interludes and its widgets' animations, shows the alert that has it,
 * and sends each frame to its panel. It runs on the main thread (inside the
 * Runtime) or in a thread of its own (see threads/); either way through a
 * `RunnerHost`, which gives it the config, the plugins and the data.
 */
import { PAD_KEYS, createFormatters, validate, type PadEvent, type Theme } from '@kiosko/sdk';
import { pixelShift } from '@loksly/lcd-canvas-kit';
import type { Canvas } from '@napi-rs/canvas';
import { alertIntensity, alertStepMs, paintAlert } from './alert-paint.ts';
import type { ShownAlert } from './alerts.ts';
import { AnimationScheduler, type PlayablePlan } from './animation.ts';
import { composePage, rotateCanvas, type Animatable, type ComposeResult, type TileCache } from './compositor.ts';
import { legibleCjkPx, paintTurn, whenMatches, type Config, type Page, type Screen } from './config/model.ts';
import { encodeFor, type Device } from './devices.ts';
import { CANVAS, baseContext, kit, resolveLocale, type LogFn } from './env.ts';
import { offersSetup } from './config/starter.ts';
import { BOOT_FPS, BOOT_MS, CARD_EVERY_MS, CARD_MS, FIRST_CARD_MS, cardUrl, paintBoot, paintCard, welcomeDue } from './welcome.ts';
import { registerFonts, setFontLocale } from './fonts.ts';
import { FrameStats, type ScreenFrameStats } from './frame-stats.ts';
import { pickPage } from './layout/stack.ts';
import type { Registry } from './registry.ts';

export interface FrameInfo {
  screenId: string;
  pageId: string | null;
  at: number;
  /**
   * JPEG of the logical (unrotated) frame, for the editor: encoded only if
   * someone asks for it. Encoding every frame as PNG "just in case" was ~80%
   * of the daemon's CPU.
   */
  image: () => Buffer | Promise<Buffer>;
  tiles: ComposeResult['tiles'];
  interlude: string | null;
  /** Type of the widget whose animation is playing (a frame of it), if any. */
  animation?: string;
  /** Id of the alert that has the screen (see alerts.ts), if any. */
  alert?: string;
  sleeping: boolean;
}

/** How often each screen looks whether it has something to paint. */
export const TICK_MS = 250;
/** An interlude being played ends after this long without a button pressed. */
export const PLAY_IDLE_MS = 60_000;

/**
 * The editor's picture of a frame, encoded only if the editor asks for it.
 * `turned` frames were painted the panel's way round: the editor wants them
 * the page's way, so they are turned back then (and only then).
 */
function lazyJpeg(c: Canvas, turned = 0): () => Buffer {
  let b: Buffer | null = null;
  return () => (b ??= (turned ? rotateCanvas(c, (360 - turned) % 360) : c).toBuffer('image/jpeg', 88));
}

/**
 * Encodes on libuv's thread pool, not on the JS thread: a 1920×462 JPEG takes
 * ~35 ms, so two screens playing at 12 fps took most of the only thread there
 * is, and they ended up taking turns (one froze while the other played).
 *
 * Not all of it leaves the thread, though: the canvas records what is drawn
 * on it and only rasterizes it when asked for its pixels, so the call itself
 * blocks while Skia paints (5–20 ms for a busy 1920×462 page). `raster` gets
 * that time: it is painting, not encoding.
 */
function encode(c: Canvas, kind: 'png' | 'jpeg', quality: number, raster?: { ms: number }): Promise<Buffer> {
  const t0 = performance.now();
  const p = kind === 'jpeg' ? c.encode('jpeg', Math.max(1, Math.min(100, quality || 90))) : c.encode('png');
  if (raster) raster.ms += performance.now() - t0;
  return p;
}

/** Lowest JPEG quality `encodeFit` goes down to. */
const MIN_FIT_QUALITY = 20;

/**
 * Encodes a frame no bigger than `maxBytes`: when the JPEG at `quality` is
 * over it, tries lower qualities (10 at a time, down to 20) until one fits.
 * LY panels drop frames over ~500 KB and keep showing the previous one, so a
 * photo-heavy page at quality 100 looked frozen. `over` says nothing fitted.
 */
export async function encodeFit(c: Canvas, kind: 'png' | 'jpeg', quality: number, maxBytes: number, raster?: { ms: number }): Promise<{ out: Buffer; quality: number; over: boolean }> {
  const q0 = Math.max(1, Math.min(100, quality || 90));
  let out = await encode(c, kind, q0, raster);
  if (kind !== 'jpeg' || !(maxBytes > 0) || out.length <= maxBytes) return { out, quality: q0, over: false };
  let q = q0;
  while (q > MIN_FIT_QUALITY) {
    q = Math.max(MIN_FIT_QUALITY, q - 10);
    out = await encode(c, kind, q);
    if (out.length <= maxBytes) return { out, quality: q, over: false };
  }
  return { out, quality: q, over: true };
}

const kb = (n: number) => `${Math.round(n / 1000)} KB`;

/**
 * What a screen's runner needs from whoever runs it: the Runtime on the main
 * thread, or a screen's own thread (see threads/), which keeps a copy of the
 * data the screen shows.
 */
export interface RunnerHost {
  readonly config: Config;
  readonly registry: Registry;
  readonly demoMode: boolean;
  /** How many animations play together on a screen (see animation.ts). */
  readonly maxConcurrent: number;
  /** An interlude being played from the Play page ends after this long without a button. */
  readonly playIdleMs: number;
  /** Whether screens show the boot animation and the first run's card (welcome.ts); off in tests and the demo. */
  readonly welcome: boolean;
  /** The editor's real address, when known (see Runtime.editorUrl). */
  readonly editorUrl?: string | undefined;
  /** When Kiosko started: the boot animation only plays soon after. */
  readonly startedAt: number;
  log: LogFn;
  rnd: () => number;
  theme(): Theme;
  working(now: number): boolean;
  /** Data of a widget instance's own fetch. */
  dataOf(instanceId: string): unknown;
  /** Latest data of shared sources, by type: of the source profile `profile` where it has one (see config/profiles.ts). */
  sourcesOf(types: readonly string[] | undefined, profile?: string | null): Record<string, unknown>;
  /** How long a widget took to paint on the panel. */
  paintTime(instance: string, type: string, ms: number, now: number): void;
  /** A frame painted, for the editor. */
  frame(info: FrameInfo): void;
  /** The page shown changed: what data counts as visible changes too. */
  pageChanged(): void;
  openDevice(screen: Screen, log: (m: string) => void): Device;
}

/**
 * What the Runtime does with a screen, painted here (ScreenRunner) or in a
 * thread of its own (ThreadRunner, in threads/thread-runner.ts).
 */
export interface Runner {
  readonly screen: Screen;
  readonly page: Page | null;
  readonly pinned: string | null;
  readonly off: boolean;
  readonly interlude: { type: string; play: boolean } | null;
  readonly animating: string | null;
  readonly alert: ShownAlert | null;
  readonly lastInfo: FrameInfo | null;
  readonly device: Device;
  readonly stats: { read(now?: number): ScreenFrameStats };
  /** Instance ids and source types on the current page (filled by `Runtime.refreshWanted`). */
  visibleIds: Set<string>;
  sourceTypes: Set<string>;
  update(now: number): Promise<void>;
  reconfigure(screen: Screen): void;
  /** Forgets every painted tile: a plugin's code changed. */
  invalidate(): void;
  /** Some data changed: repaint if it is on screen. */
  dataChanged(change: { source?: string; instance?: string }): void;
  setAlert(shown: ShownAlert | null, now: number): void;
  /** The panel, for whoever paints the screen next; closing this runner leaves it open. */
  takeDevice(): Device;
  setPinned(pageId: string | null): void;
  setOff(off: boolean): void;
  playNow(slotId: string, play?: boolean): Promise<void>;
  stopInterlude(): void;
  press(e: PadEvent): boolean;
  close(): void;
}

export class ScreenRunner implements Runner {
  device: Device;
  private deviceKey: string;
  private last: Buffer | null = null;
  lastInfo: FrameInfo | null = null;
  dirty = true;
  private nextAt = 0;
  private busy = false;
  pinned: string | null = null;
  private playedSlot = new Map<string, number>();
  interlude: { slotId: string; type: string; stopAt: number; play: boolean } | null = null;
  /** The buttons of whoever plays the interlude now (Play page). */
  private pad: { send(e: PadEvent): void } | null = null;
  /** Switched off from outside (Home Assistant, the API): black until switched on. Not saved. */
  off = false;
  /** An interlude asked for now (the editor, Home Assistant): played as soon as the screen is free. */
  private wanted: string | null = null;
  private wantedPlay = false;
  /** When `fit` last told the log that frames were shrunk, to say it now and then, not every frame. */
  private fitLoggedAt = 0;
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
  /** The alert that has the screen now, over everything (set by the runtime, see `setAlert`). */
  alert: ShownAlert | null = null;
  /** When the alert on top came up here: it flashes from then. */
  private alertStart = 0;
  /** What the last alert frame showed, so an equal one isn't painted again. */
  private alertKey: string | null = null;
  /** Real fps, paint and encode times (see frame-stats.ts). */
  readonly stats = new FrameStats();
  /** The start went by (the boot animation played, or wasn't due). */
  private booted = false;
  /** The first run's card: the last slot it was shown in, and until when it stays. */
  private cardSlot = -1;
  private cardUntil = 0;
  private cardKey: string | null = null;

  screen: Screen;
  private readonly rt: RunnerHost;
  /** `device`: one already open for this screen (handed over by a thread that stopped). */
  constructor(screen: Screen, rt: RunnerHost, device?: Device) {
    this.screen = screen;
    this.rt = rt;
    this.deviceKey = JSON.stringify(screen.device);
    this.device = device ?? rt.openDevice(screen, (m) => rt.log(`screen:${screen.name}`, m));
    this.pinned = screen.pinnedPage ?? null;
    this.scheduler = new AnimationScheduler(() => rt.rnd(), (type, why) => rt.log(type, `animation ignored: ${why}`));
  }

  /** Encodes a frame within the screen's `maxBytes`, saying so in the log (at most every 10 min) when it had to shrink it. */
  private async fit(c: Canvas, kind: 'png' | 'jpeg', quality: number, screen: Screen, paintMs = 0): Promise<Buffer> {
    const t0 = performance.now();
    const raster = { ms: 0 };
    const r = await encodeFit(c, kind, quality, screen.maxBytes, raster);
    // Rasterizing happens in the first encode call, on this thread: it counts as painting.
    this.stats.painted(paintMs + raster.ms, performance.now() - t0 - raster.ms);
    if ((r.quality !== Math.max(1, Math.min(100, quality || 90)) || r.over) && Date.now() - this.fitLoggedAt > 10 * 60_000) {
      this.fitLoggedAt = Date.now();
      this.rt.log(
        `screen:${screen.name}`,
        r.over
          ? `frames don't fit in ${kb(screen.maxBytes)} even at JPEG quality ${r.quality} (${kb(r.out.length)}); the panel may drop them`
          : `frames over ${kb(screen.maxBytes)} at quality ${quality}: sent at quality ${r.quality} (${kb(r.out.length)})`,
      );
    }
    return r.out;
  }

  /** Forgets every painted tile: the next frame is painted from scratch (a plugin's code changed). */
  invalidate(): void {
    this.tiles.clear();
    this.last = null;
    this.dirty = true;
  }

  reconfigure(screen: Screen): void {
    const key = JSON.stringify(screen.device);
    if (key !== this.deviceKey) {
      this.device.close();
      this.device = this.rt.openDevice(screen, (m) => this.rt.log(`screen:${screen.name}`, m));
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

  /**
   * The alert for this screen now (or none). One coming up stops what plays
   * (an interlude, a game, an animation: they check `alert`) and the next
   * update paints it; one going away gives the pages back.
   */
  setAlert(shown: ShownAlert | null, now: number): void {
    const was = this.alert;
    this.alert = shown;
    if (shown && shown.top.id !== was?.top.id) this.alertStart = now;
    if (shown && !was && this.interlude) {
      this.rt.log(`screen:${this.screen.name}`, `${this.interlude.type} stopped: an alert`);
      this.stopInterlude();
    }
    if (!shown && was) {
      this.alertKey = null;
      this.last = null;
      this.dirty = true;
    }
  }

  async update(now: number): Promise<void> {
    if (this.busy || !this.screen.enabled) return;
    this.busy = true;
    try {
      // An alert is above everything: pages, interludes, animations, sleep.
      if (this.alert) {
        this.wanted = null;
        await this.paintAlert(this.alert, now);
        return;
      }
      // One asked for goes first; otherwise the one due, if any.
      const asked = this.wanted;
      const play = this.wantedPlay;
      this.wanted = null;
      this.wantedPlay = false;
      if (!this.off && !asked && (await this.maybeWelcome(now))) return;
      if (!this.off && (await this.maybeInterlude(now, asked ?? undefined, play))) return;
      const page = this.currentPage(now);
      if (page?.id !== this.page?.id) {
        this.page = page;
        this.dirty = true;
        this.rt.pageChanged();
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

  /** Sends a frame and counts it. */
  private async send(out: Buffer): Promise<void> {
    await this.device.send(out);
    this.stats.sentAt(Date.now());
  }

  private async paint(page: Page | null, now: number): Promise<void> {
    const { screen } = this;
    const theme = this.rt.theme();
    const t0 = performance.now();
    let result: ComposeResult | null = null;
    let canvas: Canvas;
    if (page && !this.off) {
      result = composePage({
        cfg: this.rt.config,
        screen,
        page,
        theme,
        registry: this.rt.registry,
        now,
        working: this.rt.working(now),
        dataOf: (inst) => this.rt.dataOf(inst.id),
        sourcesOf: (types, profile) => this.rt.sourcesOf(types, profile),
        log: this.rt.log,
        demo: this.rt.demoMode,
        cache: this.tiles,
        rotate: paintTurn(screen),
      });
      canvas = result.canvas;
      this.animatable = result.animatable;
      this.nextAt = Math.min(result.nextAt, now + 60_000);
      // How long each widget took (the ones painted now, not those from the cache).
      for (const t of result.tiles) {
        if (t.renderMs === undefined || !t.shown) continue;
        const type = page.tiles.find((x) => x.id === t.id)?.widgets.find((w) => w.id === t.shown)?.type ?? '?';
        this.rt.paintTime(t.shown, type, t.renderMs, now);
      }
      // Pages and work hours change by the clock: check at least every minute.
    } else {
      // Black: already the panel's way round (it looks the same either way).
      const turn = paintTurn(screen);
      const swap = turn === 90 || turn === 270;
      canvas = CANVAS.createCanvas(swap ? screen.height : screen.width, swap ? screen.width : screen.height);
      this.animatable = [];
      this.nextAt = now + 60_000;
    }
    const sleeping = this.off || !!(screen.sleepWhenIdle && result?.idle);
    if (sleeping || !result) {
      const g = canvas.getContext('2d');
      g.save();
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.fillStyle = '#000';
      g.fillRect(0, 0, canvas.width, canvas.height);
      g.restore();
    }
    const kind = encodeFor(screen.device, screen.jpegQuality);
    // Painted the panel's way round already (composePage's `rotate`): no turning here.
    const out = await this.fit(canvas, kind, screen.jpegQuality, screen, performance.now() - t0);
    this.lastInfo = { screenId: screen.id, pageId: page?.id ?? null, at: now, image: lazyJpeg(canvas, paintTurn(screen)), tiles: result?.tiles ?? [], interlude: null, sleeping };
    this.rt.frame(this.lastInfo);
    if (this.last?.equals(out)) return;
    this.last = out;
    await this.send(out);
  }

  /**
   * A frame of the alert: only when it would differ from the last one (the
   * frame's brightness steps every half second at most, see alert-paint.ts),
   * so a flashing alert costs 2 frames a second and no more.
   */
  private async paintAlert(shown: ShownAlert, now: number): Promise<void> {
    const { screen } = this;
    const a = shown.top;
    const intensity = alertIntensity(a.level, now - this.alertStart, alertStepMs(screen.maxFps));
    const shift = screen.pixelShift.enabled ? pixelShift(now, screen.pixelShift) : { x: 0, y: 0 };
    const cfg = this.rt.config;
    const sinceText = createFormatters({ locale: resolveLocale(cfg), timeFormat: cfg.timeFormat, now }).time(a.since);
    const minPx = legibleCjkPx(screen);
    const key = JSON.stringify([a.id, a.level, a.title, a.text, a.source, a.detail, a.icon, shown.more, intensity, shift, sinceText, minPx, screen.width, screen.height, screen.rotate]);
    if (key === this.alertKey) return;
    this.alertKey = key;
    const t0 = performance.now();
    registerFonts();
    setFontLocale(resolveLocale(cfg));
    kit.setMinCjkPx(minPx);
    const canvas = CANVAS.createCanvas(screen.width, screen.height);
    paintAlert(canvas.getContext('2d'), screen.width, screen.height, shown, { intensity, fonts: this.rt.theme().fonts, minPx, sinceText, shift });
    const kind = encodeFor(screen.device, screen.jpegQuality || 85);
    const turned = rotateCanvas(canvas, paintTurn(screen));
    const out = await this.fit(turned, kind, screen.jpegQuality || 85, screen, performance.now() - t0);
    this.lastInfo = { screenId: screen.id, pageId: this.page?.id ?? null, at: now, image: lazyJpeg(canvas), tiles: [], interlude: null, alert: a.id, sleeping: false };
    this.rt.frame(this.lastInfo);
    if (this.last?.equals(out)) return;
    this.last = out;
    await this.send(out);
  }

  /**
   * The boot animation and the first run's card (welcome.ts), before
   * anything else but an alert. True while one has the screen.
   */
  private async maybeWelcome(now: number): Promise<boolean> {
    if (!this.rt.welcome || this.rt.demoMode) return false;
    const cfg = this.rt.config;
    if (this.cardUntil) {
      if (now < this.cardUntil && offersSetup(cfg)) {
        await this.paintWelcomeCard(now);
        return true;
      }
      // Its time is over, or the setup was done: back to the pages.
      this.cardUntil = 0;
      this.cardKey = null;
      this.last = null;
      this.dirty = true;
      return false;
    }
    const due = welcomeDue(cfg, { sinceStartMs: now - this.rt.startedAt, now, booted: this.booted, cardSlot: this.cardSlot });
    const first = !this.booted;
    this.booted = true;
    if (!due) return false;
    if (due === 'boot') {
      await this.playBoot();
      if (!offersSetup(cfg)) {
        this.last = null;
        this.dirty = true;
        return true;
      }
    }
    this.cardSlot = Math.floor(Date.now() / CARD_EVERY_MS);
    this.cardUntil = Date.now() + (first ? FIRST_CARD_MS : CARD_MS);
    await this.paintWelcomeCard(Date.now());
    return true;
  }

  private welcomeLook() {
    const cfg = this.rt.config;
    return { theme: this.rt.theme(), locale: resolveLocale(cfg), url: cardUrl(this.rt.editorUrl, cfg) };
  }

  /** The boot animation, at the screen's fps (at most BOOT_FPS): a slower panel plays fewer frames, never longer. */
  private async playBoot(): Promise<void> {
    const { screen } = this;
    const look = this.welcomeLook();
    registerFonts();
    setFontLocale(look.locale);
    const fps = Math.max(1, Math.min(BOOT_FPS, screen.maxFps));
    const frames = Math.max(1, Math.round((BOOT_MS / 1000) * fps));
    const kind = encodeFor(screen.device, screen.jpegQuality || 85);
    const canvas = CANVAS.createCanvas(screen.width, screen.height);
    const g = canvas.getContext('2d');
    const start = Date.now();
    for (let i = 0; i < frames && !this.alert && !this.closed; i++) {
      const ms = Math.min(BOOT_MS, Date.now() - start);
      if (ms >= BOOT_MS) break;
      const t0 = performance.now();
      g.save();
      paintBoot(g, screen.width, screen.height, ms, look);
      g.restore();
      const out = await this.fit(rotateCanvas(canvas, paintTurn(screen)), kind, screen.jpegQuality || 85, screen, performance.now() - t0);
      await this.send(out);
      if (i % 4 === 0) {
        const snap = CANVAS.createCanvas(canvas.width, canvas.height);
        snap.getContext('2d').drawImage(canvas, 0, 0);
        this.lastInfo = { screenId: screen.id, pageId: this.page?.id ?? null, at: Date.now(), image: lazyJpeg(snap), tiles: [], interlude: 'kiosko/boot', sleeping: false };
        this.rt.frame(this.lastInfo);
      }
      const wait = start + ((i + 1) * 1000) / fps - Date.now();
      await new Promise((r) => (wait > 0 ? setTimeout(r, wait) : setImmediate(r)));
    }
  }

  /** The first run's card: a still frame, sent again only when it changes (the theme, the language, the address). */
  private async paintWelcomeCard(now: number): Promise<void> {
    const { screen } = this;
    const look = this.welcomeLook();
    const key = JSON.stringify([look.theme.id, look.locale, look.url, screen.width, screen.height, screen.rotate]);
    if (key === this.cardKey) return;
    this.cardKey = key;
    const t0 = performance.now();
    registerFonts();
    setFontLocale(look.locale);
    const canvas = CANVAS.createCanvas(screen.width, screen.height);
    paintCard(canvas.getContext('2d'), screen.width, screen.height, look);
    const kind = encodeFor(screen.device, screen.jpegQuality || 85);
    const out = await this.fit(rotateCanvas(canvas, paintTurn(screen)), kind, screen.jpegQuality || 85, screen, performance.now() - t0);
    this.lastInfo = { screenId: screen.id, pageId: this.page?.id ?? null, at: now, image: lazyJpeg(canvas), tiles: [], interlude: 'kiosko/welcome', sleeping: false };
    this.rt.frame(this.lastInfo);
    this.last = out;
    await this.send(out);
  }

  /**
   * Plays an interlude if one is due. Returns true while it played (no normal paint this tick).
   * `play`: someone plays it from the Play page (an interlude with `input`): it gets their
   * buttons and lasts while they press them, not `maxSeconds`.
   */
  private async maybeInterlude(now: number, force?: string, play = false): Promise<boolean> {
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
    const sources = this.rt.sourcesOf(def.sources);
    const options = def.options ? validate(def.options, due.options).value : {};
    if (!force && def.skip?.({ sources, now, options })) {
      this.rt.log(`screen:${this.screen.name}`, `interlude ${due.type} skipped (busy)`);
      return false;
    }
    const [plugin] = due.type.split('/');
    const seed = Math.floor(now / Math.max(60_000, due.everyMs));
    const playing = play && !!def.input;
    const listeners = new Set<(e: PadEvent) => void>();
    let lastPress = Date.now();
    const input = playing ? { on: (l: (e: PadEvent) => void) => (listeners.add(l), () => void listeners.delete(l)) } : undefined;
    const player = await def.prepare({ ...baseContext(this.rt.config, plugin!, this.rt.log, now), options, width: this.screen.width, height: this.screen.height, seed, theme: this.rt.theme(), canvas: CANVAS, sources, ...(input ? { input } : {}) });
    if (!player || !(player.frames > 0)) return false;
    const fps = Math.max(1, Math.min(def.fps, this.screen.maxFps));
    const frames = playing ? player.frames : Math.min(player.frames, Math.round(due.maxSeconds * fps));
    this.interlude = { slotId: due.id, type: due.type, stopAt: playing ? Infinity : now + (frames / fps) * 1000, play: playing };
    if (playing) {
      lastPress = Date.now();
      this.pad = {
        send: (e) => {
          lastPress = Date.now();
          for (const l of listeners) {
            try {
              l(e);
            } catch (err) {
              this.rt.log(due.type, `input failed: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        },
      };
    }
    this.rt.log(`screen:${this.screen.name}`, playing ? `${due.type} being played (ends after ${this.rt.playIdleMs / 1000} s without a button)` : `playing ${due.type}: ${frames} frames at ${fps} fps`);
    const kind = encodeFor(this.screen.device, this.screen.jpegQuality || 85);
    const canvas = CANVAS.createCanvas(this.screen.width, this.screen.height);
    const g = canvas.getContext('2d');
    let start = Date.now();
    // maxSeconds is a time: a screen slower than the interlude's fps plays fewer frames, not longer.
    const until = playing ? Infinity : Date.now() + due.maxSeconds * 1000;
    for (let i = 0; i < frames && this.interlude && !this.alert; i++) {
      if (Date.now() >= until) break;
      if (playing && Date.now() - lastPress > this.rt.playIdleMs) {
        this.rt.log(`screen:${this.screen.name}`, `${due.type}: nobody playing, back to the pages`);
        break;
      }
      const t0 = performance.now();
      g.save();
      try {
        await player.draw(g, i);
      } catch (err) {
        this.rt.log(due.type, `frame ${i} failed: ${err instanceof Error ? err.message : String(err)}`);
        break;
      } finally {
        g.restore();
      }
      // Encoded off the JS thread: meanwhile the other screens paint and play.
      const turned = rotateCanvas(canvas, paintTurn(this.screen));
      const out = await this.fit(turned, kind, this.screen.jpegQuality || 85, this.screen, performance.now() - t0);
      await this.send(out);
      if (i % 3 === 0) {
        // The interlude draws every frame on the same canvas: snapshot it.
        const snap = CANVAS.createCanvas(canvas.width, canvas.height);
        snap.getContext('2d').drawImage(canvas, 0, 0);
        this.lastInfo = { screenId: this.screen.id, pageId: this.page?.id ?? null, at: Date.now(), image: lazyJpeg(snap), tiles: [], interlude: due.type, sleeping: false };
        this.rt.frame(this.lastInfo);
      }
      const wait = start + ((i + 1) * 1000) / fps - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      else {
        // Late (the machine is busy, or another screen is playing too): slow
        // down rather than catch up in a burst, and let the rest run. A burst
        // never yields and starves every other screen until it is over.
        start -= wait;
        await new Promise((r) => setImmediate(r));
      }
    }
    this.interlude = null;
    this.pad = null;
    this.last = null;
    this.dirty = true;
    return true;
  }

  /**
   * Plays the animations the shown widgets ask for, if any is due (see
   * animation.ts). Like an interlude it runs inside `update`, so nothing else
   * is painted meanwhile, but unlike it the page stays in place: only the
   * widgets' tiles change from frame to frame. How many play together is
   * `Runtime.maxConcurrent` (one by default); the rest wait their turn.
   */
  private async maybeAnimate(now: number): Promise<void> {
    if (!this.screen.enabled || this.closed || this.lastInfo?.sleeping || !this.animatable.length) return;
    const due = this.scheduler.next(this.animatable, now, this.screen.maxFps, this.rt.maxConcurrent);
    if (!due.length) return;
    this.animating = due.map((d) => d.animatable.type).join(', ');
    let completed = false;
    try {
      completed = await this.playAnimations(due, now);
    } finally {
      this.animating = null;
      // Whatever happened, the next paint is a real one with the current data.
      this.last = null;
      this.dirty = true;
      for (const d of due) {
        this.scheduler.ended(d.animatable.instanceId, Date.now(), d.animatable);
        d.animatable.ended(d.play.plan, completed);
      }
    }
  }

  /**
   * One timeline for all: the fastest plan sets the rate and each animation
   * advances at its own, so they start together and the longest decides when
   * it is over. The ones that finish earlier stay at rest. With only one it
   * is just that animation's own frames.
   */
  private async playAnimations(items: { animatable: Animatable; play: PlayablePlan }[], now: number): Promise<boolean> {
    const page = this.page;
    if (!page) return false;
    const { screen } = this;
    const fps = Math.max(...items.map((x) => x.play.fps));
    const seconds = Math.max(...items.map((x) => (x.play.frames - 1) / x.play.fps));
    const frames = Math.round(seconds * fps) + 1;
    // Cut short by new data only if every one of them can be (an urgent one is not).
    const interruptible = items.every((x) => x.play.interruptible);
    // A hold has a meaning for a single animation: with several it is ignored.
    const hold = items.length === 1 ? items[0]!.play.hold : undefined;
    // An alert stops any of them, interruptible or not.
    const abort = () => this.closed || !!this.alert || (interruptible && this.dirty) || !this.screen.enabled;
    this.dirty = false;
    // The page as it was at the start: same clock, same data for every frame, so
    // only the animated tiles move (a changing clock would flicker) and, if it
    // can't be cut short, a data change during it doesn't leak in.
    const memoData = new Map<string, unknown>();
    const memoSources = new Map<string, Record<string, unknown>>();
    const working = this.rt.working(now);
    const kind = encodeFor(screen.device, screen.jpegQuality || 85);
    const sent: { out: Promise<Buffer>; snap: Canvas | null }[] = [];
    const t0 = Date.now();
    // Every frame is painted before the first is sent: painting and sending
    // at once is slower than either, and the panel drops what comes late.
    for (let s = 1; s < frames - 1; s++) {
      if (abort()) return false;
      const animate = items.flatMap(({ animatable: a, play }) => {
        // Frame of this animation at this moment of the timeline; at either end it is at rest.
        const i = Math.round((s / fps) * play.fps);
        return i <= 0 || i >= play.frames - 1 ? [] : [{ tileId: a.tileId, instanceId: a.instanceId, frame: { plan: play.plan, i, t: i / (play.frames - 1) } }];
      });
      const t0 = performance.now();
      const result = composePage({
        cfg: this.rt.config,
        screen,
        page,
        theme: this.rt.theme(),
        registry: this.rt.registry,
        now,
        working,
        dataOf: (inst) => {
          if (!memoData.has(inst.id)) memoData.set(inst.id, this.rt.dataOf(inst.id));
          return memoData.get(inst.id);
        },
        sourcesOf: (types, profile) => {
          const k = JSON.stringify([types ?? [], profile ?? null]);
          if (!memoSources.has(k)) memoSources.set(k, this.rt.sourcesOf(types, profile));
          return memoSources.get(k)!;
        },
        log: this.rt.log,
        demo: this.rt.demoMode,
        cache: this.tiles,
        animate,
        rotate: paintTurn(screen),
      });
      // Encoding goes on in the thread pool while the next frame is painted.
      sent.push({ out: this.fit(result.canvas, kind, screen.jpegQuality || 85, screen, performance.now() - t0), snap: s % 3 === 1 ? result.canvas : null });
      // Let the loop breathe: a long animation must not freeze the timers and the other screens.
      await new Promise((r) => setImmediate(r));
    }
    const outs = await Promise.all(sent.map((x) => x.out));
    const what = items.map((x) => `${x.animatable.type} ${x.play.plan.id}`).join(' + ');
    this.rt.log(`screen:${screen.name}`, `animating ${what}: ${sent.length} frames at ${fps} fps (painted in ${Date.now() - t0} ms)`);
    const holdAt = hold ? Math.max(0, Math.min(sent.length - 1, hold.index - 1)) : -1;
    let start = Date.now();
    for (let k = 0; k < sent.length; k++) {
      if (abort()) return false;
      // Late: skip the frame rather than let the delay pile up.
      const due = Math.floor(((Date.now() - start) * fps) / 1000);
      if (k < due - 1 && k !== holdAt && k < sent.length - 1) continue;
      await this.send(outs[k]!);
      const snap = sent[k]!.snap;
      if (snap) {
        this.lastInfo = { screenId: screen.id, pageId: page.id, at: Date.now(), image: lazyJpeg(snap, paintTurn(screen)), tiles: [], interlude: null, animation: items.map((x) => x.animatable.type).join(', '), sleeping: false };
        this.rt.frame(this.lastInfo);
      }
      if (hold && k === holdAt) {
        // Still: the panel keeps the picture without being sent it again.
        const until = Date.now() + hold.ms;
        while (Date.now() < until && !abort()) await new Promise((r) => setTimeout(r, Math.min(250, until - Date.now())));
        start = Date.now() - ((k + 1) * 1000) / fps;
        continue;
      }
      const wait = start + ((k + 1) * 1000) / fps - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
    return true;
  }

  /**
   * Plays an interlude as soon as the screen is free: now if it is, or right
   * after the paint or animation under way (asked in the middle of one, it
   * used to be dropped without a word).
   */
  async playNow(slotId: string, play = false): Promise<void> {
    if (this.off || this.alert) return;
    this.wanted = slotId;
    this.wantedPlay = play;
    if (this.busy) return;
    this.busy = true;
    try {
      this.wanted = null;
      this.wantedPlay = false;
      await this.maybeInterlude(Date.now(), slotId, play);
    } finally {
      this.busy = false;
    }
  }

  stopInterlude(): void {
    this.interlude = null;
    this.pad = null;
  }

  dataChanged(change: { source?: string; instance?: string }): void {
    if ((change.instance && this.visibleIds.has(change.instance)) || (change.source && this.sourceTypes.has(change.source))) this.dirty = true;
  }

  setPinned(pageId: string | null): void {
    this.pinned = pageId;
    this.dirty = true;
  }

  setOff(off: boolean): void {
    this.off = off;
    if (off) this.stopInterlude();
    this.dirty = true;
  }

  /** A button from the Play page, for the interlude being played; false when none is. */
  press(e: PadEvent): boolean {
    if (!this.pad || !PAD_KEYS.includes(e.key)) return false;
    this.pad.send({ key: e.key, pressed: !!e.pressed });
    return true;
  }

  private deviceTaken = false;
  takeDevice(): Device {
    this.deviceTaken = true;
    return this.device;
  }

  close(): void {
    this.closed = true;
    this.interlude = null;
    if (!this.deviceTaken) this.device.close();
  }
}


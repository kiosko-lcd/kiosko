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
import { availableParallelism } from 'node:os';
import { localize, themeById, validate, type AlertLevel, type PadEvent, type Theme } from '@kiosko/sdk';
import { AlertBoard, type ActiveAlert, type PluginAlert } from './alerts.ts';
import { MAX_CONCURRENT } from './animation.ts';
import { composePage, composeWidget, type ComposeResult, tileState } from './compositor.ts';
import { isWorking, widgetsOf, type Config, type Page, type Screen, type WidgetInstance, whenMatches } from './config/model.ts';
import { ContextEngine, matchingPages, needsApps, ruleSources, type ContextEnv, type ContextPick, type ContextReason } from './context.ts';
import { parseSourceKey, resolveSourceKey, sourceKeysOf } from './config/profiles.ts';
import { backgroundSources } from './config/sources.ts';
import { FetchHost, SourceHub } from './data.ts';
import { ledFor, openDevice, type Device, type DeviceStatus } from './devices.ts';
import { ProcessWatch, systemProcesses, type ProcessLister } from './processes.ts';
import { posixTz } from './remote/tz.ts';
import { BrowserHub } from './browser/hub.ts';
import { dimFor } from './remote/backlight.ts';
import { resolveLocale, type LogFn } from './env.ts';
import type { Registry } from './registry.ts';
import { PLAY_IDLE_MS, ScreenRunner, TICK_MS, type FrameInfo, type Runner, type RunnerHost } from './screen-runner.ts';
import { planThreads, threadsMode, type ThreadWhy } from './threads/plan.ts';
import { ThreadRunner, defaultThreadEntry, type ThreadOwner } from './threads/thread-runner.ts';

export { PLAY_IDLE_MS, encodeFit, type FrameInfo } from './screen-runner.ts';

export interface LogEntry {
  at: number;
  scope: string;
  message: string;
}

/** A widget's `render` taking longer than this slows every panel: frames are painted one after another. */
export const SLOW_PAINT_MS = 50;
const SLOW_WARN_EVERY_MS = 10 * 60_000;

export interface PaintTime {
  instance: string;
  type: string;
  /** The last paint, the running average (recent paints weigh more) and the slowest, in ms. */
  lastMs: number;
  avgMs: number;
  maxMs: number;
  paints: number;
}

/**
 * How long each widget instance takes to paint on the panels, to name the
 * one that slows them down (in Activity, and in the inspector).
 */
export class PaintTimes {
  private times = new Map<string, PaintTime & { warnedAt: number }>();

  record(instance: string, type: string, ms: number, now: number, log: (scope: string, msg: string) => void): void {
    const t = this.times.get(instance) ?? { instance, type, lastMs: ms, avgMs: ms, maxMs: ms, paints: 0, warnedAt: Number.NEGATIVE_INFINITY };
    t.type = type;
    t.lastMs = ms;
    t.avgMs = t.paints ? t.avgMs * 0.8 + ms * 0.2 : ms;
    t.maxMs = Math.max(t.maxMs, ms);
    t.paints++;
    this.times.set(instance, t);
    if (ms > SLOW_PAINT_MS && now - t.warnedAt >= SLOW_WARN_EVERY_MS) {
      t.warnedAt = now;
      log(type, `painting took ${Math.round(ms)} ms; a widget should paint in under ${SLOW_PAINT_MS} ms, or it delays every panel (keep the heavy work in fetch or a source)`);
    }
  }

  /** Every instance measured, slowest (on average) first. */
  list(): PaintTime[] {
    return [...this.times.values()].map(({ warnedAt: _, ...t }) => ({ ...t, lastMs: round(t.lastMs), avgMs: round(t.avgMs), maxMs: round(t.maxMs) })).sort((a, b) => b.avgMs - a.avgMs);
  }

  /** Forgets instances that are gone. */
  retain(ids: Set<string>): void {
    for (const id of this.times.keys()) if (!ids.has(id)) this.times.delete(id);
  }
}

const round = (ms: number) => Math.round(ms * 10) / 10;

/** How often the context pages' rules are looked at again without a change (time windows, urgency). */
export const CONTEXT_EVERY_MS = 1_000;

/** How often the plugins' alerts are asked again without a data change (for the ones that depend on the time). */
export const ALERTS_EVERY_MS = 5_000;

const TEST_ALERT_TITLE = { en: 'Test alert', es: 'Alerta de prueba', de: 'Testalarm', 'zh-Hant': '測試警報', 'zh-Hans': '测试警报' };
const TEST_ALERT_TEXT = {
  en: 'This is how an alert looks on {screen}. Can you read it from where you sit?',
  es: 'Así se ve una alerta en {screen}. ¿Se lee desde donde te sientas?',
  de: 'So sieht ein Alarm auf {screen} aus. Lesbar von deinem Platz aus?',
  'zh-Hant': '這是警報在「{screen}」上的樣子。從你的座位看得清楚嗎？',
  'zh-Hans': '这是警报在“{screen}”上的样子。从你的座位看得清吗？',
};

export class Runtime extends EventEmitter implements RunnerHost, ThreadOwner {
  config: Config;
  readonly hub: SourceHub;
  readonly fetches: FetchHost;
  /** How long each widget takes to paint on the panels. */
  readonly paintTimes = new PaintTimes();
  private runners = new Map<string, Runner>();
  private timer: NodeJS.Timeout | null = null;
  readonly logs: LogEntry[] = [];
  /** How many animations play together on a screen (see animation.ts). */
  maxConcurrent: number = MAX_CONCURRENT;
  /** An interlude being played from the Play page ends after this long without a button. */
  playIdleMs: number = PLAY_IDLE_MS;
  /** Random numbers for the animations; tests replace it with a seeded one. */
  rnd: () => number = Math.random;
  /** Alerts from the plugins, from outside and the screens' tests (see alerts.ts). */
  readonly alerts = new AlertBoard((m) => this.log('alerts', m));
  /** Data changed since the plugins' alerts were last asked. */
  private alertsDirty = true;
  private alertsAskedAt = 0;
  /** What the editor was last told, to tell it only changes. */
  private alertsSig = '';
  /** A plugin's `alerts` failing, said once per message. */
  private alertErrors = new Map<string, string>();
  /** Context pages (context.ts): what holds, over time, per screen. */
  private readonly contextEngine = new ContextEngine();
  private contextDirty = true;
  private contextAt = Number.NEGATIVE_INFINITY;
  /** The running programs, listed only while an `app` rule needs them; null: none can be (the browser demo). */
  private readonly apps: ProcessWatch | null;

  /**
   * The browsers showing screens (browser/hub.ts): the network-screens server
   * hands it their connections; each `browser` screen's driver takes its own.
   */
  readonly browsers = new BrowserHub((uid) => {
    const s = this.config.screens.find((x) => x.device.driver === 'browser' && x.device.uid === uid);
    const key = s?.device.driver === 'browser' ? s.device.key : undefined;
    return key && /^[0-9a-f]{64}$/i.test(key) ? Buffer.from(key, 'hex') : null;
  });

  /** The cores `threads: auto` counts on (see threads/plan.ts); tests set it. */
  cores: number = cpuCount();
  /** Where each screen is painted, and why (see threads/plan.ts). */
  private threadWhy = new Map<string, ThreadWhy>();
  /** Screens whose thread failed, with why: they paint here until their config or the plugins change. */
  private threadless = new Map<string, { reason: string; key: string }>();
  /** The entry point of the screens' threads (the server brings one with the built-in plugins). */
  private readonly threadEntry: URL | undefined;

  readonly registry: Registry;
  /**
   * Demo mode: no source or fetch runs, every widget paints its sample data.
   * For trying Kiosko without any setup, screenshots and kiosks at fairs.
   */
  readonly demoMode: boolean;
  /** The boot animation and the first run's card on the panels (welcome.ts): the server's `start` asks for them; tests and the browser demo don't. */
  readonly welcome: boolean;
  /** Where the editor really listens (`kiosko start` with its --host/--port), for the first run's card; else the config's. */
  readonly editorUrl: string | undefined;
  /** When this runtime was made: the boot animation plays only soon after. */
  readonly startedAt = Date.now();
  /** `processes`: who lists the running programs for `app` rules (tests pass a fake); null: nobody. Default: this system's (none in demo mode). */
  constructor(registry: Registry, config: Config, o: { demo?: boolean; threadEntry?: URL; welcome?: boolean; editorUrl?: string; processes?: ProcessLister | null; appsEveryMs?: number } = {}) {
    super();
    this.registry = registry;
    this.demoMode = !!o.demo;
    this.welcome = !!o.welcome && !o.demo;
    this.editorUrl = o.editorUrl;
    this.threadEntry = o.threadEntry;
    this.setMaxListeners(100);
    this.config = config;
    this.hub = new SourceHub(registry, this.log, (type) => this.onData({ source: type }));
    this.fetches = new FetchHost(this.hub, this.log, (id) => this.onData({ instance: id }));
    const lister = o.processes !== undefined ? o.processes : o.demo ? null : systemProcesses();
    this.apps = lister ? new ProcessWatch(lister, (m) => this.log('context', m), o.appsEveryMs) : null;
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

  // The runners' host (see screen-runner.ts), for the screens painted on this thread.
  dataOf(instanceId: string): unknown {
    return this.fetches.data(instanceId);
  }
  sourceData(key: string): unknown {
    return this.hub.data(key);
  }
  sourcesOf(types: readonly string[] | undefined, profile?: string | null): Record<string, unknown> {
    return this.hub.pick(types, this.config, profile);
  }
  failedOf(instanceId: string, types: readonly string[] | undefined, profile?: string | null): boolean {
    return this.fetches.failed(instanceId) || this.sourceKeys(types, profile).some((k) => this.hub.failed(k));
  }
  // What a screen's thread is told along with the data (see threads/).
  instanceFailed(instanceId: string): boolean {
    return this.fetches.failed(instanceId);
  }
  sourceFailed(key: string): boolean {
    return this.hub.failed(key);
  }
  /** The source keys a widget with `profile` reads (see config/profiles.ts). */
  sourceKeys(types: readonly string[] | undefined, profile?: string | null): string[] {
    return sourceKeysOf(this.config, types, profile, (t) => this.registry.source(t)).map(([, key]) => key);
  }
  paintTime(instance: string, type: string, ms: number, now: number): void {
    this.paintTimes.record(instance, type, ms, now, this.log);
  }
  frame(info: FrameInfo): void {
    this.emit('frame', info);
  }
  pageChanged(): void {
    this.refreshWanted();
  }
  openDevice(screen: Screen, log: (m: string) => void): Device {
    return openDevice(screen.device, log, screen.rotate, { settings: () => ({ lang: resolveLocale(this.config).slice(0, 5), tz: posixTz() }), browsers: this.browsers });
  }

  private onData(change: { source?: string; instance?: string }): void {
    this.alertsDirty = true;
    this.contextDirty = true;
    for (const r of this.runners.values()) r.dataChanged(change);
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
      // A screen whose panel is missing needs nothing: what only it shows stops (presence.ts).
      if (r.paused) continue;
      for (const { page, widget } of widgetsOf(r.screen)) {
        const def = this.registry.widget(widget.type);
        if (!def || widget.disabled) continue;
        instances.push({ inst: widget, def });
        const keys = this.sourceKeys(def.sources, widget.profile);
        for (const s of keys) sources.add(s);
        if (!r.page || r.page.id === page.id) {
          r.visibleIds.add(widget.id);
          for (const s of keys) r.sourceTypes.add(s);
        }
      }
      for (const slot of r.screen.interludes) for (const s of this.registry.interlude(slot.type)?.sources ?? []) if (slot.enabled) sources.add(s);
    }
    // And those the user turned on to watch for alerts with no widget.
    for (const s of backgroundSources(this.config, (type) => this.registry.source(type))) sources.add(s);
    // And those the context pages' rules read.
    for (const s of ruleSources(this.config, (type) => this.registry.source(type))) if (this.registry.source(parseSourceKey(s).type)) sources.add(s);
    this.paintTimes.retain(new Set(instances.map((i) => i.inst.id)));
    if (this.demoMode) {
      sources.clear();
      instances.length = 0;
    }
    this.hub.retain(sources, this.config);
    this.fetches.retain(instances);
  }

  /**
   * After a plugin's code changed (installed, reloaded, removed): its sources
   * and fetches start again with the new code and every screen repaints
   * from scratch.
   */
  pluginsChanged(ids: string[]): void {
    for (const id of ids) {
      this.hub.forget(id);
      this.fetches.forget(id);
    }
    // A screen sent back from its thread because of a plugin may go again.
    const retry = this.threadless.size > 0;
    this.threadless.clear();
    for (const r of this.runners.values()) r.invalidate();
    if (retry) this.placeRunners();
    this.refreshWanted();
    this.emit('config', this.config);
  }

  /** Applies a new config: screens added, removed or changed; data kept where possible. */
  apply(config: Config): void {
    this.config = config;
    this.alertsDirty = true;
    this.contextDirty = true;
    this.registry.setDisabled(config.plugins.disabled);
    const ids = new Set(config.screens.map((s) => s.id));
    for (const [id, r] of this.runners) {
      if (!ids.has(id)) {
        r.close();
        this.runners.delete(id);
      }
    }
    for (const s of config.screens) {
      const failed = this.threadless.get(s.id);
      if (failed && failed.key !== JSON.stringify(s)) this.threadless.delete(s.id);
      this.runners.get(s.id)?.reconfigure(s);
    }
    this.placeRunners();
    // A device kept across the change (same connection) still has to hear a new rotation.
    for (const s of config.screens) this.runners.get(s.id)?.device.setRotation?.(s.rotate);
    // A browser whose key went (revoked, paired again, its screen removed) is shown nothing more.
    this.browsers.recheck();
    this.refreshPresence(false);
    this.refreshWanted();
    this.emit('config', config);
  }

  /**
   * Each screen's runner where the config says (see threads/plan.ts): a new
   * one where there was none, and moved, panel and all, when it changed
   * between the main thread and one of its own.
   */
  private placeRunners(): void {
    const plan = planThreads(this.config, this.cores);
    for (const s of this.config.screens) {
      const choice = plan.get(s.id)!;
      // Threads only once started: a config applied before that (tests, the CLI's one-offs) starts nothing.
      const thread = choice.thread && !this.threadless.has(s.id) && this.timer !== null;
      this.threadWhy.set(s.id, choice.why);
      const r = this.runners.get(s.id);
      if (r && r instanceof ThreadRunner === thread) continue;
      this.runners.set(s.id, this.makeRunner(s, thread, r));
    }
  }

  /** A runner for `s` here or in a thread; `old`: the one it replaces, whose panel it keeps (and state). */
  private makeRunner(s: Screen, thread: boolean, old?: Runner): Runner {
    let device: Device | undefined;
    if (old) {
      const taken = old.takeDevice();
      old.close();
      if (JSON.stringify(old.screen.device) === JSON.stringify(s.device)) device = taken;
      else taken.close();
    }
    const r = thread ? new ThreadRunner(s, this, this.threadEntry ?? defaultThreadEntry(), device) : new ScreenRunner(s, this, device);
    // A panel known to be missing from the start (a probe that answers at once): not one frame for it.
    if (isPaused(r)) {
      if (old?.paused) r.setPaused(true);
      else this.setPaused(r, true);
    }
    if (old) {
      if (old.pinned !== r.pinned) r.setPinned(old.pinned);
      if (old.context) r.setContext(old.context);
      if (old.off) r.setOff(true);
      if (old.alert) r.setAlert(old.alert, Date.now());
    }
    return r;
  }

  /** The device a screen sends to now (its remote screen, for pairing, updates, logs). */
  deviceOf(screenId: string): Device | undefined {
    return this.runners.get(screenId)?.device;
  }

  threadFailed(screenId: string, reason: string): void {
    const s = this.config.screens.find((x) => x.id === screenId);
    const r = this.runners.get(screenId);
    if (!s || !r) return;
    this.log(`screen:${s.name}`, `painting on the main thread: ${reason}`);
    this.threadless.set(screenId, { reason, key: JSON.stringify(s) });
    this.runners.set(screenId, this.makeRunner(s, false, r));
    this.refreshWanted();
  }

  start(): void {
    const loop = async () => {
      const now = Date.now();
      this.hub.tick(this.config, now);
      this.fetches.tick(this.config, now);
      if (this.alertsDirty || now - this.alertsAskedAt >= ALERTS_EVERY_MS) this.askAlerts(now);
      this.refreshPresence();
      this.refreshAlerts(now);
      this.refreshContext(now);
      await Promise.all([...this.runners.values()].map((r) => r.update(now)));
      this.refreshBacklights(now);
    };
    this.timer = setInterval(() => void loop(), TICK_MS);
    this.apply(this.config);
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

  /** The context page that has a screen now, and why (see context.ts). */
  contextOf(screenId: string): ContextPick | null {
    return this.runners.get(screenId)?.context ?? null;
  }

  pin(screenId: string, pageId: string | null): void {
    const r = this.runners.get(screenId);
    r?.setPinned(pageId);
  }

  /** `play`: someone plays it from the Play page (see `maybeInterlude`). */
  playInterlude(screenId: string, slotId: string, play = false): void {
    void this.runners.get(screenId)?.playNow(slotId, play);
  }

  /** A button for the interlude being played on a screen; false when none is. */
  press(screenId: string, e: PadEvent): boolean {
    return this.runners.get(screenId)?.press(e) ?? false;
  }

  stopInterlude(screenId: string): void {
    this.runners.get(screenId)?.stopInterlude();
  }

  /** Switches a screen's picture off (black) or back on, until the next restart. */
  setOff(screenId: string, off: boolean): void {
    const r = this.runners.get(screenId);
    if (!r || r.off === off) return;
    r.setOff(off);
    this.emit('screen', { screenId, off });
  }

  /**
   * Pauses the screens whose panel is missing (`Device.presence` absent, see
   * presence.ts) and resumes those whose panel is back: a paused screen
   * composes, paints and encodes nothing, its interludes, animations and
   * alerts wait, and the sources and fetches only it needed stop. A screen
   * the user disabled stays as it is: presence is not `enabled`.
   * `rewant`: start or stop the data at once (false: the caller does).
   */
  refreshPresence(rewant = true): void {
    let changed = false;
    for (const r of this.runners.values()) {
      const pause = isPaused(r);
      if (pause === r.paused) continue;
      this.setPaused(r, pause);
      changed = true;
    }
    if (!changed) return;
    this.alertsDirty = true;
    this.contextDirty = true;
    if (rewant) this.refreshWanted();
  }

  private setPaused(r: Runner, pause: boolean): void {
    r.setPaused(pause);
    r.device.pausedChanged?.(pause);
    const why = r.device.presence?.why;
    this.log(`screen:${r.screen.name}`, pause ? `panel not connected${why ? ` (${why})` : ''}: paused, painting nothing until it is back` : `panel connected${why ? ` (${why})` : ''}: painting again`);
    this.emit('screen', { screenId: r.screen.id, paused: pause });
  }

  refreshWidget(instanceId: string): void {
    this.fetches.refresh(instanceId);
  }

  /** Asks every widget instance of the enabled screens (any page) and every running source for its alerts. */
  askAlerts(now = Date.now()): void {
    this.alertsDirty = false;
    this.alertsAskedAt = now;
    const out: PluginAlert[] = [];
    const call = (from: string, fn: () => unknown, origin: PluginAlert['origin']) => {
      let list: unknown;
      try {
        list = fn();
        this.alertErrors.delete(from);
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        if (this.alertErrors.get(from) !== m) this.log(from, `alerts failed: ${m}`);
        this.alertErrors.set(from, m);
        return;
      }
      if (Array.isArray(list)) for (const alert of list) out.push({ alert, origin, from });
    };
    // In demo mode nothing runs: sample data must not set the panels flashing.
    if (!this.demoMode) {
      const working = this.working(now);
      const cfg = this.config;
      const done = new Set<string>();
      for (const r of this.runners.values()) {
        if (!r.screen.enabled || r.paused) continue;
        for (const { widget } of widgetsOf(r.screen)) {
          const def = this.registry.widget(widget.type);
          if (!def?.alerts || widget.disabled || done.has(widget.id)) continue;
          done.add(widget.id);
          call(widget.type, () => {
            const options = def.options ? (validate(def.options, widget.options).value as Record<string, unknown>) : {};
            return def.alerts!({ options, data: this.fetches.data(widget.id), sources: this.hub.pick(def.sources, cfg, widget.profile), now, working, workday: cfg.workday, ...(cfg.location ? { location: cfg.location } : {}) });
          }, 'widget');
        }
      }
      // Every profile of a source is asked; the same alert id from two of them is one alert.
      for (const { key, type, options } of this.hub.running()) {
        const def = this.registry.source(type);
        if (def?.alerts) call(type, () => def.alerts!({ data: this.hub.data(key), options, now }), 'source');
      }
    }
    this.alerts.sync(out, now, resolveLocale(this.config));
  }

  /**
   * Every screen gets the context page it must show now (context.ts), if
   * any: at most every `CONTEXT_EVERY_MS`, or sooner when data, the running
   * programs or the config changed.
   */
  refreshContext(now = Date.now()): void {
    const wantApps = needsApps(this.config);
    if (wantApps) this.apps?.poll(now, () => (this.contextDirty = true));
    else this.apps?.stop();
    if (!this.contextDirty && now - this.contextAt < CONTEXT_EVERY_MS) return;
    this.contextDirty = false;
    this.contextAt = now;
    const working = this.working(now);
    const env: ContextEnv = {
      now,
      apps: wantApps ? (this.apps?.names ?? null) : null,
      source: (type, profile) => this.hub.data(resolveSourceKey(this.config, type, profile, this.registry.source(type))),
      urgent: (page) => this.urgentOn(page, now, working),
    };
    this.contextEngine.retain(new Set(this.config.screens.map((s) => s.id)));
    for (const r of this.runners.values()) {
      const has = r.screen.enabled && !r.paused && r.screen.pages.some((p) => p.showWhen?.length);
      const pick = has ? this.contextEngine.step(r.screen, matchingPages(r.screen, env, working), now) : null;
      const was = r.context;
      r.setContext(pick);
      if (pick?.page !== was?.page || pick?.leaving !== was?.leaving) {
        if (pick?.page !== was?.page) this.log(`screen:${r.screen.name}`, pick ? `context page ${pick.page}: ${describeReason(pick.reason)}` : 'context page gone: back to the rotation');
        this.emit('screen', { screenId: r.screen.id, context: pick });
      }
    }
  }

  /** The type of a widget on `page` that is urgent now (as its tile sees it), or null. */
  private urgentOn(page: Page, now: number, working: boolean): string | null {
    if (this.demoMode) return null;
    const cfg = this.config;
    for (const tile of page.tiles) {
      for (const w of tile.widgets) {
        const def = this.registry.widget(w.type);
        if (!def?.urgent || w.disabled || !whenMatches(w.when, working)) continue;
        const options = def.options ? (validate(def.options, w.options).value as Record<string, unknown>) : {};
        const state = { options, data: this.fetches.data(w.id), sources: this.hub.pick(def.sources), now, working, workday: cfg.workday, ...(cfg.location ? { location: cfg.location } : {}) };
        if (tileState(def, w, state).urgent) return w.type;
      }
    }
    return null;
  }

  /** Every screen gets the alert it must show now, and the editor hears of any change. */
  refreshAlerts(now = Date.now()): void {
    this.alerts.prune(now);
    const list = this.alerts.list(now);
    for (const r of this.runners.values()) {
      const shown = r.screen.enabled ? this.alerts.forScreen(r.screen, now, r.off) : null;
      r.setAlert(shown, now);
      // Screens with a light of their own (remote screens) show the alert there too.
      r.device.setLed?.(...ledFor(shown?.top.level ?? null));
    }
    const sig = JSON.stringify(list);
    if (sig === this.alertsSig) return;
    this.alertsSig = sig;
    this.emit('alerts', list);
  }

  /** Remote screens' backlights: off while Kiosko shows them black, the night's brightness in their night window (remote/backlight.ts). */
  refreshBacklights(now = Date.now()): void {
    for (const r of this.runners.values()) {
      if (!r.device.setDim) continue;
      r.device.setDim(dimFor(r.screen, { sleeping: r.off || !!r.lastInfo?.sleeping, alert: !!r.alert }, now));
    }
  }

  /** Alerts not seen nor expired, highest first; the snoozed ones too. */
  listAlerts(now = Date.now()): ActiveAlert[] {
    return this.alerts.list(now);
  }

  /** An alert from outside (`POST /api/alerts`); throws `AlertError` if it is not one. */
  postAlert(raw: unknown): ActiveAlert {
    const now = Date.now();
    const a = this.alerts.post(raw, now, resolveLocale(this.config), this.config.screens.map((s) => s.id));
    this.log('alerts', `${a.level}: ${a.title} (${a.id})`);
    this.refreshAlerts(now);
    return a;
  }

  ackAlert(id: string): ReturnType<AlertBoard['ack']> {
    const r = this.alerts.ack(id);
    if (r === 'ok') this.refreshAlerts();
    return r;
  }

  /** Every dismissible alert seen at once; how many. */
  ackAllAlerts(): number {
    const n = this.alerts.ackAll(Date.now());
    this.refreshAlerts();
    return n;
  }

  snoozeAlert(id: string, ms: number): ReturnType<AlertBoard['snooze']> {
    const r = this.alerts.snooze(id, ms, Date.now());
    if (r === 'ok') this.refreshAlerts();
    return r;
  }

  removeAlert(id: string): boolean {
    const r = this.alerts.remove(id);
    if (r) this.refreshAlerts();
    return r;
  }

  /** The screen's test alert ("Test alert" in Screens): shown there for a while, whatever its settings. */
  testAlert(screenId: string, level: AlertLevel = 'critical'): ActiveAlert | null {
    const screen = this.config.screens.find((s) => s.id === screenId);
    if (!screen) return null;
    const locale = resolveLocale(this.config);
    const a = this.alerts.test(screen, level, Date.now(), { title: localize(TEST_ALERT_TITLE, locale), text: localize(TEST_ALERT_TEXT, locale).replace('{screen}', screen.name) });
    this.refreshAlerts();
    return a;
  }

  /** The main thread's event loop use, sampled every few seconds (whoever asks for the status). */
  private elu = { mark: loopUse(), at: Date.now(), value: 0 };
  private mainLoad(): number {
    if (Date.now() - this.elu.at >= 2_000) {
      const mark = loopUse();
      this.elu = { mark, at: Date.now(), value: mark && this.elu.mark ? Math.round(nodePerf.eventLoopUtilization!(mark, this.elu.mark).utilization * 100) / 100 : 0 };
    }
    return this.elu.value;
  }

  status() {
    return {
      screens: [...this.runners.values()].map((r) => ({
        id: r.screen.id,
        name: r.screen.name,
        page: r.page?.id ?? null,
        pinned: r.pinned,
        /** The context page that has the screen, and why (see context.ts); null: none. */
        context: r.context,
        interlude: r.interlude?.type ?? null,
        /** The interlude is being played from the Play page. */
        playing: r.interlude?.play ?? false,
        animation: r.animating,
        device: r.device.status as DeviceStatus,
        lastFrameAt: r.lastInfo?.at ?? null,
        sleeping: r.lastInfo?.sleeping ?? false,
        off: r.off,
        /** Its panel is missing (presence.ts): nothing is painted for it until it is back. */
        paused: r.paused,
        /** What its driver says of the panel being there: present, absent, unknown (none: it can't tell). */
        presence: r.device.presence ?? null,
        /** The alert that has the screen, if any. */
        alert: r.alert?.top.id ?? null,
        /** Real fps, paint and encode times. */
        frames: r.stats.read(),
        /** Painted in a thread of its own or here, why, and what its thread holds in memory. */
        thread: {
          on: r instanceof ThreadRunner,
          why: this.threadless.has(r.screen.id) ? ('failed' as const) : (this.threadWhy.get(r.screen.id) ?? 'setting'),
          error: this.threadless.get(r.screen.id)?.reason ?? null,
          heapBytes: r instanceof ThreadRunner ? r.heapBytes : null,
        },
      })),
      threads: {
        mode: threadsMode(this.config),
        cores: this.cores,
        /** The main thread's JavaScript heap and the whole process' memory, in bytes. */
        ...memory(),
      },
      /** How busy the main thread was since the last status (0–1). */
      mainLoad: this.mainLoad(),
      sources: this.hub.status(),
      fetches: this.fetches.status(),
      /** Paint times of the widgets on the panels, slowest first. */
      paint: this.paintTimes.list(),
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
      sourcesOf: (types, profile) => this.hub.pick(types, this.config, profile),
      failedOf: (inst, types) => this.failedOf(inst.id, types, inst.profile),
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

// Node's, read with care: the browser demo runs this Runtime too, with none of them.
type LoopUse = { idle: number; active: number; utilization: number };
const nodePerf = globalThis.performance as { eventLoopUtilization?: (a?: LoopUse, b?: LoopUse) => LoopUse };
const loopUse = (): LoopUse | null => nodePerf.eventLoopUtilization?.() ?? null;
function cpuCount(): number {
  try {
    return availableParallelism();
  } catch {
    return 1;
  }
}
function memory(): { heapBytes: number; rssBytes: number } {
  try {
    return { heapBytes: process.memoryUsage().heapUsed, rssBytes: process.memoryUsage.rss() };
  } catch {
    return { heapBytes: 0, rssBytes: 0 };
  }
}

/** A screen is paused when it is enabled and its panel is known to be missing. */
function isPaused(r: Runner): boolean {
  return r.screen.enabled && r.device.presence?.state === 'absent';
}

/** A context page's reason, in a line for the log. */
function describeReason(r: ContextReason): string {
  const parts = [r.app && `${r.app} running`, r.source && `${r.source}${r.profile ? `#${r.profile}` : ''}${r.path ? ` ${r.path}` : ''} = ${r.value}`, r.time && `time ${r.time}`, r.urgent && `${r.urgent} urgent`].filter(Boolean);
  return [r.label, parts.join(', ')].filter(Boolean).join(': ');
}

/** Theme and language for a thumbnail; unset ones come from the config. */
export interface ThumbnailLook {
  theme?: string;
  locale?: string;
}

export function withLook<C extends { theme: string; locale: string }>(cfg: C, look: ThumbnailLook): C {
  return { ...cfg, ...(look.theme ? { theme: look.theme } : {}), ...(look.locale ? { locale: look.locale } : {}) };
}

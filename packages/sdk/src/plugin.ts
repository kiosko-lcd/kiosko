/**
 * The plugin contract.
 *
 * A plugin is an ES module whose default export is `definePlugin({...})`. It
 * can contribute three kinds of things:
 *
 *   - **widgets**: paint inside a rectangle of the screen (a cell of the
 *     grid). Optionally fetch their own data on a timer.
 *   - **sources**: shared data (agent sessions, system vitals, weather…)
 *     read once and handed to every widget that asks for it, so ten widgets
 *     showing the CPU don't read /proc ten times.
 *   - **interludes**: full-screen animations the screen plays now and then
 *     (the 8-bit runner every quarter hour, a video clip…).
 *
 * Everything a widget needs arrives in its context: options already
 * validated, data, theme, fonts, the drawing kit and the canvas factory.
 * A plugin must not import its own copy of @napi-rs/canvas: images from
 * another copy can't be drawn on the panel's canvas.
 */
import type { Canvas, Image, SKRSContext2D, createCanvas, loadImage } from '@napi-rs/canvas';
import type * as Kit from '@loksly/lcd-canvas-kit';
import type { Formatters } from './format.ts';
import type { Localized } from './i18n.ts';
import type { Field, Infer, ObjectField } from './schema.ts';
import type { Theme } from './theme.ts';
import type { Workday } from './workday.ts';

/** The 2D context widgets paint with. Same API as the browser's CanvasRenderingContext2D. */
export type Graphics = SKRSContext2D;
export type { Canvas, Image };

export interface CanvasApi {
  createCanvas: typeof createCanvas;
  loadImage: typeof loadImage;
}

/** A rectangle in panel pixels. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Size in panel pixels. */
export interface Size {
  w: number;
  h: number;
}

export type Category = 'agents' | 'system' | 'time' | 'productivity' | 'dev' | 'info' | 'media' | 'scene' | 'fun';

export const CATEGORIES: { id: Category; label: Localized }[] = [
  { id: 'agents', label: { en: 'AI agents', es: 'Agentes IA' } },
  { id: 'system', label: { en: 'System', es: 'Sistema' } },
  { id: 'time', label: { en: 'Time & calendar', es: 'Tiempo y agenda' } },
  { id: 'productivity', label: { en: 'Productivity', es: 'Productividad' } },
  { id: 'dev', label: { en: 'Development', es: 'Desarrollo' } },
  { id: 'info', label: { en: 'News & world', es: 'Noticias y mundo' } },
  { id: 'media', label: { en: 'Media', es: 'Multimedia' } },
  { id: 'scene', label: { en: 'Scenes', es: 'Escenas' } },
  { id: 'fun', label: { en: 'Fun', es: 'Diversión' } },
];

export interface Logger {
  (msg: string): void;
}

/** A place on Earth, in degrees. */
export interface Location {
  latitude: number;
  longitude: number;
  /** Shown by some widgets, e.g. "Madrid". */
  name?: string;
}

/** What every context has. */
export interface BaseContext {
  now: number;
  /** BCP-47 language of the user (`es`, `en-GB`…). */
  locale: string;
  /** Picks the user's language from a `Localized` text. */
  t: (text: Localized) => string;
  /**
   * Times and lengths of time in the user's language and clock (Settings →
   * time format): `fmt.time(at)` "14:05" / "2:05 PM", `fmt.ago(at)`
   * "5 min ago", `fmt.duration(ms)` "1 h 05". Use these rather than your own.
   */
  fmt: Formatters;
  log: Logger;
  /** Where the plugin may keep files (caches, downloads). Created on demand. */
  dataDir: string;
  /**
   * The user's place, if set in Settings (weather, sun, earthquakes…). Use it
   * by default; offer a place of your own only where a second one makes sense
   * (an advanced override), with an empty or 0,0 value meaning "this one".
   */
  location?: Location;
  /**
   * The user's working week from Settings: days, start and end, hours due,
   * days with other hours and holidays. Default to it instead of asking for
   * your own schedule; `scheduleOn(ctx.workday, now)` gives one day's.
   */
  workday: Workday;
}

export interface FetchContext<O> extends BaseContext {
  options: O;
  canvas: CanvasApi;
  /** Aborted when the widget is removed, the app stops, or this fetch takes longer than `timeoutMs`. Pass it to `fetch` and child processes. */
  signal: AbortSignal;
  /** How long this fetch may take (the widget's `timeoutMs`), for a per-request budget of your own. */
  timeoutMs: number;
  /** Latest data of the sources the widget declared. */
  sources: Record<string, unknown>;
}

export interface StateContext<O, D> {
  options: O;
  data: D | undefined;
  sources: Record<string, unknown>;
  now: number;
  /** True for a work-hours slot, per the user's work schedule. */
  working: boolean;
  /** The user's working week (see `BaseContext.workday`); tests can pass `DEFAULT_WORKDAY`. */
  workday: Workday;
  /** The user's place, if set (see `BaseContext.location`). */
  location?: Location;
}

export interface RenderContext<O, D> extends BaseContext, StateContext<O, D> {
  /** Where to paint, already inside the card's padding and title. */
  box: Box;
  theme: Theme;
  /** Families registered on the panel; same as `theme.fonts`. */
  fonts: Theme['fonts'];
  /** Helpers from @loksly/lcd-canvas-kit: tracked text, wrapping, sparklines, weather icons… */
  kit: typeof Kit;
  canvas: CanvasApi;
  /** The widget is drawn in the editor (gallery thumbnail or live preview) and not on the panel. */
  preview: boolean;
  /**
   * Set while an animation of this widget is being painted (see
   * `WidgetDefinition.animation`): which frame this call must draw. Without
   * it, paint the widget at rest. The first and the last frame of an
   * animation should look exactly like the still one.
   */
  anim?: AnimationFrame;
  /** Index of the frame being painted while an animation runs (`anim.i`). */
  frame?: number;
}

/**
 * A short animation a widget asks the runtime to play inside its own tile: a
 * cat's tail flick, a tile sliding in. The runtime plans it (when, one at a
 * time per screen), paints every frame by calling `render` with `ctx.anim`
 * before playing, sends them at `fps` (never above the screen's `maxFps`) and
 * finishes with a real still repaint.
 */
export interface AnimationPlan {
  /** What it is (`tail`, `walk`…): for the log and for `render`, which receives it in `ctx.anim.plan`. */
  id: string;
  /** Frames, counting the first and the last (those are the still picture and are not sent). At least 3. */
  frames: number;
  /** Frames per second it was designed for. The screen's `maxFps` caps it. */
  fps: number;
  /** Whatever `render` needs to draw it (who does what). Plain data: it is not interpreted. */
  params?: unknown;
  /**
   * `false`: new data doesn't cut it short (something that must be seen to
   * the end). Default `true`: a data change cancels it and the screen is
   * repainted with the new data.
   */
  interruptible?: boolean;
  /** Stay still at `at` (0..1 of the animation) for `ms` (a long task being shown), or until interrupted. */
  hold?: { at: number; ms: number };
}

/** The frame `render` must paint (see `RenderContext.anim`). */
export interface AnimationFrame {
  plan: AnimationPlan;
  /** Frame number, 0..plan.frames-1. */
  i: number;
  /** Progress, 0..1: `i / (frames - 1)`. 0 and 1 are the still picture. */
  t: number;
}

/** What `WidgetDefinition.animation` is asked with. */
export interface AnimationContext<O, D> extends StateContext<O, D> {
  /** Where the widget paints (the same `box` its `render` gets), to decide with the layout it will have. */
  box: Box;
  /**
   * Why it is asked: `idle`, every now and then while nothing else happens
   * (see `animationGap`), or `data`, because this instance's data just changed
   * or one of its sources did (see `prev`) and a reaction may be due, like a
   * cat walking to its new spot.
   */
  trigger: 'idle' | 'data';
  /** What the widget had before the change, for `trigger: 'data'`: its own data and its sources. */
  prev?: { data: D | undefined; sources: Record<string, unknown> };
  /** Random numbers in [0, 1). Use these and not `Math.random`, so tests can seed them. */
  rnd: () => number;
}

/**
 * When the widget must be repainted even though its data didn't change: a
 * clock every second, a countdown every minute. Fewer repaints are fewer
 * frames over USB, so pick the slowest that still looks right.
 */
export type Redraw = 'never' | 'minute' | 'second' | { everyMs: number };

export interface WidgetDefinition<OF extends ObjectField<any> = ObjectField<any>, D = unknown> {
  /** Unique inside its plugin: `clock`, `sessions`… The full type is `plugin/widget`. */
  id: string;
  name: Localized;
  description?: Localized;
  /** Name of an icon of the editor (see web/icons) or an inline SVG string. */
  icon?: string;
  category?: Category;
  tags?: string[];
  /**
   * Sizes in panel pixels. `min` is a hard limit enforced by the editor;
   * `preferred` is what it uses when the widget is dropped.
   */
  size?: { min?: Size; preferred?: Size; max?: Size };
  /** How the cell frames it: a card with optional title (default) or bare, edge to edge (scenes, photos). */
  chrome?: 'card' | 'bare';
  /** Options, as a schema: typed, validated and turned into a form by the editor. */
  options?: OF;
  /** Ids of shared sources (`plugin/source`) whose data the widget receives in `ctx.sources`. */
  sources?: string[];
  /** Own data, per instance. Runs in Node, never blocks the panel. */
  fetch?: (ctx: FetchContext<Infer<OF>>) => Promise<D>;
  /** How often `fetch` runs. Default: 10 minutes. The user can override it. */
  intervalMs?: number;
  /**
   * How often `fetch` runs when that depends on the options or on the latest
   * data (a module that declares its own interval): asked after every fetch;
   * `undefined` keeps `intervalMs`. An interval the user set on the instance
   * wins. Never under 5 s.
   */
  intervalOf?: (ctx: { options: Infer<OF>; data: NoInfer<D> | undefined }) => number | undefined;
  /** Longest one `fetch` may take before its `signal` aborts and it counts as failed. Default: 2 minutes. */
  timeoutMs?: number;
  /** Paint. Synchronous and fast: load images in `fetch` and paint them here. */
  render: (g: Graphics, ctx: RenderContext<Infer<OF>, D>) => void;
  /**
   * Asks for a short animation inside the tile, or `null` for none. The
   * runtime calls it only while this widget is the one shown, the screen has
   * room for another animation (several widgets may ask: they wait their turn,
   * and how many play together is up to the runtime) and its `animationGap` /
   * `animationCooldownMs` allow it. It must be cheap and decide from the data alone; the drawing goes in
   * `render`, which gets `ctx.anim` for every frame. Every frame costs USB
   * time: keep them few and short.
   */
  animation?: (ctx: AnimationContext<Infer<OF>, D>) => AnimationPlan | null;
  /** How long to wait between the `idle` questions of `animation`, a random time in the range. Default 20-60 s. */
  animationGap?: { minMs: number; maxMs: number };
  /** Minimum time from the end of an animation to the next one asked because of a data change. Default 0. */
  animationCooldownMs?: number;
  /** Also a function, when the cadence depends on the options or the data (a carousel every `rotateMs`). */
  redraw?: Redraw | ((ctx: StateContext<Infer<OF>, D>) => Redraw);
  /** Has nothing to show right now (nothing playing, no rain): skipped in its cell's rotation. */
  visible?: (ctx: StateContext<Infer<OF>, D>) => boolean;
  /**
   * Needs the user now (a meeting about to start): takes its cell over while
   * true, unless the user turned the widget's "keep the tile while urgent"
   * switch (`takeOver`) off. Don't add an option of your own for that.
   */
  urgent?: (ctx: StateContext<Infer<OF>, D>) => boolean;
  /** Default of the instance's `takeOver` switch (keep the tile while urgent). Default true. */
  takeOver?: boolean;
  /**
   * Has nothing to list right now (no reviews, no tasks). Declaring it gives
   * the widget a "hide when empty" switch (`hideWhenEmpty`): when on, an
   * empty widget is skipped in its tile's rotation like `visible: false`;
   * when off, it paints its empty message (`drawEmpty`). Unlike `visible`,
   * which is the widget's own decision, this one is the user's.
   */
  empty?: (ctx: StateContext<Infer<OF>, D>) => boolean;
  /** Default of the instance's `hideWhenEmpty` switch. Default false. */
  hideWhenEmpty?: boolean;
  /**
   * Nothing worth lighting the panel for. When every widget of the page is
   * idle and the screen has `sleepWhenIdle`, the panel goes black.
   */
  idle?: (ctx: StateContext<Infer<OF>, D>) => boolean;
  /**
   * Sample data for the gallery, the editor and the tests, so a widget can
   * be seen before it's configured (no tokens, no network). `options` are
   * sample options used only for gallery thumbnails (e.g. a few countdown
   * dates), never for a widget the user placed.
   */
  demo?: (ctx: { options: Infer<OF>; now: number; locale: string }) => { data?: D; sources?: Record<string, unknown>; options?: Partial<Infer<OF>> };
}

export interface SourceContext<O> extends BaseContext {
  options: O;
  /**
   * Aborted when the source stops (no widget uses it, options changed, the
   * app stops) and, in `read`, when this read takes longer than `timeoutMs`.
   * Pass it to `fetch` and child processes.
   */
  signal: AbortSignal;
  /** How often `read` runs (the user's `intervalMs`, clamped to `minIntervalMs`). */
  intervalMs: number;
  /** How long one `read` may take (the user's `timeoutMs`), for a per-request budget of your own. */
  timeoutMs: number;
}

export interface SourceDefinition<OF extends ObjectField<any> = ObjectField<any>, D = unknown> {
  /** Unique inside its plugin. Widgets ask for `plugin/source`. */
  id: string;
  name: Localized;
  description?: Localized;
  /** Global options, edited once in Settings → Sources. */
  options?: OF;
  /**
   * Polled every `intervalMs` while some widget uses it. The user can change
   * the interval and the timeout in Settings → Data sources
   * (`sources["plugin/source"].intervalMs` / `.timeoutMs`): don't add options
   * of your own for them.
   */
  read?: (ctx: SourceContext<Infer<OF>>) => Promise<D>;
  /** Default interval of `read`. Default: 30 s. */
  intervalMs?: number;
  /** Shortest interval the user may set: API rate limits, an expensive command. Default: 5 s (or `intervalMs`, if shorter). */
  minIntervalMs?: number;
  /** Default of the longest one `read` may take before its `signal` aborts and it counts as failed. Default: 2 minutes. */
  timeoutMs?: number;
  /**
   * Push-based alternative (file watchers, sockets): call `emit` with new
   * data, return a function that stops watching.
   */
  watch?: (ctx: SourceContext<Infer<OF>>, emit: (data: D) => void) => () => void;
  demo?: (ctx: { now: number; locale: string }) => D;
}

export interface InterludePlayer {
  /** Number of frames. */
  frames: number;
  /** Paints frame `i` on a canvas of the full panel size. May be async (to decode a prerendered frame). */
  draw: (g: Graphics, i: number) => void | Promise<void>;
}

export interface InterludeContext<O> extends BaseContext {
  options: O;
  width: number;
  height: number;
  /** Deterministic per slot: the same quarter hour plays the same story. */
  seed: number;
  theme: Theme;
  canvas: CanvasApi;
  sources: Record<string, unknown>;
}

export interface InterludeDefinition<OF extends ObjectField<any> = ObjectField<any>> {
  id: string;
  name: Localized;
  description?: Localized;
  icon?: string;
  options?: OF;
  sources?: string[];
  /** Frames per second it was designed for. USB panels top out around 12-24 fps. */
  fps: number;
  /** Builds the animation. May be slow (it runs before playing, not during). */
  prepare: (ctx: InterludeContext<Infer<OF>>) => Promise<InterludePlayer | null>;
  /** Don't interrupt now (someone waits for a permission, a meeting is about to start). */
  skip?: (ctx: { sources: Record<string, unknown>; now: number; options: Infer<OF> }) => boolean;
}

export interface PluginDefinition {
  /** npm-like id: lowercase, digits and dashes. Stable: configs refer to it. */
  id: string;
  name: Localized;
  version: string;
  description?: Localized;
  author?: string;
  homepage?: string;
  license?: string;
  icon?: string;
  widgets?: WidgetDefinition<any, any>[];
  sources?: SourceDefinition<any, any>[];
  interludes?: InterludeDefinition<any>[];
}

/* Identity helpers: they only exist so TypeScript infers option and data types. */

export function defineWidget<OF extends ObjectField<any> = ObjectField<{}>, D = undefined>(w: WidgetDefinition<OF, D>): WidgetDefinition<OF, D> {
  return w;
}
export function defineSource<OF extends ObjectField<any> = ObjectField<{}>, D = unknown>(s: SourceDefinition<OF, D>): SourceDefinition<OF, D> {
  return s;
}
export function defineInterlude<OF extends ObjectField<any> = ObjectField<{}>>(i: InterludeDefinition<OF>): InterludeDefinition<OF> {
  return i;
}
export function definePlugin(p: PluginDefinition): PluginDefinition {
  return p;
}

export type { Field };

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
import type { Localized, PluralForms } from './i18n.ts';
import type { Field, Infer, ObjectField } from './schema.ts';
import type { Theme } from './theme.ts';
import type { Workday } from './workday.ts';

/** The 2D context widgets paint with. Same API as the browser's CanvasRenderingContext2D. */
export type Graphics = SKRSContext2D;
export type { Canvas, Image };

export interface CanvasApi {
  createCanvas: typeof createCanvas;
  loadImage: typeof loadImage;
  /**
   * Loads an image already shrunk to the size it will be shown at: decoded,
   * scaled and prepared in another thread, so neither this nor the first
   * paint of it holds the panels up. A press photo of 14 megapixels shown
   * in a 600×462 tile cost up to 130 ms in that first paint; shrunk, a few.
   * Never enlarges. `cover`: at least `width` × `height` (it will be
   * cropped); `contain`: at most that (it will be shown whole).
   * Kiosko 0.2.5 and later: check that it's there and fall back to
   * `loadImage` otherwise. Not in the browser demo.
   */
  loadImageScaled?: (src: string | Buffer | Uint8Array, size: { width: number; height: number; fit?: 'cover' | 'contain' }) => Promise<Image>;
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
  { id: 'agents', label: { en: 'AI agents', es: 'Agentes IA', de: 'KI-Agenten', 'zh-Hant': 'AI 代理', 'zh-Hans': 'AI 智能体' } },
  { id: 'system', label: { en: 'System', es: 'Sistema', de: 'System', 'zh-Hant': '系統', 'zh-Hans': '系统' } },
  { id: 'time', label: { en: 'Time & calendar', es: 'Tiempo y agenda', de: 'Zeit & Kalender', 'zh-Hant': '時間與行事曆', 'zh-Hans': '时间与日历' } },
  { id: 'productivity', label: { en: 'Productivity', es: 'Productividad', de: 'Produktivität', 'zh-Hant': '生產力', 'zh-Hans': '效率' } },
  { id: 'dev', label: { en: 'Development', es: 'Desarrollo', de: 'Entwicklung', 'zh-Hant': '開發', 'zh-Hans': '开发' } },
  { id: 'info', label: { en: 'News & world', es: 'Noticias y mundo', de: 'Nachrichten & Welt', 'zh-Hant': '資訊與生活', 'zh-Hans': '资讯与生活' } },
  { id: 'media', label: { en: 'Media', es: 'Multimedia', de: 'Medien', 'zh-Hant': '多媒體', 'zh-Hans': '多媒体' } },
  { id: 'scene', label: { en: 'Scenes', es: 'Escenas', de: 'Szenen', 'zh-Hant': '場景', 'zh-Hans': '场景' } },
  { id: 'fun', label: { en: 'Fun', es: 'Diversión', de: 'Spaß', 'zh-Hant': '趣味', 'zh-Hans': '趣味' } },
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
   * `{n} files` with the plural form the user's language asks for:
   * `ctx.plural(n, { en: { one: '{n} file', other: '{n} files' }, 'zh-Hant': { other: '{n} 個檔案' } })`.
   * Use it for any text with a count in it, rather than `n === 1 ? … : …`.
   */
  plural: (n: number, forms: Record<string, PluralForms>) => string;
  /**
   * Which of `available` (language tags) to use for this user: for tables
   * kept one per language (`TABLES[ctx.pickLanguage(Object.keys(TABLES))]`).
   * English when none fits, else the first.
   */
  pickLanguage: (available: readonly string[]) => string;
  /**
   * Times and lengths of time in the user's language and clock (Settings →
   * time format): `fmt.time(at)` "14:05" / "2:05 PM", `fmt.ago(at)`
   * "5 min ago", `fmt.duration(ms)` "1 h 05". Use these rather than your own.
   */
  fmt: Formatters;
  log: Logger;
  /** Where the plugin may keep files that must survive a reboot (settings, history). Created on demand. */
  dataDir: string;
  /**
   * Where the plugin keeps what can be fetched again (downloads, feed copies,
   * photos, tiles). It is RAM (tmpfs), so the constant rewriting never wears
   * the SSD, and it is empty after a reboot. Created on demand. Falls back to
   * `dataDir` where there is no tmpfs. Use this, not `dataDir`, for caches.
   */
  cacheDir: string;
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

/** What `WidgetDefinition.animationEnded` is told. */
export interface AnimationEndContext<O, D> extends BaseContext {
  options: O;
  /** The animation that has just ended. */
  plan: AnimationPlan;
  /**
   * `true` if it played to its last frame; `false` if it was cut short (new
   * data, the screen went away) or never got to play.
   */
  completed: boolean;
  /** The widget's data when it started. */
  data: D | undefined;
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

/** How much an alert matters: the panel's frame turns blue, amber or red. */
export type AlertLevel = 'info' | 'warn' | 'critical';
/** From least to most. */
export const ALERT_LEVELS: readonly AlertLevel[] = ['info', 'warn', 'critical'];

/**
 * Something that must be seen from across the room (the panel has no
 * sound): smoke, a leak, the doorbell, a call, `main` broken, a typhoon
 * warning. Returned by a widget's or a source's `alerts`, decided from its
 * data like `urgent`; Kiosko decides how it is shown: over everything, on
 * every screen whose settings let that level through (the rest keep it in
 * the editor's band), with a flashing frame and the text still and huge.
 * Kiosko 0.2.7 and later; older ones ignore `alerts`.
 */
export interface Alert {
  /**
   * Stable while it is the same event, new for a new one (`smoke-kitchen`,
   * `pipeline-4711`): an alert the user has seen ("Seen") stays hidden while
   * the plugin keeps returning the same id, and shows again with a new id.
   */
  id: string;
  level: AlertLevel;
  /** A few words, painted as big as the panel allows: "Smoke in the kitchen". */
  title: Localized;
  /** One short line under it: "Sensor 2 · since 14:05". */
  text?: Localized;
  /**
   * Who published it, a few letters, painted small in a corner next to the
   * time: "IGN", "NWS", "AEMET", "气象署". Name the authority when the alert
   * is someone else's: their licences ask for it, and the user must know
   * where it comes from. Kiosko 0.2.7 and later; older ones ignore it.
   */
  source?: Localized;
  /**
   * A second line under `text`, to be read after it: the authority's own
   * instruction ("Move away from the coast and go to high ground"), as it
   * is. Painted smaller than the title and only as far as it fits. Kiosko
   * 0.2.7 and later; older ones ignore it.
   */
  detail?: Localized;
  /**
   * An icon of Lucide's (`flame`, `droplet`, `bell-ring`, `phone-incoming`,
   * `activity`, `cloud-lightning`, `git-branch`…; see docs/plugins.md for
   * those the panel draws) or one or two characters (`震`). Default: by level.
   */
  icon?: string;
  /** When it stops on its own (epoch ms). */
  expiresAt?: number;
  /** Or how long it lasts from when Kiosko first sees it, in ms. */
  ttlMs?: number;
  /** Whether "Seen" (or snoozing it) may hide it. Default true; `false` stays while the plugin returns it. */
  dismissible?: boolean;
}

/** What a source's `alerts` is asked with. */
export interface SourceAlertContext<O, D> {
  data: D | undefined;
  options: O;
  now: number;
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
  /**
   * Called when an animation of this widget ends, whether it played through
   * or not (see `completed`): to remember what it did, like a trophy for
   * a set that got built. Synchronous and quick; keep files under `dataDir`.
   */
  animationEnded?: (ctx: AnimationEndContext<Infer<OF>, D>) => void;
  /** How long to wait between the `idle` questions of `animation`, a random time in the range. Default 20-60 s. */
  animationGap?: { minMs: number; maxMs: number };
  /** Minimum time from the end of an animation to the next one asked because of a data change. Default 0. */
  animationCooldownMs?: number;
  /** Also a function, when the cadence depends on the options or the data (a carousel every `rotateMs`). */
  redraw?: Redraw | ((ctx: StateContext<Infer<OF>, D>) => Redraw);
  /** Shouldn't be shown at all right now (nothing playing, no rain): out of its cell's rotation, even alone in it. For "nothing to list" prefer `empty`, which the user can overrule. */
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
   * Alerts to show full-screen (see `Alert`): a smoke sensor going off, the
   * pipeline of `main` failing. Plain and quick, from the data alone: it is
   * asked for every instance on any page of an enabled screen (not only the
   * one shown) whenever its data changes, and every few seconds. Return `[]`
   * when there is nothing. Several instances of the widget returning the
   * same `id` are one alert. Kiosko 0.2.7 and later.
   */
  alerts?: (ctx: StateContext<Infer<OF>, D>) => Alert[];
  /**
   * Has nothing useful to show right now (no reviews, no tasks, no prices
   * because the provider is down). Declare it whenever your widget can have
   * nothing to show: in a tile with other widgets, an empty one passes its
   * turn to them (Kiosko 0.2.15 and later; before, only when its
   * `hideWhenEmpty` was on). Alone in its tile, or when none of the tile's
   * widgets has anything, it is shown and paints its empty message
   * (`drawEmpty`). Mean "nothing to show", not "nothing urgent": an idle but
   * healthy thing worth seeing is not empty.
   *
   * Kiosko also skips a widget, in a tile with others, while nothing it
   * reads has come yet (its `fetch` and its `sources`) or while its fetch or
   * a source it reads is failing: no need to declare that.
   *
   * Unlike `visible`, which is the widget's own decision, this one the user
   * can overrule with the instance's `hideWhenEmpty` switch.
   */
  empty?: (ctx: StateContext<Infer<OF>, D>) => boolean;
  /**
   * Default of the instance's `hideWhenEmpty` switch, which says what the
   * widget does when it has nothing to show (empty, loading, failing):
   * - missing (the default, and what nearly every widget wants): passes its
   *   turn when its tile has another widget with something to show;
   * - `false`: never passes its turn, whatever it has;
   * - `true`: as missing, and also hidden while `empty` when it is alone in
   *   its tile (like `visible: false`: the tile then shows nothing).
   */
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
  /**
   * The source profile being read (see `SourceDefinition.profiles`): its id,
   * or undefined for the default one. Each profile is read on its own, with
   * its own options; use it to keep files of each apart in `cacheDir`.
   * Kiosko 0.2.14 and later.
   */
  profile?: string;
}

export interface SourceDefinition<OF extends ObjectField<any> = ObjectField<any>, D = unknown> {
  /** Unique inside its plugin. Widgets ask for `plugin/source`. */
  id: string;
  name: Localized;
  description?: Localized;
  /** Global options, edited once in Settings → Sources. */
  options?: OF;
  /**
   * Polled every `intervalMs` while some widget uses it (or always, see
   * `background`). The user can change the interval and the timeout in
   * Settings → Data sources (`sources["plugin/source"].intervalMs` /
   * `.timeoutMs`): don't add options of your own for them.
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
  /**
   * Alerts to show full-screen (see `Alert`), from the source's latest data:
   * like a widget's `alerts`, for alerts that belong to the data itself (a
   * Home Assistant smoke sensor, an earthquake report). Asked while the
   * source runs: while some widget uses it, or always if it runs in the
   * `background`. Kiosko 0.2.7 and later.
   */
  alerts?: (ctx: SourceAlertContext<Infer<OF>, D>) => Alert[];
  /**
   * May run with no widget using it, for its `alerts` alone (official
   * warnings, earthquake reports): Settings → Data sources then offers a
   * switch, "Watch for alerts without a widget", off by default
   * (`sources["plugin/source"].background`). While it is on and the plugin
   * is enabled, Kiosko reads (or watches) the source and asks its `alerts`
   * even if no tile shows it. Only with `alerts`; Kiosko 0.2.7 and later,
   * older ones ignore it (the source runs only while a widget uses it).
   */
  background?: boolean;
  /**
   * Named lists of values for the editor to offer in options, made from
   * this source's latest data (or its demo data before there is any): the
   * entities of a Home Assistant, the calendars read, the repos seen. A
   * field asks for one with `choices: { source: 'plugin/source', list }`.
   * Plain and quick: they run when the editor opens a form.
   */
  choices?: Record<string, (data: D, ctx: { locale: string; t: (text: Localized) => string }) => Choice[]>;
  /**
   * The user may keep several named configurations of it, **profiles**
   * (news «General» and «Technology», two GitHub accounts), each with its
   * own options and read on its own, as if it were another source. A widget
   * picks one with its `profile` (Kiosko adds the picker to the widgets that
   * read the source; the plugin adds nothing) and finds that profile's data
   * in `ctx.sources["plugin/source"]` as usual. Without profiles in the
   * config, nothing changes: the source's options are
   * `sources["plugin/source"]`, the default profile. Off unless declared:
   * a source that reads hardware or the local machine (a battery, a
   * Bluetooth sensor) has one thing to read. Kiosko 0.2.14 and later; older
   * ones ignore it (one configuration).
   */
  profiles?: boolean;
}

/** One value the editor offers for an option (see `SourceDefinition.choices`). */
export interface Choice {
  value: string;
  /** What the person sees, when it isn't the value itself (`Living room` for `sensor.living_room`). */
  label?: string;
  /** Heading to group it under (`Sensors`, `Lights`). */
  group?: string;
}

export interface InterludePlayer {
  /** Number of frames. */
  frames: number;
  /** Paints frame `i` on a canvas of the full panel size. May be async (to decode a prerendered frame). */
  draw: (g: Graphics, i: number) => void | Promise<void>;
}

/** A button of the Play page's pad: a game controller's, the keyboard's arrows and keys, or the phone's touch pad. */
export type PadKey = 'up' | 'down' | 'left' | 'right' | 'a' | 'b' | 'x' | 'y' | 'l' | 'r' | 'start' | 'select';
export const PAD_KEYS: readonly PadKey[] = ['up', 'down', 'left', 'right', 'a', 'b', 'x', 'y', 'l', 'r', 'start', 'select'];

/** A button pressed or let go on the Play page. */
export interface PadEvent {
  key: PadKey;
  pressed: boolean;
}

/** The player's buttons, for an interlude being played (see `InterludeDefinition.input`). */
export interface InterludeInput {
  /** Calls `listener` for every button pressed or let go; returns what stops it. */
  on(listener: (e: PadEvent) => void): () => void;
}

export interface InterludeContext<O> extends BaseContext {
  options: O;
  /**
   * Someone is playing it from the editor's Play page (only for an
   * interlude with `input: true`): their buttons. It then lasts while they
   * play (no `maxSeconds`; a minute without a button ends it), and `frames`
   * may be `Infinity`. Undefined when it plays at its time slot. Kiosko
   * 0.2.7 and later.
   */
  input?: InterludeInput;
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
  /**
   * It can be played: the editor's Play page offers it, and when started
   * from there `ctx.input` brings the player's buttons. Kiosko 0.2.7 and
   * later.
   */
  input?: boolean;
  /**
   * A short recording for the plugin store, relative to its package
   * (`docs/<id>.webm`, 6–10 s, and a still `docs/<id>.jpg` for where video
   * doesn't play).
   */
  preview?: { video?: string; poster: string };
  /** Builds the animation. May be slow (it runs before playing, not during). */
  prepare: (ctx: InterludeContext<Infer<OF>>) => Promise<InterludePlayer | null>;
  /** Don't interrupt now (someone waits for a permission, a meeting is about to start). */
  skip?: (ctx: { sources: Record<string, unknown>; now: number; options: Infer<OF> }) => boolean;
}

/**
 * The version of the plugin API this Kiosko speaks. A plugin says which
 * versions it was written for in `PluginDefinition.sdk` (and in its
 * package.json, `"kiosko": { "sdk": "^0.2.0" }`, so it can be refused before
 * it runs); the registry compares them with `satisfies`.
 */
export const SDK_VERSION = '0.2.14';

/**
 * What a plugin does on the machine, declared for the person who installs
 * it: the Plugins page and the plugin store show it next to the plugin. It
 * is a promise, not (yet) a fence: plugins run with the user's rights. Keep
 * it honest and small; options with a `risk` (see `Risk`) are listed apart.
 */
export interface Permissions {
  /**
   * Hosts it contacts on its own: exact names (`api.github.com`,
   * `*.open-meteo.com`), `user` for the hosts the user types in its options
   * (a feed, a Home Assistant), `lan` for the local network.
   */
  network?: string[];
  /** Programs it runs (`nvidia-smi`, `pactl`, `ssh`); `user` for a command the user configures. */
  exec?: string[];
  /** Files or folders it reads or writes besides its own `dataDir`/`cacheDir` (`~/.aimonitor/sessions`); `user` for paths the user configures. */
  files?: string[];
  /** Hardware or system services it talks to: `usb`, `audio` (whether the microphone is in use), `mpris` (what is playing), `bluetooth`… */
  devices?: string[];
}

/** One tile of a page template, in fractions of the page (0..1). */
export interface TemplateTile {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Widget types, stacked; a bare id (`clock`) is this plugin's own. With options: `['clock', { showDate: true }]`. */
  widgets: (string | [string, Record<string, unknown>])[];
  chrome?: 'card' | 'bare';
}

/**
 * A starting layout the editor offers under "New page", made of this
 * plugin's widgets (and others', if installed: tiles whose widgets are all
 * missing are left out).
 */
export interface PageTemplate {
  /** Unique inside the plugin. */
  id: string;
  name: Localized;
  /** An icon of the editor (Lucide name). */
  icon?: string;
  /** For strips and wide panels. */
  wide: TemplateTile[];
  /** For square-ish panels; defaults to `wide`. */
  square?: TemplateTile[];
  /** For portrait panels; defaults to `wide` turned a quarter (columns become bands). */
  tall?: TemplateTile[];
}

export type Platform = 'linux' | 'darwin' | 'win32';

export interface PluginDefinition {
  /** npm-like id: lowercase, digits and dashes. Stable: configs refer to it. */
  id: string;
  name: Localized;
  version: string;
  description?: Localized;
  author?: string;
  homepage?: string;
  /** Where its code lives (a git URL): the store links to it. */
  repository?: string;
  license?: string;
  icon?: string;
  /**
   * The plugin API versions it works with, as an npm range (`^0.2.0`).
   * Without it, any Kiosko is assumed to fit. Put the same in package.json
   * (`"kiosko": { "sdk": … }`) so an incompatible plugin is refused before
   * its code runs.
   */
  sdk?: string;
  /** What it does on the machine (see `Permissions`). */
  permissions?: Permissions;
  /**
   * Sources or widgets of other plugins it needs (`agents/sessions`): the
   * editor says which are missing and offers to install their plugins.
   */
  requires?: string[];
  /**
   * Sources or widgets of other plugins it uses when they are there, and
   * does without otherwise (the weather in a corner): never asked for, only
   * mentioned.
   */
  optional?: string[];
  /** The operating systems it works on. Omitted: all. Also npm's `os` in package.json. */
  platforms?: Platform[];
  /**
   * The languages its texts come in, as BCP 47 tags, English first:
   * `['en', 'es', 'zh-Hant', 'zh-Hans']`. Chinese goes by script (`zh-Hant`
   * for Taiwan and Hong Kong, `zh-Hans` for mainland China), never a bare
   * `zh`. Every `Localized` text of the plugin has them all (the linter
   * says which lack one). Also `kiosko.languages` in package.json, so a
   * catalogue knows without running it. Omitted: the ones its texts use.
   */
  languages?: string[];
  widgets?: WidgetDefinition<any, any>[];
  sources?: SourceDefinition<any, any>[];
  interludes?: InterludeDefinition<any>[];
  /** Page layouts the editor offers, built from its widgets (see `PageTemplate`). */
  templates?: PageTemplate[];
  /**
   * The category it is browsed under in the plugin store when it has no
   * widgets of its own (only interludes, say): `fun` or `scene`. With widgets,
   * the store takes theirs.
   */
  category?: Category;
  /**
   * Where it is useful, for the plugin store (see `PluginMarkets`): only in
   * Spain (an electricity tariff), not where its service isn't offered.
   */
  markets?: PluginMarkets;
  /** Where to ask for help. Missing: `bugs` and `homepage` of package.json. */
  support?: { issues?: string; discussions?: string; docs?: string };
  /** How it is sold. Only `free` for now: paid plugins are not there yet. */
  pricing?: { model: 'free' };
  /** A page to support its author (also `funding` in package.json). */
  funding?: string;
  /** What it costs to run, roughly, for the store (`memoryMb` while painting, `cpu`). */
  resources?: { memoryMb?: number; cpu?: 'low' | 'medium' | 'high'; note?: Localized };
}

/**
 * Where a plugin is useful, as regions: ISO 3166-1 alpha-2 country codes
 * (`ES`, `TW`) or `EU`. The store marks it ("only useful in Spain") and its
 * "available in my region" filter uses it; it is never hidden from search.
 */
export interface PluginMarkets {
  /** Only useful here (a country's tariff, a city's metro). */
  only?: string[];
  /** Its service isn't offered here. */
  without?: string[];
  /** What it needs there ("an account with Red Eléctrica"). */
  note?: Localized;
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

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
import type { Localized } from './i18n.ts';
import type { Field, Infer, ObjectField } from './schema.ts';
import type { Theme } from './theme.ts';

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

/** What every context has. */
export interface BaseContext {
  now: number;
  /** BCP-47 language of the user (`es`, `en-GB`…). */
  locale: string;
  /** Picks the user's language from a `Localized` text. */
  t: (text: Localized) => string;
  log: Logger;
  /** Where the plugin may keep files (caches, downloads). Created on demand. */
  dataDir: string;
  /** User's place, if set in the settings (weather, sun, earthquakes…). */
  location?: { latitude: number; longitude: number; name?: string };
}

export interface FetchContext<O> extends BaseContext {
  options: O;
  canvas: CanvasApi;
  /** Aborted when the widget is removed or the app stops. */
  signal: AbortSignal;
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
  /** Frame index while an animation requested with `animate` is running. */
  frame?: number;
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
  /** Paint. Synchronous and fast: load images in `fetch` and paint them here. */
  render: (g: Graphics, ctx: RenderContext<Infer<OF>, D>) => void;
  /** Also a function, when the cadence depends on the options or the data (a carousel every `rotateMs`). */
  redraw?: Redraw | ((ctx: StateContext<Infer<OF>, D>) => Redraw);
  /** Has nothing to show right now (nothing playing, no rain): skipped in its cell's rotation. */
  visible?: (ctx: StateContext<Infer<OF>, D>) => boolean;
  /** Needs the user now (a meeting about to start): takes its cell over while true. */
  urgent?: (ctx: StateContext<Infer<OF>, D>) => boolean;
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
  signal: AbortSignal;
}

export interface SourceDefinition<OF extends ObjectField<any> = ObjectField<any>, D = unknown> {
  /** Unique inside its plugin. Widgets ask for `plugin/source`. */
  id: string;
  name: Localized;
  description?: Localized;
  /** Global options, edited once in Settings → Sources. */
  options?: OF;
  /** Polled every `intervalMs` while some widget uses it. */
  read?: (ctx: SourceContext<Infer<OF>>) => Promise<D>;
  intervalMs?: number;
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

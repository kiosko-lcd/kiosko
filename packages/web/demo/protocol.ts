/**
 * What the editor (src/demo/) asks the in-browser runtime (renderer.ts),
 * and what the runtime tells it unprompted. In a Web Worker each call is a
 * message; in the page (fallback) it is a plain method call.
 *
 * Types (and a name) only: the editor bundle must not pull the runtime in.
 */
import type { Config, Screen } from '@kiosko/core/model';
import type { AppState, FrameEvent, Status } from '../src/api.ts';

export interface LogEntry {
  at: number;
  scope: string;
  message: string;
}

/** The parts of the server's /api/state that come from the runtime. */
export type RuntimeState = Pick<AppState, 'version' | 'locale' | 'catalog' | 'categories' | 'themes' | 'presets' | 'status' | 'official'>;

export interface PreviewResult {
  blob: Blob;
  tiles: { id: string; shown: string | null; error?: string }[];
}

/** What one panel of the 3D page (panel3d/) shows: see stage.ts. */
export interface StageChannel {
  /** The panel it feeds: any id, echoed in its frames. */
  id: string;
  /** Screen of the current config whose pages it shows (the first one if missing). */
  screenId?: string;
  /** Pages to show, by id or name, in this order, taking turns; none = every enabled page. */
  pages?: string[];
  /** How long each page stays. Default 15 s. */
  pageMs?: number;
  /** A widget alone, filling the panel, instead of pages. */
  widget?: { type: string; options?: Record<string, unknown>; title?: string; chrome?: 'auto' | 'card' | 'bare'; /** 0.5-2; by default, what fills the panel best. */ zoom?: number };
  /** Time between the animations of the page's widgets, a random one in the range. Default 6-12 s. */
  animateMs?: [number, number];
  /** When the first animation is asked for. Default 3 s. */
  firstAnimationMs?: number;
  /** Time between the screen's interludes; 0 or missing = none. */
  interludeMs?: number;
}

/** A frame for a panel of the 3D page. */
export interface StageFrame {
  channel: string;
  /** Counts up per channel. */
  seq: number;
  bitmap: ImageBitmap;
  /** Name of the page it is a frame of. */
  page: string;
  /** A still page, a frame of a widget's animation, or of an interlude. */
  kind: 'page' | 'animation' | 'interlude';
  /** The widget type and plan animating, or the interlude's type. */
  what: string | null;
}

export interface RendererApi {
  /** Loads fonts and plugins and starts from `stored` (or the showcase, if null or broken). */
  init(stored: unknown): Promise<{ config: Config; fromShowcase: boolean }>;
  /** Normalizes and applies a config, as the server does on save. */
  apply(config: unknown): Promise<Config>;
  state(): Promise<RuntimeState>;
  preview(screen: Screen, pageId: string, forceShown?: Record<string, string>, demo?: boolean): Promise<PreviewResult>;
  thumbnail(type: string, width: number, height: number, look?: { theme?: string; locale?: string }): Promise<Blob>;
  pin(screenId: string, pageId: string | null): Promise<void>;
  logs(): Promise<LogEntry[]>;
  /** Paints these channels continuously, as `stage` events, until called again (none = stop). */
  stage(channels: StageChannel[]): Promise<void>;
}

/** Where the editor on tour (src/demo/tour.ts) says what it is editing, and takes `play` and `pause`: a BroadcastChannel. */
export const TOUR_CHANNEL = 'kiosko.tour';

/** What the tour tells whoever shows its page elsewhere (the front page's panel). */
export interface TourMessage {
  type: 'config';
  config: unknown;
  screenId: string;
  pageId: string;
}

export type RendererEvent = { name: 'frame'; data: FrameEvent } | { name: 'status'; data: Status } | { name: 'log'; data: LogEntry } | { name: 'stage'; data: StageFrame };

/** Worker → page messages. */
export type FromWorker =
  | { ready: true }
  | { unsupported: string }
  | { id: number; result: unknown }
  | { id: number; error: string }
  | { event: RendererEvent };

/** Page → worker messages. */
export interface ToWorker {
  id: number;
  method: keyof RendererApi;
  args: unknown[];
}

/**
 * What the editor (src/demo/) asks the in-browser runtime (renderer.ts),
 * and what the runtime tells it unprompted. In a Web Worker each call is a
 * message; in the page (fallback) it is a plain method call.
 *
 * Types only: the editor bundle must not pull the runtime in.
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
}

export type RendererEvent = { name: 'frame'; data: FrameEvent } | { name: 'status'; data: Status } | { name: 'log'; data: LogEntry };

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

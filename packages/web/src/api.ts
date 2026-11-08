/** Thin client of the Tessera server API. */
import type { Config, Screen } from '@tessera/core/model';

export interface WidgetInfo {
  type: string;
  name: string;
  description: string;
  icon?: string;
  category: string;
  tags: string[];
  size: { min?: { w: number; h: number }; preferred?: { w: number; h: number }; max?: { w: number; h: number } };
  chrome: 'card' | 'bare';
  options: JsonSchema | null;
  sources: string[];
  hasFetch: boolean;
  intervalMs: number | null;
}

export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  author?: string;
  homepage?: string;
  icon?: string;
  builtin: boolean;
  origin: string;
  enabled: boolean;
  widgets: WidgetInfo[];
  sources: { type: string; name: string; description: string; options: JsonSchema | null; intervalMs: number | null }[];
  interludes: { type: string; name: string; description: string; icon?: string; fps: number; options: JsonSchema | null }[];
}

export interface JsonSchema {
  type?: string;
  default?: unknown;
  enum?: string[];
  minimum?: number;
  maximum?: number;
  maxItems?: number;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  additionalProperties?: unknown;
  format?: string;
  'x-ui'?: {
    label?: string | Record<string, string>;
    help?: string | Record<string, string>;
    advanced?: boolean;
    secret?: boolean;
    multiline?: boolean;
    placeholder?: string;
    format?: string;
    unit?: string;
    step?: number;
    slider?: boolean;
    widget?: string;
    labels?: Record<string, string | Record<string, string>>;
  };
}

export interface ThemeInfo {
  id: string;
  name: string;
  colors: Record<string, string>;
  radius: number;
}

export interface Status {
  screens: { id: string; name: string; page: string | null; pinned: string | null; interlude: string | null; device: { driver: string; ok: boolean; message: string; framesSent: number; lastSentAt: number | null; detected?: { width: number; height: number } }; lastFrameAt: number | null; sleeping: boolean }[];
  sources: { type: string; ok: boolean; error: string | null; updatedAt: number | null }[];
  fetches: { id: string; type: string; ok: boolean; error: string | null; updatedAt: number | null }[];
  problems: { origin: string; message: string }[];
}

export interface AppState {
  version: string;
  locale: string;
  config: Config;
  catalog: PluginInfo[];
  categories: { id: string; label: string | Record<string, string> }[];
  themes: ThemeInfo[];
  presets: { id: string; name: string; width: number; height: number }[];
  status: Status;
  paths: { config: string; plugins: string; home: string };
  restartNeeded: boolean;
  demo: boolean;
  platform: string;
}

const H = { 'content-type': 'application/json', 'x-tessera': '1' };

async function ok<T>(r: Response): Promise<T> {
  if (!r.ok) {
    let msg = `${r.status}`;
    try {
      msg = ((await r.json()) as { error?: string }).error ?? msg;
    } catch {
      /* not json */
    }
    throw new Error(msg);
  }
  return (await r.json()) as T;
}

export const api = {
  state: () => fetch('/api/state').then((r) => ok<AppState>(r)),
  saveConfig: (config: Config) => fetch('/api/config', { method: 'PUT', headers: H, body: JSON.stringify(config) }).then((r) => ok<{ ok: true; config: Config }>(r)),
  async preview(screen: Screen, pageId: string, forceShown?: Record<string, string>, demo = true): Promise<{ url: string; tiles: { id: string; shown: string | null; error?: string }[] }> {
    const r = await fetch('/api/preview', { method: 'POST', headers: H, body: JSON.stringify({ screen, pageId, forceShown, demo }) });
    if (!r.ok) throw new Error(`preview ${r.status}`);
    const tiles = JSON.parse(decodeURIComponent(r.headers.get('x-tessera-tiles') ?? '%5B%5D'));
    return { url: URL.createObjectURL(await r.blob()), tiles };
  },
  thumbnailUrl: (type: string, w: number, h: number, v = '') => `/api/thumbnail?type=${encodeURIComponent(type)}&w=${Math.round(w)}&h=${Math.round(h)}&v=${encodeURIComponent(v)}`,
  liveFrameUrl: (screenId: string, at: number) => `/api/screens/${encodeURIComponent(screenId)}/frame.png?at=${at}`,
  pin: (screenId: string, pageId: string | null) => fetch(`/api/screens/${encodeURIComponent(screenId)}/pin`, { method: 'POST', headers: H, body: JSON.stringify({ pageId }) }).then((r) => ok(r)),
  playInterlude: (screenId: string, slotId: string) => fetch(`/api/screens/${encodeURIComponent(screenId)}/interlude`, { method: 'POST', headers: H, body: JSON.stringify({ slotId }) }).then((r) => ok(r)),
  refreshWidget: (id: string) => fetch(`/api/widgets/${encodeURIComponent(id)}/refresh`, { method: 'POST', headers: H, body: '{}' }).then((r) => ok(r)),
  discover: (url?: string) => fetch(`/api/devices/discover${url ? `?url=${encodeURIComponent(url)}` : ''}`).then((r) => ok<{ trcc: { key: string; width: number; height: number }[] }>(r)),
  logs: () => fetch('/api/logs').then((r) => ok<{ at: number; scope: string; message: string }[]>(r)),
  install: (name: string) => fetch('/api/plugins/install', { method: 'POST', headers: H, body: JSON.stringify({ name }) }).then((r) => ok<{ ok: boolean; output: string; restartNeeded: boolean }>(r)),
  setPluginEnabled: (id: string, enabled: boolean) => fetch(`/api/plugins/${encodeURIComponent(id)}/enabled`, { method: 'POST', headers: H, body: JSON.stringify({ enabled }) }).then((r) => ok<AppState>(r)),
};

export interface FrameEvent {
  screenId: string;
  pageId: string | null;
  at: number;
  interlude: string | null;
  sleeping: boolean;
}

/** Server-sent events, reconnecting on their own. */
export function connectEvents(h: { frame?: (e: FrameEvent) => void; log?: (e: { at: number; scope: string; message: string }) => void; status?: (s: Status) => void; online?: (on: boolean) => void }): () => void {
  let es: EventSource | null = null;
  let closed = false;
  const open = () => {
    es = new EventSource('/api/events');
    es.addEventListener('hello', () => h.online?.(true));
    es.addEventListener('frame', (e) => h.frame?.(JSON.parse((e as MessageEvent).data)));
    es.addEventListener('log', (e) => h.log?.(JSON.parse((e as MessageEvent).data)));
    es.addEventListener('status', (e) => h.status?.(JSON.parse((e as MessageEvent).data)));
    es.onerror = () => {
      h.online?.(false);
      es?.close();
      if (!closed) setTimeout(open, 2000);
    };
  };
  open();
  return () => {
    closed = true;
    es?.close();
  };
}

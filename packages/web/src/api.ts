/** Thin client of the Kiosko server API. */
import type { Config, Screen } from '@kiosko/core/model';

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
  /** Default of the "keep the tile while urgent" switch; null when the widget is never urgent. */
  takeOver: boolean | null;
  /** Default of the "hide when empty" switch; null when the widget can't tell it's empty. */
  hideWhenEmpty: boolean | null;
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
  /** `options` include Kiosko's `intervalMs` and `timeoutMs` for polled sources. */
  sources: { type: string; name: string; description: string; options: JsonSchema | null; intervalMs: number | null; polled: boolean }[];
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
  /** A list of `matchFilter` patterns. */
  'x-filter'?: boolean;
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
  sources: { type: string; ok: boolean; error: string | null; updatedAt: number | null; intervalMs?: number }[];
  fetches: { id: string; type: string; ok: boolean; error: string | null; updatedAt: number | null }[];
  problems: { origin: string; message: string }[];
}

export interface AppState {
  version: string;
  rev: number;
  locale: string;
  config: Config;
  catalog: PluginInfo[];
  categories: { id: string; label: string | Record<string, string> }[];
  themes: ThemeInfo[];
  presets: { id: string; name: string; width: number; height: number }[];
  status: Status;
  paths: { config: string; plugins: string; home: string };
  restartNeeded: boolean;
  official: { id: string; npm: string }[];
  demo: boolean;
  platform: string;
}

const H = { 'content-type': 'application/json', 'x-kiosko': '1' };
/** Identifies this tab, so it can ignore the "config changed" echo of its own saves. */
export const CLIENT_ID = Math.random().toString(36).slice(2, 10);

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
  async saveConfig(config: Config, baseRev: number): Promise<{ ok: true; rev: number } | { conflict: true; rev: number; config: Config }> {
    const r = await fetch('/api/config', { method: 'PUT', headers: { ...H, 'x-kiosko-client': CLIENT_ID }, body: JSON.stringify({ config, baseRev }) });
    if (r.status === 409) {
      const b = (await r.json()) as { rev: number; config: Config };
      return { conflict: true, rev: b.rev, config: b.config };
    }
    return ok<{ ok: true; rev: number }>(r);
  },
  async preview(screen: Screen, pageId: string, forceShown?: Record<string, string>, demo = true): Promise<{ url: string; tiles: { id: string; shown: string | null; error?: string }[] }> {
    const r = await fetch('/api/preview', { method: 'POST', headers: H, body: JSON.stringify({ screen, pageId, forceShown, demo }) });
    if (!r.ok) throw new Error(`preview ${r.status}`);
    const tiles = JSON.parse(decodeURIComponent(r.headers.get('x-kiosko-tiles') ?? '%5B%5D'));
    return { url: URL.createObjectURL(await r.blob()), tiles };
  },
  thumbnailUrl: (type: string, w: number, h: number, look: { theme?: string; locale?: string } = {}) =>
    `/api/thumbnail?type=${encodeURIComponent(type)}&w=${Math.round(w)}&h=${Math.round(h)}&theme=${encodeURIComponent(look.theme ?? '')}&locale=${encodeURIComponent(look.locale ?? '')}`,
  liveFrameUrl: (screenId: string, at: number) => `/api/screens/${encodeURIComponent(screenId)}/frame.jpg?at=${at}`,
  pin: (screenId: string, pageId: string | null) => fetch(`/api/screens/${encodeURIComponent(screenId)}/pin`, { method: 'POST', headers: H, body: JSON.stringify({ pageId }) }).then((r) => ok(r)),
  playInterlude: (screenId: string, slotId: string) => fetch(`/api/screens/${encodeURIComponent(screenId)}/interlude`, { method: 'POST', headers: H, body: JSON.stringify({ slotId }) }).then((r) => ok(r)),
  refreshWidget: (id: string) => fetch(`/api/widgets/${encodeURIComponent(id)}/refresh`, { method: 'POST', headers: H, body: '{}' }).then((r) => ok(r)),
  discover: (url?: string) => fetch(`/api/devices/discover${url ? `?url=${encodeURIComponent(url)}` : ''}`).then((r) => ok<{ trcc: { key: string; width: number; height: number }[]; usb: { serial: string; key: string; width: number; height: number; location: string; error?: string }[] }>(r)),
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
export function connectEvents(h: { config?: (e: { rev: number; by: string | null }) => void; frame?: (e: FrameEvent) => void; log?: (e: { at: number; scope: string; message: string }) => void; status?: (s: Status) => void; online?: (on: boolean) => void }): () => void {
  let es: EventSource | null = null;
  let closed = false;
  const open = () => {
    es = new EventSource('/api/events');
    es.addEventListener('hello', () => h.online?.(true));
    es.addEventListener('frame', (e) => h.frame?.(JSON.parse((e as MessageEvent).data)));
    es.addEventListener('config', (e) => h.config?.(JSON.parse((e as MessageEvent).data)));
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

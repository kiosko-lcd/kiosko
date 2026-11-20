/** Thin client of the Kiosko server API. */
import type { Config, Screen } from '@kiosko/core/model';
import { ApiError } from './errors.ts';

export interface WidgetInfo {
  type: string;
  name: string;
  description: string;
  icon?: string;
  category: string;
  tags: string[];
  /** Name and description in every language the plugin has (search). */
  searchText?: string;
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

/** What a plugin declares it does on the machine (see the SDK's `Permissions`). */
export interface PluginPermissions {
  network?: string[];
  exec?: string[];
  files?: string[];
  devices?: string[];
}

export interface TemplateTileInfo {
  x: number;
  y: number;
  w: number;
  h: number;
  widgets: (string | [string, Record<string, unknown>])[];
  chrome?: 'card' | 'bare';
}

/** A newer version of an installed plugin: `version` is what Update installs; `blocked`, why `latest` can't be. */
export interface PluginUpdate {
  id: string;
  package: string;
  current: string;
  latest: string;
  version?: string;
  blocked?: string;
}

export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  author?: string;
  homepage?: string;
  repository?: string;
  license?: string;
  icon?: string;
  /** Plugin API range it is written for, if it says. */
  sdk: string | null;
  platforms: string[] | null;
  languages: string[];
  permissions: PluginPermissions;
  /** What it needs from other plugins and whether that is here. */
  requires: { type: string; plugin: string; ok: boolean }[];
  /** What it uses from other plugins when they are there. */
  optional: { type: string; plugin: string; ok: boolean }[];
  /** Page templates it offers, with full widget types. */
  templates: { id: string; name: string; icon: string; wide: TemplateTileInfo[]; square?: TemplateTileInfo[] | undefined; tall?: TemplateTileInfo[] | undefined }[];
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
    /** Values to offer, from a source's live data (`GET /api/choices`). */
    choices?: { source: string; list: string };
  };
}

export interface ThemeInfo {
  id: string;
  name: string;
  colors: Record<string, string>;
  radius: number;
}

export interface Status {
  screens: { id: string; name: string; page: string | null; pinned: string | null; interlude: string | null; device: { driver: string; ok: boolean; message: string; code?: string; params?: Record<string, string | number>; framesSent: number; lastSentAt: number | null; detected?: { width: number; height: number; rotate?: number } }; lastFrameAt: number | null; sleeping: boolean }[];
  sources: { type: string; ok: boolean; error: string | null; updatedAt: number | null; intervalMs?: number }[];
  fetches: { id: string; type: string; ok: boolean; error: string | null; updatedAt: number | null }[];
  /** How long each widget instance takes to paint on the panels, slowest first. */
  paint?: { instance: string; type: string; lastMs: number; avgMs: number; maxMs: number; paints: number }[];
  problems: { origin: string; message: string }[];
  /** Kiosko as a device in Home Assistant, over MQTT. */
  homeassistant?: { enabled: boolean; state: 'off' | 'connecting' | 'connected' | 'error' | 'closed'; error: string | null; broker?: string };
}

export interface AppState {
  version: string;
  rev: number;
  locale: string;
  config: Config;
  catalog: PluginInfo[];
  /** Plugins found but not loaded: they don't fit this Kiosko (plugin API, operating system). */
  refused: { id?: string; version?: string; origin: string; reason: string }[];
  /** Newer versions on npm, from the last daily check (null before it, and in the demo). */
  updates?: { checkedAt: number; plugins: PluginUpdate[]; kiosko: { current: string; latest: string } | null } | null;
  categories: { id: string; label: string | Record<string, string> }[];
  themes: ThemeInfo[];
  presets: { id: string; name: string; width: number; height: number }[];
  status: Status;
  paths: { config: string; plugins: string; home: string };
  restartNeeded: boolean;
  /** `bundled: false`: offered here, not installed with Kiosko. */
  official: { id: string; npm: string; bundled?: boolean }[];
  demo: boolean;
  platform: string;
}

const H = { 'content-type': 'application/json', 'x-kiosko': '1' };
/** Identifies this tab, so it can ignore the "config changed" echo of its own saves. */
export const CLIENT_ID = Math.random().toString(36).slice(2, 10);

async function ok<T>(r: Response): Promise<T> {
  if (!r.ok) {
    let body: { error?: string; code?: string; params?: Record<string, string | number> } = {};
    try {
      body = (await r.json()) as typeof body;
    } catch {
      /* not json */
    }
    throw new ApiError(body.error ?? `${r.status}`, body.code, body.params);
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
  async preview(screen: Screen, pageId: string, forceShown?: Record<string, string>, demo = true): Promise<{ url: string; tiles: { id: string; shown: string | null; error?: string; cjkEnlarged?: number }[] }> {
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
  discover: (url?: string) => fetch(`/api/devices/discover${url ? `?url=${encodeURIComponent(url)}` : ''}`).then((r) => ok<{ trcc: { key: string; width: number; height: number }[]; usb: { serial: string; key: string; width: number; height: number; rotate?: number; location: string; error?: string }[] }>(r)),
  logs: () => fetch('/api/logs').then((r) => ok<{ at: number; scope: string; message: string }[]>(r)),
  /** Values a source offers for an option, from its live data (or its demo data before there is any). */
  choices: (source: string, list: string) => fetch(`/api/choices?source=${encodeURIComponent(source)}&list=${encodeURIComponent(list)}`).then((r) => ok<{ choices: { value: string; label?: string; group?: string }[]; from: 'live' | 'demo' | 'none'; error?: string }>(r)),
  install: (name: string) => fetch('/api/plugins/install', { method: 'POST', headers: H, body: JSON.stringify({ name }) }).then((r) => ok<{ ok: boolean; output: string; ids: string[]; problem: string | null; restartNeeded: boolean; state: AppState }>(r)),
  /** Installs the newest version of a plugin that fits this Kiosko. */
  updatePlugin: (id: string) => fetch(`/api/plugins/${encodeURIComponent(id)}/update`, { method: 'POST', headers: H }).then((r) => ok<{ ok: boolean; problem: string | null; rolledBack: boolean; addedPermissions: PluginPermissions | null; version: string; state: AppState }>(r)),
  /** Asks npm now instead of waiting for the daily check. */
  checkUpdates: () => fetch('/api/plugins/updates?refresh=1').then((r) => ok<unknown>(r)),
  removePlugin: (id: string) => fetch(`/api/plugins/${encodeURIComponent(id)}`, { method: 'DELETE', headers: H }).then((r) => ok<AppState>(r)),
  reloadPlugin: (id: string) => fetch(`/api/plugins/${encodeURIComponent(id)}/reload`, { method: 'POST', headers: H }).then((r) => ok<AppState>(r)),
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

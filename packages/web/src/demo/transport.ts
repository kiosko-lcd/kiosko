/**
 * Browser demo only: the editor's API (same exports as ../api.ts, which
 * the demo build swaps for this file) with no server behind it. The
 * runtime paints in the browser (client.ts); the config lives in this
 * browser's localStorage, with a revision number so two tabs of the demo
 * behave like two tabs of the real editor (the second save gets a
 * conflict and reloads).
 */
import type { Config, Screen } from '@kiosko/core/model';
import type { AppState, Status, api as httpApi, connectEvents as httpConnectEvents } from '../api.ts';
import { DEMO_CONFIG_KEY, type RendererApi, type RendererEvent } from '../../demo/protocol.ts';
import { onRendererEvent, renderMode, renderer } from './client.ts';

export type { AppState, FrameEvent, JsonSchema, PluginInfo, Status, ThemeInfo, WidgetInfo } from '../api.ts';

/** localStorage key of the demo's config ({ rev, config }). */
export const STORAGE_KEY = DEMO_CONFIG_KEY;

// Top-level values are marked pure: the normal build reaches this module
// (through ui.tsx) and must be able to drop all of it.
export const CLIENT_ID = /* @__PURE__ */ (() => Math.random().toString(36).slice(2, 10))();

interface Saved {
  rev: number;
  config: Config;
}

/**
 * On tour (`?tour=1`, the front page's editor on autopilot, see tour.ts) nothing is read or kept:
 * it starts from the sample screens every time and never touches what the visitor made.
 */
const TOUR = /* @__PURE__ */ (() => typeof location !== 'undefined' && new URLSearchParams(location.search).has('tour'))();

function readSaved(): Saved | null {
  if (TOUR) return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const v = raw ? (JSON.parse(raw) as Saved) : null;
    return v && typeof v.rev === 'number' && v.config && typeof v.config === 'object' ? v : null;
  } catch {
    return null;
  }
}

function writeSaved(s: Saved): void {
  if (TOUR) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* private mode or full: the demo still works, it just won't remember */
  }
}

/** Forgets the visitor's changes; the next load starts from the showcase again. */
export function resetDemo(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* nothing stored */
  }
  location.reload();
}

type Handlers = Parameters<typeof httpConnectEvents>[0];
const handlers = /* @__PURE__ */ new Set<Handlers>();
let current: Saved | null = null;
let started: Promise<RendererApi> | null = null;

function emitConfig(rev: number, by: string | null): void {
  for (const h of handlers) h.config?.({ rev, by });
}

function onEvent(e: RendererEvent): void {
  for (const h of handlers) {
    if (e.name === 'frame') h.frame?.(e.data);
    else if (e.name === 'status') h.status?.(e.data as Status);
    else if (e.name === 'log') h.log?.(e.data);
    // 'stage' frames are for the 3D page (panel3d/), which listens by itself.
  }
}

/** Starts the runtime once, from what this browser saved (or the showcase). */
function start(): Promise<RendererApi> {
  started ??= (async () => {
    onRendererEvent(onEvent);
    const r = await renderer();
    const saved = readSaved();
    const { config } = await r.init(saved?.config ?? null);
    current = { rev: saved?.rev ?? 1, config };
    // Another tab of the demo saved: follow it, as the real editor follows the server.
    addEventListener('storage', (e) => {
      if (e.key !== STORAGE_KEY) return;
      const s = readSaved();
      if (!s || !current || s.rev === current.rev) return;
      current = s;
      void r.apply(s.config).then(() => emitConfig(s.rev, null));
    });
    return r;
  })();
  return started;
}

async function state(): Promise<AppState> {
  const r = await start();
  const s = await r.state();
  const es = s.locale.toLowerCase().startsWith('es');
  return {
    ...s,
    rev: current!.rev,
    config: current!.config,
    paths: {
      config: es ? `localStorage de este navegador («${STORAGE_KEY}»)` : `this browser's localStorage ("${STORAGE_KEY}")`,
      plugins: es ? 'incluidos en la demo' : 'bundled with the demo',
      home: '',
    },
    restartNeeded: false,
    demo: true,
    platform: `browser · ${renderMode === 'worker' ? 'Web Worker' : 'page'}`,
  };
}

/** Saves `config` as a new revision (the server's PUT /api/config). */
async function save(config: Config, by: string | null): Promise<number> {
  const r = await start();
  const normalized = await r.apply(config);
  const rev = Math.max(current!.rev, readSaved()?.rev ?? 0) + 1;
  current = { rev, config: normalized };
  writeSaved(current);
  emitConfig(rev, by);
  return rev;
}

const notHere = () => new Error('Installing plugins needs Kiosko running on your computer (see the README). / Instalar plugins necesita Kiosko en tu ordenador (mira el README).');

export const api: typeof httpApi = {
  state,
  async saveConfig(config: Config, baseRev: number) {
    await start();
    const saved = readSaved();
    const rev = Math.max(current!.rev, saved?.rev ?? 0);
    if (baseRev !== rev) return { conflict: true as const, rev, config: saved?.config ?? current!.config };
    return { ok: true as const, rev: await save(config, CLIENT_ID) };
  },
  async preview(screen: Screen, pageId: string, forceShown?: Record<string, string>, demo = true) {
    const r = await start();
    const { blob, tiles } = await r.preview(screen, pageId, forceShown, demo);
    return { url: URL.createObjectURL(blob), tiles };
  },
  // Synchronous URLs of the HTTP API: the demo UI uses thumbnail() (ui.tsx) and never shows live frames.
  thumbnailUrl: () => '',
  liveFrameUrl: () => '',
  pin: async (screenId: string, pageId: string | null) => {
    await (await start()).pin(screenId, pageId);
    return { ok: true };
  },
  playInterlude: async () => ({ ok: true }),
  refreshWidget: async () => ({ ok: true }),
  discover: async () => ({ trcc: [], usb: [] }),
  logs: async () => (await start()).logs(),
  install: async () => {
    throw notHere();
  },
  async setPluginEnabled(id: string, enabled: boolean) {
    await start();
    const cfg = JSON.parse(JSON.stringify(current!.config)) as Config;
    const disabled = new Set(cfg.plugins.disabled);
    if (enabled) disabled.delete(id);
    else disabled.add(id);
    cfg.plugins = { disabled: [...disabled] };
    await save(cfg, null);
    return state();
  },
};

/** A widget painted alone with its sample data, as an object URL (GET /api/thumbnail). */
const thumbs = /* @__PURE__ */ new Map<string, Promise<string>>();
export function thumbnail(type: string, w: number, h: number, look: { theme?: string; locale?: string } = {}): Promise<string> {
  const key = `${type}|${Math.round(w)}x${Math.round(h)}|${look.theme ?? ''}|${look.locale ?? ''}`;
  let p = thumbs.get(key);
  if (!p) {
    p = start()
      .then((r) => r.thumbnail(type, w, h, look))
      .then((b) => URL.createObjectURL(b));
    p.catch(() => thumbs.delete(key));
    thumbs.set(key, p);
  }
  return p;
}

/** The current config of a screen as an export file (GET /api/screens/export). */
export function exportScreen(id: string): void {
  const s = current?.config.screens.find((x) => x.id === id);
  if (!s) return;
  const blob = new Blob([JSON.stringify({ kiosko: 'screen', version: 1, screen: { ...s, device: { driver: 'virtual' } } }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `kiosko-${id}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Server-sent events, here straight from the runtime. Always "online". */
export function connectEvents(h: Handlers): () => void {
  handlers.add(h);
  queueMicrotask(() => h.online?.(true));
  return () => handlers.delete(h);
}

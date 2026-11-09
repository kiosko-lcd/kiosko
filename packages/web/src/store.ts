/**
 * Editor state, as Preact signals. The config is edited as a whole object:
 * every change goes through `edit`, which records undo history and saves to
 * the server shortly after (debounced), so there's no "Save" button to forget.
 */
import { batch, computed, signal } from '@preact/signals';
import type { Config, Page, Screen, Tile, WidgetInstance } from '@tessera/core/model';
import { CLIENT_ID, api, connectEvents, type AppState, type FrameEvent, type PluginInfo, type Status, type WidgetInfo } from './api.ts';

export type View = 'editor' | 'screens' | 'plugins' | 'settings' | 'logs';

export const app = signal<AppState | null>(null);
export const config = signal<Config | null>(null);
export const status = signal<Status | null>(null);
export const online = signal(true);
export const view = signal<View>(readView());
export const screenId = signal<string | null>(null);
export const pageId = signal<string | null>(null);
export const selectedTile = signal<string | null>(null);
/** Widget instance selected inside the selected tile's stack. */
export const selectedWidget = signal<string | null>(null);
export const saving = signal<'idle' | 'pending' | 'saving' | 'saved' | 'error'>('idle');
export const saveError = signal<string | null>(null);
export const lastFrame = signal<Record<string, FrameEvent>>({});
export const logs = signal<{ at: number; scope: string; message: string }[]>([]);
export const toast = signal<{ text: string; kind: 'info' | 'error' | 'ok'; at: number } | null>(null);
/** UI theme of the editor itself (not the panel's). */
export const uiTheme = signal<'dark' | 'light'>(readUiTheme());
export const showGrid = signal(true);
export const liveMode = signal(false);

function readView(): View {
  const h = location.hash.replace('#/', '').split('/')[0];
  return (['editor', 'screens', 'plugins', 'settings', 'logs'] as View[]).includes(h as View) ? (h as View) : 'editor';
}
function readUiTheme(): 'dark' | 'light' {
  try {
    const v = localStorage.getItem('tessera.ui');
    if (v === 'dark' || v === 'light') return v;
  } catch {
    /* private mode */
  }
  return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}
export function setUiTheme(t: 'dark' | 'light'): void {
  uiTheme.value = t;
  document.documentElement.dataset.theme = t;
  try {
    localStorage.setItem('tessera.ui', t);
  } catch {
    /* ignore */
  }
}
export function go(v: View): void {
  view.value = v;
  location.hash = `#/${v}`;
}

export const locale = computed(() => {
  const l = config.value?.locale;
  return !l || l === 'auto' ? (app.value?.locale ?? navigator.language) : l;
});

export const widgets = computed(() => {
  const m = new Map<string, WidgetInfo & { plugin: PluginInfo }>();
  for (const p of app.value?.catalog ?? []) if (p.enabled) for (const w of p.widgets) m.set(w.type, { ...w, plugin: p });
  return m;
});

export const screen = computed<Screen | null>(() => config.value?.screens.find((s) => s.id === screenId.value) ?? config.value?.screens[0] ?? null);
export const page = computed<Page | null>(() => screen.value?.pages.find((p) => p.id === pageId.value) ?? screen.value?.pages[0] ?? null);
export const tile = computed<Tile | null>(() => page.value?.tiles.find((t) => t.id === selectedTile.value) ?? null);
export const widget = computed<WidgetInstance | null>(() => {
  const t = tile.value;
  if (!t) return null;
  return t.widgets.find((w) => w.id === selectedWidget.value) ?? t.widgets[0] ?? null;
});

export function notify(text: string, kind: 'info' | 'error' | 'ok' = 'info'): void {
  toast.value = { text, kind, at: Date.now() };
  setTimeout(() => {
    if (toast.value && Date.now() - toast.value.at >= 3900) toast.value = null;
  }, 4000);
}

// ---------- History and saving ----------

const past: string[] = [];
const future: string[] = [];
export const canUndo = signal(false);
export const canRedo = signal(false);
let saveTimer: ReturnType<typeof setTimeout> | null = null;
/** Server revision of the config this tab is editing. */
let rev = 0;

function scheduleSave(): void {
  saving.value = 'pending';
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const c = config.value;
    if (!c) return;
    saving.value = 'saving';
    try {
      const r = await api.saveConfig(c, rev);
      if ('conflict' in r) {
        // Someone else (another tab, a hand edit) saved first: take theirs.
        rev = r.rev;
        config.value = r.config;
        past.length = 0;
        future.length = 0;
        canUndo.value = false;
        canRedo.value = false;
        saving.value = 'idle';
        notify(locale.value.startsWith('es') ? 'La configuración cambió en otra pestaña: recargada.' : 'The configuration changed in another tab: reloaded.', 'error');
        return;
      }
      rev = r.rev;
      saving.value = 'saved';
      saveError.value = null;
    } catch (err) {
      saving.value = 'error';
      saveError.value = err instanceof Error ? err.message : String(err);
    }
  }, 500);
}

/**
 * Applies a change to a deep copy of the config. `mutate` may change the
 * draft in place. `coalesce` merges quick successive edits (typing in a
 * field) into one undo step.
 */
let lastCoalesce: { key: string; at: number } | null = null;
export function edit(mutate: (draft: Config) => void, coalesce?: string): void {
  const cur = config.value;
  if (!cur) return;
  const before = JSON.stringify(cur);
  const draft = JSON.parse(before) as Config;
  mutate(draft);
  const after = JSON.stringify(draft);
  if (after === before) return;
  const now = Date.now();
  const merge = coalesce && lastCoalesce && lastCoalesce.key === coalesce && now - lastCoalesce.at < 1500;
  if (!merge) {
    past.push(before);
    if (past.length > 100) past.shift();
  }
  lastCoalesce = coalesce ? { key: coalesce, at: now } : null;
  future.length = 0;
  canUndo.value = past.length > 0;
  canRedo.value = false;
  config.value = draft;
  scheduleSave();
}

export function undo(): void {
  const prev = past.pop();
  if (!prev || !config.value) return;
  future.push(JSON.stringify(config.value));
  config.value = JSON.parse(prev);
  canUndo.value = past.length > 0;
  canRedo.value = true;
  lastCoalesce = null;
  scheduleSave();
}
export function redo(): void {
  const next = future.pop();
  if (!next || !config.value) return;
  past.push(JSON.stringify(config.value));
  config.value = JSON.parse(next);
  canUndo.value = true;
  canRedo.value = future.length > 0;
  scheduleSave();
}

/** Helpers to find things inside a draft by id. */
export function draftScreen(d: Config, id = screen.value?.id): Screen | undefined {
  return d.screens.find((s) => s.id === id);
}
export function draftPage(d: Config, sid = screen.value?.id, pid = page.value?.id): Page | undefined {
  return draftScreen(d, sid)?.pages.find((p) => p.id === pid);
}
export function draftTile(d: Config, tid = selectedTile.value): Tile | undefined {
  return draftPage(d)?.tiles.find((t) => t.id === tid);
}

// ---------- Boot ----------

export async function boot(): Promise<void> {
  document.documentElement.dataset.theme = uiTheme.value;
  addEventListener('hashchange', () => (view.value = readView()));
  const s = await api.state();
  rev = s.rev;
  batch(() => {
    app.value = s;
    config.value = s.config;
    status.value = s.status;
    screenId.value = s.config.screens[0]?.id ?? null;
    pageId.value = s.config.screens[0]?.pages[0]?.id ?? null;
  });
  connectEvents({
    config: (e) => {
      if (e.by === CLIENT_ID || e.rev <= rev) return;
      // Changed elsewhere. With nothing pending here, follow it quietly.
      if (saving.value === 'pending' || saving.value === 'saving') return;
      void api.state().then((st) => {
        rev = st.rev;
        app.value = st;
        config.value = st.config;
      });
    },
    frame: (f) => (lastFrame.value = { ...lastFrame.value, [f.screenId]: f }),
    log: (e) => (logs.value = [...logs.value.slice(-299), e]),
    status: (st) => (status.value = st),
    online: (on) => (online.value = on),
  });
  api.logs().then((l) => (logs.value = l)).catch(() => undefined);
}

/** Reloads the catalogue (after enabling a plugin), keeping local edits. */
export async function reloadState(): Promise<void> {
  const s = await api.state();
  app.value = s;
  status.value = s.status;
}

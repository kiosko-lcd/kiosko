/** Thin client of the Kiosko server API. */
import type { Config, Screen } from '@kiosko/core/model';
import { ApiError } from './errors.ts';
import type { StoreIndex, StorePluginFile } from '@kiosko/core/store';

/** The plugin store as this Kiosko sees it (GET /api/store). */
export interface StoreState {
  index: StoreIndex | null;
  /** Where the catalogue came from: the copy that comes with Kiosko, the one kept, or just downloaded. */
  from: 'snapshot' | 'cache' | 'network' | 'none';
  fetchedAt: number | null;
  error: string | null;
  /** The catalogue's folder (https://kioskolcd.dev/store/v1/); pictures are relative to the site above it. */
  url: string;
  /** Whether Kiosko asks the site for a newer catalogue (off with KIOSKO_NO_UPDATE_CHECK=1). */
  online: boolean;
  sdk: string;
  platform: string;
  /** Plugins loaded now, by id, with their version. */
  installed: Record<string, string>;
}

/** What installing from the store answers. */
export interface StoreInstallResult {
  ok: boolean;
  ids: string[];
  problem: string | null;
  rolledBack: boolean;
  addedPermissions: PluginPermissions | null;
  version: string;
  restartNeeded: boolean;
  state: AppState;
}

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
  /** The newer Kiosko that `latest` would fit, when only this Kiosko's plugin API blocks it. */
  unlockedBy?: string;
}

/** A newer Kiosko on npm, with what is new in it (GitHub's release notes, or npm's versions). */
export interface KioskoUpdateInfo {
  current: string;
  latest: string;
  versions: string[];
  notes?: {
    from: 'github' | 'npm';
    releases: { version: string; name?: string; body?: string; truncated?: boolean; url: string; date?: string }[];
    error?: string;
    windows?: { name: string; exe: string; sha256: string };
  };
}

export type InstallKind = 'windows-installer' | 'npm-global' | 'npx' | 'source' | 'other';
export type UpdateStepCode = 'prefix' | 'install' | 'verify' | 'selfCheck' | 'rollback' | 'restart' | 'download' | 'hash' | 'launch';
export type RestartHow = 'systemd' | 'launchd' | 'handover' | 'manual' | 'installer';

/** "Update Kiosko"'s progress (see server's self-update.ts). */
export interface KioskoUpdateStatus {
  state: 'idle' | 'working' | 'ready' | 'restarting' | 'done' | 'failed';
  target: string | null;
  from: string;
  method: 'npm' | 'windows' | null;
  steps: { at: number; code: UpdateStepCode; ok: boolean | null; detail?: string }[];
  error: { code: string; detail: string } | null;
  rolledBack: boolean;
  restart: RestartHow | null;
  sha256: string | null;
  warnings: string[];
  logFile: string | null;
}

/** How this Kiosko was installed, what to do to update it, and whether its button can. */
export interface KioskoUpdateState {
  install: { kind: InstallKind; service: 'systemd' | 'launchd' | 'schtasks' | null; dir: string; perUser: boolean; platform: string };
  canUpdate: boolean;
  /** Why the button can't: the install kind, `npmWindows`, `demo`. */
  blocker: string | null;
  restart: RestartHow;
  instructions: { kind: InstallKind; version: string; command?: string; url: string; download?: string; stopFirst?: boolean } | null;
  status: KioskoUpdateStatus;
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
  /**
   * `options` include Kiosko's `intervalMs` and `timeoutMs` for polled sources, and `background` for those that may run with no widget.
   * `profiles`: it may have several named configurations (`Config.sourceProfiles`); missing from older servers.
   */
  sources: { type: string; name: string; description: string; options: JsonSchema | null; intervalMs: number | null; polled: boolean; background?: boolean; profiles?: boolean }[];
  /** `input`: it can be played from the Play page. */
  interludes: { type: string; name: string; description: string; icon?: string; fps: number; input?: boolean; options: JsonSchema | null }[];
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
    /** Keys to offer for a map, with their labels (a device's last reading): see MapField.keyChoices. */
    keyChoices?: { source: string; list: string };
  };
}

export interface ThemeInfo {
  id: string;
  name: string;
  colors: Record<string, string>;
  radius: number;
}

/** A Kiosko remote screen heard on the LAN (mDNS). */
export interface RemoteFound {
  uid: string;
  id: string;
  model: string;
  width: number;
  height: number;
  rotate: number;
  fw: string;
  paired: boolean;
  address: string;
  port: number;
  hostname: string;
}

/** A remote screen's link, as its driver sees it. */
export interface RemoteLink {
  online: boolean;
  id: string;
  host: string | null;
  fw: string;
  model: string;
  w: number;
  h: number;
  rot: number;
  fps: number;
  rttMs: number | null;
  decodeMs: number | null;
  lastFrameAt: number | null;
  dropped: number;
  since: number | null;
  /** The chip's temperature, °C (screen firmware 0.1.2 on). */
  tempC?: number | null;
  /** Its backlight, 0-100 (screen firmware 0.1.2 on; null: an older one). */
  bright?: number | null;
  /** The dimming Kiosko asks for now (night, a black screen), 0-100; null: none. */
  dim?: number | null;
  /** Whether its firmware dims (0.1.4 on); null until it says. */
  dimmable?: boolean | null;
  /** A newer firmware this Kiosko brings for it; null: none. */
  firmwareOffer?: string | null;
}

/** The context page that has a screen, and why (core's context.ts). */
export interface ContextInfo {
  page: string;
  reason: { label?: string; app?: string; source?: string; path?: string; value?: string; time?: string; urgent?: string };
  priority: number;
  since: number;
  /** Its rule stopped holding: it stays for the anti-flicker margin only. */
  leaving: boolean;
}

export interface Status {
  screens: { id: string; name: string; page: string | null; pinned: string | null; context?: ContextInfo | null; interlude: string | null; playing?: boolean; device: { driver: string; ok: boolean; message: string; code?: string; params?: Record<string, string | number>; framesSent: number; lastSentAt: number | null; detected?: { width: number; height: number; rotate?: number }; remote?: RemoteLink }; lastFrameAt: number | null; sleeping: boolean; alert?: string | null; frames?: ScreenFrames; thread?: ScreenThread }[];
  /** Painting in threads: the setting, the cores, the main thread's heap and the whole process' memory. */
  threads?: { mode: 'auto' | 'always' | 'never'; cores: number; heapBytes: number; rssBytes: number };
  /** How busy the main thread is (0–1). */
  mainLoad?: number;
  /** `key`: `type`, or `type#profile` for a source profile (missing from older servers). */
  sources: { type: string; key?: string; profile?: string | null; ok: boolean; error: string | null; updatedAt: number | null; intervalMs?: number }[];
  fetches: { id: string; type: string; ok: boolean; error: string | null; updatedAt: number | null }[];
  /** How long each widget instance takes to paint on the panels, slowest first. */
  paint?: { instance: string; type: string; lastMs: number; avgMs: number; maxMs: number; paints: number }[];
  problems: { origin: string; message: string }[];
  /** Kiosko as a device in Home Assistant, over MQTT. */
  homeassistant?: { enabled: boolean; state: 'off' | 'connecting' | 'connected' | 'error' | 'closed'; error: string | null; broker?: string };
  /** Push names (POST /api/push/<name>) and when each last got something. */
  push?: { name: string; at: number | null }[];
}

/** What a screen really does: frames sent per second, ms painting (on its thread) and encoding each one. */
export interface ScreenFrames {
  fps: number;
  paintMs: number;
  encodeMs: number;
  frames: number;
}

/** Where a screen is painted (see core's threads/plan.ts) and what its thread holds in memory. */
export interface ScreenThread {
  on: boolean;
  why: 'always' | 'never' | 'setting' | 'auto' | 'fewScreens' | 'fewCores' | 'off' | 'failed';
  error: string | null;
  heapBytes: number | null;
}

/** A full-screen alert (see core's alerts.ts). */
export interface AlertInfo {
  id: string;
  level: 'info' | 'warn' | 'critical';
  title: string;
  text: string;
  /** Who published it ("IGN", "NWS"). */
  source?: string;
  /** A second line: the authority's instruction. */
  detail?: string;
  icon?: string;
  origin: 'widget' | 'source' | 'api' | 'test';
  from?: string;
  since: number;
  expiresAt: number | null;
  dismissible: boolean;
  screens?: string[];
  snoozedUntil?: number;
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
  updates?: { checkedAt: number; plugins: PluginUpdate[]; kiosko: KioskoUpdateInfo | null } | null;
  /** Updating Kiosko itself (not in the demo). */
  kioskoUpdate?: KioskoUpdateState;
  categories: { id: string; label: string | Record<string, string> }[];
  themes: ThemeInfo[];
  presets: { id: string; name: string; width: number; height: number; maker?: string; tested?: boolean }[];
  status: Status;
  /** Active alerts, highest first (not in the demo). */
  alerts?: AlertInfo[];
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
  playInterlude: (screenId: string, slotId: string, play = false) => fetch(`/api/screens/${encodeURIComponent(screenId)}/interlude`, { method: 'POST', headers: H, body: JSON.stringify({ slotId, ...(play ? { play: true } : {}) }) }).then((r) => ok(r)),
  stopInterlude: (screenId: string) => fetch(`/api/screens/${encodeURIComponent(screenId)}/interlude`, { method: 'POST', headers: H, body: JSON.stringify({ stop: true }) }).then((r) => ok(r)),
  /** The Play page's buttons, for the interlude being played on that screen. */
  press: (screenId: string, events: { key: string; pressed: boolean }[]) => fetch(`/api/screens/${encodeURIComponent(screenId)}/input`, { method: 'POST', headers: H, body: JSON.stringify({ events }), keepalive: true }).then((r) => ok(r)),
  /** "Seen". */
  ackAlert: (id: string) => fetch(`/api/alerts/${encodeURIComponent(id)}/ack`, { method: 'POST', headers: H, body: '{}' }).then((r) => ok<{ ok: true; alerts: AlertInfo[] }>(r)),
  snoozeAlert: (id: string, minutes: number) => fetch(`/api/alerts/${encodeURIComponent(id)}/snooze`, { method: 'POST', headers: H, body: JSON.stringify({ minutes }) }).then((r) => ok<{ ok: true; alerts: AlertInfo[] }>(r)),
  /** How an alert looks on that screen, for a while. */
  testAlert: (screenId: string, level: AlertInfo['level']) => fetch(`/api/screens/${encodeURIComponent(screenId)}/test-alert`, { method: 'POST', headers: H, body: JSON.stringify({ level }) }).then((r) => ok<{ ok: true; alert: AlertInfo }>(r)),
  refreshWidget: (id: string) => fetch(`/api/widgets/${encodeURIComponent(id)}/refresh`, { method: 'POST', headers: H, body: '{}' }).then((r) => ok(r)),
  discover: (url?: string) => fetch(`/api/devices/discover${url ? `?url=${encodeURIComponent(url)}` : ''}`).then((r) => ok<{ trcc: { key: string; width: number; height: number }[]; usb: { serial: string; key: string; width: number; height: number; rotate?: number; location: string; error?: string }[]; remote?: RemoteFound[] }>(r)),
  /** Remote screens: the screen shows a code… */
  pairStart: (uid: string, host?: string) => fetch('/api/remote/pair', { method: 'POST', headers: H, body: JSON.stringify({ uid, ...(host ? { host } : {}) }) }).then((r) => ok<{ pairId: string; ttl: number; screen: { uid: string; id: string; model: string; w: number; h: number; rot: number; fw: string } }>(r)),
  /** …which is typed here: the key goes into that screen's config (or a new screen's). */
  pairFinish: (pairId: string, code: string, screenId?: string) => fetch(`/api/remote/pair/${pairId}`, { method: 'POST', headers: H, body: JSON.stringify({ code, ...(screenId ? { screenId } : {}) }) }).then((r) => ok<{ ok: true; screenId: string }>(r)),
  pairCancel: (pairId: string) => fetch(`/api/remote/pair/${pairId}`, { method: 'DELETE', headers: H }).then((r) => ok(r)),
  unpairRemote: (screenId: string) => fetch(`/api/screens/${encodeURIComponent(screenId)}/remote/unpair`, { method: 'POST', headers: H }).then((r) => ok<{ ok: true; told: boolean }>(r)),
  remoteOta: (screenId: string, image: Blob) => fetch(`/api/screens/${encodeURIComponent(screenId)}/remote/ota`, { method: 'POST', headers: { 'x-kiosko': '1', 'content-type': 'application/octet-stream' }, body: image }).then((r) => ok<{ ok: true }>(r)),
  remoteFirmware: (screenId: string) => fetch(`/api/screens/${encodeURIComponent(screenId)}/remote/firmware`, { method: 'POST', headers: { 'x-kiosko': '1' } }).then((r) => ok<{ ok: true; version: string; sha256: string }>(r)),
  remoteLogs: (screenId: string) => fetch(`/api/screens/${encodeURIComponent(screenId)}/remote/logs`).then((r) => ok<{ text: string }>(r)),
  logs: () => fetch('/api/logs').then((r) => ok<{ at: number; scope: string; message: string }[]>(r)),
  /** A source's data paths, each with a short value, for a context rule. */
  sourcePaths: (source: string) => fetch(`/api/source-paths?source=${encodeURIComponent(source)}`).then((r) => ok<{ paths: { path: string; value: string }[]; from: 'live' | 'demo' | 'none' }>(r)),
  /** Values a source offers for an option, from its live data (or its demo data before there is any); of the widget's source `profile`, if it reads one. */
  choices: (source: string, list: string, profile?: string) => fetch(`/api/choices?source=${encodeURIComponent(source)}&list=${encodeURIComponent(list)}${profile ? `&profile=${encodeURIComponent(profile)}` : ''}`).then((r) => ok<{ choices: { value: string; label?: string; group?: string }[]; from: 'live' | 'demo' | 'none'; error?: string }>(r)),
  install: (name: string) => fetch('/api/plugins/install', { method: 'POST', headers: H, body: JSON.stringify({ name }) }).then((r) => ok<{ ok: boolean; output: string; ids: string[]; problem: string | null; restartNeeded: boolean; state: AppState }>(r)),
  /** Installs the newest version of a plugin that fits this Kiosko. */
  updatePlugin: (id: string) => fetch(`/api/plugins/${encodeURIComponent(id)}/update`, { method: 'POST', headers: H }).then((r) => ok<{ ok: boolean; problem: string | null; rolledBack: boolean; addedPermissions: PluginPermissions | null; version: string; state: AppState }>(r)),
  /** Asks npm now instead of waiting for the daily check. */
  checkUpdates: () => fetch('/api/plugins/updates?refresh=1').then((r) => ok<unknown>(r)),
  removePlugin: (id: string) => fetch(`/api/plugins/${encodeURIComponent(id)}`, { method: 'DELETE', headers: H }).then((r) => ok<AppState>(r)),
  reloadPlugin: (id: string) => fetch(`/api/plugins/${encodeURIComponent(id)}/reload`, { method: 'POST', headers: H }).then((r) => ok<AppState>(r)),
  /** The plugin store's catalogue, with what this Kiosko is (system, plugin API) and has. */
  store: () => fetch('/api/store').then((r) => ok<StoreState>(r)),
  /** A plugin's full record in the store. */
  storePlugin: (id: string) => fetch(`/api/store/${encodeURIComponent(id)}`).then((r) => ok<StorePluginFile>(r)),
  refreshStore: () => fetch('/api/store/refresh', { method: 'POST', headers: H }).then((r) => ok<{ from: string; fetchedAt: number | null; error: string | null }>(r)),
  /** Installs exactly this release (checked against the catalogue's integrity), and what it needs; an unreviewed one only with `acceptRisk`. */
  installFromStore: (id: string, version: string, acceptRisk = false) => fetch('/api/store/install', { method: 'POST', headers: H, body: JSON.stringify({ id, version, acceptRisk }) }).then((r) => ok<StoreInstallResult>(r)),
  /** Kiosko's own update: how it is installed, the instructions and the button's progress. */
  kioskoUpdate: () => fetch('/api/kiosko/update').then((r) => ok<KioskoUpdateState>(r)),
  /** Starts updating Kiosko to the version the check found (npm: all of it; Windows: download and verify). */
  startKioskoUpdate: (version: string) => fetch('/api/kiosko/update', { method: 'POST', headers: H, body: JSON.stringify({ version }) }).then((r) => ok<KioskoUpdateState>(r)),
  /** Windows: runs the verified installer. */
  confirmKioskoUpdate: (version: string) => fetch('/api/kiosko/update/confirm', { method: 'POST', headers: H, body: JSON.stringify({ version }) }).then((r) => ok<KioskoUpdateState>(r)),
  cancelKioskoUpdate: () => fetch('/api/kiosko/update/cancel', { method: 'POST', headers: H, body: '{}' }).then((r) => ok<KioskoUpdateState>(r)),
  /** Who answers now (after a restart: the new version). */
  version: () => fetch('/api/version', { cache: 'no-store' }).then((r) => ok<{ version: string; instance: string }>(r)),
  setPluginEnabled: (id: string, enabled: boolean) => fetch(`/api/plugins/${encodeURIComponent(id)}/enabled`, { method: 'POST', headers: H, body: JSON.stringify({ enabled }) }).then((r) => ok<AppState>(r)),
};

export interface FrameEvent {
  screenId: string;
  pageId: string | null;
  at: number;
  interlude: string | null;
  /** The alert that has the screen, if any. */
  alert?: string | null;
  sleeping: boolean;
}

/** Server-sent events, reconnecting on their own. */
export function connectEvents(h: { config?: (e: { rev: number; by: string | null }) => void; frame?: (e: FrameEvent) => void; log?: (e: { at: number; scope: string; message: string }) => void; status?: (s: Status) => void; alerts?: (a: AlertInfo[]) => void; online?: (on: boolean) => void; hello?: (e: { version: string }) => void; kioskoUpdate?: (s: KioskoUpdateStatus) => void }): () => void {
  let es: EventSource | null = null;
  let closed = false;
  const open = () => {
    es = new EventSource('/api/events');
    es.addEventListener('hello', (e) => {
      h.online?.(true);
      h.hello?.(JSON.parse((e as MessageEvent).data));
    });
    es.addEventListener('kiosko-update', (e) => h.kioskoUpdate?.(JSON.parse((e as MessageEvent).data)));
    es.addEventListener('frame', (e) => h.frame?.(JSON.parse((e as MessageEvent).data)));
    es.addEventListener('config', (e) => h.config?.(JSON.parse((e as MessageEvent).data)));
    es.addEventListener('log', (e) => h.log?.(JSON.parse((e as MessageEvent).data)));
    es.addEventListener('status', (e) => h.status?.(JSON.parse((e as MessageEvent).data)));
    es.addEventListener('alerts', (e) => h.alerts?.(JSON.parse((e as MessageEvent).data)));
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

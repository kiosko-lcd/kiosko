/**
 * The user's configuration: screens, their pages, the tiles of each page and
 * the widgets of each tile. Pure (no Node): the editor builds and edits these
 * same objects and sends them back whole.
 *
 *   Config
 *   └─ screens[]           one per physical panel (or a virtual one)
 *      ├─ device           how frames get to the glass
 *      ├─ pages[]          layouts that take turns (dashboard, cats room…)
 *      │  └─ tiles[]       rectangles of the grid
 *      │     └─ widgets[]  a stack: they take turns inside the tile
 *      └─ interludes[]     full-screen animations every so often
 */
// The pure parts of the SDK only: the editor imports this file.
import type { TimeFormat } from '@kiosko/sdk/format';
import { DEFAULT_WORKDAY, isWorkingAt, type Workday } from '@kiosko/sdk/workday';
import { rescale, suggestGrid, type Gravity, type GridSpec } from '../layout/grid.ts';

export * from './profiles.ts';

export const CONFIG_VERSION = 1;

/**
 * The stable address of the config's JSON Schema (`kiosko config schema`
 * prints the same with the plugins installed here). `saveConfig` writes it as
 * `$schema`, so editors validate and complete the file on their own.
 */
export const CONFIG_SCHEMA_ID = 'https://kioskolcd.dev/schema/v1/config.json';

export type Rotation = 0 | 90 | 180 | 270;

export type DeviceConfig =
  | { driver: 'virtual' }
  /** `trcc serve` REST API (thermalright-trcc-linux). */
  | { driver: 'trcc'; url: string; tokenFile?: string; deviceKey?: string; serial?: string; keepalive?: boolean }
  /** Straight over USB from Node (LY panels, Trofeo Vision…): no trcc, no Python. */
  | { driver: 'usb'; serial?: string; keepalive?: number }
  /** Writes `frame.jpg` atomically to `dir`; a sender (e.g. by USB serial) takes it to the panel. */
  | { driver: 'file'; dir: string; format?: 'jpeg' | 'png'; quality?: number }
  /**
   * A Kiosko remote screen on the network (firmware/esp32-screen, docs/remote-screen.md):
   * found by `uid` over mDNS (or at `host`), paired with `key` (secret), turned by the
   * screen itself to the screen's `rotate`. `brightness` (0-100, perceived) is pushed to
   * screens that support it (firmware 0.1.2 on); unset, the screen keeps its own. `night`: a
   * window (`HH:MM` local time, start after end across midnight) when the backlight goes to its
   * own `brightness` (0 = off), for as long as it lasts (firmware 0.1.4 on; see remote/backlight.ts).
   */
  | { driver: 'remote'; uid: string; id?: string; key?: string; host?: string; port?: number; brightness?: number; night?: { start: string; end: string; brightness: number } };

/** Whether the panel turns the picture itself (Kiosko then paints it the page's way round). */
export function deviceRotates(d: DeviceConfig): boolean {
  return d.driver === 'remote';
}

/** The angle Kiosko turns the picture by before sending it: the screen's, unless the panel turns it. */
export function paintTurn(s: Pick<Screen, 'rotate' | 'device'>): Rotation {
  return deviceRotates(s.device) ? 0 : s.rotate;
}

/** When a widget or page shows: always, only in work hours, or only outside them. */
export type When = 'always' | 'work' | 'off';

export interface WidgetInstance {
  /** Stable id (survives moves between tiles). */
  id: string;
  /** `plugin/widget`, e.g. `core/clock`, `agents/sessions`. */
  type: string;
  /** Card title; empty = no title bar. */
  title?: string;
  options: Record<string, unknown>;
  /** Overrides the widget's own fetch interval. */
  intervalMs?: number;
  when?: When;
  disabled?: boolean;
  /**
   * Text density: the widget is painted `zoom` times bigger (1.25: bigger
   * letters, fewer rows) or smaller (0.8: denser), from 0.5 to 2. Missing = 1.
   */
  zoom?: number;
  /** Keeps its tile while it's urgent. Missing = the widget's default (`WidgetDefinition.takeOver`, true unless it says otherwise). */
  takeOver?: boolean;
  /** Skipped in its tile's rotation while it has nothing to list. Missing = the widget's default (`WidgetDefinition.hideWhenEmpty`, false unless it says otherwise). */
  hideWhenEmpty?: boolean;
  /**
   * The profile of its shared sources it reads (`Config.sourceProfiles`), by
   * id: news «Technology» instead of the general one. Missing, or a profile
   * that isn't there: the default one (`sources["plugin/source"]`).
   */
  profile?: string;
}

/** Range and step of `WidgetInstance.zoom`. */
export const ZOOM = { min: 0.5, max: 2, step: 0.1 } as const;

/** The zoom a widget is painted at: 1 when missing or invalid, otherwise clamped to `ZOOM` (to the hundredth, against float noise). */
export function zoomOf(inst: Pick<WidgetInstance, 'zoom'>): number {
  const z = inst.zoom;
  if (typeof z !== 'number' || !Number.isFinite(z)) return 1;
  return Math.round(Math.min(ZOOM.max, Math.max(ZOOM.min, z)) * 100) / 100;
}

export interface Tile {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  locked?: boolean;
  /** Widgets that take turns here. */
  widgets: WidgetInstance[];
  /** Turn length when several are visible. */
  rotateMs: number;
  /** `auto` = what the shown widget prefers. */
  chrome: 'auto' | 'card' | 'bare';
}

export interface Page {
  id: string;
  name: string;
  enabled?: boolean;
  /** Time on screen when pages rotate. */
  durationMs?: number;
  when?: When;
  /**
   * Context rules (see context.ts): while one of them holds, this page takes
   * the screen over from the normal rotation. Missing or empty: none.
   */
  showWhen?: ShowWhenRule[];
  /**
   * Whether a page with rules also takes its turn in the normal rotation.
   * Missing: no (it only comes up when a rule holds); pages without rules
   * always rotate.
   */
  inRotation?: boolean;
  grid: GridSpec;
  gravity: Gravity;
  background: { color?: string; image?: string };
  tiles: Tile[];
}

/** How a source's value is compared in a `showWhen` rule. */
export type CompareOp = 'truthy' | 'falsy' | 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains';
export const COMPARE_OPS: readonly CompareOp[] = ['truthy', 'falsy', 'eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains'];

/**
 * One rule of a page's `showWhen`. Each condition set must hold (AND); the
 * page comes up when any of its rules holds (OR). A rule without conditions
 * never holds.
 */
export interface ShowWhenRule {
  /** What the editor says it means ("game open"); else it says what it checks. */
  label?: string;
  /** Higher wins when several pages want the screen. Default 0. */
  priority?: number;
  /** A program running: its process name, a glob (`steam*`, `obs*`), case-insensitive; several separated by commas. */
  app?: string;
  /** A source's value (`plugin/source`), at `path` in its data, compared with `op` and `value`. */
  source?: string;
  /** Dots and brackets into the source's data (`active`, `items[0].price`); empty: the data itself. */
  path?: string;
  /** Default: `eq` with a `value`, `truthy` without. */
  op?: CompareOp;
  value?: string | number | boolean;
  /** A local time window, `HH:MM`; start after end goes across midnight. `days`: 0 = Sunday … 6, the days it starts on (missing: every day). */
  time?: { start: string; end: string; days?: number[] };
  /** A widget on this page is urgent (a meeting about to start, a permission waiting). */
  urgent?: boolean;
}

/** Anti-flicker for context pages, in ms. */
export interface ContextTiming {
  /** Least time a context page stays once it came up (unless a higher priority one comes). */
  minMs?: number;
  /** How long it stays after its rule stopped holding, in case it holds again. */
  holdMs?: number;
}
export const CONTEXT_TIMING: Required<ContextTiming> = { minMs: 20_000, holdMs: 10_000 };

export interface InterludeSlot {
  id: string;
  /** `plugin/interlude`. */
  type: string;
  enabled: boolean;
  /** Against the wall clock: every 15 min plays at :00, :15, :30, :45. */
  everyMs: number;
  /** Seconds it may last at most. */
  maxSeconds: number;
  options: Record<string, unknown>;
}

export interface Screen {
  id: string;
  name: string;
  enabled: boolean;
  width: number;
  height: number;
  /** Panels are often mounted upside down. */
  rotate: Rotation;
  device: DeviceConfig;
  pages: Page[];
  /** Pin one page (no rotation). Also settable at runtime from the API. */
  pinnedPage?: string;
  /** How context pages (`Page.showWhen`) come and go here. Missing: `CONTEXT_TIMING`. */
  context?: ContextTiming;
  interludes: InterludeSlot[];
  /** Anti burn-in: moves everything 1-2 px in a slow cycle. */
  pixelShift: { enabled: boolean; amplitude: number; periodMs: number };
  /** Black panel when every widget of the page says it's idle. */
  sleepWhenIdle: boolean;
  /** JPEG quality for photo-like pages; 0 = PNG. */
  jpegQuality: number;
  /**
   * Largest frame to send, in bytes; a bigger one is re-encoded at a lower
   * JPEG quality until it fits. LY panels (Trofeo Vision and friends) silently
   * drop frames over ~500 KB and keep showing the last one. 0 = no limit.
   */
  maxBytes: number;
  /** Frames per second ceiling for animations. */
  maxFps: number;
  /**
   * How far the people reading it sit: with the panel's pixel size it sets
   * the smallest Chinese, Japanese or Korean text that can be read, which
   * Kiosko never paints smaller (see `legibleCjkPx`).
   */
  readingDistance?: ReadingDistance;
  /** Every widget's text size times this (each widget keeps its own zoom too). */
  textScale?: number;
  /** The panel's diagonal in inches, when it isn't a known model (for its pixel size). */
  diagonalIn?: number;
  /** How alerts take this panel over (see `ScreenAlerts`). Missing = every level, at any hour. */
  alerts?: ScreenAlerts;
  /**
   * Paint this screen in a thread of its own (`always`) or on the main
   * thread (`never`), whatever the config's `threads` says. Missing: as it
   * says.
   */
  thread?: 'always' | 'never';
}

/**
 * Whether each screen paints in a thread of its own (see threads/):
 * `auto` = yes with two or more screens on and a core to spare for each;
 * `always`; `never` = every screen on the main thread (less memory).
 */
export type ThreadsMode = 'auto' | 'always' | 'never';
export const THREADS_MODES: readonly ThreadsMode[] = ['auto', 'always', 'never'];

/** An alert's level (`AlertLevel` in the SDK), and `off` for none. */
export type AlertThreshold = 'info' | 'warn' | 'critical' | 'off';
export const ALERT_THRESHOLDS: readonly AlertThreshold[] = ['info', 'warn', 'critical', 'off'];

/**
 * Per screen: from which level an alert takes the whole panel over (the
 * rest stay in their tile and in the editor's band) and the hours when only
 * `critical` ones do (night, a meeting room). A switched-off screen (Home
 * Assistant, the API) also lets only `critical` through.
 */
export interface ScreenAlerts {
  /** The least level shown full-screen here; `off`: none. */
  minLevel: AlertThreshold;
  /** Quiet hours, `HH:MM` local time; `start` after `end` goes across midnight (22:00–07:00). */
  quiet?: { start: string; end: string };
}

/** What a screen does with alerts, with the defaults filled in. */
export function screenAlerts(s: Pick<Screen, 'alerts'>): ScreenAlerts {
  return { minLevel: s.alerts?.minLevel ?? 'info', ...(s.alerts?.quiet ? { quiet: s.alerts.quiet } : {}) };
}

const minutesOf = (hhmm: string) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
};

/** Whether local time `now` falls in the quiet hours (start included, end not). */
export function inQuietHours(quiet: ScreenAlerts['quiet'], now: number): boolean {
  if (!quiet) return false;
  const a = minutesOf(quiet.start), b = minutesOf(quiet.end);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) return false;
  const d = new Date(now);
  const t = d.getHours() * 60 + d.getMinutes();
  return a < b ? t >= a && t < b : t >= a || t < b;
}

export type ReadingDistance = 'near' | 'normal' | 'far';
/** Centimetres for each reading distance. */
export const READING_CM: Record<ReadingDistance, number> = { near: 40, normal: 60, far: 90 };
export const TEXT_SCALE = { min: 0.75, max: 2, step: 0.05 } as const;

/** Default `maxBytes`: under the ~500 KB LY panels accept, with some margin. */
export const DEFAULT_MAX_BYTES = 480_000;

export interface Config {
  /** JSON Schema of the file, for editors. Kept as written; `CONFIG_SCHEMA_ID` when missing. */
  $schema?: string;
  version: number;
  /** `auto` = from the OS. */
  locale: string;
  /** How clock times are written on the panels: `auto` follows the language. */
  timeFormat: TimeFormat;
  theme: string;
  location?: { latitude: number; longitude: number; name?: string };
  /** Work schedule, for `when: work|off` and for plugins (`ctx.workday`). */
  workday: Workday;
  /** Global options of shared sources, by `plugin/source`: each one's default profile. */
  sources: Record<string, Record<string, unknown>>;
  /**
   * More named configurations of the sources that accept them
   * (`SourceDefinition.profiles`), by `plugin/source` and then by profile id:
   * `{ "news/deck": { "tech": { "name": "Technology", "options": { … } } } }`.
   * Each is read on its own; a widget picks one with its `profile`. Missing:
   * one configuration per source, the default one (see config/profiles.ts).
   */
  sourceProfiles?: Record<string, Record<string, SourceProfile>>;
  plugins: { disabled: string[] };
  screens: Screen[];
  server: { host: string; port: number };
  /** Kiosko as a device in Home Assistant, over MQTT (see docs/homeassistant.md). Absent = off. */
  homeassistant?: HomeAssistantLink;
  /** Names scripts may push to (`POST /api/push/<name>`), each with its token (see docs/rest-webhook.md). Absent = none. */
  push?: { hooks: PushHook[] };
  /** Each screen painting in a thread of its own (see `ThreadsMode`). Missing = `auto`. */
  threads?: ThreadsMode;
  /**
   * The editor's first-run setup (web/src/wizard): `pending` as the first run writes it (the
   * panels show how to open the editor; the first edit made by hand counts as setting up), then
   * `done` or `skipped`, so it is not offered on its own again (Settings can always run it).
   * Missing (a config from before it): offered while the config is still the first run's
   * (`looksLikeStarter`).
   */
  setup?: SetupState;
  /** The short animation on every panel when Kiosko starts (welcome.ts). Missing = on. */
  bootAnimation?: boolean;
}

/** One named configuration of a source (see `Config.sourceProfiles`). */
export interface SourceProfile {
  /** What the person calls it: «Technology», «Work account». */
  name: string;
  /** Its options, as `sources["plugin/source"]` has them for the default profile. */
  options: Record<string, unknown>;
}

export type SetupState = 'pending' | 'done' | 'skipped';
export const SETUP_STATES: readonly SetupState[] = ['pending', 'done', 'skipped'];

/** A name scripts push to, `POST /api/push/<name>`, with the token that lets them. */
export interface PushHook {
  /** Lowercase letters, digits, `-` and `_`, up to 40: it goes in the URL. */
  name: string;
  /** Sent as `Authorization: Bearer <token>` (or `?token=`). Random, made by the editor. */
  token: string;
}

/** A push name: lowercase letters, digits, `-` and `_`, 1 to 40, not starting with `-` or `_`. */
export const PUSH_NAME_PATTERN = '^[a-z0-9][a-z0-9_-]{0,39}$';

/**
 * How Kiosko shows up in Home Assistant: an MQTT broker (the one Home
 * Assistant uses, usually its Mosquitto add-on) and MQTT discovery, so each
 * screen appears with its page to choose, a switch to turn it off and a
 * button per interlude.
 */
export interface HomeAssistantLink {
  enabled: boolean;
  /** `mqtt://homeassistant.local:1883`, or `mqtts://` for TLS. */
  broker: string;
  username?: string;
  password?: string;
  /** Home Assistant's discovery prefix. Default `homeassistant`. */
  discoveryPrefix: string;
  /** This Kiosko's id in the topics (`kiosko/<node>/…`), so several machines don't collide. Default `kiosko`. */
  nodeId: string;
}

/**
 * The names the first run gives its screen and page (server/src/starter.ts), in each language Kiosko
 * speaks (a test checks). They are written before anyone opens the editor, in the system's language;
 * the editor puts them in its own while nobody has renamed them (web/src/store.ts).
 */
export const STARTER_NAMES = {
  screen: { en: 'My panel', es: 'Mi panel', de: 'Mein Panel', 'zh-Hant': '我的面板', 'zh-Hans': '我的屏幕' } as Record<string, string>,
  page: { en: 'Home', es: 'Inicio', de: 'Start', 'zh-Hant': '首頁', 'zh-Hans': '首页' } as Record<string, string>,
};

let counter = 0;
/** Short unique id. Not crypto: only needs to be unique inside one config. */
export function newId(prefix = 'id'): string {
  counter = (counter + 1) % 1296;
  return `${prefix}-${Date.now().toString(36).slice(-5)}${counter.toString(36).padStart(2, '0')}${Math.floor(Math.random() * 1296).toString(36).padStart(2, '0')}`;
}

export function newPage(name: string, width: number, height: number, tiles: Tile[] = []): Page {
  const grid = suggestGrid(width, height);
  return { id: newId('page'), name, enabled: true, durationMs: 10 * 60_000, when: 'always', grid, gravity: width / height > 2.2 ? 'left' : 'up', background: {}, tiles };
}

export function newTile(r: { x: number; y: number; w: number; h: number }, widgets: WidgetInstance[] = []): Tile {
  return { id: newId('tile'), ...r, widgets, rotateMs: 30_000, chrome: 'auto' };
}

export function newWidget(type: string, options: Record<string, unknown> = {}, title?: string): WidgetInstance {
  return { id: newId('w'), type, options, ...(title ? { title } : {}) };
}

export function newScreen(name: string, width = 1920, height = 462, device: DeviceConfig = { driver: 'virtual' }): Screen {
  return {
    id: newId('screen'),
    name,
    enabled: true,
    width,
    height,
    rotate: 0,
    device,
    pages: [newPage('Main', width, height)],
    interludes: [],
    pixelShift: { enabled: true, amplitude: 2, periodMs: 8 * 60_000 },
    sleepWhenIdle: false,
    jpegQuality: 90,
    maxBytes: DEFAULT_MAX_BYTES,
    maxFps: 12,
  };
}

export const DEFAULT_CONFIG: Config = {
  version: CONFIG_VERSION,
  locale: 'auto',
  timeFormat: 'auto',
  theme: 'midnight',
  workday: { ...DEFAULT_WORKDAY, days: [...DEFAULT_WORKDAY.days], holidays: [], byDay: {} },
  sources: {},
  plugins: { disabled: [] },
  screens: [],
  server: { host: '127.0.0.1', port: 7420 },
};

export interface PanelPreset {
  id: string;
  name: string;
  /** Width × height as the panel reports them. */
  width: number;
  height: number;
  /** For the smallest readable text (mmPerPx). */
  diagonalIn: number;
  /** A maker's model (not just a size): its name is what is on the box. */
  maker?: string;
  /** Kiosko has run on one. A model without it comes from its maker's page: its size and resolution, untested. */
  tested?: boolean;
  /** `round`: a circular screen (an AIO cooler's), whose corners are not there. Missing: rectangular. */
  shape?: 'rect' | 'round';
}

/**
 * Known panels, for the "add screen" dialog: the makers' models first, then
 * plain sizes. Thermalright's from its accessories page (resolution and
 * diagonal; the Fan Bracket's from its 125 × 71 mm screen). A model is only
 * a size here: how Kiosko talks to it is the screen's connection (trcc,
 * file, or usb for the LY ones).
 */
export const PANEL_PRESETS: PanelPreset[] = [
  { id: 'trofeo-916', name: 'Trofeo Vision 9.16″', width: 1920, height: 462, diagonalIn: 9.16, maker: 'Thermalright', tested: true },
  { id: 'trofeo-113', name: 'Trofeo Vision 11.3″', width: 1920, height: 400, diagonalIn: 11.3, maker: 'Thermalright' },
  // The id of the size it was before it had its model's name: kept.
  { id: 'wide-1280x480', name: 'Trofeo Vision 6.86″', width: 1280, height: 480, diagonalIn: 6.86, maker: 'Thermalright' },
  { id: 'fan-bracket-vision-1', name: 'Fan Bracket Vision-1', width: 854, height: 480, diagonalIn: 5.66, maker: 'Thermalright' },
  { id: 'gpu-bracket-458', name: 'GPU Bracket LCD 4.58″', width: 320, height: 960, diagonalIn: 4.58, maker: 'Thermalright' },
  { id: 'fan-frame-vision-1', name: 'Fan Frame Vision-1 3.69″', width: 640, height: 172, diagonalIn: 3.69, maker: 'Thermalright' },
  { id: 'wide-1920x480', name: 'Wide bar 1920×480', width: 1920, height: 480, diagonalIn: 9.16 },
  { id: 'wide-1600x720', name: '1600×720', width: 1600, height: 720, diagonalIn: 8.8 },
  { id: 'square-480', name: 'Square 480×480', width: 480, height: 480, diagonalIn: 3.4 },
  { id: 'square-320', name: 'Square 320×320', width: 320, height: 320, diagonalIn: 2.1 },
  { id: 'small-320x240', name: 'Small 320×240', width: 320, height: 240, diagonalIn: 2.4 },
  { id: 'round-480', name: 'Round 480×480 (AIO)', width: 480, height: 480, diagonalIn: 2.8, shape: 'round' },
];

/** Millimetres per pixel of a screen: its diagonal, or a known model's, or ~200 ppi (most of these panels). */
export function mmPerPx(s: Pick<Screen, 'width' | 'height'> & { diagonalIn?: number | undefined }): number {
  const known = PANEL_PRESETS.find((p) => (p.width === s.width && p.height === s.height) || (p.width === s.height && p.height === s.width));
  const diag = s.diagonalIn ?? known?.diagonalIn;
  if (!diag) return 25.4 / 200;
  return (diag * 25.4) / Math.hypot(s.width, s.height);
}

/**
 * The smallest Chinese, Japanese or Korean text, in px, that can be read on
 * this screen from its reading distance: a character about 10 minutes of arc
 * tall (ergonomics asks 16′ for reading; a panel is glanced at), ~0.88 of
 * the font size. ~17 px on a Trofeo Vision at 60 cm, ~13 px on a 2.4″ one.
 */
export function legibleCjkPx(s: Pick<Screen, 'width' | 'height'> & { diagonalIn?: number | undefined; readingDistance?: ReadingDistance | undefined }): number {
  const mm = READING_CM[s.readingDistance ?? 'normal'] * 10 * Math.tan(((10 / 60) * Math.PI) / 180);
  return Math.round(mm / 0.88 / mmPerPx(s));
}

/** Is `now` inside the work schedule (its days, their own hours, not a holiday)? */
export function isWorking(workday: Config['workday'], now: number): boolean {
  return isWorkingAt(workday, now);
}

export function whenMatches(when: When | undefined, working: boolean): boolean {
  return !when || when === 'always' || (when === 'work') === working;
}

/** Every widget instance of a screen, with where it lives. */
export function* widgetsOf(screen: Screen): Generator<{ page: Page; tile: Tile; widget: WidgetInstance }> {
  for (const page of screen.pages) for (const tile of page.tiles) for (const widget of tile.widgets) yield { page, tile, widget };
}

/* ---------- orientation ---------- */

/**
 * A screen's `width` × `height` are the picture as it is designed and seen
 * (what the editor shows); `rotate` is how the panel is mounted. A quarter
 * turn (90° or 270°) means the panel stands on its side: the picture is
 * portrait while the panel's own resolution is landscape, or the other way
 * round.
 */
export const isQuarterTurn = (rotate: number): boolean => rotate === 90 || rotate === 270;

/** The panel's own resolution (what it reports, what presets list) for a screen. */
export function panelSize(s: Pick<Screen, 'width' | 'height' | 'rotate'>): { width: number; height: number } {
  return isQuarterTurn(s.rotate) ? { width: s.height, height: s.width } : { width: s.width, height: s.height };
}

/** Whether the picture is portrait (taller than wide). */
export const isPortrait = (s: Pick<Screen, 'width' | 'height'>): boolean => s.height > s.width;

/**
 * A page's layout turned a quarter: what went left to right goes top to
 * bottom (x ↔ y, w ↔ h), then fitted to the grid suggested for the new
 * size. Columns of a strip become bands of a tall panel instead of being
 * squashed. Thin rows across the whole top (a summary strip) are headers:
 * they stay across the top, about as tall as they were, instead of turning
 * into a sliver down the side. Gravity follows the turn (left ↔ up).
 */
export function transposePage(page: Page, width: number, height: number): void {
  const { cols, rows } = page.grid;
  const grid = suggestGrid(width, height);
  grid.gap = page.grid.gap;
  grid.padding = page.grid.padding;
  // Headers: full-width tiles stacked from the top, each at most an eighth of the height (one row on a strip).
  const thin = Math.max(1, Math.round(rows / 8));
  const headers: Tile[] = [];
  let top = 0;
  for (;;) {
    const h = page.tiles.find((t) => t.x === 0 && t.w === cols && t.y === top && t.h <= thin);
    if (!h || top + h.h >= rows) break;
    headers.push(h);
    top += h.h;
  }
  // The picture before the turn was height × width: keep the headers' height in pixels, in the new rows.
  const cellBefore = width / rows, cellAfter = height / grid.rows;
  let y = 0;
  const bands = headers.map((h) => {
    const band = { ...h, x: 0, y, w: grid.cols, h: Math.max(1, Math.round((h.h * cellBefore) / cellAfter)) };
    y += band.h;
    return band;
  });
  const rest = page.tiles.filter((t) => !headers.includes(t)).map((t) => ({ ...t, x: t.y - top, y: t.x, w: t.h, h: t.w }));
  const turned = { ...page.grid, cols: rows - top, rows: cols };
  const body = rescale(rest, turned, { ...grid, rows: grid.rows - y }).map((t) => ({ ...t, y: t.y + y }));
  page.tiles = [...bands, ...body];
  page.grid = grid;
  page.gravity = page.gravity === 'left' ? 'up' : page.gravity === 'up' ? 'left' : page.gravity;
}

/** Fits every page of a screen to a new picture size, keeping proportions (the same orientation). */
export function resizePages(s: Screen, width: number, height: number): void {
  for (const p of s.pages) {
    const g = suggestGrid(width, height);
    g.gap = p.grid.gap;
    g.padding = p.grid.padding;
    p.tiles = rescale(p.tiles, p.grid, g);
    p.grid = g;
  }
}

/**
 * Mounts the panel at `rotate`. Going from upright to on its side (or back)
 * swaps the picture's width and height and turns every page's layout with
 * it, so the screen keeps matching the panel's resolution.
 */
export function setRotation(s: Screen, rotate: Rotation): void {
  if (isQuarterTurn(rotate) !== isQuarterTurn(s.rotate)) {
    const width = s.height, height = s.width;
    for (const p of s.pages) transposePage(p, width, height);
    s.width = width;
    s.height = height;
  }
  s.rotate = rotate;
}

/** Sets the panel's own resolution (a preset, what was detected), keeping the screen's orientation. */
export function setPanelSize(s: Screen, width: number, height: number): void {
  const pic = isQuarterTurn(s.rotate) ? { width: height, height: width } : { width, height };
  if (pic.width === s.width && pic.height === s.height) return;
  resizePages(s, pic.width, pic.height);
  s.width = pic.width;
  s.height = pic.height;
}

/** Turns the panel's mounting by `by` degrees from where it is (a quarter turn changes the orientation). */
export function turnScreen(s: Screen, by: 90 | 180 | 270): void {
  setRotation(s, (((s.rotate + by) % 360) as Rotation));
}

/**
 * The picture size a detected panel wants for a screen mounted at `rotate`.
 * A panel reports its size as seen at its firmware's own angle (`detected.rotate`,
 * 0 when unknown); a quarter turn from that angle stands it on its side.
 */
export function detectedPicture(detected: { width: number; height: number; rotate?: number }, rotate: number): { width: number; height: number } {
  return isQuarterTurn((((rotate - (detected.rotate ?? 0)) % 360) + 360) % 360) ? { width: detected.height, height: detected.width } : { width: detected.width, height: detected.height };
}

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
import { suggestGrid, type Gravity, type GridSpec } from '../layout/grid.ts';

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
  | { driver: 'file'; dir: string; format?: 'jpeg' | 'png'; quality?: number };

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
  grid: GridSpec;
  gravity: Gravity;
  background: { color?: string; image?: string };
  tiles: Tile[];
}

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
  interludes: InterludeSlot[];
  /** Anti burn-in: moves everything 1-2 px in a slow cycle. */
  pixelShift: { enabled: boolean; amplitude: number; periodMs: number };
  /** Black panel when every widget of the page says it's idle. */
  sleepWhenIdle: boolean;
  /** JPEG quality for photo-like pages; 0 = PNG. */
  jpegQuality: number;
  /** Frames per second ceiling for animations. */
  maxFps: number;
}

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
  /** Global options of shared sources, by `plugin/source`. */
  sources: Record<string, Record<string, unknown>>;
  plugins: { disabled: string[] };
  screens: Screen[];
  server: { host: string; port: number };
}

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

/** Known panel resolutions, for the "add screen" dialog. Width × height as the panel reports them. */
export const PANEL_PRESETS: { id: string; name: string; width: number; height: number }[] = [
  { id: 'trofeo-916', name: 'Trofeo Vision 9.16″', width: 1920, height: 462 },
  { id: 'wide-1920x480', name: 'Wide bar 1920×480', width: 1920, height: 480 },
  { id: 'wide-1280x480', name: 'Wide 1280×480', width: 1280, height: 480 },
  { id: 'wide-1600x720', name: '1600×720', width: 1600, height: 720 },
  { id: 'square-480', name: 'Square 480×480', width: 480, height: 480 },
  { id: 'square-320', name: 'Square 320×320', width: 320, height: 320 },
  { id: 'small-320x240', name: 'Small 320×240', width: 320, height: 240 },
  { id: 'round-480', name: 'Round 480×480 (AIO)', width: 480, height: 480 },
];

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

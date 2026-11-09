/**
 * Turns an aimonitor `~/.aimonitor/config.json` into a Tessera config:
 *
 *   - the main panel becomes a screen with two pages, «Dashboard» (header,
 *     session tiles, vitals, usage rail) and «Cats» (the room plus a column
 *     with the `modules` cards taking turns), pinned or alternating per
 *     `scene.mode`;
 *   - every entry of `screens` becomes a screen written to its `dir` (file
 *     driver), with its columns as tiles and shared `column`s as stacks;
 *   - the quarter-hour runner becomes an interlude;
 *   - custom modules (files in ~/.aimonitor/modules) run through the
 *     `legacy/module` adapter, unchanged.
 *
 * Pure: returns the config and human-readable notes of what didn't map.
 */
import { newId, normalize, suggestGrid, type Config, type Page, type Registry, type Screen, type Tile, type WidgetInstance, type When } from '@tessera/core';

/** aimonitor module name → Tessera widget type. */
export const MODULE_MAP: Record<string, string> = {
  countdown: 'mirror/countdown',
  compliments: 'mirror/compliments',
  tasks: 'mirror/tasks',
  nowplaying: 'mirror/nowplaying',
  onthisday: 'mirror/onthisday',
  airquality: 'mirror/airquality',
  earthquakes: 'mirror/earthquakes',
  rainmap: 'mirror/rainmap',
  pipelines: 'gitlab/pipelines',
  reviews: 'gitlab/reviews',
  syshealth: 'system/health',
  noticias: 'news/column',
};

/** Built-in aimonitor modules that depend on aimonitor-only services and have no widget yet. */
const NOT_PORTED = new Set(['agenda', 'imputacion', 'horas', 'runner']);

interface OldModule {
  module: string;
  header?: string;
  disabled?: boolean;
  updateMs?: number;
  when?: 'jornada' | 'fuera' | 'siempre';
  config?: Record<string, unknown>;
  weight?: number;
  column?: number;
}

type Old = Record<string, any>;

const WHEN: Record<string, When> = { jornada: 'work', fuera: 'off', siempre: 'always' };

function widgetFor(m: OldModule, reg: Registry, notes: string[], modulesDir: string): WidgetInstance | null {
  if (m.disabled) return null;
  const mapped = MODULE_MAP[m.module];
  const base = { id: newId('w'), ...(m.header ? { title: m.header } : {}), ...(m.updateMs ? { intervalMs: m.updateMs } : {}), ...(m.when && m.when !== 'siempre' ? { when: WHEN[m.when] } : {}) };
  if (mapped) {
    if (!reg.widget(mapped)) notes.push(`"${m.module}" maps to ${mapped}, but that plugin isn't installed: kept, it will show once it is`);
    return { ...base, type: mapped, options: m.config ?? {} };
  }
  if (NOT_PORTED.has(m.module)) {
    notes.push(`"${m.module}" depends on aimonitor-only services and has no Tessera widget yet: skipped`);
    return null;
  }
  // Anything else is a user module file: run it through the adapter.
  return { ...base, type: 'legacy/module', options: { module: m.module, dir: modulesDir, json: m.config ? JSON.stringify(m.config, null, 2) : '' } };
}

/** Columns of old `screens[].modules`: same `column` → one stack; widths from `weight` over 24 columns. */
function columnsPage(name: string, width: number, height: number, mods: OldModule[], rotateMs: number, reg: Registry, notes: string[], modulesDir: string): Page {
  const groups: { weight: number; widgets: WidgetInstance[] }[] = [];
  const byColumn = new Map<number, number>();
  for (const m of mods) {
    const w = widgetFor(m, reg, notes, modulesDir);
    if (!w) continue;
    if (m.column !== undefined && byColumn.has(m.column)) {
      groups[byColumn.get(m.column)!]!.widgets.push(w);
      continue;
    }
    if (m.column !== undefined) byColumn.set(m.column, groups.length);
    groups.push({ weight: m.weight ?? 1, widgets: [w] });
  }
  const grid = { ...suggestGrid(width, height), cols: 24 };
  const total = groups.reduce((a, g) => a + g.weight, 0) || 1;
  let x = 0;
  const tiles: Tile[] = groups.map((g, i) => {
    const w = i === groups.length - 1 ? grid.cols - x : Math.max(2, Math.round((grid.cols * g.weight) / total));
    const t: Tile = { id: newId('tile'), x, y: 0, w, h: grid.rows, widgets: g.widgets, rotateMs, chrome: 'auto' };
    x += w;
    return t;
  });
  return { id: newId('page'), name, enabled: true, durationMs: 10 * 60_000, when: 'always', grid, gravity: 'left', background: {}, tiles };
}

export function importAimonitor(old: Old, reg: Registry): { config: Config; notes: string[] } {
  const notes: string[] = [];
  const width = Number(old.width) || 1920;
  const height = Number(old.height) || 462;
  const modulesDir = '~/.aimonitor/modules';
  const trcc = old.trcc ?? {};
  const device: Screen['device'] = trcc.frameDir
    ? { driver: 'file', dir: trcc.frameDir, format: 'jpeg' }
    : { driver: 'trcc', url: trcc.api?.url ?? 'http://127.0.0.1:8099', ...(trcc.api?.tokenFile ? { tokenFile: trcc.api.tokenFile } : {}), ...(trcc.serial ? { serial: trcc.serial } : {}), ...(trcc.deviceKey ? { deviceKey: trcc.deviceKey } : {}) };

  const grid = { cols: 24, rows: 6, gap: 10, padding: 10 };
  const W = (type: string, options: Record<string, unknown> = {}, title?: string): WidgetInstance => ({ id: newId('w'), type, options, ...(title ? { title } : {}) });
  const T = (x: number, y: number, w: number, h: number, widgets: WidgetInstance[], chrome: Tile['chrome'] = 'auto', rotateMs = 30_000): Tile => ({ id: newId('tile'), x, y, w, h, widgets, rotateMs, chrome });

  const railOn = old.rail?.enabled !== false && old.usage?.enabled !== false;
  const sysOn = old.system?.enabled !== false;
  const sessionsOpts = { ...(old.tile ? { tileMin: old.tile.min, tileMax: old.tile.max, gap: old.tile.gap, detailLines: old.tile.detailLines } : {}), ...(old.spineWidth ? { spineWidth: old.spineWidth } : {}) };
  const dashTiles: Tile[] = [T(0, 0, 24, 1, [W('agents/summary')], 'bare'), T(0, 1, railOn ? (sysOn ? 13 : 19) : sysOn ? 18 : 24, 5, [W('agents/sessions', sessionsOpts)], 'bare')];
  if (sysOn) dashTiles.push(T(railOn ? 13 : 18, 1, 6, 5, [W('vitals/vitals', { diskPath: old.system?.diskPath ?? '/' })], 'bare'));
  if (railOn) dashTiles.push(T(19, 1, 5, 5, [W('usage/rail')], 'bare'));
  const dashboard: Page = { id: newId('page'), name: 'Dashboard', enabled: true, durationMs: old.scene?.alternateMs ?? 10 * 60_000, when: 'always', grid, gravity: 'none', background: {}, tiles: dashTiles };

  const cardWidgets = ((old.modules ?? []) as OldModule[]).map((m) => widgetFor(m, reg, notes, modulesDir)).filter((w): w is WidgetInstance => !!w);
  if (railOn) cardWidgets.push(W('usage/rail', {}, 'Consumo'));
  const side = old.scene?.side === 'izquierda' ? 'left' : 'right';
  const catsTiles: Tile[] = [T(side === 'right' ? 0 : 7, 0, 17, 6, [W('cats/room', { room: old.scene?.room === 'rotar' || !old.scene?.room ? 'rotate' : old.scene.room })], 'bare')];
  if (cardWidgets.length) catsTiles.push(T(side === 'right' ? 17 : 0, 0, 7, 6, cardWidgets, 'card', old.timesheet?.alternateMs || 30_000));
  const cats: Page = { id: newId('page'), name: 'Cats', enabled: true, durationMs: old.scene?.alternateMs ?? 10 * 60_000, when: 'always', grid, gravity: 'none', background: {}, tiles: catsTiles };

  const mode = old.scene?.mode ?? 'tablero';
  const main: Screen = {
    id: newId('screen'),
    name: 'Trofeo Vision',
    enabled: true,
    width,
    height,
    rotate: (trcc.frameDir ? trcc.frameRotate ?? 0 : 0) as Screen['rotate'],
    device,
    pages: [dashboard, cats],
    ...(mode === 'alternar' ? {} : { pinnedPage: mode === 'gatos' ? cats.id : dashboard.id }),
    interludes: [],
    pixelShift: { enabled: old.pixelShift?.enabled ?? true, amplitude: old.pixelShift?.amplitude ?? 2, periodMs: old.pixelShift?.periodMs ?? 8 * 60_000 },
    sleepWhenIdle: old.blankWhenIdle ?? true,
    jpegQuality: old.scene?.jpegQuality ?? 90,
    maxFps: old.easterEgg?.fps ?? 12,
  };
  if (old.easterEgg?.enabled !== false) {
    main.interludes.push({ id: newId('interlude'), type: 'agents/runner', enabled: !old.easterEgg?.source, everyMs: old.easterEgg?.everyMs ?? 15 * 60_000, maxSeconds: old.easterEgg?.maxSeconds ?? 30, options: {} });
    if (old.easterEgg?.source) notes.push('easterEgg.source (your own video clips) has no interlude yet: the built-in runner is added but disabled');
  }

  const screens: Screen[] = [main];
  for (const s of (old.screens ?? []) as Old[]) {
    const w = Number(s.width) || 1920;
    const h = Number(s.height) || 462;
    const page = columnsPage(s.name ?? 'Screen', w, h, s.modules ?? [], s.alternateMs ?? 60_000, reg, notes, modulesDir);
    screens.push({ ...main, id: newId('screen'), name: s.name ?? 'Screen', width: w, height: h, rotate: (s.rotate ?? 0) as Screen['rotate'], device: { driver: 'file', dir: s.dir, format: 'jpeg' }, pages: [page], interludes: [], sleepWhenIdle: false, pinnedPage: undefined as unknown as string });
    delete (screens.at(-1) as Partial<Screen>).pinnedPage;
  }

  const lat = old.scene?.place?.latitude;
  const lon = old.scene?.place?.longitude;
  const sources: Config['sources'] = {};
  if (old.usage) sources['usage/ccusage'] = { bin: old.usage.bin ?? 'ccusage', mode: old.usage.mode ?? 'max', dailyCap: old.usage.dailyCap, monthlyCap: old.usage.monthlyCap };
  sources['agents/sessions'] = { dir: '~/.aimonitor/sessions', ...(old.zombieMs ? { zombieMs: old.zombieMs } : {}), ...(old.staleMs ? { staleMs: old.staleMs } : {}) };
  if (old.calendar?.enabled) notes.push('calendar (next meeting) is not ported yet: your ICS URLs were NOT copied');
  if (old.timesheet?.enabled) notes.push('timesheet (GitLab hours) is not ported yet');
  const ws = old.timesheet?.workday;
  const config = normalize({
    locale: 'es',
    theme: 'midnight',
    ...(typeof lat === 'number' && typeof lon === 'number' ? { location: { latitude: lat, longitude: lon } } : {}),
    ...(ws ? { workday: { days: [1, 2, 3, 4, 5], start: ws.start ?? '09:00', end: ws.end ?? '17:00' } } : {}),
    sources,
    screens,
  });
  return { config, notes: [...new Set(notes)] };
}

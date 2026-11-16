/**
 * Page templates: starting layouts in fractions of the panel, mapped to the
 * page grid of whatever screen they're used on. Widgets whose plugin isn't
 * installed are left out; a tile left empty is dropped.
 */
import { compact, suggestGrid } from '@kiosko/core/layout';
import { newPage, newTile, newWidget, type Page, type Tile } from '@kiosko/core/model';

interface Frac {
  x: number;
  y: number;
  w: number;
  h: number;
  widgets: (string | [string, Record<string, unknown>])[];
  chrome?: Tile['chrome'];
}

export interface Template {
  /** Built-in ones: `blank`, `agents`… (named by `tpl.<id>`); a plugin's: `plugin/id`. */
  id: string;
  /** A plugin's template brings its own name; built-in ones are translated in the editor. */
  name?: string;
  icon: string;
  /** Widget types that must exist for the template to make sense. */
  needs: string[];
  wide: Frac[];
  /** For square-ish panels; defaults to `wide`. */
  square?: Frac[];
  /** For portrait panels (a strip on its side); defaults to `wide` turned a quarter, columns becoming bands. */
  tall?: Frac[];
}

/** A landscape layout turned a quarter: what went left to right goes top to bottom. */
const turned = (fracs: Frac[]): Frac[] => fracs.map((f) => ({ ...f, x: f.y, y: f.x, w: f.h, h: f.w }));

export type { Frac };

export const TEMPLATES: Template[] = [
  { id: 'blank', icon: 'square-dashed', needs: [], wide: [] },
  {
    id: 'agents',
    icon: 'bot',
    needs: ['agents/sessions'],
    wide: [
      { x: 0, y: 0, w: 1, h: 1 / 6, widgets: ['agents/summary'], chrome: 'bare' },
      { x: 0, y: 1 / 6, w: 0.55, h: 5 / 6, widgets: ['agents/sessions'], chrome: 'bare' },
      { x: 0.55, y: 1 / 6, w: 0.25, h: 5 / 6, widgets: ['vitals/vitals'], chrome: 'bare' },
      { x: 0.8, y: 1 / 6, w: 0.2, h: 5 / 6, widgets: ['usage/rail'], chrome: 'bare' },
    ],
    square: [
      { x: 0, y: 0, w: 1, h: 1 / 6, widgets: ['agents/summary'], chrome: 'bare' },
      { x: 0, y: 1 / 6, w: 1, h: 3 / 6, widgets: ['agents/sessions'], chrome: 'bare' },
      { x: 0, y: 4 / 6, w: 1, h: 2 / 6, widgets: ['usage/rail', 'vitals/vitals'], chrome: 'bare' },
    ],
    tall: [
      { x: 0, y: 0, w: 1, h: 1 / 24, widgets: ['agents/summary'], chrome: 'bare' },
      { x: 0, y: 1 / 24, w: 1, h: 13 / 24, widgets: ['agents/sessions'], chrome: 'bare' },
      { x: 0, y: 14 / 24, w: 1, h: 5 / 24, widgets: ['vitals/vitals'], chrome: 'bare' },
      { x: 0, y: 19 / 24, w: 1, h: 5 / 24, widgets: ['usage/rail'], chrome: 'bare' },
    ],
  },
  {
    id: 'cats',
    icon: 'cat',
    needs: ['cats/room'],
    wide: [
      { x: 0, y: 0, w: 0.7, h: 1, widgets: ['cats/room'], chrome: 'bare' },
      { x: 0.7, y: 0, w: 0.3, h: 1, widgets: ['weather/forecast', 'mirror/countdown', 'mirror/onthisday', 'usage/rail'] },
    ],
    square: [{ x: 0, y: 0, w: 1, h: 1, widgets: ['cats/room'], chrome: 'bare' }],
  },
  {
    id: 'news',
    icon: 'newspaper',
    needs: ['news/headline'],
    wide: [
      { x: 0, y: 0, w: 0.6, h: 1, widgets: ['news/headline'], chrome: 'bare' },
      { x: 0.6, y: 0, w: 0.4, h: 0.5, widgets: ['weather/forecast'] },
      { x: 0.6, y: 0.5, w: 0.2, h: 0.5, widgets: [['core/clock', { showDate: true }]], chrome: 'bare' },
      { x: 0.8, y: 0.5, w: 0.2, h: 0.5, widgets: ['mirror/rainmap', 'mirror/earthquakes'] },
    ],
    square: [
      { x: 0, y: 0, w: 1, h: 0.65, widgets: ['news/column'], chrome: 'bare' },
      { x: 0, y: 0.65, w: 1, h: 0.35, widgets: ['weather/forecast'] },
    ],
    tall: [
      { x: 0, y: 0, w: 1, h: 11 / 24, widgets: ['news/headline'], chrome: 'bare' },
      { x: 0, y: 11 / 24, w: 1, h: 5 / 24, widgets: ['weather/forecast'] },
      { x: 0, y: 16 / 24, w: 1, h: 3 / 24, widgets: [['core/clock', { showDate: true }]], chrome: 'bare' },
      { x: 0, y: 19 / 24, w: 1, h: 5 / 24, widgets: ['mirror/rainmap', 'mirror/earthquakes'] },
    ],
  },
  {
    id: 'clock',
    icon: 'clock',
    needs: ['core/clock'],
    wide: [
      { x: 0, y: 0, w: 0.5, h: 1, widgets: [['core/clock', { showDate: true }]], chrome: 'bare' },
      { x: 0.5, y: 0, w: 0.2, h: 1, widgets: ['core/date'] },
      { x: 0.7, y: 0, w: 0.3, h: 1, widgets: ['calendar/next', 'weather/forecast', 'mirror/compliments'] },
    ],
    square: [
      { x: 0, y: 0, w: 1, h: 1 / 3, widgets: [['core/clock', { showDate: false }]], chrome: 'bare' },
      { x: 0, y: 1 / 3, w: 0.5, h: 2 / 3, widgets: ['core/date'] },
      { x: 0.5, y: 1 / 3, w: 0.5, h: 1 / 3, widgets: ['weather/forecast'] },
      { x: 0.5, y: 2 / 3, w: 0.5, h: 1 / 3, widgets: ['mirror/compliments'] },
    ],
    tall: [
      { x: 0, y: 0, w: 1, h: 4 / 24, widgets: [['core/clock', { showDate: true }]], chrome: 'bare' },
      { x: 0, y: 4 / 24, w: 1, h: 6 / 24, widgets: ['core/date'] },
      { x: 0, y: 10 / 24, w: 1, h: 6 / 24, widgets: ['calendar/next', 'weather/forecast'] },
      { x: 0, y: 16 / 24, w: 1, h: 8 / 24, widgets: ['calendar/agenda', 'mirror/compliments'] },
    ],
  },
  {
    id: 'system',
    icon: 'cpu',
    needs: ['system/health'],
    wide: [
      { x: 0, y: 0, w: 0.6, h: 1, widgets: ['vitals/vitals'], chrome: 'bare' },
      { x: 0.6, y: 0, w: 0.4, h: 1, widgets: ['system/health'] },
    ],
    square: [
      { x: 0, y: 0, w: 1, h: 0.5, widgets: ['vitals/vitals'], chrome: 'bare' },
      { x: 0, y: 0.5, w: 1, h: 0.5, widgets: ['system/health'] },
    ],
    tall: [
      { x: 0, y: 0, w: 1, h: 7 / 24, widgets: ['vitals/vitals'], chrome: 'bare' },
      { x: 0, y: 7 / 24, w: 1, h: 10 / 24, widgets: ['system/health'] },
      { x: 0, y: 17 / 24, w: 1, h: 7 / 24, widgets: ['gpu/cards', 'usage/rail'] },
    ],
  },
];

export function available(t: Template, has: (type: string) => boolean): boolean {
  return t.needs.every(has);
}

/** A template a plugin declares (from the catalog), in the editor's terms. */
export function pluginTemplate(tp: { id: string; name: string; icon: string; wide: Frac[]; square?: Frac[] | undefined; tall?: Frac[] | undefined }): Template {
  return { id: tp.id, name: tp.name, icon: tp.icon, needs: [], wide: tp.wide, ...(tp.square ? { square: tp.square } : {}), ...(tp.tall ? { tall: tp.tall } : {}) };
}

/**
 * Every template the menu offers: blank, then plugins' own, then the
 * built-in ones whose plugin doesn't bring one of its own any more (the
 * built-in `agents` steps aside once the agents plugin declares a template).
 */
export function allTemplates(catalog: { id: string; templates: Parameters<typeof pluginTemplate>[0][] }[], has: (type: string) => boolean): Template[] {
  const fromPlugins = catalog.flatMap((p) => p.templates.map(pluginTemplate));
  const withOwn = new Set(catalog.filter((p) => p.templates.length).map((p) => p.id));
  return [
    ...TEMPLATES.filter((t) => t.id === 'blank'),
    ...fromPlugins,
    ...TEMPLATES.filter((t) => t.id !== 'blank' && !withOwn.has(t.id) && available(t, has)),
  ];
}

/** A new page built from a template for a `width×height` screen. */
export function pageFromTemplate(t: Template, name: string, width: number, height: number, has: (type: string) => boolean, titleOf: (type: string) => string | undefined): Page {
  const page = newPage(name, width, height);
  page.grid = suggestGrid(width, height);
  const ratio = width / height;
  const tall = ratio < 0.7;
  const squareish = !tall && ratio < 1.6;
  const fracs = tall ? (t.tall ?? turned(t.wide)) : squareish ? (t.square ?? t.wide) : t.wide;
  const { cols, rows } = page.grid;
  const tiles: Tile[] = [];
  for (const f of fracs) {
    const widgets = f.widgets
      .map((w) => (typeof w === 'string' ? [w, {}] as const : w))
      .filter(([type]) => has(type))
      .map(([type, options]) => newWidget(type, { ...options }, f.chrome === 'bare' || squareish ? undefined : titleOf(type)));
    if (!widgets.length) continue;
    const x = Math.round(f.x * cols);
    const y = Math.round(f.y * rows);
    const w = Math.max(1, Math.round((f.x + f.w) * cols) - x);
    const h = Math.max(1, Math.round((f.y + f.h) * rows) - y);
    const tile = newTile({ x, y, w, h }, widgets);
    if (f.chrome) tile.chrome = f.chrome;
    tiles.push(tile);
  }
  page.gravity = 'none';
  page.tiles = compact(tiles, 'none');
  return page;
}

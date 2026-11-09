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
  id: 'blank' | 'agents' | 'cats' | 'news' | 'clock' | 'system';
  icon: string;
  /** Widget types that must exist for the template to make sense. */
  needs: string[];
  wide: Frac[];
  /** For square-ish panels; defaults to `wide`. */
  square?: Frac[];
}

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
  },
];

export function available(t: Template, has: (type: string) => boolean): boolean {
  return t.needs.every(has);
}

/** A new page built from a template for a `width×height` screen. */
export function pageFromTemplate(t: Template, name: string, width: number, height: number, has: (type: string) => boolean, titleOf: (type: string) => string | undefined): Page {
  const page = newPage(name, width, height);
  page.grid = suggestGrid(width, height);
  const squareish = width / height < 1.6;
  const fracs = squareish ? (t.square ?? t.wide) : t.wide;
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

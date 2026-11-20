/**
 * The config of a first run: one virtual screen with a page that shows off
 * what's installed, so the editor never opens on an empty canvas. Only
 * widgets whose plugin is present are used.
 */
import { localize, type Localized } from '@kiosko/sdk';
import { newPage, newScreen, newTile, newWidget, normalize, rescale, suggestGrid, transposePage, type Config, type Registry, type Tile } from '@kiosko/core';

export function starterConfig(registry: Registry, o: { width?: number; height?: number; locale?: string } = {}): Config {
  const width = o.width ?? 1920;
  const height = o.height ?? 462;
  const L = (t: Localized) => localize(t, o.locale ?? 'en');
  const screen = newScreen(L({ en: 'My panel', es: 'Mi panel', 'zh-Hant': '我的面板', 'zh-Hans': '我的屏幕' }), width, height);
  const has = (t: string) => !!registry.widget(t);
  const page = newPage(L({ en: 'Home', es: 'Inicio', 'zh-Hant': '首頁', 'zh-Hans': '首页' }), width, height);
  page.grid = { cols: 24, rows: 6, gap: 10, padding: 10 };
  page.gravity = 'left';
  const tiles: Tile[] = [];
  const add = (r: { x: number; y: number; w: number; h: number }, types: string[], title?: string) => {
    const ws = types.filter(has).map((t) => newWidget(t, {}, title));
    if (ws.length) tiles.push(newTile(r, ws));
  };
  if (has('agents/sessions')) add({ x: 0, y: 0, w: 11, h: 6 }, ['agents/sessions']);
  else add({ x: 0, y: 0, w: 11, h: 6 }, ['core/text'], L({ en: 'Welcome', es: 'Bienvenida', 'zh-Hant': '歡迎', 'zh-Hans': '欢迎' }));
  add({ x: 11, y: 0, w: 5, h: 4 }, ['core/clock']);
  add({ x: 11, y: 4, w: 5, h: 2 }, ['weather/forecast', 'mirror/compliments']);
  add({ x: 16, y: 0, w: 8, h: 6 }, ['usage/rail', 'vitals/vitals', 'system/health', 'mirror/countdown'].filter(has).slice(0, 3));
  if (!has('agents/sessions')) {
    const welcome = tiles[0]?.widgets[0];
    if (welcome) welcome.options = { text: L({ en: 'Hi there.\nDrag widgets from the library to build your panel.', es: 'Hola.\nArrastra widgets desde la biblioteca para montar tu panel.', 'zh-Hant': '你好。\n從小工具庫拖曳小工具，打造你的面板。', 'zh-Hans': '你好。\n从组件库拖动小组件，搭建你的屏幕。' }), maxSize: 54 };
  }
  page.tiles = tiles;
  // Laid out for a 1920×462 strip: turned a quarter for a portrait screen, fitted for any other.
  if (height > width) transposePage(page, width, height);
  else {
    const grid = suggestGrid(width, height);
    page.tiles = rescale(page.tiles, page.grid, grid);
    page.grid = grid;
  }
  screen.pages = [page];
  screen.interludes = registry.interlude('agents/runner') ? [{ id: 'interlude-runner', type: 'agents/runner', enabled: false, everyMs: 15 * 60_000, maxSeconds: 30, options: {} }] : [];
  return normalize({ screens: [screen], locale: 'auto' });
}

/**
 * The config of a first run: one virtual screen with a page that shows off
 * what's installed, so the editor never opens on an empty canvas. Only
 * widgets whose plugin is present are used.
 */
import { newPage, newScreen, newTile, newWidget, normalize, type Config, type Registry, type Tile } from '@tessera/core';

export function starterConfig(registry: Registry, o: { width?: number; height?: number; locale?: string } = {}): Config {
  const width = o.width ?? 1920;
  const height = o.height ?? 462;
  const es = (o.locale ?? '').startsWith('es');
  const screen = newScreen(es ? 'Mi panel' : 'My panel', width, height);
  const has = (t: string) => !!registry.widget(t);
  const page = newPage(es ? 'Inicio' : 'Home', width, height);
  page.grid = { cols: 24, rows: 6, gap: 10, padding: 10 };
  page.gravity = 'left';
  const tiles: Tile[] = [];
  const add = (r: { x: number; y: number; w: number; h: number }, types: string[], title?: string) => {
    const ws = types.filter(has).map((t) => newWidget(t, {}, title));
    if (ws.length) tiles.push(newTile(r, ws));
  };
  if (has('agents/sessions')) add({ x: 0, y: 0, w: 11, h: 6 }, ['agents/sessions']);
  else add({ x: 0, y: 0, w: 11, h: 6 }, ['core/text'], es ? 'Bienvenida' : 'Welcome');
  add({ x: 11, y: 0, w: 5, h: 4 }, ['core/clock']);
  add({ x: 11, y: 4, w: 5, h: 2 }, ['weather/forecast', 'mirror/compliments']);
  add({ x: 16, y: 0, w: 8, h: 6 }, ['usage/rail', 'vitals/vitals', 'system/health', 'mirror/countdown'].filter(has).slice(0, 3));
  if (!has('agents/sessions')) {
    const welcome = tiles[0]?.widgets[0];
    if (welcome) welcome.options = { text: es ? 'Hola.\nArrastra widgets desde la biblioteca para montar tu panel.' : 'Hi there.\nDrag widgets from the library to build your panel.', maxSize: 54 };
  }
  page.tiles = tiles;
  screen.pages = [page];
  screen.interludes = registry.interlude('agents/runner') ? [{ id: 'interlude-runner', type: 'agents/runner', enabled: false, everyMs: 15 * 60_000, maxSeconds: 30, options: {} }] : [];
  return normalize({ screens: [screen], locale: 'auto' });
}

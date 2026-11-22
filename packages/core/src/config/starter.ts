/**
 * The first page Kiosko offers: what's installed, shown off on a screen of
 * any shape, so the editor never opens on an empty canvas. Pure (no Node):
 * the server's first run (server/src/starter.ts) and the editor's setup
 * wizard (web/src/wizard) both build it from here.
 */
import { localize, pickLocale, type Localized } from '@kiosko/sdk/i18n';
import { LANGUAGE_IDS, languageById } from '@kiosko/sdk/languages';
import { rescale, suggestGrid } from '../layout/grid.ts';
import { STARTER_NAMES, newPage, newTile, newWidget, transposePage, type Config, type InterludeSlot, type Page, type Tile } from './model.ts';

/**
 * What the market of `locale` leaves out (languages.ts: in mainland China
 * neither Claude nor Gemini are offered): a widget type not offered there,
 * and the one painted in its place when it has a stand-in.
 */
export function marketOf(locale: string | undefined): { offered: (type: string) => boolean; instead: (type: string) => string | undefined } {
  const market = languageById(pickLocale(LANGUAGE_IDS, locale ?? 'en') ?? 'en')?.plugins;
  return {
    offered: (t) => !market?.without.includes(t.split('/')[0]!) && !market?.instead[t],
    instead: (t) => market?.instead[t],
  };
}

/**
 * The first page for a `width×height` picture, with what `has` says is
 * installed and works with nothing to set up: the clock and the date, the
 * machine's own vitals and health, a kind word. The agents lead only where
 * they are in use (`agents`), the weather only where the place is known
 * (`weather`). Where the language is read, the services some plugins need
 * may not be offered: the page leaves out the plugins not offered there and
 * the widgets that have a stand-in there (Claude's usage bar), and doesn't
 * put the stand-ins (a balance needs a key) on a page meant to work at once.
 */
export function starterPage(has: (type: string) => boolean, o: { width: number; height: number; locale?: string | undefined; name?: string | undefined; agents?: boolean; weather?: boolean }): Page {
  const { width, height } = o;
  const L = (t: Localized) => localize(t, o.locale ?? 'en');
  const { offered } = marketOf(o.locale);
  const ok = (t: string) => offered(t) && has(t) && (o.weather !== false || !t.startsWith('weather/'));
  const page = newPage(o.name ?? L(STARTER_NAMES.page as Localized), width, height);
  page.grid = { cols: 24, rows: 6, gap: 10, padding: 10 };
  page.gravity = 'left';
  const tiles: Tile[] = [];
  const add = (r: { x: number; y: number; w: number; h: number }, types: (string | [string, Record<string, unknown>])[], title?: string) => {
    const ws = types.filter((t) => ok(typeof t === 'string' ? t : t[0])).map((t) => (typeof t === 'string' ? newWidget(t, {}, title) : newWidget(t[0], { ...t[1] }, title)));
    if (ws.length) tiles.push(newTile(r, ws));
  };
  const lead = 'agents/sessions';
  const agents = o.agents !== false && ok(lead);
  if (agents) {
    add({ x: 0, y: 0, w: 11, h: 6 }, [lead]);
    add({ x: 11, y: 0, w: 5, h: 4 }, ['core/clock']);
  } else {
    // No agents to follow: the time leads, big, with the date under it.
    add({ x: 0, y: 0, w: 11, h: 6 }, [['core/clock', { showDate: true }]]);
    add({ x: 11, y: 0, w: 5, h: 4 }, ['core/date']);
  }
  add({ x: 11, y: 4, w: 5, h: 2 }, ['weather/forecast', 'mirror/compliments']);
  add({ x: 16, y: 0, w: 8, h: 6 }, ['vitals/vitals', 'system/health', 'usage/rail', 'mirror/countdown'].filter(ok).slice(0, 3));
  if (!tiles.length) {
    // Nothing installed at all but the text widget: a hello, so the editor never opens on nothing.
    add({ x: 0, y: 0, w: 24, h: 6 }, ['core/text'], L({ en: 'Welcome', es: 'Bienvenida', de: 'Willkommen', 'zh-Hant': '歡迎', 'zh-Hans': '欢迎' }));
    const welcome = tiles[0]?.widgets[0];
    if (welcome) welcome.options = { text: L({ en: 'Hi there.\nDrag widgets from the library to build your panel.', es: 'Hola.\nArrastra widgets desde la biblioteca para montar tu panel.', de: 'Hallo!\nZieh Widgets aus der Bibliothek, um dein Panel zu gestalten.', 'zh-Hant': '你好。\n從小工具庫拖曳小工具，\n打造你的面板。', 'zh-Hans': '你好。\n从组件库拖动小组件，\n布置你的副屏。' }), maxSize: 54 };
  }
  page.tiles = tiles;
  // Laid out for a 1920×462 strip: turned a quarter for a portrait screen, fitted for any other.
  if (height > width) transposePage(page, width, height);
  else {
    const grid = suggestGrid(width, height);
    page.tiles = rescale(page.tiles, page.grid, grid);
    page.grid = grid;
  }
  return page;
}

/** The interludes a first screen comes with (switched off): the agents' runner, where it is offered and installed. */
export function starterInterludes(hasInterlude: (type: string) => boolean, locale?: string): InterludeSlot[] {
  return marketOf(locale).offered('agents/runner') && hasInterlude('agents/runner') ? [{ id: 'interlude-runner', type: 'agents/runner', enabled: false, everyMs: 15 * 60_000, maxSeconds: 30, options: {} }] : [];
}

/** The widgets a first run's page may hold (starterPage). */
const STARTER_TYPES = new Set(['agents/sessions', 'core/text', 'core/clock', 'core/date', 'weather/forecast', 'mirror/compliments', 'usage/rail', 'vitals/vitals', 'system/health', 'mirror/countdown']);

/**
 * Whether the config is still the first run's, as nobody has changed it: one
 * virtual screen with the starter's name (in any language), its one page with
 * the starter's name and only the starter's widgets. The setup wizard may
 * replace such a screen; anything else is somebody's work and is only added to.
 */
export function looksLikeStarter(c: Pick<Config, 'screens'>): boolean {
  if (c.screens.length !== 1) return false;
  const s = c.screens[0]!;
  const named = (name: string, names: Record<string, string>) => Object.values(names).includes(name);
  if (s.device.driver !== 'virtual' || !named(s.name, STARTER_NAMES.screen) || s.pages.length !== 1) return false;
  const p = s.pages[0]!;
  return named(p.name, STARTER_NAMES.page) && p.tiles.length <= 4 && p.tiles.every((t) => t.widgets.every((w) => STARTER_TYPES.has(w.type)));
}

/** Whether the setup is still to do (the editor offers it on its own, the panels show the welcome card): the first run's, untouched. */
export function offersSetup(c: Pick<Config, 'screens' | 'setup'>): boolean {
  return c.setup === 'pending' || (!c.setup && (c.screens.length === 0 || looksLikeStarter(c)));
}

/**
 * Browser demo only: the editor on autopilot (`?tour=1`), for the site's
 * front page. A ghost cursor composes a page from nothing, the way a person
 * would: finds widgets in the library, drops them on the panel, resizes
 * them, sets an option, stacks one on another, changes the theme. Then it
 * starts again.
 *
 * Every change goes through the editor's own store, so what happens on
 * screen is the real thing; only the hand is fake. Each state is also
 * announced on a BroadcastChannel, for the front page's 3D panel to show
 * what is being composed as it happens.
 *
 * Nothing here runs unless `startTour` is called: this module is reachable
 * from the normal build's module graph and must stay inert there.
 */
import { effect } from '@preact/signals';
import { newPage, newWidget, type Tile } from '@kiosko/core/model';
import { TOUR_CHANNEL, type TourMessage } from '../../demo/protocol.ts';
import { addTileAt } from '../editor/Stage.tsx';
import { config, draftPage, draftScreen, draftTile, edit, go, page, pageId, screen, screenId, selectedTile, selectedWidget, uiTheme, widgets } from '../store.ts';

/** The page it composes; one left from a previous round is removed. */
const PAGE_NAME = 'My desk';

/** Asked for in the address: the editor drives itself and keeps nothing. */
export function touring(): boolean {
  return typeof location !== 'undefined' && new URLSearchParams(location.search).has('tour');
}

export function startTour(): void {
  document.body.classList.add('tour');
  // Dark, as the page it is shown on; not saved, so the visitor's own choice for the demo stays.
  uiTheme.value = 'dark';
  document.documentElement.dataset.theme = 'dark';
  const cursor = document.createElement('div');
  cursor.className = 'tour-cursor';
  cursor.innerHTML =
    '<svg width="26" height="26" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3l14 8.5-6.2 1.4L9.6 19z" fill="#fff" stroke="#0b0d12" stroke-width="1.4" stroke-linejoin="round"/></svg><i></i>';
  document.body.append(cursor);
  let at = { x: innerWidth / 2, y: innerHeight / 2 };
  cursor.style.transform = `translate(${at.x}px, ${at.y}px)`;

  const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(TOUR_CHANNEL) : null;
  let paused = false;
  channel?.addEventListener('message', (e: MessageEvent<{ type?: string }>) => {
    if (e.data?.type === 'pause') paused = true;
    else if (e.data?.type === 'play') paused = false;
  });
  // What is on the editor now, for whoever shows it elsewhere.
  effect(() => {
    const c = config.value;
    const s = screen.value;
    const p = page.value;
    if (c && s && p) channel?.postMessage({ type: 'config', config: c, screenId: s.id, pageId: p.id } satisfies TourMessage);
  });

  /** Waits, and keeps waiting while nobody is watching. */
  const wait = async (ms: number) => {
    await new Promise((r) => setTimeout(r, ms));
    while (paused || document.hidden) await new Promise((r) => setTimeout(r, 300));
  };
  const moveTo = async (x: number, y: number, ms = 650) => {
    at = { x, y };
    cursor.style.setProperty('--ms', `${ms}ms`);
    cursor.style.transform = `translate(${x}px, ${y}px)`;
    await wait(ms + 40);
  };
  /** Moves to a point of an element (fractions of its box). False if it isn't on the page. */
  const pointAt = async (el: Element | null | undefined, fx = 0.5, fy = 0.5, ms?: number) => {
    if (!el) return false;
    el.scrollIntoView({ block: 'nearest' });
    const r = el.getBoundingClientRect();
    await moveTo(r.left + r.width * fx, r.top + r.height * fy, ms);
    return true;
  };
  const click = async () => {
    cursor.classList.add('down');
    await wait(170);
    cursor.classList.remove('down');
    await wait(120);
  };
  const $ = (selector: string) => document.querySelector(selector);
  /** Types in the library's search box, letter by letter. */
  const search = async (text: string) => {
    const input = $('.library input') as HTMLInputElement | null;
    if (!input) return;
    if (text) {
      await pointAt(input, 0.3, 0.5, 450);
      await click();
    }
    for (let i = text ? 1 : 0; i <= text.length; i++) {
      input.value = text.slice(0, i);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      if (text) await wait(70);
    }
  };
  /** Where a grid rectangle's middle is on the panel's picture. */
  const onPanel = (r: { x: number; y: number; w: number; h: number }) => {
    const box = $('.panel-surface')?.getBoundingClientRect();
    const g = page.value?.grid;
    return box && g ? { x: box.left + ((r.x + r.w / 2) / g.cols) * box.width, y: box.top + ((r.y + r.h / 2) / g.rows) * box.height } : null;
  };
  /** Finds a widget in the library and carries it to the panel. */
  const carry = async (type: string, find: string, to: { x: number; y: number; w: number; h: number }) => {
    await search(find);
    await wait(350);
    if (await pointAt($(`.lib-item[data-type="${type}"]`), 0.5, 0.35, 500)) {
      cursor.classList.add('down', 'carrying');
      await wait(200);
    }
    const p = onPanel(to);
    if (p) await moveTo(p.x, p.y, 800);
    cursor.classList.remove('down', 'carrying');
  };
  const drop = async (type: string, find: string, rect: { x: number; y: number; w: number; h: number }) => {
    await carry(type, find, rect);
    addTileAt(type, rect);
    const id = selectedTile.value!;
    await search('');
    await wait(900);
    return id;
  };
  const tileBox = (id: string) => $(`.tile[data-tile="${id}"]`);
  /** Drags an edge of a tile by a row, and the tile takes its new shape. */
  const drag = async (id: string, edge: 'top' | 'bottom', change: (t: Tile) => void) => {
    selectedTile.value = id;
    await wait(300);
    const el = tileBox(id);
    const row = ($('.panel-surface')?.getBoundingClientRect().height ?? 0) / (page.value?.grid.rows ?? 6);
    if (await pointAt(el, 0.5, edge === 'bottom' ? 0.98 : 0.02, 500)) {
      cursor.classList.add('down');
      await wait(160);
      await moveTo(at.x, at.y - row, 520);
    }
    edit((d) => {
      const t = draftPage(d)?.tiles.find((x) => x.id === id);
      if (t) change(t);
    });
    cursor.classList.remove('down');
    await wait(800);
  };
  /** Sets an option of the selected widget, pointing at its field in the inspector first. */
  const option = async (label: string, key: string, value: unknown) => {
    const named = [...document.querySelectorAll('.inspector label, .inspector .field-label')].find((l) => l.textContent?.trim().toLowerCase().startsWith(label.toLowerCase()));
    const field = named?.closest('.field') ?? named ?? $('.inspector');
    field?.scrollIntoView({ block: 'center' });
    if (await pointAt(field, 0.55, 0.7, 600)) await click();
    edit((d) => {
      const w = draftTile(d)?.widgets[0];
      if (w) w.options = { ...w.options, [key]: value };
    });
    await wait(1200);
  };
  const press = async (selector: string, then: () => void, after = 700) => {
    if (await pointAt($(selector), 0.5, 0.5, 600)) await click();
    then();
    await wait(after);
  };

  const round = async () => {
    const cfg = config.value;
    // The bar-shaped screen: that is the panel the front page shows.
    const s = cfg && [...cfg.screens].sort((a, b) => b.width / b.height - a.width / a.height)[0];
    if (!s) return void (await wait(1000));
    screenId.value = s.id;
    go('editor');
    const blank = { ...newPage(PAGE_NAME, s.width, s.height), gravity: 'none' as const };
    edit((d) => {
      const ds = draftScreen(d, s.id);
      if (!ds) return;
      ds.pages = [...ds.pages.filter((p) => p.name !== PAGE_NAME), blank];
      // Shown alone: the other pages don't take its turn away while it is being composed.
      ds.pinnedPage = blank.id;
      d.theme = 'midnight';
    });
    pageId.value = blank.id;
    selectedTile.value = null;
    selectedWidget.value = null;
    await wait(1400);

    // From nothing to a panel: four widgets found in the library and dropped where they go.
    await drop('cats/room', 'cats', { x: 0, y: 0, w: 12, h: 6 });
    const pipelines = await drop('gitlab/pipelines', 'pipel', { x: 12, y: 0, w: 6, h: 6 });
    const clock = await drop('core/clock', 'clock', { x: 18, y: 0, w: 6, h: 3 });
    const weather = await drop('weather/forecast', 'weather', { x: 18, y: 3, w: 6, h: 3 });

    // The clock gives a row to the weather.
    await drag(clock, 'bottom', (t) => (t.h = 2));
    await drag(weather, 'top', (t) => {
      t.y = 2;
      t.h = 4;
    });

    // Every widget has its options: three rows of pipelines, with their details.
    selectedTile.value = pipelines;
    await pointAt(tileBox(pipelines), 0.5, 0.5, 600);
    await click();
    await wait(500);
    await option('Rows', 'rows', 3);
    await option('Layout', 'layout', 'detailed');

    // One tile, two widgets: they take turns.
    await carry('mirror/countdown', 'countd', { x: 18, y: 2, w: 6, h: 4 });
    edit((d) => {
      const t = draftPage(d)?.tiles.find((x) => x.id === weather);
      if (!t) return;
      t.widgets = [...t.widgets, newWidget('mirror/countdown', {}, widgets.value.get('mirror/countdown')?.name)];
      t.rotateMs = 4000;
    });
    selectedTile.value = weather;
    await search('');
    await wait(1800);

    // And the whole look, in one click.
    await press('.rail-btn[data-view="settings"]', () => go('settings'));
    await press('.theme-swatch[data-theme-id="aurora"]', () => edit((d) => (d.theme = 'aurora')), 1500);
    await press('.rail-btn[data-view="editor"]', () => go('editor'));
    selectedTile.value = null;
    await wait(6000);
  };

  void (async () => {
    // The editor has just booted: let it paint first.
    await wait(1200);
    for (;;) {
      try {
        await round();
      } catch (err) {
        console.warn('Kiosko tour:', err);
        await wait(2000);
      }
    }
  })();
}

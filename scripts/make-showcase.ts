/**
 * Writes examples/showcase.json: two screens that show off the built-in
 * plugins. Try it without any setup:
 *
 *   node --conditions=source packages/server/src/cli.ts start --config examples/showcase.json --demo
 */
import { writeFileSync } from 'node:fs';
import { normalize, type Page, type Screen, type Tile, type WidgetInstance } from '@kiosko/core';

let n = 0;
const id = (p: string) => `${p}-${(++n).toString(36).padStart(2, '0')}`;
const W = (type: string, options: Record<string, unknown> = {}, title?: string, extra: Partial<WidgetInstance> = {}): WidgetInstance => ({ id: id('w'), type, options, ...(title ? { title } : {}), ...extra });
const T = (x: number, y: number, w: number, h: number, widgets: WidgetInstance[], chrome: Tile['chrome'] = 'auto', rotateMs = 20_000): Tile => ({ id: id('tile'), x, y, w, h, widgets, rotateMs, chrome });
const page = (name: string, tiles: Tile[], grid = { cols: 24, rows: 6, gap: 10, padding: 10 }): Page => ({ id: id('page'), name, enabled: true, durationMs: 5 * 60_000, when: 'always', grid, gravity: 'none', background: {}, tiles });
const base = { enabled: true, rotate: 0 as const, device: { driver: 'virtual' as const }, interludes: [], pixelShift: { enabled: true, amplitude: 2, periodMs: 480_000 }, sleepWhenIdle: false, jpegQuality: 90, maxFps: 12 };

const wide: Screen = {
  ...base,
  id: 'trofeo',
  name: 'Trofeo Vision',
  width: 1920,
  height: 462,
  pages: [
    page('Dashboard', [
      T(0, 0, 24, 1, [W('agents/summary')], 'bare'),
      T(0, 1, 13, 5, [W('agents/sessions')], 'bare'),
      T(13, 1, 6, 5, [W('vitals/vitals')], 'bare'),
      T(19, 1, 5, 5, [W('usage/rail')], 'bare'),
    ]),
    page('Cats', [
      T(0, 0, 17, 6, [W('cats/room')], 'bare'),
      T(17, 0, 7, 6, [W('weather/forecast', {}, 'Weather'), W('mirror/countdown', {}, 'Countdown'), W('mirror/onthisday', {}, 'On this day'), W('mirror/airquality', {}, 'Air'), W('gitlab/reviews', {}, 'Your reviews')], 'card'),
    ]),
    page('News', [
      T(0, 0, 14, 6, [W('news/headline')], 'bare'),
      T(14, 0, 5, 6, [W('mirror/rainmap', {}, 'Radar'), W('mirror/earthquakes', {}, 'Earthquakes')], 'card'),
      T(19, 0, 5, 3, [W('core/clock', { showDate: true })], 'bare'),
      T(19, 3, 5, 3, [W('system/health', {}, 'The PC'), W('mirror/nowplaying')], 'card'),
    ]),
  ],
  interludes: [{ id: 'runner', type: 'agents/runner', enabled: true, everyMs: 15 * 60_000, maxSeconds: 30, options: {} }],
};

const square: Screen = {
  ...base,
  id: 'square',
  name: 'AIO 480',
  width: 480,
  height: 480,
  pages: [
    page('Home', [
      T(0, 0, 6, 2, [W('core/clock', { showDate: false })], 'bare'),
      T(0, 2, 3, 4, [W('core/date')]),
      T(3, 2, 3, 2, [W('weather/forecast', { hours: 0, days: 0 })]),
      T(3, 4, 3, 2, [W('mirror/compliments')]),
    ], { cols: 6, rows: 6, gap: 6, padding: 6 }),
  ],
};

const cfg = normalize({ locale: 'en', theme: 'midnight', location: { latitude: 40.4168, longitude: -3.7038, name: 'Madrid' }, screens: [wide, square] });
writeFileSync('examples/showcase.json', `${JSON.stringify(cfg, null, 2)}\n`);
console.log('examples/showcase.json');

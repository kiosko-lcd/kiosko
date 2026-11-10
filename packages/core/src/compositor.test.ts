import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createCanvas, type Canvas } from '@napi-rs/canvas';
import { DEFAULT_THEME, definePlugin, defineWidget, t } from '@kiosko/sdk';
import { composePage, composeWidget, rotateCanvas } from './compositor.ts';
import type { Page } from './config/model.ts';
import { normalize as norm } from './config/store.ts';
import { openDevice } from './devices.ts';
import { Registry } from './registry.ts';

const calls: string[] = [];
const probes: { box: { x: number; y: number; w: number; h: number }; time: string; workday: string; located: boolean }[] = [];
const reg = new Registry();
reg.add(
  definePlugin({
    id: 'test',
    name: 'Test',
    version: '1',
    widgets: [
      defineWidget({ id: 'boom', name: 'Boom', render: () => { throw new Error('kaput'); } }),
      defineWidget({
        id: 'probe',
        name: 'Probe',
        options: t.object({ empty: t.boolean(), urgent: t.boolean() }),
        render: (g, ctx) => {
          probes.push({ box: { ...ctx.box }, time: ctx.fmt.time(ctx.now), workday: ctx.workday.start, located: !!ctx.location });
          g.fillStyle = '#00ff00';
          g.fillRect(ctx.box.x, ctx.box.y, ctx.box.w, ctx.box.h);
        },
        empty: ({ options }) => options.empty,
        urgent: ({ options }) => options.urgent,
      }),
      defineWidget({
        id: 'mark',
        name: 'Mark',
        options: t.object({ label: t.string({ default: 'x' }), urgent: t.boolean(), hidden: t.boolean(), idle: t.boolean() }),
        redraw: 'minute',
        render: (g, { box, options }) => {
          calls.push(options.label);
          g.fillStyle = '#ff0000';
          g.fillRect(box.x, box.y, box.w, box.h);
        },
        urgent: ({ options }) => options.urgent,
        visible: ({ options }) => !options.hidden,
        idle: ({ options }) => options.idle,
        demo: () => ({ options: { label: 'demo' } }),
      }),
    ],
  }),
);
const cfg = norm({});
const screen = { width: 400, height: 200, pixelShift: { enabled: false, amplitude: 0, periodMs: 1 } };
const page = (tiles: Page['tiles']): Page => ({ id: 'p', name: 'p', grid: { cols: 4, rows: 2, gap: 0, padding: 0 }, gravity: 'none', background: {}, tiles });
const W = (id: string, type: string, options: Record<string, unknown> = {}) => ({ id, type, options });
const compose = (p: Page, now = 0) => composePage({ cfg, screen, page: p, theme: DEFAULT_THEME, registry: reg, now, working: true, dataOf: () => undefined, sourcesOf: () => ({}) });

test('a widget that throws only breaks its own tile', () => {
  calls.length = 0;
  const r = compose(page([
    { id: 'a', x: 0, y: 0, w: 2, h: 2, widgets: [W('1', 'test/boom')], rotateMs: 0, chrome: 'card' },
    { id: 'b', x: 2, y: 0, w: 2, h: 2, widgets: [W('2', 'test/mark', { label: 'ok' })], rotateMs: 0, chrome: 'bare' },
  ]));
  assert.match(r.tiles[0]!.error ?? '', /kaput/);
  assert.equal(r.tiles[1]!.error, undefined);
  assert.deepEqual(calls, ['ok']);
});

test('urgent beats rotation, hidden ones are skipped, unknown types are ignored', () => {
  const r = compose(page([{ id: 'a', x: 0, y: 0, w: 4, h: 2, rotateMs: 1000, chrome: 'bare', widgets: [W('1', 'test/mark'), W('2', 'test/mark', { hidden: true }), W('3', 'test/mark', { urgent: true }), W('4', 'nope/missing')] }]));
  assert.equal(r.tiles[0]!.shown, '3');
});

test('idle only when every shown widget is idle; nextAt follows redraw and turns', () => {
  const both = compose(page([
    { id: 'a', x: 0, y: 0, w: 2, h: 2, rotateMs: 0, chrome: 'bare', widgets: [W('1', 'test/mark', { idle: true })] },
    { id: 'b', x: 2, y: 0, w: 2, h: 2, rotateMs: 0, chrome: 'bare', widgets: [W('2', 'test/mark', { idle: false })] },
  ]), 1000);
  assert.equal(both.idle, false);
  assert.equal(both.nextAt, 60_000);
  const one = compose(page([{ id: 'a', x: 0, y: 0, w: 4, h: 2, rotateMs: 5000, chrome: 'bare', widgets: [W('1', 'test/mark', { idle: true }), W('2', 'test/mark', { idle: true })] }]), 1000);
  assert.equal(one.idle, true);
  assert.equal(one.nextAt, 5000);
});

test('gallery thumbnails use demo options; placed widgets keep theirs', () => {
  calls.length = 0;
  composeWidget({ cfg, registry: reg, theme: DEFAULT_THEME, type: 'test/mark', width: 100, height: 100 });
  composeWidget({ cfg, registry: reg, theme: DEFAULT_THEME, type: 'test/mark', width: 100, height: 100, options: { label: 'mine' } });
  assert.deepEqual(calls, ['demo', 'mine']);
});

test('rotateCanvas swaps dimensions for 90/270 and keeps them for 180', () => {
  const c = createCanvas(400, 100);
  assert.deepEqual([rotateCanvas(c, 90).width, rotateCanvas(c, 90).height], [100, 400]);
  assert.deepEqual([rotateCanvas(c, 180).width, rotateCanvas(c, 180).height], [400, 100]);
  assert.equal(rotateCanvas(c, 0), c);
});

test('the file device writes frame.jpg atomically and counts frames', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kiosko-'));
  const dev = openDevice({ driver: 'file', dir }, () => undefined);
  await dev.send(Buffer.from('frame-1'));
  await dev.send(Buffer.from('frame-2'));
  assert.deepEqual(readdirSync(dir), ['frame.jpg']);
  assert.equal(readFileSync(join(dir, 'frame.jpg'), 'utf8'), 'frame-2');
  assert.equal(dev.status.framesSent, 2);
  assert.ok(dev.status.ok);
});

test('normalize fills a hand-written config', () => {
  const n = norm({ screens: [{ name: 'x', width: 480, height: 480, pages: [{ tiles: [{ x: 0, y: 0, w: 2, h: 2, widgets: [{ type: 'core/clock' }] }] }] }] });
  const s = n.screens[0]!;
  assert.equal(s.device.driver, 'virtual');
  assert.equal(s.pages[0]!.grid.cols, 6);
  assert.equal(s.pages[0]!.tiles[0]!.widgets[0]!.options && typeof s.pages[0]!.tiles[0]!.widgets[0]!.id, 'string');
});

test('the tile cache repaints only tiles whose inputs changed', () => {
  calls.length = 0;
  const cache = new Map();
  let data: unknown = { v: 1 };
  const p = page([
    { id: 'a', x: 0, y: 0, w: 2, h: 2, widgets: [W('1', 'test/mark', { label: 'A' })], rotateMs: 0, chrome: 'bare' },
    { id: 'b', x: 2, y: 0, w: 2, h: 2, widgets: [W('2', 'test/mark', { label: 'B' })], rotateMs: 0, chrome: 'bare' },
  ]);
  const run = (now: number) => composePage({ cfg, screen, page: p, theme: DEFAULT_THEME, registry: reg, now, working: true, dataOf: (i) => (i.id === '2' ? data : undefined), sourcesOf: () => ({}), cache });
  run(1000);
  assert.deepEqual(calls, ['A', 'B']);
  run(2000); // same minute, same data: nothing repainted
  assert.deepEqual(calls, ['A', 'B']);
  data = { v: 2 }; // B's data changes
  run(3000);
  assert.deepEqual(calls, ['A', 'B', 'B']);
  run(61_000); // new minute: both (redraw: 'minute')
  assert.deepEqual(calls, ['A', 'B', 'B', 'A', 'B']);
});

const pixel = (c: Canvas, x: number, y: number) => [...c.getContext('2d').getImageData(x, y, 1, 1).data.slice(0, 3)];

test('zoom: the widget gets a smaller (or bigger) box and is painted scaled to fill its tile', () => {
  const run = (zoom?: number) => {
    probes.length = 0;
    const r = compose(page([{ id: 'a', x: 1, y: 0, w: 2, h: 2, rotateMs: 0, chrome: 'bare', widgets: [{ ...W('1', 'test/probe'), ...(zoom === undefined ? {} : { zoom }) }] }]));
    return { box: probes[0]!.box, canvas: r.canvas };
  };
  assert.deepEqual(run().box, { x: 100, y: 0, w: 200, h: 200 });
  const big = run(2);
  assert.deepEqual(big.box, { x: 100, y: 0, w: 100, h: 100 });
  // Painting its whole (smaller) box still covers the whole tile, and only it.
  assert.deepEqual(pixel(big.canvas, 101, 1), [0, 255, 0]);
  assert.deepEqual(pixel(big.canvas, 298, 198), [0, 255, 0]);
  assert.notDeepEqual(pixel(big.canvas, 302, 100), [0, 255, 0]);
  const dense = run(0.5);
  assert.deepEqual(dense.box, { x: 100, y: 0, w: 400, h: 400 });
  assert.deepEqual(pixel(dense.canvas, 298, 198), [0, 255, 0]);
  assert.notDeepEqual(pixel(dense.canvas, 302, 100), [0, 255, 0]);
  // Out of range: clamped to 0.5–2; nonsense: 1.
  assert.deepEqual(run(9).box, { x: 100, y: 0, w: 100, h: 100 });
  assert.deepEqual(run(Number.NaN).box, { x: 100, y: 0, w: 200, h: 200 });
});

test('zoom: the card title stays as it is; only the content is scaled', () => {
  probes.length = 0;
  compose(page([{ id: 'a', x: 0, y: 0, w: 4, h: 2, rotateMs: 0, chrome: 'card', widgets: [{ ...W('1', 'test/probe'), title: 'Hi' }] }]));
  const plain = probes[0]!.box;
  probes.length = 0;
  compose(page([{ id: 'a', x: 0, y: 0, w: 4, h: 2, rotateMs: 0, chrome: 'card', widgets: [{ ...W('1', 'test/probe'), title: 'Hi', zoom: 1.25 }] }]));
  const z = probes[0]!.box;
  assert.deepEqual([z.x, z.y], [plain.x, plain.y]);
  assert.ok(Math.abs(z.w - plain.w / 1.25) < 1e-9 && Math.abs(z.h - plain.h / 1.25) < 1e-9);
});

test('zoom is part of the tile cache key', () => {
  const cache = new Map();
  const run = (zoom: number) => {
    probes.length = 0;
    composePage({ cfg, screen, page: page([{ id: 'a', x: 0, y: 0, w: 2, h: 2, rotateMs: 0, chrome: 'bare', widgets: [{ ...W('1', 'test/probe'), zoom }] }]), theme: DEFAULT_THEME, registry: reg, now: 0, working: true, dataOf: () => undefined, sourcesOf: () => ({}), cache });
    return probes.length;
  };
  assert.equal(run(1), 1);
  assert.equal(run(1), 0);
  assert.equal(run(1.5), 1);
});

test('takeOver off: an urgent widget takes its turn like the rest', () => {
  const tile = (takeOver?: boolean) => page([{ id: 'a', x: 0, y: 0, w: 4, h: 2, rotateMs: 1000, chrome: 'bare', widgets: [W('1', 'test/probe'), { ...W('2', 'test/probe', { urgent: true }), ...(takeOver === undefined ? {} : { takeOver }) }] }]);
  assert.equal(compose(tile()).tiles[0]!.shown, '2');
  assert.equal(compose(tile(true)).tiles[0]!.shown, '2');
  assert.equal(compose(tile(false)).tiles[0]!.shown, '1');
  assert.equal(compose(tile(false), 1000).tiles[0]!.shown, '2');
});

test('hideWhenEmpty: an empty widget leaves the rotation only when the user says so', () => {
  const tile = (hideWhenEmpty?: boolean) => page([{ id: 'a', x: 0, y: 0, w: 4, h: 2, rotateMs: 1000, chrome: 'bare', widgets: [{ ...W('1', 'test/probe', { empty: true }), ...(hideWhenEmpty === undefined ? {} : { hideWhenEmpty }) }, W('2', 'test/probe')] }]);
  assert.equal(compose(tile()).tiles[0]!.shown, '1');
  assert.equal(compose(tile(true)).tiles[0]!.shown, '2');
  assert.equal(compose(tile(true), 1000).tiles[0]!.shown, '2');
  // Alone and empty: the tile shows nothing.
  const alone = page([{ id: 'a', x: 0, y: 0, w: 4, h: 2, rotateMs: 0, chrome: 'bare', widgets: [{ ...W('1', 'test/probe', { empty: true }), hideWhenEmpty: true }] }]);
  assert.equal(compose(alone).tiles[0]!.shown, null);
});

test('the render context carries fmt (with the config time format), workday and location', () => {
  const at = new Date(2026, 10, 10, 21, 5).getTime();
  const run = (c: typeof cfg) => {
    probes.length = 0;
    composePage({ cfg: c, screen, page: page([{ id: 'a', x: 0, y: 0, w: 2, h: 2, rotateMs: 0, chrome: 'bare', widgets: [W('1', 'test/probe')] }]), theme: DEFAULT_THEME, registry: reg, now: at, working: true, dataOf: () => undefined, sourcesOf: () => ({}) });
    return probes[0]!;
  };
  assert.equal(run(norm({ locale: 'en-US', timeFormat: '24h' })).time, '21:05');
  assert.equal(run(norm({ locale: 'es', timeFormat: '12h' })).time, '9:05 p. m.');
  const p = run(norm({ locale: 'es', workday: { start: '07:30' }, location: { latitude: 1, longitude: 2 } }));
  assert.deepEqual([p.time, p.workday, p.located], ['21:05', '07:30', true]);
});

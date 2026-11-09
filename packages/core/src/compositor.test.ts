import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createCanvas } from '@napi-rs/canvas';
import { DEFAULT_THEME, definePlugin, defineWidget, t } from '@tessera/sdk';
import { composePage, composeWidget, rotateCanvas } from './compositor.ts';
import type { Page } from './config/model.ts';
import { normalize as norm } from './config/store.ts';
import { openDevice } from './devices.ts';
import { Registry } from './registry.ts';

const calls: string[] = [];
const reg = new Registry();
reg.add(
  definePlugin({
    id: 'test',
    name: 'Test',
    version: '1',
    widgets: [
      defineWidget({ id: 'boom', name: 'Boom', render: () => { throw new Error('kaput'); } }),
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
  const dir = mkdtempSync(join(tmpdir(), 'tessera-'));
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

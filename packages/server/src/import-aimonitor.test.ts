import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Registry } from '@tessera/core';
import { importAimonitor } from './import-aimonitor.ts';

const OLD = {
  width: 1920,
  height: 462,
  scene: { mode: 'alternar', alternateMs: 600000, side: 'derecha', room: 'rotar', place: { latitude: 40.4, longitude: -3.7 } },
  usage: { enabled: false },
  rail: { enabled: false },
  calendar: { enabled: true, icsUrl: 'https://outlook.example/secret.ics' },
  trcc: { frameDir: '$XDG_RUNTIME_DIR/aimonitor/panel', frameRotate: 180 },
  modules: [
    { module: 'countdown', header: 'Countdown', when: 'jornada' },
    { module: 'pizarra', header: 'Board', config: { cycleMs: 480000 } },
    { module: 'horas' },
  ],
  screens: [
    { name: 'news', dir: '/run/news', width: 1920, height: 462, rotate: 180, modules: [
      { module: 'noticias', weight: 2 },
      { module: 'rainmap', column: 1 },
      { module: 'airquality', column: 1 },
    ] },
  ],
};

test('imports the main panel as dashboard + cats pages, alternating', () => {
  const { config } = importAimonitor(OLD, new Registry());
  const main = config.screens[0]!;
  assert.deepEqual(main.pages.map((p) => p.name), ['Dashboard', 'Cats']);
  assert.equal(main.pinnedPage, undefined);
  assert.deepEqual(main.device, { driver: 'file', dir: '$XDG_RUNTIME_DIR/aimonitor/panel', format: 'jpeg' });
  assert.equal(main.rotate, 180);
  // No rail: usage was disabled.
  assert.ok(!main.pages[0]!.tiles.some((t) => t.widgets.some((w) => w.type === 'usage/rail')));
  assert.deepEqual(config.location, { latitude: 40.4, longitude: -3.7 });
});

test('modules become a stack; custom ones run through the legacy adapter; unported ones are skipped', () => {
  const { config, notes } = importAimonitor(OLD, new Registry());
  const stack = config.screens[0]!.pages[1]!.tiles[1]!.widgets;
  assert.deepEqual(stack.map((w) => w.type), ['mirror/countdown', 'legacy/module']);
  assert.equal(stack[0]!.when, 'work');
  assert.equal(stack[1]!.options.module, 'pizarra');
  assert.ok(notes.some((n) => n.includes('horas')));
});

test('extra screens keep shared columns as stacks and weights as widths', () => {
  const { config } = importAimonitor(OLD, new Registry());
  const news = config.screens[1]!;
  const tiles = news.pages[0]!.tiles;
  assert.equal(tiles.length, 2);
  assert.deepEqual(tiles[1]!.widgets.map((w) => w.type), ['mirror/rainmap', 'mirror/airquality']);
  assert.equal(tiles[0]!.w, 16);
  assert.equal(tiles[0]!.w + tiles[1]!.w, 24);
});

test('never copies calendar URLs', () => {
  const { config, notes } = importAimonitor(OLD, new Registry());
  assert.ok(!JSON.stringify(config).includes('secret.ics'));
  assert.ok(notes.some((n) => /calendar/.test(n) && /NOT copied/.test(n)));
});

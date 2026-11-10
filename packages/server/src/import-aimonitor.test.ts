import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Registry } from '@kiosko/core';
import { importAimonitor, optionsOf } from './import-aimonitor.ts';

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

test('the mode file wins over scene.mode', () => {
  const { config } = importAimonitor(OLD, new Registry(), 'gatos\n');
  const main = config.screens[0]!;
  assert.equal(main.pinnedPage, main.pages[1]!.id);
});

test('--with-secrets copies the ICS URLs into the calendar source', () => {
  const { config } = importAimonitor(OLD, new Registry(), null, { withSecrets: true });
  assert.deepEqual((config.sources['calendar/events'] as { urls: string[] }).urls, ['https://outlook.example/secret.ics']);
});

test('module settings become the options of today: renamed keys, minutes in ms, a threshold pair', () => {
  assert.deepEqual(optionsOf('countdown', { max: 3, warnDays: 7 }), { rows: 3, warnDays: 7 });
  assert.deepEqual(optionsOf('agenda', { tomorrow: false, warnMin: 10, holdMin: 5 }), { days: 1, warnMs: 600_000, holdMs: 300_000 });
  assert.deepEqual(optionsOf('syshealth', { tempWarn: 85, mounts: ['/'] }), { tempAlert: 85, tempWarn: 70, mounts: ['/'] });
  assert.deepEqual(optionsOf('tasks', { gitlab: true }), { includeIssues: true });
  assert.deepEqual(optionsOf('pipelines', { aliases: { a: 'b' } }), { aliases: { a: 'b' } });
  assert.deepEqual(optionsOf('nowplaying'), {});
});

test('the disk to watch goes to the vitals source; the timesheet day to the working week', () => {
  const { config } = importAimonitor({ ...OLD, system: { diskPath: '/home' }, timesheet: { workday: { start: '09:00', end: '16:30', hours: 7.5, weekly: 40, friday: { end: '15:00', hours: 6 }, holidays: ['2026-10-12'] } } }, new Registry());
  assert.deepEqual(config.sources['system/vitals'], { diskPath: '/home' });
  const vitals = config.screens[0]!.pages[0]!.tiles.flatMap((t) => t.widgets).find((w) => w.type === 'vitals/vitals')!;
  assert.deepEqual(vitals.options, {});
  assert.deepEqual(config.workday, { days: [1, 2, 3, 4, 5], start: '09:00', end: '16:30', hours: 7.5, holidays: ['2026-10-12'], byDay: { '5': { end: '15:00', hours: 6 } } });
});

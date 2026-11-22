import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Registry } from '@kiosko/core';
import core from '@kiosko/plugin-core';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentTraces, starterConfig, starterPanels } from './starter.ts';

const reg = new Registry();
reg.add(core);

test('the first page fits the screen it is made for: a strip, a square, a panel on its side', () => {
  const tilesOf = (w: number, h: number) => {
    const p = starterConfig(reg, { width: w, height: h }).screens[0]!.pages[0]!;
    return { grid: [p.grid.cols, p.grid.rows], tiles: p.tiles.map((t) => [t.x, t.y, t.w, t.h]) };
  };
  assert.deepEqual(tilesOf(1920, 462), { grid: [24, 6], tiles: [[0, 0, 11, 6], [11, 0, 5, 4]] });
  // On its side the columns become bands, top to bottom.
  assert.deepEqual(tilesOf(462, 1920), { grid: [6, 24], tiles: [[0, 0, 6, 11], [0, 11, 4, 5]] });
  const square = tilesOf(480, 480);
  assert.deepEqual(square.grid, [6, 6]);
  for (const [x, y, w, h] of square.tiles) assert.ok(x! + w! <= 6 && y! + h! <= 6);
});

test('in mainland China the first page has the agents used there but not Claude’s usage bar (languages.ts)', async () => {
  const { definePlugin } = await import('@kiosko/sdk');
  const r = new Registry();
  r.add(core);
  const w = (id: string) => ({ id, name: id, render() {} });
  for (const [id, widgets] of [['agents', ['sessions', 'summary']], ['usage', ['rail']], ['llm', ['models', 'status']], ['system', ['health']]] as const) {
    r.add(definePlugin({ id, name: id, version: '1', widgets: widgets.map(w) }));
  }
  const types = (locale: string) => starterConfig(r, { locale }).screens[0]!.pages[0]!.tiles.flatMap((t) => t.widgets.map((x) => x.type));
  assert.deepEqual(types('zh-CN'), ['agents/sessions', 'core/clock', 'system/health']);
  assert.deepEqual(types('zh-TW'), ['agents/sessions', 'core/clock', 'system/health', 'usage/rail']);
});

test('the first run’s config is offered the setup; once changed, done or skipped it is not', async () => {
  const { looksLikeStarter, offersSetup, newScreen } = await import('@kiosko/core');
  for (const locale of ['en', 'es-ES', 'zh-CN', 'de']) {
    const c = starterConfig(reg, { locale });
    assert.equal(c.setup, 'pending', locale);
    assert.ok(looksLikeStarter(c), locale);
    assert.ok(offersSetup(c), locale);
  }
  const c = starterConfig(reg, { locale: 'es' });
  assert.equal(offersSetup({ ...c, setup: 'skipped' }), false);
  assert.equal(offersSetup({ ...c, setup: 'done' }), false);
  assert.ok(offersSetup({ screens: [] }), 'no screens at all');
  // A config from before `setup`: told by its looks.
  const old = structuredClone(c);
  delete old.setup;
  assert.ok(offersSetup(old));
  const renamed = structuredClone(old);
  renamed.screens[0]!.name = 'Desk';
  assert.equal(offersSetup(renamed), false, 'a renamed screen is somebody’s work');
  const usb = structuredClone(old);
  usb.screens[0]!.device = { driver: 'usb', serial: 'X' };
  assert.equal(offersSetup(usb), false, 'a connected panel');
  const more = structuredClone(old);
  more.screens[0]!.pages[0]!.tiles[0]!.widgets.push({ id: 'w-x', type: 'news/headline', options: {} });
  assert.equal(offersSetup(more), false, 'a widget the first run never puts');
  assert.equal(offersSetup({ screens: [old.screens[0]!, newScreen('Two')] }), false, 'two screens');
});

test('the first start: a screen per panel found, named by model, at its size and angle; none found, one virtual', () => {
  const found = {
    usb: [
      { serial: 'A1', key: 'A1', width: 1920, height: 462, location: '1-1' },
      { serial: 'B2', key: 'B2', width: 0, height: 0, location: '1-2', error: 'busy' },
      { serial: 'C3', key: 'C3', width: 1920, height: 462, rotate: 90, location: '1-3' },
    ],
    trcc: [{ key: '0416:5302', width: 480, height: 480 }],
  };
  const panels = starterPanels(found);
  assert.deepEqual(panels.map((p) => p.name), ['Trofeo Vision 9.16″ 1', 'Trofeo Vision 9.16″ 2', 'Trofeo Vision 9.16″ 3', 'Square 480×480']);
  const cfg = starterConfig(reg, { panels, agents: false, weather: false });
  assert.deepEqual(cfg.screens.map((s) => [s.width, s.height, s.rotate, s.device.driver]), [[1920, 462, 0, 'usb'], [1920, 462, 0, 'usb'], [1920, 462, 90, 'usb'], [480, 480, 0, 'trcc']]);
  assert.deepEqual(cfg.screens[3]!.device, { driver: 'trcc', url: 'http://127.0.0.1:8099', deviceKey: '0416:5302' });
  for (const s of cfg.screens) for (const p of s.pages) for (const t of p.tiles) assert.ok(t.x + t.w <= p.grid.cols && t.y + t.h <= p.grid.rows, `${s.name}: in its grid`);
  assert.equal(cfg.setup, 'pending');
  const none = starterConfig(reg, { panels: [] });
  assert.deepEqual(none.screens.map((s) => s.device.driver), ['virtual']);
});

test('the first page works with nothing to set up: agents and the cats room only where agents are in use, weather only with a place', async () => {
  const { definePlugin } = await import('@kiosko/sdk');
  const r = new Registry();
  r.add(core);
  const w = (id: string) => ({ id, name: id, render() {} });
  for (const [id, widgets] of [['agents', ['sessions']], ['cats', ['room']], ['weather', ['forecast']], ['vitals', ['vitals']], ['system', ['health']]] as const) r.add(definePlugin({ id, name: id, version: '1', widgets: widgets.map(w) }));
  const types = (o: { agents: boolean; weather: boolean }) => starterConfig(r, o).screens[0]!.pages.map((p) => p.tiles.flatMap((t) => t.widgets.map((x) => x.type)));
  assert.deepEqual(types({ agents: false, weather: false }), [['core/clock', 'core/date', 'vitals/vitals', 'system/health']]);
  assert.deepEqual(types({ agents: true, weather: false }), [['agents/sessions', 'core/clock', 'vitals/vitals', 'system/health'], ['cats/room']]);
  assert.ok(types({ agents: false, weather: true })[0]!.includes('weather/forecast'));
});

test('agent traces: the hook’s session files or the agents’ own logs, never an empty folder', () => {
  const home = mkdtempSync(join(tmpdir(), 'kiosko-home-'));
  try {
    assert.equal(agentTraces({}, home), false);
    mkdirSync(join(home, '.aimonitor', 'sessions'), { recursive: true });
    assert.equal(agentTraces({}, home), false, 'empty');
    writeFileSync(join(home, '.aimonitor', 'sessions', 's.json'), '{}');
    assert.equal(agentTraces({}, home), true);
    assert.equal(agentTraces({ AGENT_SESSIONS_DIR: join(home, 'nowhere') }, home), false, 'the folder the environment names');
    mkdirSync(join(home, '.codex', 'sessions', '2026'), { recursive: true });
    assert.equal(agentTraces({ AGENT_SESSIONS_DIR: join(home, 'nowhere') }, home), true, 'Codex’s own logs');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

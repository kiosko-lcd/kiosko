/**
 * Source profiles as the editor sees them: the catalogue says which sources
 * have them, a saved config with profiles runs them, `/api/choices` answers
 * with the data of the widget's profile and the status tells them apart.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { normalize, Registry, Runtime } from '@kiosko/core';
import { definePlugin, defineSource, defineWidget, t } from '@kiosko/sdk';
import { startServer } from './server.ts';

process.env.KIOSKO_QUIET = '1';

const deck = defineSource({
  id: 'deck',
  name: 'Deck',
  profiles: true,
  options: t.object({ outlets: t.list(t.string()) }),
  read: async (ctx) => ({ outlets: ctx.options.outlets }),
  choices: { outlets: (d: { outlets: string[] }) => d.outlets.map((value) => ({ value })) },
});
const battery = defineSource({ id: 'battery', name: 'Battery', read: async () => 1 });
const plugin = definePlugin({
  id: 'nw',
  name: 'News',
  version: '1.0.0',
  sources: [deck, battery],
  widgets: [defineWidget({ id: 'headline', name: 'Headline', sources: ['nw/deck'], options: t.object({ outlets: t.filter({ choices: { source: 'nw/deck', list: 'outlets' } }) }), render: () => undefined })],
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('the editor and source profiles: catalogue, saving, choices of the widget\'s profile, status', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kiosko-profiles-'));
  const reg = new Registry();
  reg.add(plugin);
  const screen = (profile?: string) => ({ id: 's', name: 'S', width: 64, height: 32, device: { driver: 'virtual' }, pages: [{ id: 'p', name: 'p', grid: { cols: 1, rows: 1, gap: 0, padding: 0 }, tiles: [{ id: 't', x: 0, y: 0, w: 1, h: 1, widgets: [{ id: 'w', type: 'nw/headline', options: {}, ...(profile ? { profile } : {}) }] }] }] });
  const rt = new Runtime(reg, normalize({ sources: { 'nw/deck': { outlets: ['El País', 'ABC'] } }, screens: [screen()] }));
  rt.start();
  // Below 40 000: Windows reserves blocks of its dynamic range.
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const configPath = join(dir, 'config.json');
  const srv = startServer({ runtime: rt, host: '127.0.0.1', port, configPath, webDir: dir, version: '0', checkUpdates: false, homeassistant: false });
  const base = `http://127.0.0.1:${port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-kiosko': '1' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: (await r.json()) as any };
  };
  try {
    await sleep(100);
    const state = (await call('GET', '/api/state')).body;
    const sources = state.catalog.find((p: { id: string }) => p.id === 'nw').sources;
    assert.deepEqual(sources.map((s: { type: string; profiles: boolean }) => [s.type, s.profiles]), [['nw/deck', true], ['nw/battery', false]]);

    // The editor saves a profile and moves the widget to it.
    const cfg = { ...state.config, sourceProfiles: { 'nw/deck': { tech: { name: 'Tecnología', options: { outlets: ['Xataka', 'Genbeta'] } } } }, screens: [screen('tech')] };
    const saved = await call('PUT', '/api/config', { config: cfg, baseRev: state.rev });
    assert.equal(saved.status, 200);
    assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')).sourceProfiles, cfg.sourceProfiles, 'written as it came');
    for (let i = 0; i < 100 && rt.hub.data('nw/deck#tech') === undefined; i++) await sleep(20);
    // The default one stops: no widget reads it any more.
    assert.deepEqual(rt.hub.running().map((r) => r.key), ['nw/deck#tech']);

    const choices = async (q: string) => (await call('GET', `/api/choices?source=nw/deck&list=outlets${q}`)).body;
    assert.deepEqual((await choices('&profile=tech')).choices.map((c: { value: string }) => c.value), ['Xataka', 'Genbeta'], "the widget's profile");
    assert.equal((await choices('&profile=tech')).from, 'live');
    assert.equal((await choices('')).from, 'none', 'the default one: not running now, and no demo');
    assert.equal((await choices('&profile=gone')).from, 'none', 'an unknown profile is the default one');

    const st = (await call('GET', '/api/state')).body.status.sources;
    assert.deepEqual(st.map((s: { type: string; key: string; profile: string | null }) => [s.type, s.key, s.profile]), [['nw/deck', 'nw/deck#tech', 'tech']]);
  } finally {
    srv.close();
    rt.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

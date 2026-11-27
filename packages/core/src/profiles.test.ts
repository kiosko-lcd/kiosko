/**
 * Source profiles (config/profiles.ts): several named configurations of one
 * source, each read on its own; a widget picks one with its `profile`.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { definePlugin, defineSource, defineWidget, t } from '@kiosko/sdk';
import { validateConfig } from './config/check.ts';
import { diffConfigs } from './config/diff.ts';
import { deleteProfile, newProfileId, normalizeProfiles, parseSourceKey, profileUsers, resolveSourceKey, sourceKey, sourceKeysOf, sourceOptionsOf } from './config/profiles.ts';
import { planImport } from './config/review.ts';
import { backgroundSources } from './config/sources.ts';
import { normalize } from './config/store.ts';
import { Registry } from './registry.ts';
import { ruleSources } from './context.ts';
import { Runtime } from './runtime.ts';

process.env.KIOSKO_QUIET = '1';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 4000, what = 'timed out') {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await sleep(20);
  assert.ok(cond(), what);
}

/** What each read was asked with: its options and its profile. */
const reads: { feed: string; profile: string | undefined }[] = [];
const deck = defineSource({
  id: 'deck',
  name: 'Deck',
  profiles: true,
  options: t.object({ feed: t.string({ default: 'general' }) }),
  read: async (ctx) => {
    reads.push({ feed: ctx.options.feed, profile: ctx.profile });
    return { feed: ctx.options.feed };
  },
});
/** A source that doesn't accept profiles (one thing to read). */
const battery = defineSource({ id: 'battery', name: 'Battery', options: t.object({ device: t.string({ default: 'hid0' }) }), read: async (ctx) => ({ device: ctx.options.device }) });
const warnings = defineSource({ id: 'warnings', name: 'Warnings', profiles: true, background: true, options: t.object({ region: t.string({ default: 'es' }) }), read: async (ctx) => ({ region: ctx.options.region }), alerts: ({ data }) => (data ? [{ id: `w-${data.region}`, level: 'warn', title: `Warning ${data.region}` }] : []) });

/** What the widgets saw: in `render`, in `fetch` and in `alerts`, by instance id. */
const seen = { render: new Map<string, unknown>(), fetch: new Map<string, unknown>() };
const plugin = definePlugin({
  id: 'nw',
  name: 'News',
  version: '1.0.0',
  sources: [deck, battery, warnings],
  widgets: [
    defineWidget({
      id: 'headline',
      name: 'Headline',
      sources: ['nw/deck', 'nw/battery'],
      fetch: async (ctx) => (seen.fetch.set(ctx.options.tag, ctx.sources), 1),
      options: t.object({ tag: t.string() }),
      render: (_g, ctx) => void seen.render.set(ctx.options.tag, ctx.sources),
    }),
    defineWidget({ id: 'clock', name: 'Clock', render: () => undefined }),
  ],
});

function registry(): Registry {
  const reg = new Registry();
  reg.add(plugin);
  return reg;
}

const widget = (tag: string, profile?: string) => ({ id: `w-${tag}`, type: 'nw/headline', options: { tag }, ...(profile ? { profile } : {}) });
function config(o: { profiles?: unknown; widgets: object[]; sources?: Record<string, unknown> }) {
  return normalize({
    sources: o.sources ?? { 'nw/deck': { feed: 'general' } },
    ...(o.profiles ? { sourceProfiles: o.profiles } : {}),
    screens: [{ id: 's', name: 'S', width: 64 * o.widgets.length, height: 32, pixelShift: { enabled: false }, device: { driver: 'virtual' }, pages: [{ id: 'p', name: 'p', grid: { cols: o.widgets.length, rows: 1, gap: 0, padding: 0 }, tiles: o.widgets.map((w, i) => ({ id: `t${i}`, x: i, y: 0, w: 1, h: 1, widgets: [w] })) }] }],
  });
}
const TECH = { 'nw/deck': { tech: { name: 'Tecnología', options: { feed: 'tech' } } } };

test('profiles: keys, resolution and options', () => {
  const reg = registry();
  const src = (x: string) => reg.source(x);
  assert.equal(sourceKey('nw/deck'), 'nw/deck');
  assert.equal(sourceKey('nw/deck', 'tech'), 'nw/deck#tech');
  assert.deepEqual(parseSourceKey('nw/deck#tech'), { type: 'nw/deck', profile: 'tech' });
  assert.deepEqual(parseSourceKey('nw/deck'), { type: 'nw/deck', profile: null });
  const cfg = { sources: { 'nw/deck': { feed: 'general' } }, sourceProfiles: TECH };
  assert.equal(resolveSourceKey(cfg, 'nw/deck', 'tech', src('nw/deck')), 'nw/deck#tech');
  assert.equal(resolveSourceKey(cfg, 'nw/deck', undefined, src('nw/deck')), 'nw/deck', 'no profile: the default one');
  assert.equal(resolveSourceKey(cfg, 'nw/deck', 'gone', src('nw/deck')), 'nw/deck', 'a deleted profile: the default one');
  assert.equal(resolveSourceKey(cfg, 'nw/deck', 'toString', src('nw/deck')), 'nw/deck', 'not fooled by Object.prototype');
  assert.equal(resolveSourceKey({ sourceProfiles: { 'nw/battery': { tech: { name: 'x', options: {} } } } }, 'nw/battery', 'tech', src('nw/battery')), 'nw/battery', 'a source without profiles: always the default');
  // One `profile` for the widget: each source it reads that has it.
  assert.deepEqual(sourceKeysOf(cfg, ['nw/deck', 'nw/battery'], 'tech', src), [['nw/deck', 'nw/deck#tech'], ['nw/battery', 'nw/battery']]);
  assert.deepEqual(sourceOptionsOf(cfg, 'nw/deck#tech'), { feed: 'tech' });
  assert.deepEqual(sourceOptionsOf(cfg, 'nw/deck'), { feed: 'general' });
  assert.deepEqual(sourceOptionsOf(cfg, 'nw/deck#gone'), {});
});

test('profiles: ids from names, and what normalize keeps', () => {
  assert.equal(newProfileId('Tecnología', []), 'tecnologia');
  assert.equal(newProfileId('Tecnología', ['tecnologia', 'tecnologia-2']), 'tecnologia-3');
  assert.equal(newProfileId('体育', []), 'profile', 'no Latin letters: a generic id');
  assert.equal(newProfileId('  Work account!  ', []), 'work-account');
  assert.equal(normalizeProfiles(undefined), undefined);
  assert.equal(normalizeProfiles({ 'nw/deck': {} }), undefined, 'empty lists go');
  assert.deepEqual(normalizeProfiles({ 'nw/deck': { tech: { options: { feed: 'x' } }, 'Bad Id': { name: 'x', options: {} }, sport: { name: 'Sports' } }, 'nw/x': [] }), { 'nw/deck': { tech: { name: 'tech', options: { feed: 'x' } }, sport: { name: 'Sports', options: {} } } });
});

test('profiles: migration-free, a config without them is exactly what it was', () => {
  const raw = { sources: { 'nw/deck': { feed: 'general' } }, screens: [{ id: 's', pages: [{ id: 'p', tiles: [{ id: 't', widgets: [{ id: 'w', type: 'nw/headline', options: {} }] }] }] }] };
  const cfg = normalize(raw);
  assert.equal('sourceProfiles' in cfg, false, 'normalize adds nothing');
  assert.deepEqual(normalize(JSON.parse(JSON.stringify(cfg))), cfg);
  assert.deepEqual(diffConfigs(cfg, normalize(raw)), []);
  // And at run time every key is the bare type: the same sources as before.
  const reg = registry();
  const rt = new Runtime(reg, config({ widgets: [widget('a')] }));
  rt.apply(rt.config);
  try {
    assert.deepEqual(rt.hub.running().map((r) => r.key).sort(), ['nw/battery', 'nw/deck']);
    assert.deepEqual(rt.sourceKeys(['nw/deck'], 'tech'), ['nw/deck'], 'a profile that is not in the config: the default one');
  } finally {
    rt.stop();
  }
});

test('profiles: each one is read on its own, with its options, and each widget gets its own data in render and fetch', async () => {
  reads.length = 0;
  seen.render.clear();
  seen.fetch.clear();
  const reg = registry();
  const rt = new Runtime(reg, config({ profiles: TECH, widgets: [widget('a'), widget('b', 'tech'), widget('c', 'gone')] }));
  rt.start();
  try {
    await until(() => reads.length >= 2 && seen.fetch.size === 3);
    assert.deepEqual(rt.hub.running().map((r) => r.key).sort(), ['nw/battery', 'nw/deck', 'nw/deck#tech'], 'two decks, one battery');
    assert.deepEqual(reads.map((r) => `${r.feed}:${r.profile ?? '-'}`).sort(), ['general:-', 'tech:tech'], 'each read with its options; ctx.profile only for a profile');
    // The first fetches may have come before the first reads: once more, now that there is data.
    await until(() => rt.hub.data('nw/deck') !== undefined && rt.hub.data('nw/deck#tech') !== undefined);
    seen.fetch.clear();
    rt.refreshWidget('w-a');
    rt.refreshWidget('w-b');
    rt.refreshWidget('w-c');
    await until(() => seen.fetch.size === 3);
    assert.deepEqual(seen.fetch.get('a'), { 'nw/deck': { feed: 'general' }, 'nw/battery': { device: 'hid0' } });
    assert.deepEqual(seen.fetch.get('b'), { 'nw/deck': { feed: 'tech' }, 'nw/battery': { device: 'hid0' } }, 'under the same name, the profile\'s data');
    assert.deepEqual(seen.fetch.get('c'), { 'nw/deck': { feed: 'general' }, 'nw/battery': { device: 'hid0' } }, 'a profile that is gone: the default one');
    await until(() => (seen.render.get('b') as Record<string, unknown>)?.['nw/deck'] !== undefined && (seen.render.get('a') as Record<string, unknown>)?.['nw/deck'] !== undefined);
    assert.deepEqual((seen.render.get('a') as Record<string, unknown>)['nw/deck'], { feed: 'general' });
    assert.deepEqual((seen.render.get('b') as Record<string, unknown>)['nw/deck'], { feed: 'tech' });
    // The status tells the profiles apart.
    const st = rt.status().sources.filter((s) => s.type === 'nw/deck').map((s) => [s.key, s.profile]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    assert.deepEqual(st, [['nw/deck', null], ['nw/deck#tech', 'tech']]);

    // Its options changed: only that profile is read again.
    const before = reads.length;
    rt.apply(config({ profiles: { 'nw/deck': { tech: { name: 'Tecnología', options: { feed: 'tech2' } } } }, widgets: [widget('a'), widget('b', 'tech')] }));
    await until(() => reads.length > before);
    await sleep(100);
    assert.deepEqual(reads.slice(before).map((r) => r.feed), ['tech2'], 'the default one keeps running untouched');

    // No widget on it any more: it stops.
    rt.apply(config({ profiles: TECH, widgets: [widget('a')] }));
    assert.deepEqual(rt.hub.running().map((r) => r.key).sort(), ['nw/battery', 'nw/deck']);
  } finally {
    rt.stop();
  }
});

test('profiles: a source without them ignores the widget\'s profile', async () => {
  const reg = registry();
  const rt = new Runtime(reg, config({ profiles: { 'nw/battery': { tech: { name: 'x', options: { device: 'other' } } } }, widgets: [widget('a', 'tech')] }));
  rt.apply(rt.config);
  try {
    assert.deepEqual(rt.hub.running().map((r) => r.key).sort(), ['nw/battery', 'nw/deck']);
  } finally {
    rt.stop();
  }
  const r = validateConfig(normalize({ sourceProfiles: { 'nw/battery': { tech: { name: 'x', options: {} } } } }), [plugin]);
  assert.ok(r.warnings.some((w) => w.path === 'sourceProfiles["nw/battery"]' && /no profiles/.test(w.message)), JSON.stringify(r.warnings));
});

test('profiles: background profiles run on their own, and their alerts come in', async () => {
  const reg = registry();
  const find = (x: string) => reg.source(x);
  const cfg = { sources: { 'nw/warnings': { background: true } }, sourceProfiles: { 'nw/warnings': { pt: { name: 'Portugal', options: { region: 'pt', background: true } }, fr: { name: 'France', options: { region: 'fr' } } } } };
  assert.deepEqual(backgroundSources(cfg, find), ['nw/warnings', 'nw/warnings#pt']);
  const rt = new Runtime(reg, normalize({ ...cfg, screens: [{ id: 's', name: 'S', width: 64, height: 32, device: { driver: 'virtual' }, pages: [{ id: 'p', name: 'p', grid: { cols: 1, rows: 1, gap: 0, padding: 0 }, tiles: [] }] }] }));
  rt.start();
  try {
    await until(() => rt.listAlerts().length === 2);
    assert.deepEqual(rt.listAlerts().map((a) => a.id).sort(), ['nw/warnings:w-es', 'nw/warnings:w-pt']);
  } finally {
    rt.stop();
  }
});

test('profiles: editing them, check, diff and import', () => {
  const reads = (type: string) => type === 'nw/headline';
  const cfg = config({ profiles: { 'nw/deck': { ...TECH['nw/deck'], sport: { name: 'Deportes', options: { feed: 'sport' } } } }, widgets: [widget('a', 'tech'), widget('b', 'tech'), widget('c', 'sport'), { id: 'w-clock', type: 'nw/clock', options: {}, profile: 'tech' }] });
  assert.equal(profileUsers(cfg, 'tech', reads).length, 2, 'the clock reads no deck: not a user');
  assert.equal(deleteProfile(cfg, 'nw/deck', 'tech', reads), 2);
  assert.deepEqual(Object.keys(cfg.sourceProfiles!['nw/deck']!), ['sport']);
  assert.equal(cfg.screens[0]!.pages[0]!.tiles[0]!.widgets[0]!.profile, undefined, 'its widgets read the default one');
  deleteProfile(cfg, 'nw/deck', 'sport', reads);
  assert.equal(cfg.sourceProfiles, undefined, 'none left: the key goes, as if never there');

  const withTech = config({ profiles: TECH, widgets: [widget('a', 'tech')] });
  const r = validateConfig(config({ profiles: TECH, widgets: [widget('a', 'tec'), { id: 'w-clock', type: 'nw/clock', options: {}, profile: 'tech' }] }), [plugin]);
  assert.ok(r.warnings.some((w) => /no profile "tec".*did you mean "tech"/.test(w.message)), JSON.stringify(r.warnings));
  assert.ok(r.warnings.some((w) => /reads no source with profiles/.test(w.message)));
  assert.deepEqual(validateConfig(withTech, [plugin]).errors, []);
  const unknown = validateConfig(config({ profiles: { 'nw/deck': { tech: { name: 'T', options: { feeed: 'x' } } } }, widgets: [] }), [plugin]);
  assert.ok(unknown.warnings.some((w) => w.path.startsWith('sourceProfiles["nw/deck"].tech.options')), JSON.stringify(unknown.warnings));

  const renamed = structuredClone(withTech);
  renamed.sourceProfiles!['nw/deck']!.tech!.name = 'Tech';
  renamed.sourceProfiles!['nw/deck']!.tech!.options = { feed: 'tech2' };
  assert.deepEqual(diffConfigs(withTech, renamed).map((l) => l.text), ['source profile nw/deck#tech: renamed from "Tecnología" to "Tech"; feed changed']);

  // An imported file that leaves the profiles out keeps them.
  const plan = planImport({ screens: withTech.screens }, withTech, [plugin]);
  assert.deepEqual(plan.config.sourceProfiles, TECH);
  assert.ok(plan.carried.includes('sourceProfiles["nw/deck"]["tech"]'));
});

// ---------------------------------------------------------------- context rules on a profile

/** A config with no widget reading the deck, and a context page on a profile of it (or its default one). */
function ruleConfig(profile: string | undefined, profiles: unknown = TECH) {
  const grid = { cols: 1, rows: 1, gap: 0, padding: 0 };
  const tile = (id: string) => [{ id: `t-${id}`, x: 0, y: 0, w: 1, h: 1, widgets: [{ id: `w-${id}`, type: 'nw/clock', options: {} }] }];
  return normalize({
    threads: 'never',
    sources: { 'nw/deck': { feed: 'general' } },
    ...(profiles ? { sourceProfiles: profiles } : {}),
    screens: [{
      id: 's', name: 'S', width: 64, height: 32, pixelShift: { enabled: false }, device: { driver: 'virtual' }, context: { minMs: 0, holdMs: 0 },
      pages: [
        { id: 'main', name: 'main', grid, tiles: tile('main') },
        { id: 'tech', name: 'tech', grid, tiles: tile('tech'), showWhen: [{ source: 'nw/deck', path: 'feed', value: 'tech', ...(profile ? { profile } : {}) }] },
      ],
    }],
  });
}

test('profiles: a context rule reads the profile it names, which runs with no widget on it; a gone one reads the default', async () => {
  const reg = registry();
  const find = (x: string) => reg.source(x);
  assert.deepEqual([...ruleSources(ruleConfig('tech'), find)], ['nw/deck#tech']);
  assert.deepEqual([...ruleSources(ruleConfig(undefined), find)], ['nw/deck']);
  assert.deepEqual([...ruleSources(ruleConfig('gone'), find)], ['nw/deck'], 'a profile that is gone: the default one');
  assert.deepEqual([...ruleSources(ruleConfig('tech'))], ['nw/deck'], 'without knowing which sources accept profiles: the default one');
  const rt = new Runtime(reg, ruleConfig('tech'));
  rt.start();
  try {
    const shown = () => rt.status().screens[0]!;
    assert.deepEqual(rt.hub.running().map((r) => r.key), ['nw/deck#tech'], 'only the profile the rule reads');
    await until(() => shown().page === 'tech', 4000, 'the profile\'s data brings its page up');
    assert.deepEqual(shown().context?.reason, { source: 'nw/deck', profile: 'tech', path: 'feed', value: 'tech' });
    // On the default one ("general"), the rule does not hold.
    rt.apply(ruleConfig(undefined));
    assert.deepEqual(rt.hub.running().map((r) => r.key), ['nw/deck']);
    await until(() => shown().page === 'main', 4000, 'the default one\'s data does not hold');
  } finally {
    rt.stop();
  }
});

test('profiles: a context rule\'s profile in normalize, check and when the profile is deleted', () => {
  const page = (rules: unknown) => normalize({ screens: [{ id: 's', name: 'S', width: 64, height: 32, device: { driver: 'virtual' }, pages: [{ id: 'p', name: 'p', grid: { cols: 1, rows: 1, gap: 0, padding: 0 }, tiles: [], showWhen: rules }] }] }).screens[0]!.pages[0]!.showWhen;
  assert.deepEqual(page([{ source: 'nw/deck', profile: 'tech' }, { source: 'nw/deck', profile: 'Not An Id' }, { app: 'x', profile: 'tech' }]), [{ source: 'nw/deck', profile: 'tech' }, { source: 'nw/deck' }, { app: 'x' }], 'only with a source, and only a profile id');

  const warned = (cfg: ReturnType<typeof ruleConfig>) => validateConfig(cfg, [plugin]).warnings.filter((w) => w.path.endsWith('.profile')).map((w) => w.message);
  assert.deepEqual(warned(ruleConfig('tech')), []);
  assert.ok(warned(ruleConfig('tec')).some((m) => /no profile "tec".*did you mean "tech"/.test(m)), JSON.stringify(warned(ruleConfig('tec'))));
  const battery = ruleConfig(undefined, null);
  battery.screens[0]!.pages[1]!.showWhen = [{ source: 'nw/battery', profile: 'tech', path: 'device' }];
  assert.ok(warned(battery).some((m) => /has no profiles/.test(m)), JSON.stringify(warned(battery)));

  const cfg = ruleConfig('tech');
  deleteProfile(cfg, 'nw/deck', 'tech', (type) => type === 'nw/headline');
  assert.deepEqual(cfg.screens[0]!.pages[1]!.showWhen, [{ source: 'nw/deck', path: 'feed', value: 'tech' }], 'the rule reads the default one now');
});

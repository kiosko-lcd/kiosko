import assert from 'node:assert/strict';
import { test } from 'node:test';
import { definePlugin, defineSource, defineWidget, listOptions, t } from '@kiosko/sdk';
import { lintOptions, lintPlugin } from './plugin-lint.ts';

const messages = (issues: { where: string; message: string }[]) => issues.map((i) => `${i.where}: ${i.message}`);

test('lintOptions: the option conventions of docs/plugins.md', () => {
  const issues = messages(lintOptions('x/w', t.object({
    holdMin: t.integer({ default: 5 }),
    staleMs: t.integer({ default: 60_000 }),
    wait: t.duration(),
    tempCrit: t.integer({ default: 90, unit: '°C' }),
    diskWarn: t.integer({ default: 85, min: 0, max: 100, unit: '%' }),
    ratio: t.number({ default: 0.8, max: 1, unit: '%' }),
    latestOnly: t.boolean(),
    seconds: t.boolean(),
    takeOver: t.boolean(),
    max: t.integer({ default: 4 }),
    url: t.string(),
    repos: t.list(t.string()),
    latitude: t.number(),
  }), 'widget'));
  const has = (path: string, re: RegExp) => assert.ok(issues.some((m) => m.startsWith(`x/w options.${path}:`) && re.test(m)), `${path} ${re}\n${issues.join('\n')}`);
  has('holdMin', /ending in Ms/);
  has('staleMs', /t\.duration/);
  has('wait', /name it …Ms/);
  has('tempCrit', /never …Crit/);
  has('diskWarn', /add diskAlert/);
  has('ratio', /integers 0–100/);
  has('latestOnly', /onlyLatest/);
  has('seconds', /showSeconds/);
  has('takeOver', /instance's switch/);
  has('max', /max<Things>/);
  has('url', /risk/);
  has('repos', /t\.filter/);
  has('latitude', /ctx\.location/);
  // A source's own refresh options are errors; the same names inside a list item are fine.
  const src = lintOptions('x/s', t.object({ intervalMs: t.duration(), servers: t.list(t.object({ timeoutMs: t.duration() })) }), 'source');
  assert.deepEqual(src.filter((i) => i.level === 'error').map((i) => i.where), ['x/s options.intervalMs']);
});

test('lintOptions: what follows the conventions passes', () => {
  assert.deepEqual(lintOptions('x/w', t.object({
    ...listOptions({ layouts: ['one-line', 'detailed'] }),
    repos: t.filter({ label: 'Repos' }),
    rotateMs: t.duration({ default: 30_000 }),
    tempWarn: t.integer({ default: 80, unit: '°C' }),
    tempAlert: t.integer({ default: 90, unit: '°C' }),
    diskWarn: t.integer({ default: 85, min: 0, max: 100, unit: '%' }),
    diskAlert: t.integer({ default: 95, min: 0, max: 100, unit: '%' }),
    showSeconds: t.boolean(),
    maxProcesses: t.integer({ default: 5 }),
    tileMin: t.integer({ default: 320, unit: 'px' }),
    url: t.string({ format: 'url', risk: 'network' }),
    token: t.string({ secret: true }),
  }), 'widget'), []);
});

test('lintPlugin: contract, languages, requirements, sizes and templates', () => {
  const w = defineWidget({
    id: 'card',
    name: { en: 'Card', es: 'Tarjeta' },
    size: { min: { w: 500, h: 100 }, preferred: { w: 400, h: 200 } },
    sources: ['agents/sessions', 'weather/current', 'x/feed'],
    render() {},
  });
  const s = defineSource({ id: 'feed', name: 'Feed', read: async () => 1 });
  const issues = messages(lintPlugin(definePlugin({
    id: 'x', name: { en: 'X', es: 'X' }, version: '1.0', widgets: [w, w], sources: [s],
    optional: ['weather/current'],
    templates: [{ id: 'main', name: 'Main', wide: [{ x: 0.5, y: 0, w: 0.7, h: 1, widgets: ['card'] }] }],
  })));
  const has = (re: RegExp) => assert.ok(issues.some((m) => re.test(m)), `${re}\n${issues.join('\n')}`);
  has(/^plugin: version "1.0" is not semver/);
  has(/^plugin: say which plugin API/);
  has(/^plugin: it reads data: declare `permissions`/);
  has(/^x\/card: two widgets with the id "card"/);
  has(/^x\/card: size\.min 500×100 is bigger/);
  has(/^x\/card: no `demo`/);
  has(/^x\/card: uses agents\/sessions from another plugin/);
  assert.ok(!issues.some((m) => /uses weather\/current/.test(m)), 'optional ones are fine');
  assert.ok(!issues.some((m) => /uses x\/feed/.test(m)), 'its own are fine');
  has(/^x\/feed: "Feed" has no es \(the plugin speaks en, es\)/);
  has(/^x\/main template: tiles are fractions/);
});

test('lintPlugin: a complete plugin is clean', () => {
  const p = definePlugin({
    id: 'ok', name: { en: 'Ok', es: 'Ok' }, description: { en: 'Fine.', es: 'Bien.' }, version: '1.2.3', sdk: '^0.2.0',
    permissions: { network: ['api.example.com'] },
    widgets: [defineWidget({ id: 'w', name: { en: 'W', es: 'W' }, description: { en: 'A w.', es: 'Una w.' }, icon: 'square', size: { preferred: { w: 300, h: 200 } }, sources: ['ok/s'], render() {}, demo: () => ({}) })],
    sources: [defineSource({ id: 's', name: { en: 'S', es: 'S' }, description: { en: 'A s.', es: 'Una s.' }, read: async () => 1, demo: () => 1 })],
  });
  assert.deepEqual(lintPlugin(p), []);
});

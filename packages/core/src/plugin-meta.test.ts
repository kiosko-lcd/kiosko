import assert from 'node:assert/strict';
import { test } from 'node:test';
import { definePlugin, defineSource, defineWidget, t } from '@kiosko/sdk';
import { incompatibility, languagesOf, packageMeta, pluginManifest, riskyOptions } from './plugin-meta.ts';

test('packageMeta: id, plugin API range (kiosko.sdk, else the peer dependency) and npm os', () => {
  assert.deepEqual(packageMeta({ name: 'kiosko-plugin-gpu', version: '1.2.0', kiosko: { sdk: '^0.2.0' }, os: ['linux', 'win32'] }), { name: 'kiosko-plugin-gpu', version: '1.2.0', id: 'gpu', sdk: '^0.2.0', platforms: ['linux', 'win32'] });
  assert.equal(packageMeta({ name: '@acme/kiosko-plugin-x', peerDependencies: { '@kiosko/sdk': '>=0.2' } }).sdk, '>=0.2');
  assert.equal(packageMeta({ name: '@acme/kiosko-plugin-x' }).id, 'x');
  assert.equal(packageMeta({ name: 'whatever', kiosko: { id: 'calls' } }).id, 'calls');
  assert.deepEqual(packageMeta({ os: ['!win32'] }).platforms, ['linux', 'darwin']);
});

test('incompatibility: the plugin API and the operating system', () => {
  const env = { sdk: '0.2.1', platform: 'linux' };
  assert.equal(incompatibility({}, env), null);
  assert.equal(incompatibility({ sdk: '^0.2.0', platforms: ['linux'] }, env), null);
  assert.equal(incompatibility({ sdk: '^0.3.0' }, env), 'written for the plugin API ^0.3.0; this Kiosko has 0.2.1');
  assert.equal(incompatibility({ platforms: ['darwin', 'win32'] }, env), 'works on macOS, Windows, not on Linux');
});

const source = defineSource({
  id: 'feed',
  name: { en: 'Feed', es: 'Fuente' },
  options: t.object({
    url: t.string({ risk: 'network', label: { en: 'URL', es: 'URL', zh: '网址' } }),
    token: t.string({ secret: true }),
    endpoints: t.list(t.object({ host: t.string({ risk: 'network' }), cmd: t.string({ risk: 'exec' }) })),
    files: t.list(t.string({ format: 'path' }), { risk: 'path' }),
  }),
  intervalMs: 60_000,
  read: async () => 1,
});
const widget = defineWidget({
  id: 'card',
  name: { en: 'Card', es: 'Tarjeta' },
  icon: 'square',
  category: 'dev',
  tags: ['git', 'ci'],
  size: { min: { w: 200, h: 100 }, preferred: { w: 400, h: 200 } },
  sources: ['demo/feed'],
  options: t.object({ rows: t.integer({ default: 3 }) }),
  urgent: () => false,
  render() {},
});
const plugin = definePlugin({
  id: 'demo',
  name: { en: 'Demo', es: 'Demo' },
  version: '1.4.0',
  description: { en: 'A demo.', es: 'Una demo.' },
  sdk: '^0.2.0',
  permissions: { network: ['user'], exec: ['git'] },
  requires: ['agents/sessions'],
  platforms: ['linux', 'darwin'],
  widgets: [widget],
  sources: [source],
  templates: [{ id: 'main', name: 'Main', wide: [{ x: 0, y: 0, w: 1, h: 1, widgets: ['card', ['core/clock', {}]] }] }],
});

test('riskyOptions: values that run, connect or read, and secrets, with their path', () => {
  assert.deepEqual(riskyOptions(source.options), [
    { path: 'url', risk: ['network'], secret: false },
    { path: 'token', risk: [], secret: true },
    { path: 'endpoints[].host', risk: ['network'], secret: false },
    { path: 'endpoints[].cmd', risk: ['exec'], secret: false },
    { path: 'files', risk: ['path'], secret: false },
  ]);
});

test('languagesOf: every language its texts come in, English first', () => {
  assert.deepEqual(languagesOf(plugin), ['en', 'es', 'zh']);
  assert.deepEqual(languagesOf(definePlugin({ id: 'x', name: 'X', version: '1.0.0' })), ['en']);
});

test('pluginManifest: what a store needs, without running anything', () => {
  const m = pluginManifest(plugin, {
    screenshots: { card: 'docs/card.png' },
    pkg: { name: 'kiosko-plugin-demo', author: { name: 'Ana' }, license: 'MIT', homepage: 'https://x.dev', repository: { type: 'git', url: 'git+https://github.com/ana/kiosko-plugin-demo.git' } },
  });
  assert.equal(m.manifest, 1);
  assert.equal(m.package, 'kiosko-plugin-demo');
  assert.equal(m.author, 'Ana');
  assert.equal(m.license, 'MIT');
  assert.equal(m.repository, 'https://github.com/ana/kiosko-plugin-demo.git');
  assert.equal(m.sdk, '^0.2.0');
  assert.deepEqual(m.platforms, ['linux', 'darwin']);
  assert.deepEqual(m.categories, ['dev']);
  assert.deepEqual(m.tags, ['git', 'ci']);
  assert.deepEqual(m.permissions, { network: ['user'], exec: ['git'] });
  assert.equal(m.riskyOptions.length, 5);
  assert.equal(m.riskyOptions[0]!.path, 'demo/feed: url');
  assert.deepEqual(m.requires, [{ type: 'agents/sessions', plugin: 'agents' }]);
  const w = m.widgets[0]!;
  assert.equal(w.type, 'demo/card');
  assert.equal(w.screenshot, 'docs/card.png');
  assert.deepEqual(w.size.preferred, { w: 400, h: 200 });
  assert.equal(w.urgent, true);
  assert.equal(w.animated, false);
  assert.equal((w.options as { properties: Record<string, unknown> }).properties.rows !== undefined, true);
  assert.deepEqual(m.sources[0], { type: 'demo/feed', name: { en: 'Feed', es: 'Fuente' }, polled: true, intervalMs: 60_000, options: m.sources[0]!.options });
  assert.deepEqual(m.templates, [{ id: 'main', name: 'Main', widgets: ['demo/card', 'core/clock'] }]);
  // Plain data: it goes to disk as JSON with nothing lost but undefined hints.
  const json = JSON.stringify(m);
  assert.equal(JSON.stringify(JSON.parse(json)), json);
  assert.ok(!/function|=>/.test(json));
});

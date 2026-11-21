import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SDK_VERSION, definePlugin, defineWidget, type PluginDefinition } from '@kiosko/sdk';
import { Registry } from './registry.ts';

/** A plugins folder with plugins written as files, removed afterwards. */
function folder(): { dir: string; plugin: (name: string, files: Record<string, string>) => string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'kiosko-registry-'));
  return {
    dir,
    plugin(name, files) {
      const p = join(dir, name);
      mkdirSync(p, { recursive: true });
      for (const [f, body] of Object.entries(files)) writeFileSync(join(p, f), body);
      return p;
    },
    done: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const code = (id: string, extra = '') => `import { definePlugin } from '@kiosko/sdk';\n${extra}\nexport default definePlugin({ id: '${id}', name: '${id}', version: '1.0.0', widgets: [{ id: 'w', name: 'W', render() {} }] });\n`;

test('a plugin for another plugin API is refused before its code runs', async () => {
  const f = folder();
  try {
    const marker = join(f.dir, 'ran');
    f.plugin('future', {
      'package.json': JSON.stringify({ name: 'kiosko-plugin-future', version: '3.0.0', type: 'module', kiosko: { plugin: './index.js', sdk: '^9.0.0' } }),
      'index.js': code('future', `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'x');`),
    });
    f.plugin('fits', {
      'package.json': JSON.stringify({ name: 'kiosko-plugin-fits', version: '1.0.0', type: 'module', kiosko: { plugin: './index.js', sdk: `^${SDK_VERSION}` } }),
      'index.js': code('fits'),
    });
    const r = new Registry();
    await r.loadDir(f.dir);
    assert.ok(r.plugin('fits'));
    assert.equal(r.plugin('future'), undefined);
    assert.equal(existsSync(marker), false, 'its code never ran');
    assert.deepEqual(r.refused.map((x) => [x.id, x.version]), [['future', '3.0.0']]);
    assert.match(r.refused[0]!.reason, /plugin API \^9\.0\.0; this Kiosko has/);
    assert.ok(r.problems.some((p) => /"future" not loaded/.test(p.message)));
  } finally {
    f.done();
  }
});

test('a plugin for another operating system is refused (npm os, or platforms in its definition)', async () => {
  const f = folder();
  try {
    const other = process.platform === 'win32' ? 'linux' : 'win32';
    f.plugin('elsewhere', {
      'package.json': JSON.stringify({ name: 'kiosko-plugin-elsewhere', version: '1.0.0', type: 'module', os: [other], kiosko: { plugin: './index.js' } }),
      'index.js': code('elsewhere'),
    });
    f.plugin('notmine', {
      'package.json': JSON.stringify({ name: 'kiosko-plugin-notmine', version: '1.0.0', type: 'module', os: [`!${process.platform}`] }),
      'index.js': code('notmine'),
    });
    const r = new Registry();
    await r.loadDir(f.dir);
    assert.deepEqual(r.refused.map((x) => x.id).sort(), ['elsewhere', 'notmine']);
    const r2 = new Registry();
    r2.add(definePlugin({ id: 'odd', name: 'Odd', version: '1.0.0', platforms: [other] }));
    r2.add(definePlugin({ id: 'old', name: 'Old', version: '1.0.0', sdk: '^0.0.1' }));
    r2.add(definePlugin({ id: 'ok', name: 'Ok', version: '1.0.0', sdk: `^${SDK_VERSION}`, platforms: ['linux', 'darwin', 'win32'] }));
    assert.deepEqual(r2.list().map((p) => p.def.id), ['ok']);
    assert.deepEqual(r2.refused.map((x) => x.id), ['odd', 'old']);
  } finally {
    f.done();
  }
});

test('reload picks up a rebuilt plugin; a broken rebuild keeps the old one running', async () => {
  const f = folder();
  try {
    const p = f.plugin('live', { 'package.json': JSON.stringify({ name: 'kiosko-plugin-live', type: 'module' }), 'index.js': code('live').replace("version: '1.0.0'", "version: '1.0.0'") });
    const r = new Registry();
    await r.loadDir(f.dir);
    assert.equal(r.plugin('live')!.def.version, '1.0.0');
    r.setDisabled(['live']);
    writeFileSync(join(p, 'index.js'), code('live').replace("version: '1.0.0'", "version: '1.1.0'"));
    assert.equal(await r.reload('live'), null);
    assert.equal(r.plugin('live')!.def.version, '1.1.0');
    assert.equal(r.plugin('live')!.enabled, false, 'stays switched off');
    writeFileSync(join(p, 'index.js'), 'export default {');
    assert.ok(await r.reload('live'));
    assert.equal(r.plugin('live')!.def.version, '1.1.0', 'the old code is still there');
    assert.match((await r.reload('nope')) ?? '', /not loaded/);
    r.add(definePlugin({ id: 'inside', name: 'Inside', version: '1.0.0' }));
    assert.match((await r.reload('inside')) ?? '', /built in/);
  } finally {
    f.done();
  }
});

test('loadOne loads a just-installed plugin; remove forgets it', async () => {
  const f = folder();
  try {
    const p = f.plugin('fresh', { 'package.json': JSON.stringify({ name: 'kiosko-plugin-fresh', type: 'module' }), 'index.js': code('fresh') });
    const r = new Registry();
    assert.deepEqual(await r.loadOne(p), ['fresh']);
    assert.equal(r.originOf('fresh'), p);
    assert.ok(r.widget('fresh/w'));
    assert.equal(r.remove('fresh'), true);
    assert.equal(r.widget('fresh/w'), undefined);
  } finally {
    f.done();
  }
});

test('catalog: permissions, what it needs from others and whether it is here, its templates with full types', () => {
  const r = new Registry();
  const w = defineWidget({ id: 'room', name: 'Room', render() {} });
  const cats: PluginDefinition = definePlugin({
    id: 'cats', name: 'Cats', version: '1.0.0', sdk: `^${SDK_VERSION}`, repository: 'https://github.com/x/y', license: 'MIT',
    permissions: { files: ['~/.aimonitor/sessions'] },
    requires: ['agents/sessions', 'weather/current'],
    widgets: [w],
    templates: [{ id: 'room', name: { en: 'Cats room', es: 'Habitación' }, wide: [{ x: 0, y: 0, w: 1, h: 1, widgets: ['room', ['core/clock', { showDate: true }]] }] }],
  });
  r.add(cats);
  r.add(definePlugin({ id: 'weather', name: 'Weather', version: '1.0.0', sources: [{ id: 'current', name: 'Now', read: async () => 1 }] }));
  const c = r.catalog('es').find((p) => p.id === 'cats')!;
  assert.deepEqual(c.permissions, { files: ['~/.aimonitor/sessions'] });
  assert.deepEqual(c.requires, [{ type: 'agents/sessions', plugin: 'agents', ok: false }, { type: 'weather/current', plugin: 'weather', ok: true }]);
  assert.equal(c.templates[0]!.id, 'cats/room');
  assert.equal(c.templates[0]!.name, 'Habitación');
  assert.deepEqual(c.templates[0]!.wide[0]!.widgets, ['cats/room', ['core/clock', { showDate: true }]]);
  assert.equal(c.templates[0]!.tall, undefined);
  assert.equal(c.sdk, `^${SDK_VERSION}`);
  // A switched-off plugin doesn't count as present.
  r.setDisabled(['weather']);
  assert.equal(r.catalog('en').find((p) => p.id === 'cats')!.requires[1]!.ok, false);
});

test('choices: a source offers values for options from its live data, or its demo data before there is any', async () => {
  const { t, toJsonSchema } = await import('@kiosko/sdk');
  const r = new Registry();
  r.add(definePlugin({
    id: 'ha', name: 'HA', version: '1.0.0',
    sources: [{
      id: 'states', name: 'States', read: async () => ({}),
      demo: () => ({ e: { 'light.k': 'Kitchen' } }),
      choices: {
        entities: (d: { e: Record<string, string> }) => Object.entries(d.e).map(([value, label]) => ({ value, label, group: value.split('.')[0] })),
        broken: () => { throw new Error('boom'); },
        messy: () => [{ value: '' }, { value: 'a', label: 'a' }, null, { value: 3 }] as never,
      },
    }],
  }));
  assert.deepEqual(r.choices('ha/states', 'entities', { e: { 'sensor.t': 'Temp' } }, 'en'), { choices: [{ value: 'sensor.t', label: 'Temp', group: 'sensor' }], from: 'live' });
  assert.deepEqual(r.choices('ha/states', 'entities', undefined, 'en'), { choices: [{ value: 'light.k', label: 'Kitchen', group: 'light' }], from: 'demo' });
  assert.deepEqual(r.choices('ha/states', 'broken', {}, 'en'), { choices: [], from: 'live', error: 'boom' });
  // Empty values, non-strings and labels equal to the value are cleaned up.
  assert.deepEqual(r.choices('ha/states', 'messy', {}, 'en').choices, [{ value: 'a' }]);
  assert.match(r.choices('ha/states', 'nope', {}, 'en').error!, /no list "nope"/);
  assert.match(r.choices('zz/top', 'x', {}, 'en').error!, /no source/);
  // Fields point at the list; the JSON Schema carries it for the editor.
  const field = t.object({ entity: t.string({ choices: { source: 'ha/states', list: 'entities' } }), only: t.filter({ choices: { source: 'ha/states', list: 'entities' } }) });
  const schema = toJsonSchema(field) as { properties: Record<string, { 'x-ui': { choices?: unknown } }> };
  assert.deepEqual(schema.properties.entity!['x-ui'].choices, { source: 'ha/states', list: 'entities' });
  assert.deepEqual(schema.properties.only!['x-ui'].choices, { source: 'ha/states', list: 'entities' });
});

test("threadPlugins: what a screen's thread loads, in order: built-in ones by id, the rest by their module (the reloaded one after a reload)", async () => {
  const f = folder();
  try {
    const r = new Registry();
    r.add(definePlugin({ id: 'inner', name: 'Inner', version: '1.0.0' }));
    r.add(definePlugin({ id: 'npmish', name: 'N', version: '1.0.0' }), 'npm:kiosko-plugin-npmish', 'file:///somewhere/index.js');
    f.plugin('mine', { 'index.js': code('mine'), 'package.json': '{"type":"module"}' });
    await r.loadDir(f.dir);
    const list = r.threadPlugins();
    assert.deepEqual(list.map((p) => [p.id, p.origin === 'builtin' ? 'builtin' : 'other', p.module?.startsWith('file:') ?? null]), [['inner', 'builtin', null], ['npmish', 'other', true], ['mine', 'other', true]]);
    const before = list.find((p) => p.id === 'mine')!.module!;
    assert.match(before, /\/mine\/index\.js$/);
    assert.equal(await r.reload('mine'), null);
    assert.match(r.threadPlugins().find((p) => p.id === 'mine')!.module!, /\/mine\/index\.js\?v=/, 'the code reloaded last');
    r.remove('npmish');
    assert.deepEqual(r.threadPlugins().map((p) => p.id), ['inner', 'mine']);
  } finally {
    f.done();
  }
});

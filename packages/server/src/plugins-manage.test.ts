import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Registry } from '@kiosko/core';
import { definePlugin } from '@kiosko/sdk';
import { NPM_NAME, installPlugin, packageName, reloadPlugin, removePlugin, type Npm } from './plugins-manage.ts';

const code = (id: string, version: string) => `import { definePlugin } from '@kiosko/sdk';\nexport default definePlugin({ id: '${id}', name: '${id}', version: '${version}', widgets: [{ id: 'w', name: 'W', render() {} }] });\n`;

/** A plugins folder and an npm that "installs" by writing the package, and records what it was asked. */
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'kiosko-manage-'));
  const calls: string[][] = [];
  const versions: Record<string, string> = {};
  const npm: Npm = async (args) => {
    calls.push(args);
    const spec = args.at(-1)!;
    const name = packageName(spec);
    const folder = join(dir, 'node_modules', name);
    if (args[0] === 'install') {
      mkdirSync(folder, { recursive: true });
      const id = name.replace(/^kiosko-plugin-/, '');
      const v = versions[name] ?? '1.0.0';
      writeFileSync(join(folder, 'package.json'), JSON.stringify({ name, version: v, type: 'module', kiosko: { plugin: './index.js' } }));
      writeFileSync(join(folder, 'index.js'), code(id, v));
    } else rmSync(folder, { recursive: true, force: true });
    return 'ok';
  };
  const changed: string[][] = [];
  const runtime = { pluginsChanged: (ids: string[]) => void changed.push(ids) };
  return { dir, calls, versions, npm, changed, runtime, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('npm names: packages and versions only, no URLs, paths or flags', () => {
  for (const ok of ['kiosko-plugin-gpu', 'kiosko-plugin-gpu@1.2.0', '@acme/kiosko-plugin-x@^1', 'kiosko-plugin-x@latest']) assert.ok(NPM_NAME.test(ok), ok);
  for (const bad of ['https://evil/x.tgz', '../x', '--registry=x', 'git+ssh://x', 'a b']) assert.ok(!NPM_NAME.test(bad), bad);
  assert.equal(packageName('@acme/kiosko-plugin-x@^1'), '@acme/kiosko-plugin-x');
  assert.equal(packageName('kiosko-plugin-gpu@1.2.0'), 'kiosko-plugin-gpu');
});

test('install loads the plugin at once; installing it again updates it in place', async () => {
  const s = setup();
  try {
    const registry = new Registry();
    const o = { registry, runtime: s.runtime, dir: s.dir, npm: s.npm };
    const r = await installPlugin('kiosko-plugin-hello', o);
    assert.deepEqual(r.ids, ['hello']);
    assert.equal(r.restart, false);
    assert.deepEqual(s.calls[0], ['install', '--no-audit', '--no-fund', '--ignore-scripts', 'kiosko-plugin-hello']);
    assert.ok(registry.widget('hello/w'));
    assert.deepEqual(s.changed, [['hello']]);
    s.versions['kiosko-plugin-hello'] = '1.1.0';
    const again = await installPlugin('kiosko-plugin-hello@1.1.0', o);
    assert.deepEqual(again.ids, ['hello']);
    assert.equal(registry.plugin('hello')!.def.version, '1.1.0');
    await assert.rejects(installPlugin('https://evil/x.tgz', o), /valid npm/);
  } finally {
    s.done();
  }
});

test('install replaces a copy that came with Kiosko', async () => {
  const s = setup();
  try {
    const registry = new Registry();
    registry.add(definePlugin({ id: 'gpu', name: 'GPU', version: '0.1.0' }), 'npm:kiosko-plugin-gpu');
    s.versions['kiosko-plugin-gpu'] = '2.0.0';
    const r = await installPlugin('kiosko-plugin-gpu', { registry, runtime: s.runtime, dir: s.dir, npm: s.npm });
    assert.deepEqual(r.ids, ['gpu']);
    assert.equal(registry.plugin('gpu')!.def.version, '2.0.0');
  } finally {
    s.done();
  }
});

test('remove: uninstalls what npm installed, unlinks a link, leaves hand-made folders and built-ins alone', async () => {
  const s = setup();
  try {
    const registry = new Registry();
    const o = { registry, runtime: s.runtime, dir: s.dir, npm: s.npm };
    await installPlugin('kiosko-plugin-hello', o);
    assert.deepEqual(await removePlugin('hello', o), { removed: true });
    assert.deepEqual(s.calls.at(-1), ['uninstall', '--no-audit', '--no-fund', 'kiosko-plugin-hello']);
    assert.equal(registry.plugin('hello'), undefined);
    assert.deepEqual(s.changed.at(-1), ['hello']);

    // A linked checkout.
    const checkout = join(s.dir, '..', `${s.dir.split('/').pop()}-checkout`);
    mkdirSync(checkout, { recursive: true });
    writeFileSync(join(checkout, 'package.json'), JSON.stringify({ name: 'kiosko-plugin-dev', type: 'module' }));
    writeFileSync(join(checkout, 'index.js'), code('dev', '0.0.1'));
    symlinkSync(checkout, join(s.dir, 'dev'), 'dir');
    await registry.loadOne(join(s.dir, 'dev'));
    assert.deepEqual(await removePlugin('dev', o), { removed: true });
    assert.equal(existsSync(join(s.dir, 'dev')), false);
    assert.equal(existsSync(join(checkout, 'index.js')), true, 'the checkout itself is untouched');
    rmSync(checkout, { recursive: true, force: true });

    // A folder copied by hand.
    mkdirSync(join(s.dir, 'mine'));
    writeFileSync(join(s.dir, 'mine', 'index.mjs'), code('mine', '1.0.0'));
    await registry.loadOne(join(s.dir, 'mine'));
    const kept = await removePlugin('mine', o);
    assert.equal(kept.removed, false);
    assert.match(kept.reason!, /delete it yourself/);
    assert.ok(registry.plugin('mine'));

    registry.add(definePlugin({ id: 'core', name: 'Core', version: '1.0.0' }));
    assert.deepEqual(await removePlugin('core', o), { removed: false, reason: 'it comes with Kiosko' });
  } finally {
    s.done();
  }
});

test('reload: new code without a restart; the problem when it fails', async () => {
  const s = setup();
  try {
    const registry = new Registry();
    const o = { registry, runtime: s.runtime, dir: s.dir, npm: s.npm };
    await installPlugin('kiosko-plugin-hello', o);
    writeFileSync(join(s.dir, 'node_modules', 'kiosko-plugin-hello', 'index.js'), code('hello', '1.0.1'));
    assert.equal(await reloadPlugin('hello', o), null);
    assert.equal(registry.plugin('hello')!.def.version, '1.0.1');
    writeFileSync(join(s.dir, 'node_modules', 'kiosko-plugin-hello', 'index.js'), 'syntax error here');
    assert.ok(await reloadPlugin('hello', o));
    assert.equal(registry.plugin('hello')!.def.version, '1.0.1');
  } finally {
    s.done();
  }
});

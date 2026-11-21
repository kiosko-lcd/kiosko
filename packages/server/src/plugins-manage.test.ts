import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
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
    const checkout = join(dirname(s.dir), `${basename(s.dir)}-checkout`);
    mkdirSync(checkout, { recursive: true });
    writeFileSync(join(checkout, 'package.json'), JSON.stringify({ name: 'kiosko-plugin-dev', type: 'module' }));
    writeFileSync(join(checkout, 'index.js'), code('dev', '0.0.1'));
    // As `kiosko plugins link` does: a junction on Windows (no privileges needed).
    symlinkSync(checkout, join(s.dir, 'dev'), process.platform === 'win32' ? 'junction' : 'dir');
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

test('kiosko plugins new: a plugin that declares its API and permissions, with tests and a build', async () => {
  const { newPluginFiles } = await import('./plugins-cli.ts');
  const { SDK_VERSION } = await import('@kiosko/sdk');
  const files = newPluginFiles('solar-meter');
  assert.deepEqual(Object.keys(files).sort(), ['.github/workflows/release.yml', '.gitignore', 'README.md', 'build.mjs', 'package.json', 'src/index.test.ts', 'src/index.ts', 'tsconfig.json']);
  const pkg = JSON.parse(files['package.json']!) as { name: string; kiosko: { id: string; sdk: string }; peerDependencies: Record<string, string> };
  const range = `^${SDK_VERSION.split('.').slice(0, 2).join('.')}.0`;
  assert.equal(pkg.name, 'kiosko-plugin-solar-meter');
  assert.deepEqual([pkg.kiosko.id, pkg.kiosko.sdk, pkg.peerDependencies['@kiosko/sdk']], ['solar-meter', range, range]);
  assert.match(files['src/index.ts']!, /id: 'solar-meter',\n  name: \{ en: 'Solar Meter'/);
  assert.match(files['src/index.ts']!, /permissions: \{ network: \['user'\] \}/);
  // What the store links to, and a release that publishes with provenance (trusted publishing, no token).
  const meta = JSON.parse(files['package.json']!) as { bugs: { url: string }; repository: { url: string } };
  assert.match(meta.bugs.url, /kiosko-plugin-solar-meter\/issues$/);
  assert.match(files['.github/workflows/release.yml']!, /id-token: write/);
  assert.match(files['.github/workflows/release.yml']!, /\$\{\{ github\.token \}\}/);
});

test('install: a bad update brings the previous version back; a new one says what more it does', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kiosko-update-'));
  try {
    const published: Record<string, string> = {
      '1.0.0': "export default definePlugin({ id: 'up', name: 'Up', version: '1.0.0', permissions: { network: ['a.dev'] }, widgets: [{ id: 'w', name: 'W', render() {} }] });",
      '1.1.0': 'export default {',
      '1.2.0': "export default definePlugin({ id: 'up', name: 'Up', version: '1.2.0', permissions: { network: ['a.dev', 'b.dev'], exec: ['git'] }, widgets: [{ id: 'w', name: 'W', render() {} }] });",
    };
    const calls: string[] = [];
    const npm: Npm = async (args) => {
      calls.push(args.filter((a) => !a.startsWith('--')).join(' '));
      const folder = join(dir, 'node_modules', 'kiosko-plugin-up');
      if (args[0] === 'uninstall') {
        rmSync(folder, { recursive: true, force: true });
        return '';
      }
      const version = args.at(-1)!.split('@')[1] ?? '1.0.0';
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, 'package.json'), JSON.stringify({ name: 'kiosko-plugin-up', version, type: 'module' }));
      writeFileSync(join(folder, 'index.js'), `import { definePlugin } from '@kiosko/sdk';\n${published[version]}\n`);
      return 'ok';
    };
    const registry = new Registry();
    const o = { registry, runtime: { pluginsChanged: () => undefined }, dir, npm };
    await installPlugin('kiosko-plugin-up@1.0.0', o);
    assert.equal(registry.plugin('up')!.def.version, '1.0.0');
    const bad = await installPlugin('kiosko-plugin-up@1.1.0', o);
    assert.equal(bad.rolledBack, true);
    assert.ok(bad.problem);
    assert.equal(registry.plugin('up')!.def.version, '1.0.0', 'the old one runs');
    assert.deepEqual(calls.slice(-1), ['install kiosko-plugin-up@1.0.0'], 'and is installed again');
    const good = await installPlugin('kiosko-plugin-up@1.2.0', o);
    assert.equal(registry.plugin('up')!.def.version, '1.2.0');
    assert.deepEqual(good.addedPermissions, { network: ['b.dev'], exec: ['git'] });
    assert.deepEqual(registry.packages(), [{ id: 'up', package: 'kiosko-plugin-up', version: '1.2.0' }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('install: replacing the copy that came with Kiosko, and failing, puts that copy back', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kiosko-update-'));
  try {
    const npm: Npm = async (args) => {
      const folder = join(dir, 'node_modules', 'kiosko-plugin-gpu');
      if (args[0] === 'uninstall') {
        rmSync(folder, { recursive: true, force: true });
        return '';
      }
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, 'package.json'), JSON.stringify({ name: 'kiosko-plugin-gpu', version: '9.0.0', type: 'module' }));
      writeFileSync(join(folder, 'index.js'), 'throw new Error("broken build")');
      return 'ok';
    };
    const registry = new Registry();
    registry.add(definePlugin({ id: 'gpu', name: 'GPU', version: '0.2.1' }), 'npm:kiosko-plugin-gpu');
    const r = await installPlugin('kiosko-plugin-gpu@9.0.0', { registry, runtime: { pluginsChanged: () => undefined }, dir, npm });
    assert.equal(r.rolledBack, true);
    assert.equal(registry.plugin('gpu')!.def.version, '0.2.1');
    assert.equal(registry.plugin('gpu')!.origin, 'npm:kiosko-plugin-gpu');
    assert.equal(existsSync(join(dir, 'node_modules', 'kiosko-plugin-gpu')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

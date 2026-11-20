/**
 * `kiosko plugins …`: manage the plugins folder from a terminal, and the
 * tools for writing one.
 *
 *   kiosko plugins                 what's loaded and from where
 *   kiosko plugins add <id|pkg>…   install from npm (`agents` → kiosko-plugin-agents)
 *   kiosko plugins link <dir>…     use a local checkout (development, unpublished plugins)
 *   kiosko plugins remove <id|pkg>…
 *   kiosko plugins check [dir]     conventions, and every widget painted at several sizes, themes and languages (--strict: warnings fail too)
 *   kiosko plugins manifest [dir]  write kiosko-manifest.json (what a store reads)
 *   kiosko plugins dev [dir]       link it and reload it in the running Kiosko on every build
 *   kiosko plugins new <id> [dir]  start a plugin: package.json, a widget, a source, tests, build
 */
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, watch, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { declaredLanguages, incompatibility, installSdkResolver, lintPlugin, loadConfig, packageMeta, paths, pluginManifest, type Registry } from '@kiosko/core';
import { SDK_VERSION, localize, type PluginDefinition } from '@kiosko/sdk';

const npmName = (s: string) => (/^[a-z0-9][\w.-]*$/.test(s) && !s.startsWith('kiosko-plugin-') && !s.includes('/') ? `kiosko-plugin-${s}` : s);

function ensureFolder(): string {
  const dir = paths.plugins;
  mkdirSync(dir, { recursive: true });
  const pkg = join(dir, 'package.json');
  if (!existsSync(pkg)) writeFileSync(pkg, `${JSON.stringify({ name: 'kiosko-user-plugins', private: true, type: 'module' }, null, 2)}\n`);
  return dir;
}

function npm(args: string[], cwd: string): void {
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
}

/** A plugin folder's package.json and its definition: the built entry, or `src/index.ts` with `--src` (or when there is no build). */
export async function loadPluginDir(dir: string, o: { src?: boolean } = {}): Promise<{ def: PluginDefinition; pkg: Record<string, any>; entry: string }> {
  const root = resolve(dir);
  const pkgPath = join(root, 'package.json');
  const pkg = existsSync(pkgPath) ? (JSON.parse(readFileSync(pkgPath, 'utf8')) as Record<string, any>) : {};
  const built = [pkg.kiosko?.plugin, pkg.main, 'index.mjs', 'index.js'].filter((x): x is string => typeof x === 'string').map((x) => join(root, x)).find(existsSync);
  const src = join(root, 'src', 'index.ts');
  const entry = (o.src || !built) && existsSync(src) ? src : built;
  if (!entry) throw new Error(`no plugin in ${root}: no package.json "kiosko.plugin", index.js or src/index.ts`);
  installSdkResolver();
  const mod = (await import(`${pathToFileURL(entry).href}?v=${Date.now()}`)) as { default?: PluginDefinition };
  if (!mod.default) throw new Error(`${entry} has no default export (export default definePlugin({...}))`);
  return { def: mod.default, pkg, entry };
}

const flagOf = (argv: string[], name: string) => argv.includes(name);
const optOf = (argv: string[], name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const positional = (argv: string[]) => argv.filter((a, i) => !a.startsWith('--') && !['--out', '--port'].includes(argv[i - 1] ?? ''));

/** "midnight es, paper es, midnight de" → "in es, de (2 themes)": which languages, at a glance. */
function lookList(looks: string[]): string {
  const parts = looks.map((l) => l.split(' '));
  const langs = [...new Set(parts.map((p) => p.at(-1)).filter(Boolean))];
  const themes = new Set(parts.map((p) => p[0]));
  return looks.length === 1 ? looks[0]! : `in ${langs.join(', ')}; ${themes.size} theme${themes.size === 1 ? '' : 's'}`;
}

/** `kiosko plugins check`: lint + paint. Returns the number of errors. */
async function check(dir: string, argv: string[]): Promise<{ errors: number; warnings: number }> {
  const { def, pkg, entry } = await loadPluginDir(dir, { src: flagOf(argv, '--src') });
  console.log(`${def.id} v${def.version}  (${entry})`);
  const issues = lintPlugin(def);
  const meta = packageMeta(pkg);
  if (!meta.sdk) issues.push({ level: 'warn', where: 'package.json', message: 'add "kiosko": { "sdk": "^x.y.z" } so an incompatible Kiosko refuses it before running it' });
  else if (def.sdk && meta.sdk !== def.sdk) issues.push({ level: 'warn', where: 'package.json', message: `kiosko.sdk ${meta.sdk} differs from the definition's sdk ${def.sdk}` });
  if (def.languages?.length && !meta.languages) issues.push({ level: 'warn', where: 'package.json', message: `add "kiosko": { "languages": ${JSON.stringify(def.languages)} } so a catalogue knows them without running it` });
  else if (def.languages && meta.languages && def.languages.join() !== meta.languages.join()) issues.push({ level: 'warn', where: 'package.json', message: `kiosko.languages ${JSON.stringify(meta.languages)} differs from the definition's ${JSON.stringify(def.languages)}` });
  const why = incompatibility({ sdk: def.sdk ?? meta.sdk, platforms: def.platforms ?? meta.platforms });
  if (why) issues.push({ level: 'warn', where: 'plugin', message: `this Kiosko can't run it: ${why}` });
  if (pkg.version && pkg.version !== def.version) issues.push({ level: 'warn', where: 'package.json', message: `version ${pkg.version} differs from the definition's ${def.version}` });
  // Painting needs the canvas: from Kiosko's own copy.
  const { checkPlugin } = await import('@kiosko/sdk/testing');
  // The same problem at the same size in every theme and language is one line.
  const painted = new Map<string, { type: string; size: string; problem: string; looks: string[] }>();
  for (const p of checkPlugin(def, { locales: declaredLanguages(def, meta) })) {
    const [size = '', ...look] = p.where.split(' ');
    const problem = p.problem.replace(/\d+ px/, 'N px').replace(/\d+ ms/, 'N ms');
    const key = `${p.type}|${size}|${problem}`;
    const g = painted.get(key) ?? { type: p.type, size, problem: p.problem, looks: [] };
    g.looks.push(look.join(' '));
    painted.set(key, g);
  }
  for (const g of painted.values()) issues.push({ level: /threw/.test(g.problem) ? 'error' : 'warn', where: `${g.type} ${g.size}`, message: `${g.problem}${g.looks.length ? ` (${lookList(g.looks)})` : ''}` });
  const errors = issues.filter((i) => i.level === 'error');
  for (const i of [...errors, ...issues.filter((i) => i.level === 'warn')]) console.log(`${i.level === 'error' ? '✗' : '!'} ${i.where}: ${i.message}`);
  console.log(issues.length ? `\n${errors.length} errors, ${issues.length - errors.length} warnings` : '✓ no problems found');
  return { errors: errors.length, warnings: issues.length - errors.length };
}

/** `kiosko plugins manifest`: the store's record, next to package.json. */
async function manifest(dir: string, argv: string[]): Promise<void> {
  const root = resolve(dir);
  const { def, pkg } = await loadPluginDir(root, { src: flagOf(argv, '--src') });
  const screenshots = Object.fromEntries((def.widgets ?? []).map((w) => [w.id, `docs/${w.id}.png`]).filter(([, f]) => existsSync(join(root, f!))));
  const out = optOf(argv, '--out') ?? join(root, 'kiosko-manifest.json');
  writeFileSync(out, `${JSON.stringify(pluginManifest(def, { pkg, screenshots }), null, 2)}\n`);
  console.log(out);
}

/** `kiosko plugins dev`: link the folder, then ask the running Kiosko to reload it on every build. */
async function dev(dir: string, argv: string[]): Promise<void> {
  const root = resolve(dir);
  const { def, entry } = await loadPluginDir(root);
  await pluginsCommand(['link', root], async () => { throw new Error('unused'); });
  const port = Number(optOf(argv, '--port') ?? loadConfig().config.server.port ?? 7420);
  const reload = async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/plugins/${encodeURIComponent(def.id)}/reload`, { method: 'POST', headers: { 'x-kiosko': '1' } });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      console.log(res.ok ? `${new Date().toLocaleTimeString()}  reloaded ${def.id}` : `${new Date().toLocaleTimeString()}  ✗ ${body.error ?? `HTTP ${res.status}`}`);
    } catch {
      console.log(`Kiosko isn't answering on port ${port}: start it (kiosko start) and save again`);
    }
  };
  console.log(`watching ${entry}; every save reloads "${def.id}" in the running Kiosko (Ctrl-C to stop)`);
  let timer: ReturnType<typeof setTimeout> | null = null;
  watch(entry, () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void reload(), 300);
  });
  await new Promise(() => undefined);
}

/** The files of a new plugin, ready to build, test and check. */
export function newPluginFiles(id: string): Record<string, string> {
  const sdk = `^${SDK_VERSION.split('.').slice(0, 2).join('.')}.0`;
  const name = id.replace(/(^|-)(\w)/g, (_m, _d, c: string) => ` ${c.toUpperCase()}`).trim();
  const pkg = {
    name: `kiosko-plugin-${id}`,
    version: '0.1.0',
    description: `${name} for Kiosko.`,
    type: 'module',
    license: 'MIT',
    keywords: ['kiosko', 'kiosko-plugin', 'lcd', 'widgets'],
    exports: { '.': { source: './src/index.ts', default: './dist/index.js' } },
    kiosko: { plugin: './dist/index.js', id, sdk, languages: ['en', 'es'], manifest: './kiosko-manifest.json' },
    files: ['dist', 'docs', 'kiosko-manifest.json', 'README.md', 'LICENSE'],
    engines: { node: '>=22.18' },
    scripts: {
      build: 'node build.mjs',
      test: 'node --conditions=source --test "src/**/*.test.ts"',
      check: 'tsc -p tsconfig.json',
      'kiosko:check': 'kiosko plugins check . --src',
      'kiosko:manifest': 'npm run build && kiosko plugins manifest .',
      dev: 'kiosko plugins dev .',
      prepublishOnly: 'npm run build && kiosko plugins manifest .',
    },
    peerDependencies: { '@kiosko/sdk': sdk },
    devDependencies: { '@kiosko/sdk': sdk, '@loksly/lcd-canvas-kit': '^0.2.0', '@napi-rs/canvas': '^1.0.10', '@types/node': '^24.0.0', esbuild: '^0.25.0', typescript: '^5.9.3' },
  };
  const index = `/**
 * ${name}: a widget fed by a shared source. Rename, then fill in \`read\` and \`render\`.
 * The guide: https://github.com/kiosko-lcd/kiosko/blob/main/docs/plugins.md
 */
import { createHttp, definePlugin, defineSource, defineWidget, t } from '@kiosko/sdk';

const http = createHttp({ agent: 'kiosko-plugin-${id}/0.1.0' });

export interface Reading {
  value: number;
  at: number;
}

export const reading = defineSource({
  id: 'reading',
  name: { en: '${name}', es: '${name}' },
  description: { en: 'What the widgets show, read once for all of them.', es: 'Lo que muestran los widgets, leído una vez para todos.' },
  options: t.object({
    url: t.string({ format: 'url', risk: 'network', placeholder: 'https://api.example.com/value', label: { en: 'Address', es: 'Dirección' } }),
  }),
  intervalMs: 5 * 60_000,
  async read({ options, signal, now }): Promise<Reading> {
    if (!options.url) throw new Error('set its address in Settings → Data sources');
    const { data } = await http.json<{ value: number }>(options.url, { signal });
    return { value: data.value, at: now };
  },
  demo: ({ now }) => ({ value: 42, at: now - 60_000 }),
});

export const card = defineWidget({
  id: 'card',
  name: { en: '${name}', es: '${name}' },
  description: { en: 'The latest value, in big.', es: 'El último valor, en grande.' },
  icon: 'gauge',
  category: 'info',
  size: { min: { w: 160, h: 80 }, preferred: { w: 320, h: 160 } },
  sources: ['${id}/reading'],
  options: t.object({
    label: t.string({ default: '${name}', label: { en: 'Label', es: 'Etiqueta' } }),
  }),
  redraw: 'minute',
  render(g, { box, options, sources, theme, kit, fmt }) {
    const r = sources['${id}/reading'] as Reading | undefined;
    if (!r) return;
    const { colors, fonts } = theme;
    const label = { size: Math.round(Math.min(18, box.h * 0.14)), family: fonts.sansBold, smallCaps: true, tracking: 1.5, color: colors.inkDim };
    kit.drawTracked(g, kit.truncate(g, options.label, box.w, label), box.x, box.y + label.size, label);
    const text = String(r.value);
    const size = kit.fitSize(g, text, box.w, { size: Math.round(box.h * 0.5), family: fonts.sansBold }, 12);
    kit.drawTracked(g, text, box.x, box.y + box.h * 0.4 + size * 0.5, { size, family: fonts.sansBold, color: colors.ink });
    // Fit every text to the box: other languages are longer ("hace 1 min").
    const ago = { size: Math.max(10, Math.min(22, Math.round(size * 0.25))), family: fonts.sans, color: colors.inkDim };
    kit.drawTracked(g, kit.truncate(g, fmt.ago(r.at), box.w, ago), box.x, box.y + box.h - ago.size * 0.35, ago);
  },
  demo: ({ now }) => ({ sources: { '${id}/reading': { value: 42, at: now - 60_000 } } }),
});

export default definePlugin({
  id: '${id}',
  name: { en: '${name}', es: '${name}' },
  version: '0.1.0',
  description: { en: '${name} for Kiosko.', es: '${name} para Kiosko.' },
  sdk: '${sdk}',
  // The languages its texts come in (Chinese by script: 'zh-Hant', 'zh-Hans').
  languages: ['en', 'es'],
  // What it does on the machine, shown before anyone installs it.
  permissions: { network: ['user'] },
  widgets: [card],
  sources: [reading],
});
`;
  const test = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPlugin, renderWidget } from '@kiosko/sdk/testing';
import plugin, { card } from './index.ts';

test('the card shows the label and the value', () => {
  const r = renderWidget(card, { size: { w: 320, h: 160 } });
  assert.deepEqual(r.texts.slice(0, 2), ['${name}', '42']);
  assert.equal(r.outside, 0);
});

test('every widget paints with its demo data at every size, theme and language', () => {
  assert.deepEqual(checkPlugin(plugin).filter((i) => /threw|outside/.test(i.problem)), []);
});
`;
  const build = `import { build } from 'esbuild';

// One file, with what Kiosko provides left out: it gives every plugin its own copies.
await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  conditions: ['source'],
  external: ['@kiosko/sdk', '@loksly/lcd-canvas-kit', '@loksly/weather-astro', '@napi-rs/canvas'],
  logLevel: 'warning',
});
console.log('dist/index.js');
`;
  const tsconfig = { compilerOptions: { target: 'ES2023', module: 'nodenext', moduleResolution: 'nodenext', lib: ['ES2023'], strict: true, noEmit: true, allowImportingTsExtensions: true, skipLibCheck: true, types: ['node'], customConditions: ['source'] }, include: ['src/**/*.ts'] };
  const readme = `# kiosko-plugin-${id}

${name} for [Kiosko](https://github.com/kiosko-lcd/kiosko).

\`\`\`sh
npm install
npm test                 # node:test, painting with @kiosko/sdk/testing
npm run kiosko:check     # Kiosko's conventions, every widget at several sizes, themes and languages
npm run dev              # link it into your Kiosko and reload it on every build (npm run build in another terminal)
\`\`\`

Publish with \`npm publish\`: it builds and writes \`kiosko-manifest.json\`, the record a plugin store reads.
`;
  return {
    'package.json': `${JSON.stringify(pkg, null, 2)}\n`,
    'src/index.ts': index,
    'src/index.test.ts': test,
    'build.mjs': build,
    'tsconfig.json': `${JSON.stringify(tsconfig, null, 2)}\n`,
    'README.md': readme,
    '.gitignore': 'node_modules/\ndist/\n*.log\n',
  };
}

export async function pluginsCommand(argv: string[], registry: () => Promise<Registry>): Promise<void> {
  const [sub = 'list', ...names] = argv;
  switch (sub) {
    case 'check': {
      const { errors, warnings } = await check(positional(names)[0] ?? '.', names);
      // --strict: warnings fail too (CI, or a translation that must be complete).
      if (errors || (flagOf(names, '--strict') && warnings)) process.exitCode = 1;
      return;
    }
    case 'manifest':
      return manifest(positional(names)[0] ?? '.', names);
    case 'dev':
      return dev(positional(names)[0] ?? '.', names);
    case 'new': {
      const [id, where] = positional(names);
      if (!id || !/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error('usage: kiosko plugins new <id> [folder]   (id: lowercase letters, digits and dashes)');
      const dir = resolve(where ?? `kiosko-plugin-${id}`);
      if (existsSync(dir) && readdirSync(dir).length) throw new Error(`${dir} is not empty`);
      for (const [file, body] of Object.entries(newPluginFiles(id))) {
        mkdirSync(join(dir, file, '..'), { recursive: true });
        writeFileSync(join(dir, file), body);
      }
      console.log(`${dir}\n\n  cd ${where ?? `kiosko-plugin-${id}`} && npm install && npm test\n  npm run kiosko:check    then: npm run build && npm run dev`);
      return;
    }
    case 'list': {
      const r = await registry();
      for (const p of r.list()) {
        const widgets = p.def.widgets?.length ?? 0;
        console.log(`${p.enabled ? '●' : '○'} ${p.def.id.padEnd(10)} v${p.def.version.padEnd(8)} ${String(widgets).padStart(2)} widgets  ${localize(p.def.name, 'en').padEnd(24)} ${p.origin}`);
      }
      for (const pr of r.problems) console.log(`✗ ${pr.origin}: ${pr.message}`);
      console.log(`\nplugins folder: ${paths.plugins}`);
      return;
    }
    case 'add':
    case 'install': {
      if (!names.length) throw new Error('usage: kiosko plugins add <id|npm package>…');
      const dir = ensureFolder();
      // --ignore-scripts: a plugin is code that runs as you; its install shouldn't run anything else.
      npm(['install', '--no-audit', '--no-fund', '--ignore-scripts', ...names.map(npmName)], dir);
      console.log('installed; restart Kiosko to load it (systemctl --user restart kiosko)');
      return;
    }
    case 'link': {
      if (!names.length) throw new Error('usage: kiosko plugins link <folder>…');
      const dir = ensureFolder();
      for (const n of names) {
        const src = resolve(n);
        const pkgPath = join(src, 'package.json');
        if (!existsSync(pkgPath)) throw new Error(`${src} has no package.json`);
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: string; kiosko?: { plugin?: string; id?: string } };
        const entry = pkg.kiosko?.plugin;
        if (entry && !existsSync(join(src, entry))) console.warn(`warning: ${entry} doesn't exist yet in ${src} (run its build)`);
        const target = join(dir, pkg.kiosko?.id ?? basename(src).replace(/^kiosko-plugin-/, ''));
        const existing = (() => {
          try {
            return lstatSync(target);
          } catch {
            return null;
          }
        })();
        if (existing && !existing.isSymbolicLink()) throw new Error(`${target} is a real folder, not a link: move it away first`);
        if (existing) rmSync(target);
        symlinkSync(src, target, process.platform === 'win32' ? 'junction' : 'dir');
        console.log(`${target} → ${src}`);
      }
      console.log('restart Kiosko to load them (systemctl --user restart kiosko)');
      return;
    }
    case 'remove':
    case 'uninstall': {
      const dir = ensureFolder();
      for (const n of names) {
        const id = n.replace(/^kiosko-plugin-/, '');
        const link = join(dir, id);
        const st = (() => {
          try {
            return lstatSync(link);
          } catch {
            return null;
          }
        })();
        if (st?.isSymbolicLink()) {
          rmSync(link);
          console.log(`unlinked ${link}`);
        } else if (st) {
          console.log(`${link} is a folder you put there: delete it yourself if you mean it`);
        } else npm(['uninstall', '--no-audit', '--no-fund', npmName(n)], dir);
      }
      return;
    }
    default:
      console.log('usage: kiosko plugins [list|add <id|pkg>…|link <folder>…|remove <id>…|check [folder]|manifest [folder]|dev [folder]|new <id> [folder]]');
  }
}

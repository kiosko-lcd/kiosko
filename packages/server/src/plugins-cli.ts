/**
 * `kiosko plugins …`: manage the plugins folder from a terminal, and the
 * tools for writing one.
 *
 *   kiosko plugins                 what's loaded and from where
 *   kiosko plugins add <id|pkg>…   install from npm (`agents` → kiosko-plugin-agents)
 *   kiosko plugins link <dir>…     use a local checkout (development, unpublished plugins)
 *   kiosko plugins remove <id|pkg>…
 *   kiosko plugins check [dir]     conventions, and every widget painted at several sizes, themes and languages
 *   kiosko plugins manifest [dir]  write kiosko-manifest.json (what a store reads)
 *   kiosko plugins dev [dir]       link it and reload it in the running Kiosko on every build
 */
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, watch, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { incompatibility, installSdkResolver, languagesOf, lintPlugin, loadConfig, packageMeta, paths, pluginManifest, type Registry } from '@kiosko/core';
import { localize, type PluginDefinition } from '@kiosko/sdk';

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

/** `kiosko plugins check`: lint + paint. Returns the number of errors. */
async function check(dir: string, argv: string[]): Promise<number> {
  const { def, pkg, entry } = await loadPluginDir(dir, { src: flagOf(argv, '--src') });
  console.log(`${def.id} v${def.version}  (${entry})`);
  const issues = lintPlugin(def);
  const meta = packageMeta(pkg);
  if (!meta.sdk) issues.push({ level: 'warn', where: 'package.json', message: 'add "kiosko": { "sdk": "^x.y.z" } so an incompatible Kiosko refuses it before running it' });
  else if (def.sdk && meta.sdk !== def.sdk) issues.push({ level: 'warn', where: 'package.json', message: `kiosko.sdk ${meta.sdk} differs from the definition's sdk ${def.sdk}` });
  const why = incompatibility({ sdk: def.sdk ?? meta.sdk, platforms: def.platforms ?? meta.platforms });
  if (why) issues.push({ level: 'warn', where: 'plugin', message: `this Kiosko can't run it: ${why}` });
  if (pkg.version && pkg.version !== def.version) issues.push({ level: 'warn', where: 'package.json', message: `version ${pkg.version} differs from the definition's ${def.version}` });
  // Painting needs the canvas: from Kiosko's own copy.
  const { checkPlugin } = await import('@kiosko/sdk/testing');
  // The same problem at the same size in every theme and language is one line.
  const painted = new Map<string, { type: string; size: string; problem: string; looks: string[] }>();
  for (const p of checkPlugin(def, { locales: languagesOf(def) })) {
    const [size = '', ...look] = p.where.split(' ');
    const problem = p.problem.replace(/\d+ px/, 'N px').replace(/\d+ ms/, 'N ms');
    const key = `${p.type}|${size}|${problem}`;
    const g = painted.get(key) ?? { type: p.type, size, problem: p.problem, looks: [] };
    g.looks.push(look.join(' '));
    painted.set(key, g);
  }
  for (const g of painted.values()) issues.push({ level: /threw/.test(g.problem) ? 'error' : 'warn', where: `${g.type} ${g.size}`, message: `${g.problem}${g.looks.length > 1 ? ` (${g.looks.length} themes/languages)` : g.looks[0] ? ` (${g.looks[0]})` : ''}` });
  const errors = issues.filter((i) => i.level === 'error');
  for (const i of [...errors, ...issues.filter((i) => i.level === 'warn')]) console.log(`${i.level === 'error' ? '✗' : '!'} ${i.where}: ${i.message}`);
  console.log(issues.length ? `\n${errors.length} errors, ${issues.length - errors.length} warnings` : '✓ no problems found');
  return errors.length;
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

export async function pluginsCommand(argv: string[], registry: () => Promise<Registry>): Promise<void> {
  const [sub = 'list', ...names] = argv;
  switch (sub) {
    case 'check': {
      const errors = await check(positional(names)[0] ?? '.', names);
      if (errors) process.exitCode = 1;
      return;
    }
    case 'manifest':
      return manifest(positional(names)[0] ?? '.', names);
    case 'dev':
      return dev(positional(names)[0] ?? '.', names);
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
      console.log('usage: kiosko plugins [list|add <id|pkg>…|link <folder>…|remove <id>…|check [folder]|manifest [folder]|dev [folder]]');
  }
}

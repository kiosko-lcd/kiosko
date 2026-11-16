/**
 * Installing, removing and reloading plugins while Kiosko runs, for the
 * editor's Plugins page. npm does the downloading (with `--ignore-scripts`:
 * a plugin is code that runs as you, its install shouldn't run anything
 * else); the registry loads the new code without a restart.
 */
import { execFile } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { packageMeta, paths, type Registry, type Runtime } from '@kiosko/core';

/** An npm package name (optionally scoped) with an optional version or range: no URLs, paths or flags. */
export const NPM_NAME = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(@[\w.^~<>=*-]+)?$/i;

/** `kiosko-plugin-x@^1.2` → `kiosko-plugin-x`; `@acme/kiosko-plugin-x@1` → `@acme/kiosko-plugin-x`. */
export const packageName = (spec: string) => (spec.startsWith('@') ? `@${spec.slice(1).split('@')[0]}` : spec.split('@')[0]!);

function ensureFolder(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const pkg = join(dir, 'package.json');
  if (!existsSync(pkg)) writeFileSync(pkg, `${JSON.stringify({ name: 'kiosko-user-plugins', private: true, type: 'module' }, null, 2)}\n`);
}

export type Npm = (args: string[], cwd: string) => Promise<string>;

const realNpm: Npm = (args, cwd) =>
  new Promise((ok, fail) => {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    execFile(npm, args, { cwd, timeout: 180_000, shell: process.platform === 'win32' }, (err, stdout, stderr) => (err ? fail(new Error((stderr || err.message).slice(-2000))) : ok(stdout.slice(-2000))));
  });

export interface ManageOptions {
  registry: Registry;
  runtime: Pick<Runtime, 'pluginsChanged'>;
  /** The plugins folder (default: Kiosko's). */
  dir?: string;
  npm?: Npm;
}

/**
 * Installs a package from npm into the plugins folder and loads it at once.
 * Installing a newer version of a loaded plugin replaces it. Returns the
 * plugin ids now running, or `restart: true` when the new code could only
 * take over after a restart.
 */
export async function installPlugin(spec: string, o: ManageOptions): Promise<{ ids: string[]; output: string; restart: boolean; problem?: string }> {
  if (!NPM_NAME.test(spec)) throw new Error('not a valid npm package name');
  const dir = o.dir ?? paths.plugins;
  ensureFolder(dir);
  const output = await (o.npm ?? realNpm)(['install', '--no-audit', '--no-fund', '--ignore-scripts', spec], dir);
  const folder = join(dir, 'node_modules', packageName(spec));
  if (!existsSync(join(folder, 'package.json'))) return { ids: [], output, restart: true, problem: `${packageName(spec)} was installed but has no package.json` };
  const meta = packageMeta(JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8')));
  const id = meta.id;
  const r = o.registry;
  let ids: string[] = [];
  let problem: string | undefined;
  if (id && r.plugin(id) && r.originOf(id) === folder) {
    // An update of a plugin installed here: its entry file is read again.
    problem = (await r.reload(id)) ?? undefined;
    if (!problem) ids = [id];
  } else {
    // New, or replacing a copy that came with Kiosko (the folder's wins, as at start-up).
    if (id && r.plugin(id)) r.remove(id);
    const before = r.problems.length;
    ids = await r.loadOne(folder);
    if (!ids.length) problem = r.problems.slice(before).map((p) => p.message).join('; ') || 'it did not load';
  }
  if (ids.length) o.runtime.pluginsChanged(ids);
  return { ids, output, restart: false, ...(problem ? { problem } : {}) };
}

/**
 * Removes a plugin that lives in the plugins folder: an npm install is
 * uninstalled, a linked checkout unlinked. A folder someone copied there by
 * hand is left alone (it may be their only copy), and built-in plugins
 * can't be removed.
 */
export async function removePlugin(id: string, o: ManageOptions): Promise<{ removed: boolean; reason?: string }> {
  const dir = resolve(o.dir ?? paths.plugins);
  const origin = o.registry.originOf(id);
  if (!origin) return { removed: false, reason: o.registry.plugin(id) ? 'it comes with Kiosko' : 'it is not loaded' };
  const rel = relative(dir, resolve(origin));
  if (rel.startsWith('..') || rel === '') return { removed: false, reason: `it was loaded from ${origin}, outside the plugins folder` };
  const parts = rel.split(sep);
  if (parts[0] === 'node_modules') {
    const name = parts[1]!.startsWith('@') ? `${parts[1]}/${parts[2]}` : parts[1]!;
    await (o.npm ?? realNpm)(['uninstall', '--no-audit', '--no-fund', name], dir);
  } else {
    const top = join(dir, parts[0]!);
    if (!lstatSync(top).isSymbolicLink()) return { removed: false, reason: `${top} is a folder you put there: delete it yourself if you mean it` };
    rmSync(top);
  }
  o.registry.remove(id);
  o.runtime.pluginsChanged([id]);
  return { removed: true };
}

/** Loads a plugin's code again (after rebuilding it). */
export async function reloadPlugin(id: string, o: ManageOptions): Promise<string | null> {
  const problem = await o.registry.reload(id);
  if (!problem) o.runtime.pluginsChanged([id]);
  return problem;
}

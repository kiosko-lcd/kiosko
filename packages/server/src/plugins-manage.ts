/**
 * Installing, removing and reloading plugins while Kiosko runs, for the
 * editor's Plugins page. npm does the downloading (with `--ignore-scripts`:
 * a plugin is code that runs as you, its install shouldn't run anything
 * else); the registry loads the new code without a restart.
 */
import { execFile } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { addedPermissions, packageMeta, paths, type Registry, type Runtime } from '@kiosko/core';

import type { Permissions } from '@kiosko/sdk';

export { addedPermissions };

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

/** What npm installed is not the tarball the store named. */
export class IntegrityError extends Error {
  override name = 'IntegrityError';
}

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

export interface InstallResult {
  ids: string[];
  output: string;
  restart: boolean;
  problem?: string;
  /** The new code didn't load and the previous version is back (reinstalled, or the copy that came with Kiosko). */
  rolledBack?: boolean;
  /** What the new version declares doing that the one it replaced didn't. */
  addedPermissions?: Permissions;
}

/** The integrity npm recorded for a package it installed in `dir` (node_modules/.package-lock.json), if any. */
export function installedIntegrity(dir: string, name: string): string | undefined {
  try {
    const lock = JSON.parse(readFileSync(join(dir, 'node_modules', '.package-lock.json'), 'utf8')) as { packages?: Record<string, { integrity?: string }> };
    return lock.packages?.[`node_modules/${name}`]?.integrity;
  } catch {
    return undefined;
  }
}

/**
 * Installs a package from npm into the plugins folder and loads it at once.
 * Installing a newer version of a loaded plugin replaces it in place. If the
 * new code doesn't load, the previous version comes back: the one installed
 * here is reinstalled, or the copy that came with Kiosko is put back, so a
 * bad update never leaves the plugin missing.
 */
export async function installPlugin(spec: string, o: ManageOptions & { expectIntegrity?: string }): Promise<InstallResult> {
  if (!NPM_NAME.test(spec)) throw new Error('not a valid npm package name');
  const dir = o.dir ?? paths.plugins;
  ensureFolder(dir);
  const npm = o.npm ?? realNpm;
  const r = o.registry;
  const folder = join(dir, 'node_modules', packageName(spec));
  // What was there before: the version installed here (to reinstall it), and the plugin loaded (to restore it).
  const readPkg = () => (existsSync(join(folder, 'package.json')) ? (JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8')) as Record<string, any>) : null);
  const beforePkg = readPkg();
  const beforeId = beforePkg ? packageMeta(beforePkg).id : undefined;
  const output = await npm(['install', '--no-audit', '--no-fund', '--ignore-scripts', '--save-exact', spec], dir);
  // From the store: what npm installed must be the very tarball the catalogue names (a tampered
  // registry or catalogue), checked before any of its code is loaded. Otherwise it goes again.
  if (o.expectIntegrity) {
    const got = installedIntegrity(dir, packageName(spec));
    if (got !== o.expectIntegrity) {
      if (beforePkg?.version) await npm(['install', '--no-audit', '--no-fund', '--ignore-scripts', '--save-exact', `${packageName(spec)}@${beforePkg.version}`], dir);
      else await npm(['uninstall', '--no-audit', '--no-fund', packageName(spec)], dir);
      throw new IntegrityError(`${spec}: what npm installed is not what the store's catalogue says (${got ? 'another integrity' : 'no integrity recorded'}); ${beforePkg?.version ? `${beforePkg.version} is back` : 'removed again'}, nothing of it was loaded`);
    }
  }
  const pkg = readPkg();
  if (!pkg) return { ids: [], output, restart: true, problem: `${packageName(spec)} was installed but has no package.json` };
  const id = packageMeta(pkg).id;
  const prev = id ? r.plugin(id) : beforeId ? r.plugin(beforeId) : undefined;
  const prevOrigin = prev ? (r.originOf(prev.def.id) ?? prev.origin) : undefined;
  let ids: string[] = [];
  let problem: string | undefined;
  if (id && prev && r.originOf(id) === folder) {
    // An update of a plugin installed here: its entry file is read again.
    problem = (await r.reload(id)) ?? undefined;
    if (!problem) ids = [id];
  } else {
    // New, or replacing a copy that came with Kiosko (the folder's wins, as at start-up).
    if (prev) r.remove(prev.def.id);
    const before = r.problems.length;
    ids = await r.loadOne(folder);
    if (!ids.length) problem = r.problems.slice(before).map((p) => p.message).join('; ') || 'it did not load';
  }
  if (problem && prev) {
    // Put the previous version back.
    if (prevOrigin === folder && beforePkg?.version) {
      await npm(['install', '--no-audit', '--no-fund', '--ignore-scripts', '--save-exact', `${packageName(spec)}@${beforePkg.version}`], dir);
      if (!r.plugin(prev.def.id)) await r.loadOne(folder);
      else await r.reload(prev.def.id);
    } else {
      await npm(['uninstall', '--no-audit', '--no-fund', packageName(spec)], dir);
      if (!r.plugin(prev.def.id)) r.add(prev.def, prev.origin);
    }
    o.runtime.pluginsChanged([prev.def.id]);
    return { ids: [], output, restart: false, problem, rolledBack: true };
  }
  if (ids.length) o.runtime.pluginsChanged(ids);
  const now = id ? r.plugin(id) : undefined;
  const added = prev && now ? addedPermissions(prev.def.permissions, now.def.permissions) : {};
  return { ids, output, restart: false, ...(problem ? { problem } : {}), ...(Object.keys(added).length ? { addedPermissions: added } : {}) };
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

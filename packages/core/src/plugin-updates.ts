/**
 * Newer versions of the installed plugins (and of Kiosko), from the npm
 * registry. For each plugin it finds the newest version that fits this
 * Kiosko: npm keeps every version's package.json, and its `kiosko.sdk` (or
 * @kiosko/sdk peer range) and `os` say whether it would load here, so a
 * plugin is never offered a version Kiosko would then refuse. A newer one
 * that doesn't fit is reported with why ("needs a newer Kiosko").
 *
 * Read with the abbreviated metadata (the one npm itself installs from)
 * and conditional requests, once a day: a handful of small requests.
 */
import { SDK_VERSION, compareVersions, createHttp, parseVersion, type HttpClient } from '@kiosko/sdk';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { incompatibility, packageMeta } from './plugin-meta.ts';
import { kioskoReleaseNotes, versionsBetween, type KioskoNotes } from './kiosko-release.ts';

export const REGISTRY = 'https://registry.npmjs.org';

/**
 * The registry npm installs from here: `npm_config_registry`, else the
 * `registry=` of the user's .npmrc, else npm's own. Asking that one keeps the
 * check where installs go: in mainland China, npmmirror (registry.npmjs.org
 * is slow or times out there). Project and global .npmrc files are not read.
 */
export function npmRegistry(env: Record<string, string | undefined> = process.env, home = homedir()): string {
  const fromEnv = env.npm_config_registry ?? env.NPM_CONFIG_REGISTRY;
  if (fromEnv?.trim()) return fromEnv.trim().replace(/\/+$/, '');
  try {
    const rc = readFileSync(env.npm_config_userconfig ?? env.NPM_CONFIG_USERCONFIG ?? join(home, '.npmrc'), 'utf8');
    const line = rc.split(/\r?\n/).map((l) => l.trim()).find((l) => /^registry\s*=/.test(l));
    const url = line?.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '');
    if (url && /^https?:\/\//.test(url)) return url.replace(/\/+$/, '');
  } catch {
    /* no .npmrc */
  }
  return REGISTRY;
}

export interface InstalledPlugin {
  id: string;
  /** Its npm package (`kiosko-plugin-weather`). */
  package: string;
  /** The version installed now. */
  version: string;
}

export interface PluginUpdate {
  id: string;
  package: string;
  current: string;
  /** The newest version on npm (its `latest` tag). */
  latest: string;
  /** The newest version newer than `current` that fits this Kiosko, if any: what "Update" installs. */
  version?: string;
  /** Why `latest` itself can't be installed here, when it can't. */
  blocked?: string;
  /** The newer Kiosko (the one npm has) that `latest` would fit, when it is only blocked by this Kiosko's plugin API. */
  unlockedBy?: string;
}

/** Kiosko itself, when npm has a newer one. */
export interface KioskoUpdate {
  current: string;
  latest: string;
  /** The stable versions after `current` up to `latest`, newest first (npm's list). */
  versions: string[];
  /** What's new in them (GitHub's release notes, or npm's versions when GitHub can't be read). */
  notes?: KioskoNotes;
}

export interface UpdateCheck {
  /** When the registry was asked (epoch ms). */
  checkedAt: number;
  /** Plugins with something newer: installable (`version`) or not (`blocked`). */
  plugins: PluginUpdate[];
  /** Kiosko itself, when npm has a newer one. */
  kiosko?: KioskoUpdate;
  /** Packages that couldn't be checked (offline, not on npm…), with why. */
  errors: { package: string; error: string }[];
}

interface Packument {
  'dist-tags'?: Record<string, string>;
  versions?: Record<string, Record<string, any>>;
}

/** Newest first, stable releases only (a pre-release is never offered on its own). */
const releases = (p: Packument) =>
  Object.keys(p.versions ?? {})
    .filter((v) => {
      const x = parseVersion(v);
      return !!x && !x[3];
    })
    .sort((a, b) => compareVersions(b, a));

/**
 * For one plugin: the newest version that fits, and why `latest` doesn't if
 * it doesn't. With `kioskoLatest` (a newer Kiosko npm has), whether that one
 * would take `latest`: its plugin API is its version (SDK_VERSION follows
 * Kiosko's).
 */
export function pickUpdate(installed: InstalledPlugin, p: Packument, env: { sdk: string; platform: string; kioskoLatest?: string }): PluginUpdate | null {
  const latest = p['dist-tags']?.latest;
  if (!latest || compareVersions(latest, installed.version) <= 0) return null;
  const meta = (v: string) => packageMeta(p.versions?.[v] ?? {});
  const why = (v: string) => incompatibility(meta(v), env);
  const blocked = p.versions?.[latest] ? why(latest) : null;
  const version = releases(p).find((v) => compareVersions(v, installed.version) > 0 && compareVersions(v, latest) <= 0 && !why(v));
  const unlocks = blocked && env.kioskoLatest && compareVersions(env.kioskoLatest, env.sdk) > 0 && !incompatibility(meta(latest), { sdk: env.kioskoLatest, platform: env.platform });
  return { id: installed.id, package: installed.package, current: installed.version, latest, ...(version ? { version } : {}), ...(blocked ? { blocked } : {}), ...(unlocks ? { unlockedBy: env.kioskoLatest } : {}) };
}

/**
 * Asks npm about every installed plugin (and Kiosko), and GitHub what is new
 * in a newer Kiosko. Never throws: a package that can't be read is listed in
 * `errors`; GitHub unreachable leaves npm's version list as the notes.
 */
export async function checkUpdates(
  plugins: InstalledPlugin[],
  o: { kioskoVersion?: string; http?: HttpClient; registry?: string; sdk?: string; platform?: string; now?: number; signal?: AbortSignal; github?: string | false } = {},
): Promise<UpdateCheck> {
  const http = o.http ?? createHttp({ agent: 'kiosko-updates' });
  const env = { sdk: o.sdk ?? SDK_VERSION, platform: o.platform ?? process.platform };
  const base = o.registry ?? npmRegistry();
  const headers = { Accept: 'application/vnd.npm.install-v1+json' };
  const errors: UpdateCheck['errors'] = [];
  const read = async (pkg: string): Promise<Packument | null> => {
    try {
      return (await http.json<Packument>(`${base}/${pkg.replace('/', '%2F')}`, { headers, ...(o.signal ? { signal: o.signal } : {}) })).data;
    } catch (err) {
      errors.push({ package: pkg, error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  };
  const [k, ...found] = await Promise.all([o.kioskoVersion ? read('kiosko') : Promise.resolve(null), ...plugins.map((pl) => read(pl.package))]);
  let kiosko: KioskoUpdate | undefined;
  const latest = k?.['dist-tags']?.latest;
  if (o.kioskoVersion && latest && compareVersions(latest, o.kioskoVersion) > 0) {
    const all = Object.keys(k?.versions ?? {});
    const versions = versionsBetween(all.length ? all : [latest], o.kioskoVersion, latest);
    const notes = o.github === false ? undefined : await kioskoReleaseNotes(o.kioskoVersion, latest, { http, npmVersions: versions, ...(o.github ? { api: o.github } : {}), ...(o.signal ? { signal: o.signal } : {}) });
    kiosko = { current: o.kioskoVersion, latest, versions, ...(notes ? { notes } : {}) };
  }
  const picked = plugins.map((pl, i) => (found[i] ? pickUpdate(pl, found[i]!, { ...env, ...(kiosko ? { kioskoLatest: kiosko.latest } : {}) }) : null));
  return { checkedAt: o.now ?? Date.now(), plugins: picked.filter((x): x is PluginUpdate => !!x), ...(kiosko ? { kiosko } : {}), errors };
}

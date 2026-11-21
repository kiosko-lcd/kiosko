/**
 * What the store's two faces (the site's /store/ pages and the editor's
 * Plugins page) work out from the index for the person looking: whether a
 * plugin runs here, which version would be installed, whether it is useful
 * where they are, and how it is found and sorted. Pure, browser-safe.
 */
import { compareVersions, satisfies } from '@kiosko/sdk/semver';
import { languageById } from '@kiosko/sdk/languages';
import type { StorePlugin, StoreRelease, Texts } from './types.ts';

/** A text in the reader's language: the exact tag, its language, then English. */
export function textIn(t: Texts | undefined, lang: string): string {
  if (!t) return '';
  if (t[lang]) return t[lang];
  const base = lang.split('-')[0]!;
  // zh-TW reads zh-Hant, zh-CN zh-Hans: the same script, never the other one.
  const script = scriptOf(lang);
  const near = Object.keys(t).find((k) => k !== 'en' && k.split('-')[0] === base && (!script || scriptOf(k) === script));
  return (near && t[near]) || t.en;
}

function scriptOf(tag: string): string | null {
  try {
    return new Intl.Locale(tag).maximize().script ?? null;
  } catch {
    return null;
  }
}

/** Why a release can't run here, or null: `sdk` (another plugin API) or `os`. */
export function releaseProblem(r: Pick<StoreRelease, 'sdk' | 'platforms'>, env: { sdk: string; platform: string }): { code: 'sdk'; range: string } | { code: 'os'; platforms: string[] } | null {
  if (r.sdk && !satisfies(env.sdk, r.sdk)) return { code: 'sdk', range: r.sdk };
  if (r.platforms?.length && !r.platforms.includes(env.platform as never)) return { code: 'os', platforms: r.platforms };
  return null;
}

/**
 * The release "Install" puts here: the newest stable one that fits this
 * Kiosko and system and isn't withdrawn. Deprecated ones are skipped while a
 * newer fitting one exists.
 */
export function installableRelease(p: StorePlugin, env: { sdk: string; platform: string }): StoreRelease | null {
  const ok = p.releases.filter((r) => !r.withdrawn && !releaseProblem({ sdk: r.sdk ?? undefined, platforms: r.platforms ?? p.platforms }, env));
  return ok.find((r) => !r.deprecated) ?? ok[0] ?? null;
}

/** The region of a locale (`es-ES` → `ES`, `zh-Hant` → `TW`, `zh-Hans` → `CN`), or null when it doesn't say (`en`, `es`). */
export function regionOf(locale: string | undefined): string | null {
  if (!locale) return null;
  try {
    const l = new Intl.Locale(locale.replace(/_/g, '-').replace(/[.@].*$/, ''));
    // A bare language says where most of its speakers are, which is a guess: only take it from Chinese, whose script does say.
    if (!l.region && l.language !== 'zh') return null;
    return l.maximize().region ?? null;
  } catch {
    return null;
  }
}

/**
 * Whether a plugin is useful in this region: `ok`, `elsewhere` (only useful
 * somewhere else: its `markets.only`) or `missing` (its service isn't
 * offered here: `markets.without`, or Kiosko's own per-language list, the
 * one the front page uses, for the language the person reads).
 */
export function marketFor(p: Pick<StorePlugin, 'id' | 'markets'>, where: { region: string | null; lang: string }): 'ok' | 'elsewhere' | 'missing' {
  if (languageById(where.lang)?.plugins?.without.includes(p.id)) return 'missing';
  const r = where.region;
  if (!r) return 'ok';
  const inList = (l: string[] | undefined) => !!l?.some((c) => c === r || (c === 'EU' && EU.includes(r)));
  if (p.markets?.without?.length && inList(p.markets.without)) return 'missing';
  if (p.markets?.only?.length && !inList(p.markets.only)) return 'elsewhere';
  return 'ok';
}

const EU = ['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE'];

/** Everything a search matches: names and descriptions in every language, id, package, tags, widget names. */
export function searchText(p: StorePlugin): string {
  const all = (t: Texts | undefined) => (t ? Object.values(t).join(' ') : '');
  return [p.id, p.package, all(p.name), all(p.description), p.tags.join(' '), p.categories.join(' '), ...p.widgets.map((w) => all(w.name)), ...p.interludes.map((i) => all(i.name))].join(' ').toLowerCase();
}

/** Whether every word of a query is in the plugin's text. */
export function matches(p: StorePlugin, query: string, text = searchText(p)): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return words.every((w) => text.includes(w));
}

/**
 * The default order ("Featured"): official first (bundled before optional,
 * in their own order), then verified and listed, then the rest, newest
 * first; never by downloads alone.
 */
export function featuredOrder(a: StorePlugin, b: StorePlugin): number {
  const rank = (p: StorePlugin) => ({ official: 0, verified: 1, listed: 2, found: 3 })[p.tier];
  return rank(a) - rank(b) || Number(!a.bundled) - Number(!b.bundled) || (b.releases[0]?.date ?? '').localeCompare(a.releases[0]?.date ?? '');
}

/** Newest release first. */
export const recentOrder = (a: StorePlugin, b: StorePlugin) => (b.releases[0]?.date ?? '').localeCompare(a.releases[0]?.date ?? '');

/** By the most recent version number known: helps tell an update in the editor. */
export const isNewer = (a: string, b: string) => compareVersions(a, b) > 0;

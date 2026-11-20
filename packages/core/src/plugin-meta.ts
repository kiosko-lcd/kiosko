/**
 * What can be known about a plugin without painting anything: whether it
 * fits this Kiosko (plugin API version, operating system), what its
 * package.json declares, which other plugins it needs, and its manifest,
 * the record a plugin store (or the editor, before loading its code) reads:
 * identity, authorship, versions, permissions, languages, widgets with their
 * sizes, options and screenshots.
 */
import { SDK_VERSION, risksOf, satisfies, toJsonSchema, type Field, type Localized, type Permissions, type Platform, type PluginDefinition, type Risk } from '@kiosko/sdk';

const PLATFORMS: Platform[] = ['linux', 'darwin', 'win32'];

/** What a plugin's package.json says about it for Kiosko. */
export interface PackageMeta {
  name?: string;
  version?: string;
  /** `kiosko.id`, or the package name without `kiosko-plugin-`. */
  id?: string;
  /** `kiosko.sdk`, else the `@kiosko/sdk` peer dependency range. */
  sdk?: string;
  /** From npm's `os` (`["linux"]`, `["!win32"]`), as the list of systems it runs on. */
  platforms?: Platform[];
  /** `kiosko.languages`: the languages its texts come in. */
  languages?: string[];
}

export function packageMeta(pkg: Record<string, any>): PackageMeta {
  const out: PackageMeta = {};
  if (typeof pkg.name === 'string') out.name = pkg.name;
  if (typeof pkg.version === 'string') out.version = pkg.version;
  const id = pkg.kiosko?.id ?? (typeof pkg.name === 'string' ? pkg.name.replace(/^@[^/]+\//, '').replace(/^kiosko-plugin-/, '') : undefined);
  if (typeof id === 'string') out.id = id;
  const sdk = pkg.kiosko?.sdk ?? pkg.peerDependencies?.['@kiosko/sdk'];
  if (typeof sdk === 'string') out.sdk = sdk;
  if (Array.isArray(pkg.os) && pkg.os.length) {
    const os = pkg.os.filter((x: unknown): x is string => typeof x === 'string');
    const allow = os.filter((x: string) => !x.startsWith('!'));
    const deny = os.filter((x: string) => x.startsWith('!')).map((x: string) => x.slice(1));
    out.platforms = PLATFORMS.filter((p) => (!allow.length || allow.includes(p)) && !deny.includes(p));
  }
  const langs = pkg.kiosko?.languages;
  if (Array.isArray(langs) && langs.length) out.languages = langs.filter((x: unknown): x is string => typeof x === 'string');
  return out;
}

/**
 * Why a plugin can't run here, or null when it can: a plugin API range this
 * Kiosko is not in, or an operating system it doesn't support.
 */
export function incompatibility(o: { sdk?: string | undefined; platforms?: readonly string[] | undefined }, env: { sdk: string; platform: string } = { sdk: SDK_VERSION, platform: process.platform }): string | null {
  if (o.sdk && !satisfies(env.sdk, o.sdk)) return `written for the plugin API ${o.sdk}; this Kiosko has ${env.sdk}`;
  if (o.platforms && !o.platforms.includes(env.platform)) return `works on ${o.platforms.map(platformName).join(', ')}, not on ${platformName(env.platform)}`;
  return null;
}

const platformName = (p: string) => (p === 'darwin' ? 'macOS' : p === 'win32' ? 'Windows' : p === 'linux' ? 'Linux' : p);

/** The plugin id of a type (`agents/sessions` → `agents`). */
export const pluginOf = (type: string) => type.split('/')[0] ?? type;

/** A template's widget type, with this plugin's own bare ids made full (`clock` → `core/clock`). */
export const fullType = (pluginId: string, type: string) => (type.includes('/') ? type : `${pluginId}/${type}`);

/* ---------- manifest ---------- */

export interface ManifestOption {
  /** `token`, `endpoints[].url`. */
  path: string;
  risk: Risk[];
  secret: boolean;
}

export interface ManifestWidget {
  type: string;
  name: Localized;
  description?: Localized;
  icon?: string;
  category: string;
  tags: string[];
  size: { min?: { w: number; h: number }; preferred?: { w: number; h: number }; max?: { w: number; h: number } };
  chrome: 'card' | 'bare';
  sources: string[];
  /** JSON Schema of its options (as `kiosko config schema` writes them). */
  options: Record<string, unknown> | null;
  /** A picture painted with its demo data, relative to the package (`docs/forecast.png`). */
  screenshot?: string;
  animated: boolean;
  urgent: boolean;
}

/**
 * The record of a plugin a store or the editor reads without running it.
 * Ratings and reviews are the store's, not the author's: they don't live
 * here.
 */
export interface PluginManifest {
  manifest: 1;
  id: string;
  /** The npm package (`kiosko-plugin-weather`). */
  package?: string;
  name: Localized;
  version: string;
  description?: Localized;
  author?: string;
  license?: string;
  homepage?: string;
  repository?: string;
  icon?: string;
  /** Plugin API range it is written for. */
  sdk?: string;
  platforms: Platform[];
  /** Language tags its texts come in (`en`, `es`, `zh-Hant`, `zh-Hans`): as declared, or read from its texts. */
  languages: string[];
  /** Widget categories it covers, for browsing. */
  categories: string[];
  /** Widget tags, for search. */
  tags: string[];
  permissions: Permissions;
  /** Options whose values make it act on the user's behalf (run, connect, read). */
  riskyOptions: ManifestOption[];
  /** Types of other plugins it needs, and the plugins that bring them. */
  requires: { type: string; plugin: string }[];
  /** Types of other plugins it uses when they are there. */
  optional: { type: string; plugin: string }[];
  widgets: ManifestWidget[];
  sources: { type: string; name: Localized; description?: Localized; polled: boolean; intervalMs?: number; options: Record<string, unknown> | null }[];
  interludes: { type: string; name: Localized; description?: Localized; icon?: string; fps: number }[];
  templates: { id: string; name: Localized; icon?: string; widgets: string[] }[];
}

/** A BCP 47 tag (`en`, `fil`, `yue`, `es-419`, `zh-Hant-TW`), not just any short key. */
function isLanguageTag(k: string): boolean {
  if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(k)) return false;
  try {
    return Intl.getCanonicalLocales(k).length === 1;
  } catch {
    return false;
  }
}

/** The languages a plugin speaks: the ones it declares (`languages`), or else the ones its texts use. */
export function declaredLanguages(def: PluginDefinition, meta: PackageMeta = {}): string[] {
  return def.languages?.length ? [...def.languages] : meta.languages?.length ? [...meta.languages] : languagesOf(def);
}

/** Every language tag used in a plugin's texts. */
export function languagesOf(def: PluginDefinition): string[] {
  const out = new Set<string>();
  const seen = new WeakSet<object>();
  const walk = (v: unknown, key = ''): void => {
    if (!v || typeof v !== 'object' || seen.has(v as object)) return;
    seen.add(v as object);
    if (Array.isArray(v)) return void v.forEach((x) => walk(x));
    const o = v as Record<string, unknown>;
    // A Localized: an object with `en` and only short language codes as keys, all strings.
    const keys = Object.keys(o);
    if (keys.includes('en') && keys.every((k) => isLanguageTag(k) && typeof o[k] === 'string')) {
      for (const k of keys) out.add(k);
      return;
    }
    for (const [k, x] of Object.entries(o)) if (typeof x !== 'function' && k !== 'default') walk(x, k);
  };
  walk({ name: def.name, description: def.description, widgets: def.widgets, sources: def.sources, interludes: def.interludes, templates: def.templates });
  if (!out.size) out.add('en');
  return [...out].sort((a, b) => (a === 'en' ? -1 : b === 'en' ? 1 : a.localeCompare(b)));
}

/** Options whose value runs a program, contacts a host or reads a path, with their path. */
export function riskyOptions(f: Field | undefined, prefix = ''): ManifestOption[] {
  if (!f) return [];
  const out: ManifestOption[] = [];
  const here = (path: string, x: Field) => {
    const risk = risksOf(x);
    const secret = x.kind === 'string' && !!x.secret;
    if (risk.length || secret) out.push({ path, risk, secret });
  };
  if (f.kind === 'object') {
    for (const [k, sub] of Object.entries(f.props as Record<string, Field>)) {
      const path = prefix ? `${prefix}.${k}` : k;
      if (sub.kind === 'object') out.push(...riskyOptions(sub, path));
      else if (sub.kind === 'list' && sub.item.kind === 'object') out.push(...riskyOptions(sub.item, `${path}[]`));
      else here(path, sub.kind === 'list' ? { ...sub.item, risk: sub.risk ?? sub.item.risk } as Field : sub);
    }
  } else here(prefix, f);
  return out;
}

/**
 * The manifest of a plugin. `screenshots` maps widget ids to pictures
 * (relative paths in its package); `pkg` adds what only package.json knows.
 */
export function pluginManifest(def: PluginDefinition, o: { screenshots?: Record<string, string>; pkg?: Record<string, any> } = {}): PluginManifest {
  const meta = o.pkg ? packageMeta(o.pkg) : {};
  const widgets = def.widgets ?? [];
  const repo = typeof o.pkg?.repository === 'string' ? o.pkg.repository : o.pkg?.repository?.url;
  const author = typeof o.pkg?.author === 'string' ? o.pkg.author : o.pkg?.author?.name;
  const sdk = def.sdk ?? meta.sdk;
  const homepage = def.homepage ?? o.pkg?.homepage;
  const repository = def.repository ?? (typeof repo === 'string' ? repo.replace(/^git\+/, '') : undefined);
  return {
    manifest: 1,
    id: def.id,
    ...(meta.name ? { package: meta.name } : {}),
    name: def.name,
    version: def.version,
    ...(def.description ? { description: def.description } : {}),
    ...((def.author ?? author) ? { author: def.author ?? author } : {}),
    ...((def.license ?? o.pkg?.license) ? { license: def.license ?? o.pkg?.license } : {}),
    ...(homepage ? { homepage } : {}),
    ...(repository ? { repository } : {}),
    ...(def.icon ? { icon: def.icon } : {}),
    ...(sdk ? { sdk } : {}),
    platforms: def.platforms ?? meta.platforms ?? [...PLATFORMS],
    languages: declaredLanguages(def, meta),
    categories: [...new Set(widgets.map((w) => w.category ?? 'info'))],
    tags: [...new Set(widgets.flatMap((w) => w.tags ?? []))],
    permissions: def.permissions ?? {},
    riskyOptions: [
      ...(def.sources ?? []).flatMap((s) => riskyOptions(s.options).map((r) => ({ ...r, path: `${def.id}/${s.id}: ${r.path}` }))),
      ...widgets.flatMap((w) => riskyOptions(w.options).map((r) => ({ ...r, path: `${def.id}/${w.id}: ${r.path}` }))),
      ...(def.interludes ?? []).flatMap((i) => riskyOptions(i.options).map((r) => ({ ...r, path: `${def.id}/${i.id}: ${r.path}` }))),
    ],
    requires: (def.requires ?? []).map((type) => ({ type, plugin: pluginOf(type) })),
    optional: (def.optional ?? []).map((type) => ({ type, plugin: pluginOf(type) })),
    widgets: widgets.map((w) => ({
      type: `${def.id}/${w.id}`,
      name: w.name,
      ...(w.description ? { description: w.description } : {}),
      ...(w.icon ? { icon: w.icon } : {}),
      category: w.category ?? 'info',
      tags: w.tags ?? [],
      size: w.size ?? {},
      chrome: w.chrome ?? 'card',
      sources: w.sources ?? [],
      options: w.options ? toJsonSchema(w.options) : null,
      ...(o.screenshots?.[w.id] ? { screenshot: o.screenshots[w.id] } : {}),
      animated: !!w.animation,
      urgent: !!w.urgent,
    })),
    sources: (def.sources ?? []).map((s) => ({
      type: `${def.id}/${s.id}`,
      name: s.name,
      ...(s.description ? { description: s.description } : {}),
      polled: !!s.read,
      ...(s.read && s.intervalMs ? { intervalMs: s.intervalMs } : {}),
      options: s.options ? toJsonSchema(s.options) : null,
    })),
    interludes: (def.interludes ?? []).map((i) => ({ type: `${def.id}/${i.id}`, name: i.name, ...(i.description ? { description: i.description } : {}), ...(i.icon ? { icon: i.icon } : {}), fps: i.fps })),
    templates: (def.templates ?? []).map((tp) => ({
      id: tp.id,
      name: tp.name,
      ...(tp.icon ? { icon: tp.icon } : {}),
      widgets: [...new Set([...tp.wide, ...(tp.square ?? []), ...(tp.tall ?? [])].flatMap((tile) => tile.widgets.map((w) => fullType(def.id, typeof w === 'string' ? w : w[0]))))],
    })),
  };
}

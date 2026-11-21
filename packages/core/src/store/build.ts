/**
 * The store's index from what npm says about each plugin and what its own
 * kiosko-manifest.json says: pure functions, so the builder
 * (scripts/store/build-index.ts) is tested with fixtures and never needs
 * the network in a unit test. See docs/es/tienda.md, §3 and §4.3.
 */
import { CATEGORIES, compareVersions, localize, parseVersion, satisfies, type Localized, type Permissions, type Platform } from '@kiosko/sdk';
import { validateJson, type JsonSchema } from '../config/jsonschema.ts';
import { PANEL_PRESETS } from '../config/model.ts';
import { licenseKind, parseLicense } from '../licenses.ts';
import { packageMeta, type PluginManifest } from '../plugin-meta.ts';
import { fitsPresets } from './fit.ts';
import type { Badge, StoreIndex, StorePlugin, StorePluginFile, StoreRelease, StoreWidget, Texts, Tier, Withdrawn, WithdrawnEntry } from './types.ts';

/** What npm's registry returns for a package (only what is read here). */
export interface Packument {
  name: string;
  'dist-tags'?: Record<string, string>;
  versions?: Record<string, Record<string, any>>;
  time?: Record<string, string>;
  maintainers?: { name?: string }[];
  repository?: unknown;
  license?: unknown;
}

/** `kiosko-plugin-x` or `@scope/kiosko-plugin-x`: the names the store takes. */
export const PLUGIN_PACKAGE = /^(@[a-z0-9][\w.-]*\/)?kiosko-plugin-[a-z0-9][a-z0-9-]*$/;

/** At most this many releases per plugin in the index. */
export const MAX_RELEASES = 20;
/** At most this many tags per plugin in the store. */
export const MAX_TAGS = 10;

/** Stable versions, newest first (a pre-release is never offered). */
export function stableVersions(p: Packument): string[] {
  return Object.keys(p.versions ?? {})
    .filter((v) => {
      const x = parseVersion(v);
      return !!x && !x[3];
    })
    .sort((a, b) => compareVersions(b, a));
}

/** What a newer version declares doing on top of the old one (hosts, programs, files, devices). */
export function addedPermissions(before: Permissions | undefined, after: Permissions | undefined): Permissions {
  const out: Permissions = {};
  for (const k of ['network', 'exec', 'files', 'devices'] as const) {
    const added = (after?.[k] ?? []).filter((v) => !(before?.[k] ?? []).includes(v));
    if (added.length) out[k] = added;
  }
  return out;
}

/** The store's tier: official (Kiosko's own) or found (only on npm by keyword). `listed`/`verified` come with plugin-index (phase 2). */
export function tierOf(o: { official: boolean }): Tier {
  return o.official ? 'official' : 'found';
}

/** Steps a download count is shown in, so that inflating 37 to 49 changes nothing. */
const STEPS = [10, 50, 100, 500, 1000, 5000, 10_000, 50_000, 100_000, 500_000, 1_000_000];

/** The step at or below `n` (`640` → 500), 0 below 10. */
export function downloadsBucket(n: number): number {
  let out = 0;
  for (const s of STEPS) if (n >= s) out = s;
  return out;
}

/** The median of the last four weekly sums of daily downloads (oldest first): one spike changes nothing. */
export function weeklyDownloads(daily: readonly number[]): number {
  const days = daily.slice(-28);
  if (days.length < 7) return days.reduce((a, b) => a + b, 0);
  const weeks: number[] = [];
  for (let end = days.length; end - 7 >= 0 && weeks.length < 4; end -= 7) weeks.push(days.slice(end - 7, end).reduce((a, b) => a + b, 0));
  weeks.sort((a, b) => a - b);
  const mid = weeks.length / 2;
  return weeks.length % 2 ? weeks[Math.floor(mid)]! : Math.round((weeks[mid - 1]! + weeks[mid]!) / 2);
}

/** A manifest text as the index keeps it: an object with `en`. */
export function texts(t: Localized | undefined): Texts | undefined {
  if (t === undefined || t === null) return undefined;
  if (typeof t === 'string') return { en: t };
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(t)) if (typeof v === 'string' && v) out[k] = v;
  return out.en ? (out as Texts) : { ...out, en: localize(t, 'en') };
}

const url = (u: unknown): string | undefined => {
  const s = typeof u === 'string' ? u : u && typeof u === 'object' ? (u as { url?: unknown }).url : undefined;
  if (typeof s !== 'string') return undefined;
  const clean = s.replace(/^git\+/, '').replace(/^git:\/\//, 'https://').replace(/\.git$/, '').replace(/^github:/, 'https://github.com/');
  return /^https:\/\//.test(clean) ? clean : undefined;
};

/** `https://github.com/owner/repo` → `owner/repo`. */
export function githubRepo(repository: string | undefined): string | undefined {
  const m = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?(?:[/#].*)?$/.exec(repository ?? '');
  return m?.[1];
}

/** The withdrawn entries that cover a release (by integrity, or by range). */
export function withdrawnFor(entries: readonly WithdrawnEntry[], pkg: string, version: string, integrity: string): WithdrawnEntry | undefined {
  return entries.find((e) => e.package === pkg && ((e.integrity ?? []).includes(integrity) || satisfies(version, e.versions)));
}

/** The releases as the index keeps them: stable, newest first, at most 20. */
export function pickReleases(p: Packument, o: { manifests?: Record<string, PluginManifest | null | undefined>; withdrawn?: readonly WithdrawnEntry[] } = {}): StoreRelease[] {
  const versions = stableVersions(p).slice(0, MAX_RELEASES);
  const out = versions.map((v): StoreRelease => {
    const pkg = p.versions![v]!;
    const meta = packageMeta(pkg);
    const integrity = String(pkg.dist?.integrity ?? '');
    const att = pkg.dist?.attestations;
    const withdrawn = withdrawnFor(o.withdrawn ?? [], p.name, v, integrity);
    return {
      version: v,
      date: p.time?.[v] ?? '',
      integrity,
      ...(meta.sdk ? { sdk: meta.sdk } : {}),
      ...(meta.platforms ? { platforms: meta.platforms } : {}),
      ...(att ? { provenance: {} } : {}),
      ...(typeof pkg.deprecated === 'string' && pkg.deprecated ? { deprecated: pkg.deprecated } : {}),
      ...(withdrawn ? { withdrawn: true } : {}),
    };
  });
  // What each release asks for on top of the one before, where both manifests are known.
  for (let i = 0; i + 1 < out.length; i++) {
    const now = o.manifests?.[out[i]!.version];
    const before = o.manifests?.[out[i + 1]!.version];
    if (!now || !before) continue;
    const added = addedPermissions(before.permissions, now.permissions);
    if (Object.keys(added).length) out[i]!.addedPermissions = added;
  }
  return out.filter((r) => r.date && /^sha512-/.test(r.integrity));
}

/** What is wrong with a manifest, for `health.problems` (never fatal). */
export function manifestProblems(m: unknown, o: { id: string; version: string; schema?: JsonSchema }): string[] {
  const out: string[] = [];
  if (o.schema) for (const i of validateJson(o.schema, m).slice(0, 5)) out.push(`kiosko-manifest.json ${i.path}: ${i.message}`);
  const mm = m as Partial<PluginManifest> | null;
  if (mm?.id && mm.id !== o.id) out.push(`kiosko-manifest.json says id "${mm.id}", but the package is "${o.id}"`);
  if (mm?.version && mm.version !== o.version) out.push(`kiosko-manifest.json is for version ${mm.version}, the package is ${o.version}`);
  return out;
}

export interface EntryInput {
  packument: Packument;
  /** The latest version's manifest; null when it has none. */
  manifest: PluginManifest | null;
  /** Where the manifest came from: the npm package (`package`) or, for an official plugin whose package predates it, its repository. */
  manifestSource?: 'package' | 'repository';
  /** Problems found reading or checking it. */
  problems?: string[];
  /** Manifests of older versions (from the builder's cache), for what each release asks for on top of the one before. */
  manifests?: Record<string, PluginManifest | null | undefined>;
  /** Kiosko's own (server/src/official.ts). */
  official?: { bundled: boolean } | null;
  /** Daily downloads, oldest first. */
  downloads?: readonly number[];
  github?: { stars?: number; archived?: boolean; openIssues?: number } | null;
  /** Pictures by widget type: a path from the site's root by language, and their size. */
  shots?: Record<string, { files: Record<string, string>; w: number; h: number }>;
  /** Pictures of interludes by type (path from the site's root). */
  posters?: Record<string, string>;
  /** A picture for its card when it has none of its widgets (from the site's root). */
  cover?: string;
  withdrawn?: readonly WithdrawnEntry[];
}

/** The categories (and their names) the store browses by, from the SDK. */
export function storeCategories(): StoreIndex['categories'] {
  return CATEGORIES.map((c) => ({ id: c.id, label: texts(c.label)! }));
}

/**
 * A plugin's entry in the index, or null when it isn't one the store can
 * offer (no stable release). Problems never drop it: they are listed in
 * `health.problems`.
 */
export function entryFrom(i: EntryInput): { plugin: StorePlugin; file: StorePluginFile['riskyOptions']; sources: StorePluginFile['sources'] } | null {
  const p = i.packument;
  const releases = pickReleases(p, { ...(i.manifests ? { manifests: i.manifests } : {}), ...(i.withdrawn ? { withdrawn: i.withdrawn } : {}) });
  const latest = releases.find((r) => r.version === p['dist-tags']?.latest) ?? releases[0];
  if (!latest) return null;
  const pkg = p.versions?.[latest.version] ?? {};
  const meta = packageMeta(pkg);
  const m = i.manifest;
  const problems = [...(i.problems ?? [])];
  const id = meta.id ?? p.name.replace(/^@[^/]+\//, '').replace(/^kiosko-plugin-/, '');
  if (!m) problems.push('no kiosko-manifest.json in its npm package: only what package.json says is known');
  let license = String(m?.license ?? (typeof pkg.license === 'string' ? pkg.license : '') ?? '');
  if (license) {
    try {
      const l = parseLicense(license);
      if (l.unknown.length) problems.push(`licence ${l.unknown.join(', ')} is not an SPDX identifier Kiosko knows`);
    } catch (err) {
      problems.push(`licence ${JSON.stringify(license)}: ${(err as Error).message}`);
      license = '';
    }
  } else problems.push('it says no licence');
  const repository = url(m?.repository) ?? url(pkg.repository) ?? url(p.repository);
  const homepage = url(m?.homepage) ?? url(pkg.homepage);
  const support = m?.support ?? {};
  const widgets: StoreWidget[] = (m?.widgets ?? []).map((w) => {
    const size = { min: w.size?.min, preferred: w.size?.preferred };
    const f = fitsPresets(size);
    const shot = i.shots?.[w.type];
    return {
      type: w.type,
      name: texts(w.name)!,
      ...(w.description ? { description: texts(w.description)! } : {}),
      ...(w.icon ? { icon: w.icon } : {}),
      category: w.category,
      ...(size.min ? { min: size.min } : {}),
      ...(size.preferred ? { preferred: size.preferred } : {}),
      fits: f.fits,
      ideal: f.ideal,
      presets: f.presets,
      ...(w.animated ? { animated: true } : {}),
      ...(shot ? { shots: shot.files, shotSize: { w: shot.w, h: shot.h } } : {}),
    };
  });
  const official = !!i.official;
  const badges: Badge[] = [...(official ? (['official'] as const) : []), ...(i.official?.bundled ? (['bundled'] as const) : [])];
  const tags = [...new Set((m?.tags ?? []).map((t) => t.toLowerCase().trim()).filter(Boolean))];
  if (tags.length > MAX_TAGS) problems.push(`${tags.length} tags: the store shows the first ${MAX_TAGS}`);
  const npmNames = (p.maintainers ?? []).map((x) => x.name).filter((x): x is string => !!x);
  const weekly = i.downloads ? downloadsBucket(weeklyDownloads(i.downloads)) : undefined;
  if (i.github?.archived) problems.push('its repository is archived');
  const description = texts(m?.description) ?? (typeof pkg.description === 'string' && pkg.description ? { en: pkg.description } : undefined);
  const plugin: StorePlugin = {
    id,
    package: p.name,
    name: texts(m?.name) ?? { en: id },
    ...(description ? { description } : {}),
    ...(m?.icon ? { icon: m.icon } : {}),
    tier: tierOf({ official }),
    badges,
    publisher: { ...(m?.author ? { name: m.author } : {}), ...(npmNames.length ? { npm: npmNames } : {}), ...(githubRepo(repository) ? { github: githubRepo(repository)!.split('/')[0] } : {}), verified: official },
    license,
    licenseKind: licenseKind(license || undefined),
    links: {
      ...(repository ? { repository } : {}),
      ...(homepage ? { homepage } : {}),
      ...(url(support.issues) ?? url(pkg.bugs) ? { issues: url(support.issues) ?? url(pkg.bugs) } : {}),
      ...(url(support.discussions) ? { discussions: url(support.discussions) } : {}),
      ...(url(support.docs) ? { docs: url(support.docs) } : {}),
      ...(url(m?.funding) ? { funding: url(m?.funding) } : {}),
      npm: `https://www.npmjs.com/package/${p.name}`,
    },
    ...(i.official ? { bundled: i.official.bundled } : {}),
    latest: latest.version,
    releases,
    platforms: (m?.platforms ?? meta.platforms ?? ['linux', 'darwin', 'win32']) as Platform[],
    languages: m?.languages ?? meta.languages ?? ['en'],
    categories: m?.categories?.length ? m.categories : ['info'],
    tags: tags.slice(0, MAX_TAGS),
    ...(m?.markets ? { markets: { ...(m.markets.only ? { only: m.markets.only } : {}), ...(m.markets.without ? { without: m.markets.without } : {}), ...(m.markets.note ? { note: texts(m.markets.note)! } : {}) } } : {}),
    pricing: { model: 'free' },
    permissions: m?.permissions ?? {},
    riskyOptions: m?.riskyOptions.length ?? 0,
    requires: [...new Set((m?.requires ?? []).map((r) => r.plugin))].filter((x) => x !== id),
    optional: [...new Set((m?.optional ?? []).map((r) => r.plugin))].filter((x) => x !== id),
    ...(m?.resources ? { resources: { ...(m.resources.memoryMb !== undefined ? { memoryMb: m.resources.memoryMb } : {}), ...(m.resources.cpu ? { cpu: m.resources.cpu } : {}) } } : {}),
    widgets,
    interludes: (m?.interludes ?? []).map((x) => ({
      type: x.type,
      name: texts(x.name)!,
      ...(x.description ? { description: texts(x.description)! } : {}),
      ...(x.icon ? { icon: x.icon } : {}),
      ...(i.posters?.[x.type] ? { poster: i.posters[x.type] } : {}),
    })),
    templates: (m?.templates ?? []).map((t) => ({ id: t.id, name: texts(t.name)!, layouts: t.layouts ?? ['wide'] })),
    ...(i.cover ? { cover: i.cover } : {}),
    ...(weekly !== undefined || i.github?.stars !== undefined ? { popularity: { ...(weekly !== undefined ? { weekly } : {}), ...(i.github?.stars !== undefined ? { stars: i.github.stars } : {}) } } : {}),
    health: {
      lastRelease: latest.date,
      ...(i.github?.archived ? { archived: true } : {}),
      ...(i.github?.openIssues !== undefined ? { openIssues: i.github.openIssues } : {}),
      manifest: !m ? 'missing' : (i.problems ?? []).some((x) => /^kiosko-manifest\.json /.test(x)) ? 'invalid' : i.manifestSource === 'repository' ? 'repository' : 'ok',
      ...(problems.length ? { problems } : {}),
    },
  };
  return {
    plugin,
    file: m?.riskyOptions ?? [],
    sources: (m?.sources ?? []).map((s) => ({ type: s.type, name: texts(s.name)!, ...(s.description ? { description: texts(s.description)! } : {}) })),
  };
}

/**
 * The whole index: one entry per id. When two packages claim the same id,
 * Kiosko's own wins and the other is hidden (it would shadow it); between
 * two others, the older package.
 */
export function buildIndex(entries: readonly StorePlugin[], o: { generatedAt: string; kiosko?: { latest?: string; sdk?: string }; hidden?: readonly string[] }): StoreIndex {
  const byId = new Map<string, StorePlugin>();
  const out: StorePlugin[] = [];
  const firstDate = (p: StorePlugin) => p.releases.at(-1)?.date ?? '';
  const sorted = [...entries].sort((a, b) => Number(b.tier === 'official') - Number(a.tier === 'official') || firstDate(a).localeCompare(firstDate(b)));
  for (const e of sorted) {
    const p = structuredClone(e);
    const owner = byId.get(p.id);
    if (owner) {
      p.hidden = true;
      p.health.problems = [...(p.health.problems ?? []), `its id "${p.id}" is ${owner.package}'s`];
    } else byId.set(p.id, p);
    if (o.hidden?.includes(p.package)) p.hidden = true;
    out.push(p);
  }
  const presets = PANEL_PRESETS.map((x) => ({ id: x.id, name: x.name, width: x.width, height: x.height, ...(x.shape ? { shape: x.shape } : {}) }));
  return { schema: 1, generatedAt: o.generatedAt, ...(o.kiosko ? { kiosko: o.kiosko } : {}), categories: storeCategories(), presets, plugins: out };
}

/** withdrawn.json (Kiosko's own list until plugin-index exists). */
export function withdrawnFile(entries: readonly WithdrawnEntry[], generatedAt: string): Withdrawn {
  return { schema: 1, generatedAt, entries: [...entries] };
}

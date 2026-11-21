/**
 * Builds the plugin store's catalogue, https://kioskolcd.dev/store/v1/, into
 * <out>/store/v1/: index.json, plugins/<id>.json, withdrawn.json, schema/,
 * and the pictures third-party plugins bring (img/<id>/<version>/…).
 * Called by the site build (packages/web/landing/build.mjs) after the
 * gallery, whose pictures it uses for the official plugins.
 *
 *   node --conditions=source scripts/store/build-index.ts --out site
 *        [--gallery site/gallery/gallery.json] [--cache dir] [--plugins ../kiosko-plugins]
 *        [--snapshot packages/server/assets/store-index.json]
 *
 * Sources (docs/es/tienda.md, §4.3): npm's search for the `kiosko-plugin`
 * keyword plus Kiosko's official plugins; each package's packument
 * (versions, dates, integrity, deprecations; with ETags in the cache); the
 * kiosko-manifest.json inside the tarball of its latest version (and the one
 * before, for what an update asks for on top), checked against its
 * integrity and read without unpacking or running anything; npm's download
 * counts; GitHub's stars and archived flag when GITHUB_TOKEN is there.
 *
 * Nothing about the person browsing is collected anywhere: this runs in CI.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { SDK_VERSION } from '@kiosko/sdk';
import {
  PLUGIN_PACKAGE, buildIndex, checkIntegrity, entryFrom, githubRepo, manifestProblems, readTarGz, stableVersions, validateJson, withdrawnFile,
  type JsonSchema, type Packument, type PluginManifest, type StorePlugin, type StorePluginFile, type WithdrawnEntry,
} from '@kiosko/core';
import { OFFICIAL_PLUGINS } from '../../packages/server/src/official.ts';

const root = resolve(import.meta.dirname, '../..');
const REGISTRY = process.env.KIOSKO_STORE_REGISTRY ?? 'https://registry.npmjs.org';
const DOWNLOADS = 'https://api.npmjs.org/downloads';
const AGENT = 'kiosko-store-index (+https://kioskolcd.dev/store/)';
const KEYWORD = 'kiosko-plugin';
/** Pictures bigger than this aren't copied to the site. */
const MAX_PICTURE = 2 * 1024 * 1024;

const args = process.argv.slice(2);
const opt = (k: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
const out = resolve(opt('--out') ?? join(root, 'site'));
const v1 = join(out, 'store/v1');
const galleryFile = resolve(opt('--gallery') ?? join(out, 'gallery/gallery.json'));
const cache = resolve(opt('--cache') ?? process.env.KIOSKO_STORE_CACHE ?? join(root, 'tmp/store-cache'));
const localPlugins = resolve(opt('--plugins') ?? join(root, '../kiosko-plugins'));
const snapshot = opt('--snapshot');

const log = (s: string) => console.log(`store: ${s}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** GET with a few retries on 429 and 5xx (npm asks to back off), and conditional requests from the cache. */
async function get(url: string, o: { accept?: string; etag?: string; token?: string } = {}): Promise<{ status: number; body: Buffer; etag?: string }> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      headers: { 'user-agent': AGENT, accept: o.accept ?? 'application/json', ...(o.etag ? { 'if-none-match': o.etag } : {}), ...(o.token ? { authorization: `Bearer ${o.token}` } : {}) },
      signal: AbortSignal.timeout(60_000),
    });
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      const wait = Number(res.headers.get('retry-after')) * 1000 || 2000 * 2 ** attempt;
      log(`${res.status} from ${new URL(url).host}, waiting ${Math.round(wait / 1000)} s`);
      await sleep(Math.min(wait, 60_000));
      continue;
    }
    const etag = res.headers.get('etag') ?? undefined;
    return { status: res.status, body: Buffer.from(await res.arrayBuffer()), ...(etag ? { etag } : {}) };
  }
}

async function getJson<T>(url: string, o: { token?: string } = {}): Promise<T> {
  const r = await get(url, o);
  if (r.status !== 200) throw new Error(`${url}: HTTP ${r.status}`);
  return JSON.parse(r.body.toString('utf8')) as T;
}

/** Runs `fn` over `items`, `n` at a time: polite to npm. */
async function pool<T, R>(items: readonly T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  }));
  return out;
}

const encodeName = (name: string) => name.replace('/', '%2F');
const safeFile = (s: string) => s.replace(/[^a-z0-9._-]/gi, '_');

/** Every package npm finds with the keyword (250 a page). */
async function search(): Promise<string[]> {
  const names: string[] = [];
  for (let from = 0; ; from += 250) {
    const r = await getJson<{ objects: { package: { name: string } }[]; total: number }>(`${REGISTRY}/-/v1/search?text=keywords:${KEYWORD}&size=250&from=${from}`);
    names.push(...r.objects.map((o) => o.package.name));
    if (r.objects.length < 250 || names.length >= r.total) break;
  }
  return names;
}

/** A packument, from the cache when npm says it hasn't changed. */
async function packumentOf(name: string): Promise<Packument | null> {
  const file = join(cache, 'packuments', `${safeFile(name)}.json`);
  const cached = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { etag?: string; data: Packument }) : null;
  const r = await get(`${REGISTRY}/${encodeName(name)}`, { ...(cached?.etag ? { etag: cached.etag } : {}) });
  if (r.status === 304 && cached) return cached.data;
  if (r.status === 404) return null;
  if (r.status !== 200) throw new Error(`${name}: HTTP ${r.status}`);
  const full = JSON.parse(r.body.toString('utf8')) as Packument & { readme?: string };
  // Only what the index reads (the readme alone can be most of it).
  const data: Packument = { name: full.name, 'dist-tags': full['dist-tags'] ?? {}, versions: full.versions ?? {}, time: full.time ?? {}, maintainers: full.maintainers ?? [], repository: full.repository, license: full.license };
  for (const v of Object.values(data.versions ?? {})) delete v.readme;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ ...(r.etag ? { etag: r.etag } : {}), data }));
  return data;
}

interface Unpacked {
  manifest: unknown | null;
  problem?: string;
  /** docs/* pictures (and WebM clips), by path inside the package (`docs/forecast.png`). */
  pictures: Map<string, Buffer>;
}

/** A WebM clip (an interlude's `preview.video`): EBML with the `webm` doctype, told by its bytes, not its name. */
const isClip = (b: Buffer) => b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3 && b.subarray(0, 64).includes('webm');
const isPicture = (b: Buffer) =>
  (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) || (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) || (b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP') || isClip(b);

/** A version's tarball, checked against its integrity, kept in the cache by it; its manifest and pictures. */
async function unpack(name: string, version: Record<string, any>): Promise<Unpacked> {
  const integrity = String(version.dist?.integrity ?? '');
  const tarball = String(version.dist?.tarball ?? '');
  if (!/^sha512-/.test(integrity) || !/^https:\/\//.test(tarball)) return { manifest: null, problem: 'npm gives no sha512 integrity for it', pictures: new Map() };
  const file = join(cache, 'tarballs', `${createHash('sha256').update(integrity).digest('hex')}.tgz`);
  let bytes: Buffer | null = existsSync(file) ? readFileSync(file) : null;
  if (!bytes || !checkIntegrity(bytes, integrity)) {
    const r = await get(tarball, { accept: 'application/octet-stream' });
    if (r.status !== 200) return { manifest: null, problem: `its tarball: HTTP ${r.status}`, pictures: new Map() };
    if (!checkIntegrity(r.body, integrity)) return { manifest: null, problem: 'its tarball does not match the integrity npm gives: not read', pictures: new Map() };
    bytes = r.body;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, bytes);
  }
  let files: Map<string, Buffer>;
  try {
    files = readTarGz(bytes, (p) => p === 'package/kiosko-manifest.json' || /^package\/docs\/[\w.-]+\.(png|jpe?g|webp|webm)$/i.test(p)).files;
  } catch (err) {
    return { manifest: null, problem: `its tarball: ${(err as Error).message}`, pictures: new Map() };
  }
  const pictures = new Map<string, Buffer>();
  for (const [p, b] of files) if (p !== 'package/kiosko-manifest.json' && b.length <= MAX_PICTURE && isPicture(b)) pictures.set(p.slice('package/'.length), b);
  const raw = files.get('package/kiosko-manifest.json');
  if (!raw) return { manifest: null, pictures };
  try {
    return { manifest: JSON.parse(raw.toString('utf8')), pictures };
  } catch (err) {
    return { manifest: null, problem: `kiosko-manifest.json is not JSON: ${(err as Error).message}`, pictures };
  }
}

/** Daily downloads of the last month, by package: in batches of 128 for unscoped ones, one by one for scoped ones (npm's rule). */
async function downloads(names: string[]): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  type Range = { package: string; downloads: { day: string; downloads: number }[] };
  const take = (r: Range | null | undefined) => r?.downloads && out.set(r.package, r.downloads.map((d) => d.downloads));
  const plain = names.filter((n) => !n.startsWith('@'));
  for (let i = 0; i < plain.length; i += 128) {
    const batch = plain.slice(i, i + 128);
    try {
      const r = await getJson<Range | Record<string, Range | null>>(`${DOWNLOADS}/range/last-month/${batch.join(',')}`);
      if (batch.length === 1) take(r as Range);
      else for (const x of Object.values(r as Record<string, Range | null>)) take(x);
    } catch (err) {
      log(`downloads: ${(err as Error).message}`);
    }
  }
  for (const n of names.filter((x) => x.startsWith('@'))) {
    try {
      take(await getJson<Range>(`${DOWNLOADS}/range/last-month/${n}`));
    } catch (err) {
      log(`downloads of ${n}: ${(err as Error).message}`);
    }
  }
  return out;
}

/** Stars, archived and open issues, when a token allows (GitHub gives 60 calls an hour without one). */
async function github(repo: string, token: string): Promise<{ stars?: number; archived?: boolean; openIssues?: number } | null> {
  try {
    const r = await getJson<{ stargazers_count: number; archived: boolean; open_issues_count: number }>(`https://api.github.com/repos/${repo}`, { token });
    return { stars: r.stargazers_count, archived: r.archived, openIssues: r.open_issues_count };
  } catch (err) {
    log(`github ${repo}: ${(err as Error).message}`);
    return null;
  }
}

interface Gallery {
  languages: string[];
  plugins: { id: string; widgets: { type: string; file: Record<string, string>; width: number; height: number }[] }[];
}

/** The pictures the gallery painted, by widget type: a path from the site's root by language. */
function galleryShots(): Record<string, { files: Record<string, string>; w: number; h: number }> {
  if (!existsSync(galleryFile)) {
    log(`no ${galleryFile}: official plugins without pictures`);
    return {};
  }
  const g = JSON.parse(readFileSync(galleryFile, 'utf8')) as Gallery;
  const out: Record<string, { files: Record<string, string>; w: number; h: number }> = {};
  for (const p of g.plugins) for (const w of p.widgets) out[w.type] = { files: Object.fromEntries(Object.entries(w.file).map(([l, f]) => [l, `gallery/${f}`])), w: w.width, h: w.height };
  return out;
}

/** An official plugin's manifest from its repository, when its npm package predates manifests. */
function repositoryManifest(id: string): unknown | null {
  const file = join(localPlugins, `kiosko-plugin-${id}`, 'kiosko-manifest.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}

/** A third party's own pictures (from its docs/), copied to img/<id>/<version>/. */
function copyPictures(id: string, version: string, m: PluginManifest, pictures: Map<string, Buffer>): { shots: NonNullable<Parameters<typeof entryFrom>[0]['shots']>; posters: Record<string, string>; videos: Record<string, string>; cover?: string } {
  const shots: NonNullable<Parameters<typeof entryFrom>[0]['shots']> = {};
  const posters: Record<string, string> = {};
  const videos: Record<string, string> = {};
  const put = (file: string): string | null => {
    const b = pictures.get(file.replace(/^\.\//, ''));
    if (!b) return null;
    const rel = `store/v1/img/${safeFile(id)}/${safeFile(version)}/${safeFile(file.split('/').pop()!)}`;
    mkdirSync(dirname(join(out, rel)), { recursive: true });
    writeFileSync(join(out, rel), b);
    return rel;
  };
  for (const w of m.widgets ?? []) {
    const files: Record<string, string> = {};
    let size = { w: w.size?.preferred?.w ?? 480, h: w.size?.preferred?.h ?? 240 };
    for (const s of w.screenshots ?? []) {
      if (files[s.lang]) continue;
      const rel = put(s.file);
      if (rel) {
        files[s.lang] = rel;
        size = { w: s.w, h: s.h };
      }
    }
    if (!files.en && w.screenshot) {
      const rel = put(w.screenshot);
      if (rel) files.en = rel;
    }
    if (files.en) shots[w.type] = { files, ...size };
  }
  const clip = (file: string) => pictures.get(file.replace(/^\.\//, ''));
  for (const i of m.interludes ?? []) {
    const rel = i.preview?.poster && !isClip(clip(i.preview.poster) ?? Buffer.alloc(0)) && put(i.preview.poster);
    if (rel) posters[i.type] = rel;
    // Its clip only with its still (for where it doesn't play), and only if it is one.
    const video = rel && i.preview?.video && isClip(clip(i.preview.video) ?? Buffer.alloc(0)) && put(i.preview.video);
    if (video) videos[i.type] = video;
  }
  // Nothing of its widgets to show: the first picture of its docs/ (doom's recording's first frame, say); never a clip.
  const first = Object.keys(shots).length || Object.keys(posters).length ? undefined : [...pictures.keys()].filter((k) => !isClip(pictures.get(k)!)).sort()[0];
  const cover = first ? put(first) : null;
  return { shots, posters, videos, ...(cover ? { cover } : {}) };
}

async function main(): Promise<void> {
  const started = Date.now();
  const schema = JSON.parse(readFileSync(join(root, 'packages/core/schema/store-index.json'), 'utf8')) as JsonSchema;
  const manifestSchema = JSON.parse(readFileSync(join(root, 'packages/core/schema/manifest.json'), 'utf8')) as JsonSchema;
  const overrides = JSON.parse(readFileSync(join(import.meta.dirname, 'overrides.json'), 'utf8')) as { hidden: string[]; withdrawn: WithdrawnEntry[] };
  const official = new Map(OFFICIAL_PLUGINS.map((o) => [o.npm, o]));
  const found = await search();
  const names = [...new Set([...OFFICIAL_PLUGINS.map((o) => o.npm), ...found])].filter((n) => PLUGIN_PACKAGE.test(n));
  log(`${found.length} packages with the "${KEYWORD}" keyword, ${names.length} candidates`);
  const shotsOfGallery = galleryShots();
  rmSync(v1, { recursive: true, force: true });
  mkdirSync(join(v1, 'plugins'), { recursive: true });
  const token = process.env.GITHUB_TOKEN;
  const counts = await downloads(names);
  const entries: { plugin: StorePlugin; file: StorePluginFile['riskyOptions']; sources: StorePluginFile['sources'] }[] = [];
  await pool(names, 4, async (name) => {
    try {
      const p = await packumentOf(name);
      if (!p) return log(`${name}: not on npm`);
      const versions = stableVersions(p);
      const latest = p['dist-tags']?.latest && versions.includes(p['dist-tags'].latest) ? p['dist-tags'].latest : versions[0];
      if (!latest) return log(`${name}: no stable release`);
      const o = official.get(name);
      const id = String(p.versions![latest]!.kiosko?.id ?? name.replace(/^@[^/]+\//, '').replace(/^kiosko-plugin-/, ''));
      // The latest and the one before: what an update to the latest asks for on top.
      const [now, before] = await Promise.all([unpack(name, p.versions![latest]!), versions[1] ? unpack(name, p.versions![versions[1]]!) : Promise.resolve(null)]);
      const problems = now.problem ? [now.problem] : [];
      let manifest = now.manifest as PluginManifest | null;
      let source: 'package' | 'repository' = 'package';
      if (!manifest && o) {
        const fromRepo = repositoryManifest(o.id) as PluginManifest | null;
        if (fromRepo) {
          manifest = fromRepo;
          source = 'repository';
          problems.push(`its npm package (${latest}) predates kiosko-manifest.json: read from its repository (${fromRepo.version})`);
        }
      }
      if (manifest) problems.push(...manifestProblems(manifest, { id, version: source === 'repository' ? manifest.version : latest, schema: manifestSchema }));
      // Official plugins' widgets are painted by the gallery, in every language; anything else comes from the package.
      const pictures = manifest ? copyPictures(id, latest, o ? { ...manifest, widgets: manifest.widgets.filter((w) => !shotsOfGallery[w.type]) } : manifest, now.pictures) : { shots: {}, posters: {}, videos: {} };
      const repo = githubRepo(String((manifest?.repository ?? (p.versions![latest]!.repository as { url?: string } | undefined)?.url ?? '') as string).replace(/^git\+/, '').replace(/\.git$/, ''));
      const e = entryFrom({
        packument: p,
        manifest,
        manifestSource: source,
        problems,
        manifests: { [latest]: manifest, ...(versions[1] && before ? { [versions[1]]: before.manifest as PluginManifest | null } : {}) },
        official: o ? { bundled: o.bundled } : null,
        ...(counts.get(name) ? { downloads: counts.get(name)! } : {}),
        github: token && repo ? await github(repo, token) : null,
        shots: o ? { ...pictures.shots, ...shotsOfGallery } : pictures.shots,
        posters: pictures.posters,
        videos: pictures.videos,
        ...(pictures.cover ? { cover: pictures.cover } : {}),
        withdrawn: overrides.withdrawn,
      });
      if (e) entries.push(e);
      log(`${name}@${latest}: ${manifest ? `manifest (${source})` : 'no manifest'}${problems.length ? `, ${problems.length} problem(s): ${problems.join('; ')}` : ''}`);
    } catch (err) {
      log(`${name}: ${(err as Error).message}`);
      if (official.has(name)) throw err;
    }
  });
  let kioskoLatest: string | undefined;
  try {
    kioskoLatest = (await getJson<{ version: string }>(`${REGISTRY}/kiosko/latest`)).version;
  } catch {
    /* not essential */
  }
  const generatedAt = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const index = buildIndex(entries.map((e) => e.plugin), { generatedAt, kiosko: { ...(kioskoLatest ? { latest: kioskoLatest } : {}), sdk: SDK_VERSION }, hidden: overrides.hidden });
  const issues = validateJson(schema, index);
  if (issues.length) throw new Error(`the index does not pass its schema:\n${issues.slice(0, 20).map((i) => `  ${i.path}: ${i.message}`).join('\n')}`);
  for (const o of OFFICIAL_PLUGINS) if (!index.plugins.some((p) => p.package === o.npm)) throw new Error(`the official plugin ${o.npm} is not in the index`);
  writeFileSync(join(v1, 'index.json'), JSON.stringify(index));
  for (const p of index.plugins) {
    const e = entries.find((x) => x.plugin.package === p.package)!;
    if (p.hidden) continue;
    const file: StorePluginFile = { schema: 1, generatedAt, plugin: p, riskyOptions: e.file, sources: e.sources };
    writeFileSync(join(v1, 'plugins', `${p.id}.json`), JSON.stringify(file));
  }
  writeFileSync(join(v1, 'withdrawn.json'), JSON.stringify(withdrawnFile(overrides.withdrawn, generatedAt)));
  mkdirSync(join(v1, 'schema'), { recursive: true });
  copyFileSync(join(root, 'packages/core/schema/store-index.json'), join(v1, 'schema/index.json'));
  copyFileSync(join(root, 'packages/core/schema/manifest.json'), join(v1, 'schema/manifest.json'));
  if (snapshot) {
    mkdirSync(dirname(resolve(snapshot)), { recursive: true });
    writeFileSync(resolve(snapshot), `${JSON.stringify(index)}\n`);
    log(`snapshot → ${snapshot}`);
  }
  const shown = index.plugins.filter((p) => !p.hidden);
  const size = readFileSync(join(v1, 'index.json')).length;
  log(`${shown.length} plugins (${shown.filter((p) => p.tier === 'official').length} official, ${shown.filter((p) => p.tier === 'found').length} unreviewed), ${index.plugins.length - shown.length} hidden; index.json ${Math.round(size / 1024)} kB → ${v1} in ${Math.round((Date.now() - started) / 1000)} s`);
}

/** With KIOSKO_STORE_INDEX=<folder with store/v1>, a store built before is copied instead (offline builds of the site). */
if (process.env.KIOSKO_STORE_INDEX) {
  const from = resolve(process.env.KIOSKO_STORE_INDEX, 'store/v1');
  if (!existsSync(join(from, 'index.json'))) throw new Error(`KIOSKO_STORE_INDEX: no ${join(from, 'index.json')}`);
  rmSync(v1, { recursive: true, force: true });
  mkdirSync(dirname(v1), { recursive: true });
  const copy = (a: string, b: string) => {
    mkdirSync(b, { recursive: true });
    for (const f of readdirSync(a, { withFileTypes: true })) (f.isDirectory() ? copy : copyFileSync)(join(a, f.name), join(b, f.name));
  };
  copy(from, v1);
  log(`copied from ${from}`);
} else {
  await main();
}

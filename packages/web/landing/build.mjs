// The site (https://kioskolcd.dev/), run from packages/web/build.mjs --site [--out site]:
//
//   gallery/               every widget, painted (`kiosko gallery`), and gallery.json
//   schema/v1/config.json  the config's JSON Schema (`kiosko config schema`)
//   demo/                  the editor in the browser and the panel in 3D (demo/build.mjs)
//   card.jpg               the picture shown with the site's link when it is shared
//   demo/assets/doom.*     the recording the front page's Doom section plays
//   index.html             the front page (this folder): a story told over the 3D panel,
//   es/ zh-Hant/ zh-Hans/  the same page in each language (pages.mjs, words in i18n/)
//   store/ es/store/…      the plugin store (store.mjs), from store/v1/
//   store/v1/              its catalogue as data: index.json, plugins/<id>.json, withdrawn.json,
//                          schema/ (scripts/store/build-index.ts, from npm, after the gallery)
//   sitemap.xml robots.txt the pages in every language, for search engines
//   demo/assets/landing.*  then the plugins (from gallery.json) and how to start
//
// The front page's script lives with the demo's assets because it starts the
// same renderer.js, by a relative address.
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDemo } from '../demo/build.mjs';
import { LANGS, esc, loadTexts, plural, renderPage, sitemap } from './pages.mjs';
import { buildStorePages } from './store.mjs';
import { languageById } from '../../sdk/src/languages.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');

/** The plugins the site offers in `lang`: not those whose service is missing where it is read. */
const offered = (data, lang) => data.plugins.filter((p) => !languageById(lang)?.plugins?.without.includes(p.id));

/** The plugins as cards, in `lang`: what each is, and a couple of its widgets as painted for the gallery. */
function pluginCards(data, texts, lang, prefix) {
  const say = (t) => esc(t[lang] ?? t.en);
  // What ships inside Kiosko itself goes last: the others are what there is to discover.
  const builtin = (p) => (p.id === 'legacy' ? 2 : p.id === 'core' ? 1 : 0);
  // Where a plugin's service is not offered, it isn't either (languages.ts): local models lead instead.
  const market = languageById(lang)?.plugins;
  const first = (p) => { const i = market?.first.indexOf(p.id) ?? -1; return i < 0 ? Infinity : i; };
  return offered(data, lang)
    .sort((a, b) => builtin(a) - builtin(b) || first(a) - first(b))
    .map((p) => {
      const shots = p.widgets
        .slice(0, 2)
        .map((w) => `<img src="${prefix}gallery/${esc(w.file[lang] ?? w.file.en)}" width="${w.width}" height="${w.height}" loading="lazy" alt="${say(w.name)}" />`)
        .join('');
      return `<article class="plugin"><div class="shots">${shots}</div><div class="about"><h3>${say(p.name)} <code>${esc(p.id)}</code></h3><p>${say(p.description)}</p><p class="count">${esc(plural(texts, lang, 'card-widgets', p.widgets.length))}</p></div></article>`;
    })
    .join('\n          ');
}

/**
 * @param {{ out: string, editorOptions: (outdir: string, o: { demo: boolean }) => import('esbuild').BuildOptions }} o
 */
export async function buildSite({ out, editorOptions }) {
  // 1. The gallery, with the catalogue as data and the sample pages as pictures. Nothing of this
  //    machine's own Kiosko is read: it runs with an empty home.
  const home = mkdtempSync(join(tmpdir(), 'kiosko-site-'));
  try {
    // The Chinese pages show the panel painted in Chinese: each needs its own region's font (a Japanese
    // one would draw other shapes), or the posters would be wrong or empty boxes.
    const probe = `const f = await import(${JSON.stringify(join(root, 'packages/core/src/fonts.ts'))});
      const tw = f.cjkFonts('zh-TW').families[0] ?? '', cn = f.cjkFonts('zh-CN').families[0] ?? '';
      if (!/TC|TW|HK|JhengHei|Ming|UMing/.test(tw) || !/SC|CN|YaHei|Hei|GB|Droid|Song/.test(cn)) { console.log(f.cjkFontHint()); process.exit(1); }`;
    const fonts = spawnSync(process.execPath, ['--conditions=source', '--input-type=module', '-e', probe], { encoding: 'utf8', env: { ...process.env, KIOSKO_HOME: home } });
    if (fonts.status !== 0) throw new Error(`site build: no Traditional and Simplified Chinese fonts for the panel: ${fonts.stdout.trim() || fonts.stderr.trim()}`);
    const cli = spawnSync(process.execPath, ['--conditions=source', join(root, 'packages/server/src/cli.ts'), 'gallery', '--all-languages', '--out', join(out, 'gallery'), '--pages', join(root, 'examples/showcase.json')], {
      stdio: 'inherit',
      env: { ...process.env, KIOSKO_HOME: home },
    });
    if (cli.status !== 0) throw new Error('site build: the gallery failed');
    // The config's JSON Schema at its stable address, https://kioskolcd.dev/schema/v1/config.json :
    // configs point at it, and so does the front page.
    const schema = spawnSync(process.execPath, ['--conditions=source', join(root, 'packages/server/src/cli.ts'), 'config', 'schema', '--out', join(out, 'schema/v1/config.json')], {
      stdio: 'inherit',
      env: { ...process.env, KIOSKO_HOME: home },
    });
    if (schema.status !== 0) throw new Error('site build: the config schema failed');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  const gallery = JSON.parse(readFileSync(join(out, 'gallery/gallery.json'), 'utf8'));

  // 1b. The plugin store's catalogue, from npm (and the gallery's pictures of the official plugins).
  //     KIOSKO_STORE_INDEX=<a site built before> copies its store/v1/ instead, for building offline.
  const index = spawnSync(process.execPath, ['--conditions=source', join(root, 'scripts/store/build-index.ts'), '--out', out, '--gallery', join(out, 'gallery/gallery.json')], { stdio: 'inherit' });
  if (index.status !== 0) throw new Error('site build: the plugin store index failed');
  const store = JSON.parse(readFileSync(join(out, 'store/v1/index.json'), 'utf8'));
  const details = Object.fromEntries(store.plugins.filter((p) => !p.hidden).map((p) => [p.id, JSON.parse(readFileSync(join(out, 'store/v1/plugins', `${p.id}.json`), 'utf8'))]));

  // 2. The demo (and the 3D page), whose renderer the front page starts too.
  await buildDemo({ out: join(out, 'demo'), editorOptions });
  const assets = join(out, 'demo/assets');

  // 3. The front page.
  const common = { outdir: assets, bundle: true, minify: true, legalComments: 'linked', logLevel: 'info', conditions: ['source'] };
  await build({ ...common, entryPoints: { landing: join(here, 'main.ts') }, format: 'esm', platform: 'browser', target: ['es2022', 'chrome110', 'firefox115', 'safari16'], define: { KIOSKO_DEMO: 'true' } });
  await build({ ...common, entryPoints: { landing: join(here, 'styles.css') } });
  await build({ ...common, entryPoints: { store: join(here, 'store.ts') }, format: 'esm', platform: 'browser', target: ['es2022', 'chrome110', 'firefox115', 'safari16'] });
  await build({ ...common, entryPoints: { store: join(here, 'store.css') } });

  // As in the demo: every reference carries a hash of what it points to (Pages caches for a while).
  const hash = (f) => createHash('sha256').update(readFileSync(join(assets, f))).digest('hex').slice(0, 10);
  const script = readFileSync(join(assets, 'landing.js'), 'utf8');
  if (!script.includes('"./renderer.js"')) throw new Error('site build: no "./renderer.js" reference in landing.js to version');
  writeFileSync(join(assets, 'landing.js'), script.replaceAll('"./renderer.js"', `"./renderer.js?v=${hash('renderer.js')}"`));

  // The Doom section's recording (kiosko-plugin-doom's interlude, 16 s of Freedoom's demo, 320×240,
  // VP9 and H.264: some browsers have only one of them) and its first picture: made once with the plugin's engine and kept here, like card.jpg.
  for (const f of ['doom.webm', 'doom.mp4', 'doom.jpg']) copyFileSync(join(here, f), join(assets, f));

  // The first page of the sample screen that has something moving: the picture the panel starts with.
  const poster = gallery.pages.find((p) => p.name === 'Cats') ?? gallery.pages[0];
  for (const l of LANGS) if (!poster || !existsSync(join(out, 'gallery', poster.file[l.id] ?? ''))) throw new Error(`site build: the gallery painted no sample page in ${l.id} for the front page`);
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  const texts = loadTexts(join(here, 'i18n'));
  const fill = {
    CSS: `demo/assets/landing.css?v=${hash('landing.css')}`,
    JS: `demo/assets/landing.js?v=${hash('landing.js')}`,
    POSTER: Object.fromEntries(LANGS.map((l) => [l.id, `gallery/${poster.file[l.id]}`])),
    DOOM_VIDEO: `demo/assets/doom.mp4?v=${hash('doom.mp4')}`,
    DOOM_WEBM: `demo/assets/doom.webm?v=${hash('doom.webm')}`,
    DOOM_POSTER: `demo/assets/doom.jpg?v=${hash('doom.jpg')}`,
    PLUGINS: (lang, prefix) => pluginCards(gallery, texts, lang, prefix),
    PLUGIN_COUNT: (lang) => String(offered(gallery, lang).length),
    WIDGET_COUNT: (lang) => String(offered(gallery, lang).reduce((n, p) => n + p.widgets.length, 0)),
    VERSION: esc(version),
  };
  const template = readFileSync(join(here, 'index.html'), 'utf8');
  for (const l of LANGS) {
    mkdirSync(join(out, l.path), { recursive: true });
    writeFileSync(join(out, l.path, 'index.html'), renderPage(template, texts, l.id, fill));
  }
  // The store, in every language.
  const storePages = buildStorePages({ out, index: store, details, texts, css: `demo/assets/store.css?v=${hash('store.css')}`, js: `demo/assets/store.js?v=${hash('store.js')}`, presets: store.presets ?? [] });
  writeFileSync(join(out, 'sitemap.xml'), sitemap(storePages));
  writeFileSync(join(out, 'robots.txt'), 'User-agent: *\nAllow: /\nSitemap: https://kioskolcd.dev/sitemap.xml\n');
  // Where to report a vulnerability (RFC 9116); it must say when it expires, so a year from each build.
  mkdirSync(join(out, '.well-known'), { recursive: true });
  const expires = new Date(Date.now() + 365 * 86400e3).toISOString().replace(/\.\d+Z$/, 'Z');
  writeFileSync(
    join(out, '.well-known', 'security.txt'),
    `Contact: mailto:security@kioskolcd.dev\nContact: https://github.com/kiosko-lcd/kiosko/security/advisories/new\nExpires: ${expires}\nPreferred-Languages: en, es\nCanonical: https://kioskolcd.dev/.well-known/security.txt\nPolicy: https://github.com/kiosko-lcd/kiosko/blob/main/SECURITY.md\n`,
  );
  // The picture that goes with the link when it is shared (og:image). It is the front page itself
  // in 3D, so it is taken on a machine with a GPU and kept here: scripts/panel3d-film.mjs --card.
  copyFileSync(join(here, 'card.jpg'), join(out, 'card.jpg'));
  console.log(`site → ${out}: front page in ${LANGS.map((l) => l.id).join(', ')} with ${gallery.plugins.length} plugins and ${gallery.count} widgets, gallery/, demo/, demo/3d/, schema/, store/ with ${storePages.length - 1} plugins`);
}

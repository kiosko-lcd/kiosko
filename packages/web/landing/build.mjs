// The site (https://kioskolcd.dev/), run from packages/web/build.mjs --site [--out site]:
//
//   gallery/               every widget, painted (`kiosko gallery`), and gallery.json
//   schema/v1/config.json  the config's JSON Schema (`kiosko config schema`)
//   demo/                  the editor in the browser and the panel in 3D (demo/build.mjs)
//   card.jpg               the picture shown with the site's link when it is shared
//   index.html             the front page (this folder): a story told over the 3D panel,
//   demo/assets/landing.*  then the plugins (from gallery.json) and how to start
//
// The front page's script lives with the demo's assets because it starts the
// same renderer.js, by a relative address.
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDemo } from '../demo/build.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
/** A text in the page's two languages; one element when they are the same. */
const both = (t) => (t.en === t.es ? esc(t.en) : `<span lang="en">${esc(t.en)}</span><span lang="es">${esc(t.es)}</span>`);

/** The plugins as cards: what each is, and a couple of its widgets as painted for the gallery. */
function pluginCards(data) {
  // What ships inside Kiosko itself goes last: the others are what there is to discover.
  const builtin = (p) => (p.id === 'legacy' ? 2 : p.id === 'core' ? 1 : 0);
  return [...data.plugins]
    .sort((a, b) => builtin(a) - builtin(b))
    .map((p) => {
      const shots = p.widgets
        .slice(0, 2)
        .map((w) => `<img src="gallery/${esc(w.file)}" width="${w.width}" height="${w.height}" loading="lazy" alt="${esc(w.name.en)}" />`)
        .join('');
      const n = p.widgets.length;
      return `<article class="plugin"><div class="shots">${shots}</div><div class="about"><h3>${both(p.name)} <code>${esc(p.id)}</code></h3><p>${both(p.description)}</p><p class="count">${n} <span lang="en">widget${n === 1 ? '' : 's'}</span><span lang="es">widget${n === 1 ? '' : 's'}</span></p></div></article>`;
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
    const cli = spawnSync(process.execPath, ['--conditions=source', join(root, 'packages/server/src/cli.ts'), 'gallery', '--out', join(out, 'gallery'), '--pages', join(root, 'examples/showcase.json')], {
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

  // 2. The demo (and the 3D page), whose renderer the front page starts too.
  await buildDemo({ out: join(out, 'demo'), editorOptions });
  const assets = join(out, 'demo/assets');

  // 3. The front page.
  const common = { outdir: assets, bundle: true, minify: true, legalComments: 'linked', logLevel: 'info' };
  await build({ ...common, entryPoints: { landing: join(here, 'main.ts') }, format: 'esm', platform: 'browser', target: ['es2022', 'chrome110', 'firefox115', 'safari16'], define: { KIOSKO_DEMO: 'true' } });
  await build({ ...common, entryPoints: { landing: join(here, 'styles.css') } });

  // As in the demo: every reference carries a hash of what it points to (Pages caches for a while).
  const hash = (f) => createHash('sha256').update(readFileSync(join(assets, f))).digest('hex').slice(0, 10);
  const script = readFileSync(join(assets, 'landing.js'), 'utf8');
  if (!script.includes('"./renderer.js"')) throw new Error('site build: no "./renderer.js" reference in landing.js to version');
  writeFileSync(join(assets, 'landing.js'), script.replaceAll('"./renderer.js"', `"./renderer.js?v=${hash('renderer.js')}"`));

  // The first page of the sample screen that has something moving: the picture the panel starts with.
  const poster = gallery.pages.find((p) => p.name === 'Cats') ?? gallery.pages[0];
  if (!poster || !existsSync(join(out, 'gallery', poster.file.en)) || !existsSync(join(out, 'gallery', poster.file.es))) throw new Error('site build: the gallery painted no sample page for the front page');
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  const fill = {
    CSS: `demo/assets/landing.css?v=${hash('landing.css')}`,
    JS: `demo/assets/landing.js?v=${hash('landing.js')}`,
    POSTER: `gallery/${poster.file.en}`,
    POSTER_ES: `gallery/${poster.file.es}`,
    PLUGINS: pluginCards(gallery),
    PLUGIN_COUNT: String(gallery.plugins.length),
    WIDGET_COUNT: String(gallery.count),
    VERSION: esc(version),
  };
  const page = readFileSync(join(here, 'index.html'), 'utf8').replace(/\{\{(\w+)\}\}/g, (whole, key) => {
    if (!(key in fill)) throw new Error(`site build: index.html asks for ${whole}, which nothing fills`);
    return fill[key];
  });
  writeFileSync(join(out, 'index.html'), page);
  // The picture that goes with the link when it is shared (og:image). It is the front page itself
  // in 3D, so it is taken on a machine with a GPU and kept here: scripts/panel3d-film.mjs --card.
  copyFileSync(join(here, 'card.jpg'), join(out, 'card.jpg'));
  console.log(`site → ${out}: front page with ${gallery.plugins.length} plugins and ${gallery.count} widgets, gallery/, demo/, demo/3d/, schema/`);
}

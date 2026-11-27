// The screen firmware's web installer (https://kioskolcd.dev/flash/, /es/flash/…): plug a board in
// by USB, press the button, pick its port. ESP Web Tools (Apache-2.0, pinned in packages/web's
// package.json) talks to the board over WebSerial, in Chrome and Edge on a computer.
//
// Everything is served by this site, nothing from another one: ESP Web Tools' own bundle is copied
// from node_modules into flash/esp-web-tools/ with its licence and those of what it bundles, and the
// firmware's full image comes from the latest GitHub release, copied into flash/firmware/ when the
// site is built (pages.yml downloads it; KIOSKO_SITE_FIRMWARE=<dir> here). A browser can't read a
// release's files straight from GitHub (no CORS on its downloads, and GitHub is slow or out of reach
// in mainland China). Without an image the page still builds and says where to get one.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { LANGS, esc, text } from './pages.mjs';
import { pageHead } from './store.mjs';
import { guidePath, slug } from './docs.mjs';

const require = createRequire(import.meta.url);
const REPO = 'https://github.com/kiosko-lcd/kiosko';

/** The boards the installer knows: the `model` in the image's name, its chip as ESP Web Tools calls it, and its name for people. */
export const BOARDS = [{ model: 'waveshare-esp32c6-lcd-1.47', chipFamily: 'ESP32-C6', name: 'Waveshare ESP32-C6-LCD-1.47' }];

const FULL = /^kiosko-screen-(\d+\.\d+\.\d+)-(.+)-full\.bin$/;

/** `"1.2.3"` → a number that sorts like the version. */
const rank = (v) => v.split('.').reduce((n, x) => n * 1000 + Number(x), 0);

/**
 * The newest full image of each known board in `dir` (as the release has them: `…-full.bin` with its
 * `.sha256`), checked against its checksum. A file that doesn't match its checksum stops the build.
 */
export function findImages(dir) {
  if (!dir || !existsSync(dir)) return [];
  const found = new Map();
  for (const name of readdirSync(dir)) {
    const m = FULL.exec(name);
    const board = m && BOARDS.find((b) => b.model === m[2]);
    if (!board) continue;
    const sumFile = join(dir, `${name}.sha256`);
    if (!existsSync(sumFile)) throw new Error(`site build: ${name} has no ${name}.sha256 next to it`);
    const expected = readFileSync(sumFile, 'utf8').trim().split(/\s+/)[0]?.toLowerCase();
    const bytes = readFileSync(join(dir, name));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== expected) throw new Error(`site build: ${name} does not match its .sha256 (${sha256} ≠ ${expected})`);
    const prev = found.get(board.model);
    if (!prev || rank(m[1]) > rank(prev.version)) found.set(board.model, { board, version: m[1], name, sha256, size: bytes.length, file: join(dir, name) });
  }
  return [...found.values()];
}

/** ESP Web Tools' manifest for one image: the whole flash at 0x0; erasing first is the person's choice. */
export function manifest(img) {
  return {
    name: `Kiosko screen (${img.board.name})`,
    version: img.version,
    new_install_prompt_erase: true,
    // The firmware doesn't speak Improv: its own setup network takes the Wi-Fi (the guide says how).
    new_install_improv_wait_time: 0,
    builds: [{ chipFamily: img.board.chipFamily, parts: [{ path: img.name, offset: 0 }] }],
  };
}

/** ESP Web Tools' browser bundle, its licence, and the licences of the packages it bundles, into `dir`. */
function copyInstaller(dir) {
  const pkgFile = require.resolve('esp-web-tools/package.json');
  const root = dirname(pkgFile);
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
  const web = join(root, 'dist/web');
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(web)) if (f.endsWith('.js')) copyFileSync(join(web, f), join(dir, f));
  // Its dependencies, and theirs: what the bundle is made of.
  const notices = [];
  const seen = new Set();
  const visit = (name, from) => {
    if (seen.has(name)) return;
    seen.add(name);
    // Node's own lookup, by hand: some packages (lit) don't export their package.json.
    let file;
    for (let d = from; !file; d = dirname(d)) {
      if (existsSync(join(d, 'node_modules', name, 'package.json'))) file = join(d, 'node_modules', name, 'package.json');
      else if (dirname(d) === d) throw new Error(`site build: ${name}, which ESP Web Tools bundles, is not installed`);
    }
    const p = JSON.parse(readFileSync(file, 'utf8'));
    const dirOf = dirname(file);
    const lic = readdirSync(dirOf).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f));
    notices.push(`${'='.repeat(72)}\n${p.name} ${p.version} (${p.license ?? 'see below'})\n${p.homepage ?? ''}\n\n${lic ? readFileSync(join(dirOf, lic), 'utf8').trim() : `License: ${p.license}`}\n`);
    for (const d of Object.keys(p.dependencies ?? {})) visit(d, dirOf);
  };
  visit('esp-web-tools', dirname(dirname(root)));
  writeFileSync(
    join(dir, 'LICENSES.txt'),
    `ESP Web Tools ${pkg.version} (https://github.com/esphome/esp-web-tools), Apache-2.0, served unchanged from its npm package's dist/web,\nfor Kiosko's screen firmware installer. It bundles the packages below; each one's licence follows.\n\n${notices.join('\n')}`,
  );
  const v = createHash('sha256').update(readFileSync(join(dir, 'install-button.js'))).digest('hex').slice(0, 10);
  return { version: pkg.version, script: `install-button.js?v=${v}` };
}

/**
 * Writes /flash/ in every language (and flash/esp-web-tools/, flash/firmware/). Returns the pages for
 * the sitemap.
 */
export function buildFlashPages({ out, texts, css, docsDir, firmwareDir }) {
  const base = join(out, 'flash');
  const tools = copyInstaller(join(base, 'esp-web-tools'));
  const images = findImages(firmwareDir);
  if (images.length) mkdirSync(join(base, 'firmware'), { recursive: true });
  for (const img of images) {
    copyFileSync(img.file, join(base, 'firmware', img.name));
    writeFileSync(join(base, 'firmware', `${img.name}.sha256`), `${img.sha256}  ${img.name}\n`);
    writeFileSync(join(base, 'firmware', `manifest-${img.board.model}.json`), `${JSON.stringify(manifest(img), null, 2)}\n`);
  }
  const path = 'flash/';
  for (const l of LANGS) {
    const t = (k) => text(texts, l.id, k);
    const fill = (k, vars) => t(k).replace(/\{(\w+)\}/g, (_m, n) => vars[n] ?? '');
    const root = '../'.repeat(`${l.path}${path}`.split('/').filter(Boolean).length);
    const guide = guidePath(docsDir, l.id, 'remote-screens') ?? guidePath(docsDir, 'en', 'remote-screens');
    const guideUrl = `${root}${guide}`;
    const boards = images.length
      ? images
          .map((img) => {
            const fw = `${root}flash/firmware/`;
            return `<section class="flash-board">
        <h2>${esc(img.board.name)}</h2>
        <p class="flash-version">${esc(fill('flash-version', { version: img.version }))} · <a href="${fw}${esc(img.name)}" download>${esc(img.name)}</a> (${(img.size / 1024 / 1024).toFixed(1)} MB)</p>
        <p class="flash-sha"><span>SHA-256</span> <code>${img.sha256}</code></p>
        <esp-web-install-button manifest="${fw}manifest-${esc(img.board.model)}.json">
          <button slot="activate" class="button primary big">${esc(t('flash-button'))}</button>
          <p slot="unsupported" class="flash-warn">${t('flash-unsupported')}</p>
          <p slot="not-allowed" class="flash-warn">${t('flash-not-allowed')}</p>
        </esp-web-install-button>
      </section>`;
          })
          .join('\n      ')
      : `<p class="flash-warn">${fill('flash-none', { link: `<a href="${REPO}/releases/latest">${esc(t('flash-none-link'))}</a>` })}</p>`;
    const page = `${pageHead({ lang: l.id, texts, title: `${t('flash-title')} · Kiosko`, description: t('flash-description'), path, root, css })}
  <main class="doc flash">
    <article class="guide">
      <h1>${esc(t('flash-title'))}</h1>
      <p class="flash-lede">${t('flash-lede')}</p>
      <h2>${esc(t('flash-need-title'))}</h2>
      <ul>
        <li>${t('flash-need-board')}</li>
        <li>${t('flash-need-cable')}</li>
        <li>${t('flash-need-browser')}</li>
      </ul>
      ${boards}
      <h2>${esc(t('flash-steps-title'))}</h2>
      <ol>
        <li>${t('flash-step-plug')}</li>
        <li>${t('flash-step-press')}</li>
        <li>${t('flash-step-erase')}</li>
        <li>${fill('flash-step-next', { link: `<a href="${guideUrl}#${esc(slug(t('flash-guide-anchor')))}">${esc(t('flash-guide-anchor'))}</a>` })}</li>
      </ol>
      <h2>${esc(t('flash-trouble-title'))}</h2>
      <ul>
        <li>${t('flash-trouble-port')}</li>
        <li>${t('flash-trouble-linux')}</li>
        <li>${fill('flash-trouble-manual', { link: `<a href="${guideUrl}#${esc(slug(t('flash-manual-anchor')))}">${esc(t('flash-manual-anchor'))}</a>` })}</li>
      </ul>
    </article>
    <p class="fine">${fill('flash-credits', { tool: '<a href="https://github.com/esphome/esp-web-tools">ESP Web Tools</a>', version: esc(tools.version), licences: `<a href="${root}flash/esp-web-tools/LICENSES.txt">${esc(t('flash-licences'))}</a>` })} · <a href="${guideUrl}">${esc(t('flash-guide'))}</a></p>
  </main>
  <script type="module" src="${root}flash/esp-web-tools/${tools.script}"></script>
</body>
</html>
`;
    const dir = join(out, l.path, path);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'index.html'), page);
  }
  return { pages: [{ path, langs: LANGS }], images };
}

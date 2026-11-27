import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
// @ts-expect-error: a plain ES module of the site's build
import { buildFlashPages, findImages, manifest } from './flash.mjs';
// @ts-expect-error: a plain ES module of the site's build
import { renderMarkdown, slug } from './docs.mjs';
// @ts-expect-error: a plain ES module of the site's build
import { LANGS, loadTexts } from './pages.mjs';

const docs = fileURLToPath(new URL('../../../docs/', import.meta.url));
const texts = loadTexts(fileURLToPath(new URL('./i18n/', import.meta.url)));
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** A release's files in a folder: each name with its bytes and a .sha256 (`lie`: a wrong one). */
function release(files: Record<string, Buffer>, lie: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'kiosko-flash-'));
  for (const [name, bytes] of Object.entries(files)) {
    writeFileSync(join(dir, name), bytes);
    writeFileSync(join(dir, `${name}.sha256`), `${lie.includes(name) ? sha(Buffer.from('x')) : sha(bytes)}  ${name}\n`);
  }
  return dir;
}

test('findImages: the newest full image of each known board, checked; a wrong checksum stops the build', () => {
  const a = Buffer.alloc(1000, 1), b = Buffer.alloc(2000, 2);
  const dir = release({
    'kiosko-screen-0.1.3-waveshare-esp32c6-lcd-1.47-full.bin': a,
    'kiosko-screen-0.1.10-waveshare-esp32c6-lcd-1.47-full.bin': b,
    // The app image (for OTA), and a board the installer doesn't know: left out.
    'kiosko-screen-0.1.10-waveshare-esp32c6-lcd-1.47.bin': a,
    'kiosko-screen-0.1.10-other-board-full.bin': a,
  });
  try {
    const found = findImages(dir);
    assert.equal(found.length, 1);
    assert.equal(found[0].version, '0.1.10');
    assert.equal(found[0].sha256, sha(b));
    assert.deepEqual(manifest(found[0]), {
      name: 'Kiosko screen (Waveshare ESP32-C6-LCD-1.47)',
      version: '0.1.10',
      new_install_prompt_erase: true,
      new_install_improv_wait_time: 0,
      builds: [{ chipFamily: 'ESP32-C6', parts: [{ path: 'kiosko-screen-0.1.10-waveshare-esp32c6-lcd-1.47-full.bin', offset: 0 }] }],
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const bad = release({ 'kiosko-screen-0.1.3-waveshare-esp32c6-lcd-1.47-full.bin': a }, ['kiosko-screen-0.1.3-waveshare-esp32c6-lcd-1.47-full.bin']);
  try {
    assert.throws(() => findImages(bad), /does not match its \.sha256/);
  } finally {
    rmSync(bad, { recursive: true, force: true });
  }
  assert.deepEqual(findImages(undefined), []);
});

test('the installer page in every language: the button with its manifest, the installer from this site, links that land', () => {
  const out = mkdtempSync(join(tmpdir(), 'kiosko-flash-site-'));
  const image = Buffer.concat([Buffer.from([0xe9]), Buffer.alloc(4000)]);
  const dir = release({ 'kiosko-screen-0.1.4-waveshare-esp32c6-lcd-1.47-full.bin': image });
  try {
    const { pages, images } = buildFlashPages({ out, texts, docsDir: docs, css: 'demo/assets/store.css', firmwareDir: dir });
    assert.equal(images.length, 1);
    assert.equal(pages[0].path, 'flash/');
    const fw = join(out, 'flash/firmware');
    assert.ok(readFileSync(join(fw, 'kiosko-screen-0.1.4-waveshare-esp32c6-lcd-1.47-full.bin')).equals(image));
    assert.equal(JSON.parse(readFileSync(join(fw, 'manifest-waveshare-esp32c6-lcd-1.47.json'), 'utf8')).builds[0].parts[0].offset, 0);
    // ESP Web Tools from this site, with the licences of what it bundles.
    assert.ok(existsSync(join(out, 'flash/esp-web-tools/install-button.js')));
    const lic = readFileSync(join(out, 'flash/esp-web-tools/LICENSES.txt'), 'utf8');
    assert.match(lic, /esp-web-tools .*Apache-2\.0/);
    assert.match(lic, /esptool-js/);
    for (const l of LANGS) {
      const html = readFileSync(join(out, l.path, 'flash/index.html'), 'utf8');
      assert.match(html, /<esp-web-install-button manifest="(\.\.\/)+flash\/firmware\/manifest-waveshare-esp32c6-lcd-1\.47\.json">/, l.id);
      assert.match(html, /<script type="module" src="(\.\.\/)+flash\/esp-web-tools\/install-button\.js\?v=[0-9a-f]{10}"><\/script>/, l.id);
      assert.doesNotMatch(html, /https?:\/\/(?!github\.com|kioskolcd\.dev|www\.w3\.org)[^"\s<]*\.(js|bin|json)\b/, `${l.id}: nothing loaded from another site`);
      assert.ok(html.includes(sha(image)), l.id);
      // The guide's anchors it points at exist in that language's guide.
      const md = readFileSync(join(docs, l.id === 'en' ? 'remote-screens.md' : `${l.id}/remote-screens.md`), 'utf8');
      const ids = [...renderMarkdown(md).html.matchAll(/<h\d id="([^"]+)"/g)].map((m) => m[1]);
      for (const k of ['flash-guide-anchor', 'flash-manual-anchor']) {
        const anchor = slug(texts[l.id][k]);
        assert.ok(ids.includes(anchor), `${l.id}: "${anchor}" is not a heading of its remote-screens guide`);
        assert.ok(html.includes(`docs/remote-screens/#${anchor}`), `${l.id}: links to #${anchor}`);
      }
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('without an image the page still builds, and says where to get one', () => {
  const out = mkdtempSync(join(tmpdir(), 'kiosko-flash-none-'));
  try {
    const { images } = buildFlashPages({ out, texts, docsDir: docs, css: 'x.css' });
    assert.equal(images.length, 0);
    const html = readFileSync(join(out, 'es/flash/index.html'), 'utf8');
    assert.doesNotMatch(html, /<esp-web-install-button/);
    assert.match(html, /releases\/latest/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

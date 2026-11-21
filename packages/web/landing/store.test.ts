import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildIndex, entryFrom, PANEL_PRESETS } from '@kiosko/core';
// @ts-expect-error plain JavaScript, run by the site build
import { LANGS, loadTexts, sitemap } from './pages.mjs';
// @ts-expect-error plain JavaScript, run by the site build
import { FEATURED, OPEN_IN_KIOSKO, buildStorePages, offeredIn } from './store.mjs';
import { manifest, packument } from '../../core/src/store/fixtures/npm.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const texts = loadTexts(join(here, 'i18n'));
const langs = LANGS as { id: string; path: string; hreflang: string[] }[];

function storeIndex() {
  const official = (id: string) => entryFrom({ packument: packument(`kiosko-plugin-${id}`, ['0.2.0']), manifest: manifest(id, '0.2.0', { permissions: { network: ['api.example.com', 'user'] } }), official: { bundled: true }, shots: { [`${id}/clock`]: { files: { en: `gallery/img/${id}-clock.png`, es: `gallery/img/es/${id}-clock.png` }, w: 320, h: 200 } } })!;
  const found = entryFrom({ packument: packument('kiosko-plugin-acuario', ['0.0.3']), manifest: manifest('acuario', '0.0.3', { markets: { only: ['ES'] }, license: 'GPL-3.0-only' }) })!;
  const entries = [official('weather'), official('agents'), found];
  const index = buildIndex(entries.map((e) => e.plugin), { generatedAt: '2026-11-21T03:17:00Z' });
  const details = Object.fromEntries(entries.map((e) => [e.plugin.id, { riskyOptions: e.file, sources: e.sources }]));
  return { index, details };
}

test('store pages: the list and each plugin, in every language, with the links between them', () => {
  const out = mkdtempSync(join(tmpdir(), 'kiosko-store-site-'));
  try {
    const { index, details } = storeIndex();
    const samples = ['dashboard', 'cats', 'news'].map((n) => ({ name: n, width: 1920, height: 462, file: Object.fromEntries(langs.map((l) => [l.id, `img/page-${n}.${l.id}.jpg`])) }));
    const pages = buildStorePages({ out, index, details, texts, css: 'demo/assets/store.css?v=1', js: 'demo/assets/store.js?v=1', presets: PANEL_PRESETS, pages: samples });
    for (const l of langs) {
      const list = readFileSync(join(out, l.path, 'store/index.html'), 'utf8');
      assert.match(list, new RegExp(`<html lang="${l.id}"`));
      assert.match(list, new RegExp(`<link rel="canonical" href="https://kioskolcd.dev/${l.path}store/" />`));
      for (const o of langs) for (const h of o.hreflang) assert.ok(list.includes(`hreflang="${h}" href="https://kioskolcd.dev/${o.path}store/"`), `${l.id}: ${h}`);
      // Assets and pictures from this site only, by relative paths.
      const root = '../'.repeat(`${l.path}store/`.split('/').filter(Boolean).length);
      assert.ok(list.includes(`href="${root}demo/assets/store.css?v=1"`));
      assert.ok(list.includes(`src="${root}gallery/img/`), `${l.id}: the gallery's pictures`);
      assert.doesNotMatch(list.replace(/https:\/\/(kioskolcd\.dev|github\.com)[^"]*/g, ''), /(src|href)="https?:/);
      // Unreviewed ones are listed, and marked.
      assert.match(list, /class="card found"[^>]*data-tier="found"/);
      assert.ok(list.includes(texts[l.id]['store-unreviewed'] ?? texts.en['store-unreviewed']));
      assert.doesNotMatch(list.replace(/<script type="application\/json"[\s\S]*?<\/script>/, ''), /\{\{|\{n\}|\{category\}|undefined/);
      // The panel at the top shows the gallery's sample pages in this language; the first one says what it is.
      assert.ok(list.includes(`src="${root}gallery/img/page-dashboard.${l.id}.jpg"`), `${l.id}: the sample page`);
      assert.match(list, /class="hero-panel turns"/);
      // The categories as chips (one of them chosen), the sort joined to the form from outside it.
      assert.match(list, /<input type="radio" name="cat" value="" checked \/>/);
      assert.match(list, /<select name="sort" form="store-filters">/);
      // Icons drawn into the page, not fetched.
      assert.match(list, /<span class="app-icon"><svg class="ic"/);
    }
    // Picked ones first, from those offered (an editorial order, nothing made up).
    const en = readFileSync(join(out, 'store/index.html'), 'utf8');
    assert.deepEqual([...en.matchAll(/<a class="feature" href="([^/]+)\//g)].map((m) => m[1]), FEATURED.filter((id: string) => ['weather', 'agents', 'acuario'].includes(id)).slice(0, 3));
    // Simplified Chinese: no AI agents there (languages.ts), as on the front page.
    const hans = readFileSync(join(out, 'zh-Hans/store/index.html'), 'utf8');
    assert.ok(!hans.includes('data-id="agents"'));
    assert.ok(!existsSync(join(out, 'zh-Hans/store/agents')));
    assert.ok(existsSync(join(out, 'zh-Hant/store/agents/index.html')));
    assert.deepEqual(offeredIn(index, 'zh-Hans').map((p: { id: string }) => p.id).sort(), ['acuario', 'weather']);
    // A plugin's page: open in Kiosko (never an install), the command, what it does, and its languages only.
    const page = readFileSync(join(out, 'es/store/weather/index.html'), 'utf8');
    assert.ok(page.includes(`href="${OPEN_IN_KIOSKO}weather"`));
    assert.match(OPEN_IN_KIOSKO, /^http:\/\/127\.0\.0\.1:7420\/#\/plugins\/store\/$/);
    assert.ok(page.includes('kiosko plugins install kiosko-plugin-weather@0.2.0'));
    assert.ok(page.includes('api.example.com') && page.includes(texts.es['store-perm-user']));
    assert.ok(page.includes('src="../../../gallery/img/es/weather-clock.png"'));
    // The command, and a button that copies it (a script's: the page works without).
    assert.ok(page.includes('<button type="button" class="copy" data-copy="kiosko plugins install kiosko-plugin-weather@0.2.0">'));
    const agents = readFileSync(join(out, 'es/store/agents/index.html'), 'utf8');
    assert.ok(!agents.includes('hreflang="zh-Hans"'), 'not offered in zh-Hans: no alternate there');
    const fish = readFileSync(join(out, 'store/acuario/index.html'), 'utf8');
    assert.match(fish, /class="note unreviewed"/);
    assert.match(fish, /Only useful in Spain/);
    // The sitemap has them, each in its languages.
    const xml = sitemap(pages) as string;
    assert.match(xml, /<loc>https:\/\/kioskolcd\.dev\/es\/store\/weather\/<\/loc>/);
    assert.doesNotMatch(xml, /zh-Hans\/store\/agents/);
    assert.equal(readdirSync(join(out, 'store')).sort().join(), 'acuario,agents,index.html,weather');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('an interlude with a clip: its page plays it (silent, its still as poster); without a clip, its still', () => {
  const out = mkdtempSync(join(tmpdir(), 'kiosko-store-clip-'));
  try {
    const interlude = (type: string) => ({ type, name: { en: type }, fps: 15 });
    const e = entryFrom({
      packument: packument('kiosko-plugin-fractals', ['0.2.1']),
      manifest: manifest('fractals', '0.2.1', { widgets: [], interludes: [interlude('fractals/flame'), interlude('fractals/coral')] } as never),
      official: { bundled: false },
      posters: { 'fractals/flame': 'store/v1/img/fractals/0.2.1/flame.jpg', 'fractals/coral': 'store/v1/img/fractals/0.2.1/coral.jpg' },
      // A clip without its still is not shown: here coral has no clip, and a clip for an unknown type is ignored.
      videos: { 'fractals/flame': 'store/v1/img/fractals/0.2.1/flame.webm', 'fractals/nope': 'x.webm' },
    })!;
    assert.deepEqual(e.plugin.interludes.map((i) => [i.type, i.video ?? null]), [['fractals/flame', 'store/v1/img/fractals/0.2.1/flame.webm'], ['fractals/coral', null]]);
    const index = buildIndex([e.plugin], { generatedAt: '2026-11-21T03:17:00Z' });
    buildStorePages({ out, index, details: { fractals: { riskyOptions: e.file, sources: e.sources } }, texts, css: 'c.css', js: 'j.js', presets: PANEL_PRESETS });
    const page = readFileSync(join(out, 'es/store/fractals/index.html'), 'utf8');
    const clips = [...page.matchAll(/<video class="clip"[^>]*>/g)].map((m) => m[0]);
    // On the big panel only (the list keeps the stills): never autoplaying (store.ts plays it on screen), never loading before then.
    assert.equal(clips.length, 1);
    for (const c of clips) {
      assert.match(c, /src="\.\.\/\.\.\/\.\.\/store\/v1\/img\/fractals\/0\.2\.1\/flame\.webm"/);
      assert.match(c, /poster="\.\.\/\.\.\/\.\.\/store\/v1\/img\/fractals\/0\.2\.1\/flame\.jpg"/);
      assert.match(c, / muted loop playsinline preload="none"/);
      assert.doesNotMatch(c, /autoplay/);
    }
    assert.ok(page.includes('<img src="../../../store/v1/img/fractals/0.2.1/coral.jpg"'), 'coral: its still');
    // Each interlude with a still has its place on the big panel, chosen by a thumbnail.
    assert.equal([...page.matchAll(/<button type="button" data-shot="\d"/g)].length, 2);
    assert.match(page, /<figure class="" id="shot-1"><div class="glass"><img src="[^"]*coral\.jpg"/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

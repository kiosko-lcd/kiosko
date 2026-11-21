import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
// @ts-expect-error plain JavaScript, run by the site build
import { LANGS, loadTexts, plural, renderPage, sitemap } from './pages.mjs';

type Lang = { id: string; path: string; hreflang: string[]; panel: string; dir: string };
const here = fileURLToPath(new URL('.', import.meta.url));
const texts = loadTexts(join(here, 'i18n')) as Record<string, Record<string, string>>;
const template = readFileSync(join(here, 'index.html'), 'utf8');
const langs = LANGS as Lang[];

const holes = (s: string) => [...s.matchAll(/\{\{\w+\}\}|\{\w+\}/g)].map((m) => m[0]).sort();
const tags = (s: string) => [...s.matchAll(/<\/?([a-z]+)[^>]*>/g)].map((m) => m[1]!);

test('every language has every text of en.json, and nothing else but its plural forms', () => {
  const keys = Object.keys(texts.en!).sort();
  for (const l of langs) {
    const mine = texts[l.id]!;
    // Besides en.json's keys, the plural forms a language's rules have (`js-pages-few`).
    const extra = Object.keys(mine).filter((k) => !keys.includes(k));
    for (const k of extra) assert.ok(/-(zero|two|few|many)$/.test(k) && keys.includes(k.replace(/-(zero|two|few|many)$/, '-other')), `i18n/${l.id}.json: "${k}" is not in en.json`);
    assert.deepEqual(keys.filter((k) => !(k in mine)), [], `i18n/${l.id}.json lacks`);
    for (const [k, v] of Object.entries(mine)) assert.ok(v.trim(), `i18n/${l.id}.json: "${k}" is empty`);
  }
});

test('translations keep the placeholders and only use the markup the page knows', () => {
  for (const l of langs) {
    for (const [k, en] of Object.entries(texts.en!)) {
      const mine = texts[l.id]![k]!;
      assert.deepEqual(holes(mine), holes(en), `${l.id} "${k}": placeholders`);
      for (const tag of tags(mine)) assert.ok(['em', 'code', 'span'].includes(tag), `${l.id} "${k}": <${tag}>`);
      if (en.includes('class="only3d"')) assert.ok(mine.includes('class="only3d"'), `${l.id} "${k}": the part only said with 3D`);
    }
  }
});

test('Chinese pages are in Chinese, with the right script', () => {
  // Characters that only exist in one of the two scripts.
  assert.match(texts['zh-Hant']!['the-little-screen-on-your']!, /螢幕|終於/);
  assert.match(texts['zh-Hans']!['the-little-screen-on-your']!, /屏幕|终于/);
  for (const [k, v] of Object.entries(texts['zh-Hant']!)) assert.doesNotMatch(v, /[们这个设终为]/u, `zh-Hant "${k}" has Simplified characters`);
  for (const [k, v] of Object.entries(texts['zh-Hans']!)) assert.doesNotMatch(v, /[們這個設終於為螢]/u, `zh-Hans "${k}" has Traditional characters`);
});

test('plural texts by the language’s rules', () => {
  assert.equal(plural(texts, 'en', 'card-widgets', 1), '1 widget');
  assert.equal(plural(texts, 'en', 'card-widgets', 3), '3 widgets');
  assert.equal(plural(texts, 'zh-Hant', 'card-widgets', 1), '1 個小工具');
});

const fill = {
  CSS: 'demo/assets/landing.css?v=1',
  JS: 'demo/assets/landing.js?v=1',
  POSTER: Object.fromEntries(langs.map((l) => [l.id, `gallery/img/page-cats.${l.id}.jpg`])),
  DOOM_VIDEO: 'demo/assets/doom.mp4?v=1',
  DOOM_WEBM: 'demo/assets/doom.webm?v=1',
  DOOM_POSTER: 'demo/assets/doom.jpg?v=1',
  PLUGINS: (lang: string, root: string) => `<p data-lang="${lang}" data-root="${root}"></p>`,
  PLUGIN_COUNT: '17',
  STORE_COUNT: '22',
  STORE_WIDGETS: '49',
  WIDGET_COUNT: '49',
  VERSION: '0.2.5',
};

test('one page per language, each saying what it is and where the others are', () => {
  for (const l of langs) {
    const page = renderPage(template, texts, l.id, fill) as string;
    assert.doesNotMatch(page, /\{\{/, `${l.id}: something left unfilled`);
    assert.match(page, new RegExp(`<html lang="${l.id}" dir="${l.dir}">`));
    assert.match(page, new RegExp(`<link rel="canonical" href="https://kioskolcd.dev/${l.path}" />`));
    for (const other of langs) for (const h of other.hreflang) assert.match(page, new RegExp(`hreflang="${h}" href="https://kioskolcd.dev/${other.path}"`), `${l.id}: ${h}`);
    // Paths from the site's root: a page one folder down goes up first.
    const root = l.path ? '../' : '';
    assert.ok(page.includes(`href="${root}demo/?lang=${l.panel}"`), `${l.id}: the editor, its sample in the page’s language`);
    assert.ok(page.includes(`src="${root}gallery/img/page-cats.${l.id}.jpg"`), `${l.id}: its own poster`);
    assert.ok(page.includes(`data-lang="${l.id}" data-root="${root}"`), `${l.id}: plugin cards in its language`);
    assert.ok(page.includes(`demo/3d/?lang=${l.panel}`), `${l.id}: the 3D page in its language`);
    if (l.id.startsWith('zh')) assert.ok(page.includes(`href="../${l.id}/docs/usb/"`) && page.includes(`href="../${l.id}/docs/install/"`), `${l.id}: its own guides, on the site`);
    if (l.id === 'en') assert.ok(page.includes('blob/main/docs/usb.md"'), 'en: the English guide');
    // Only the English page sends a first visit on to the visitor's language.
    assert.equal(page.includes('location.replace'), l.id === 'en', `${l.id}: redirect`);
    assert.match(page, new RegExp(`aria-current="page">[^<]+</a>`));
    // The script's words travel as data, in the page's language.
    const data = JSON.parse(/<script type="application\/json" id="kiosko-texts">(.*?)<\/script>/.exec(page)![1]!) as Record<string, string>;
    assert.equal(data['js-json'], texts[l.id]!['js-json']);
  }
});

test('the sitemap lists every language with its alternates', () => {
  const xml = sitemap() as string;
  assert.equal(xml.match(/<url>/g)!.length, langs.length);
  assert.match(xml, /<loc>https:\/\/kioskolcd\.dev\/zh-Hant\/<\/loc>/);
  assert.match(xml, /hreflang="x-default" href="https:\/\/kioskolcd\.dev\/"/);
});

test('a first visit to / goes to the visitor’s language, for every language the site has', async () => {
  const { runInNewContext } = await import('node:vm');
  const page = renderPage(template, texts, 'en', fill) as string;
  const script = /<script>\s*\(function \(\) \{[\s\S]*?location\.replace[\s\S]*?<\/script>/.exec(page)![0].replace(/<\/?script>/g, '');
  let cookie = '';
  const go = (languages: string[], saved: string | null = null) => {
    let went: string | null = null;
    cookie = '';
    runInNewContext(script, {
      Intl, String, Object, encodeURIComponent, window: {},
      document: { get cookie() { return cookie; }, set cookie(c: string) { cookie = c; } },
      location: { search: '', hash: '', replace: (u: string) => (went = u) },
      localStorage: { getItem: () => saved },
      navigator: { languages, language: languages[0] },
    });
    return went;
  };
  for (const l of langs) assert.equal(go([l.id]), l.path || null, l.id);
  assert.equal(go(['zh-TW']), 'zh-Hant/');
  assert.equal(go(['zh-HK']), 'zh-Hant/');
  assert.equal(go(['yue-HK']), 'zh-Hant/');
  assert.equal(go(['zh-CN']), 'zh-Hans/');
  assert.equal(go(['zh-SG']), 'zh-Hans/');
  assert.equal(go(['es-MX']), 'es/');
  assert.equal(go(['fr-FR']), null, 'a language the site lacks stays in English');
  assert.equal(go(['en-GB', 'zh-TW']), null, 'the first one that fits wins');
  assert.equal(go(['fr-FR', 'zh-TW']), 'zh-Hant/');
  assert.equal(go(['zh-TW'], 'en'), null, 'a choice made in the menu is kept');
  assert.match(cookie, /^kiosko_lang=en; Path=\//, 'and handed to the edge (worker/choose.ts) as a cookie');
  go(['es']);
  assert.equal(cookie, '', 'no choice, no cookie');
});

// The front page in each language the site speaks: one page per language, each at its own address,
// so that search engines index every language and a link says which one it is.
//
//   /           English (and x-default; a first visit goes on to the visitor's language)
//   /es/        Spanish
//   /zh-Hant/   Traditional Chinese (Taiwan, Hong Kong)
//   /zh-Hans/   Simplified Chinese (mainland China)
//
// The words are in i18n/<language>.json, one file per language with the same keys as en.json;
// index.html asks for them as {{t:key}} (HTML) or {{a:key}} (plain text, for attributes).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const SITE = 'https://kioskolcd.dev/';

/**
 * The site's languages. `dir` is where the page lives, `panel` the locale the panel paints in
 * (dates and widget texts), `hreflang` what the page is declared to be for.
 */
export const LANGS = [
  { id: 'en', dir: '', name: 'English', ogLocale: 'en_US', hreflang: ['en', 'x-default'], panel: 'en' },
  { id: 'es', dir: 'es/', name: 'Español', ogLocale: 'es_ES', hreflang: ['es'], panel: 'es' },
  { id: 'zh-Hant', dir: 'zh-Hant/', name: '繁體中文', ogLocale: 'zh_TW', hreflang: ['zh-Hant', 'zh-TW', 'zh-HK'], panel: 'zh-TW' },
  { id: 'zh-Hans', dir: 'zh-Hans/', name: '简体中文', ogLocale: 'zh_CN', hreflang: ['zh-Hans', 'zh-CN'], panel: 'zh-CN' },
];

/** Where the visitor's choice of language is kept (the menu writes it, the English page reads it). */
export const LANG_KEY = 'kiosko.lang';

export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
/** A text that may hold markup, as plain text for an attribute. */
const plain = (html) => esc(html.replace(/<[^>]+>/g, ''));

/** Every language's words, by language id. */
export function loadTexts(dir) {
  return Object.fromEntries(LANGS.map((l) => [l.id, JSON.parse(readFileSync(join(dir, `${l.id}.json`), 'utf8'))]));
}

/** A word in `lang`, or English if that language lacks it (the test says which ones do). */
export function text(texts, lang, key) {
  const s = texts[lang]?.[key] ?? texts.en[key];
  if (s === undefined) throw new Error(`site build: no text "${key}" in i18n/en.json`);
  return s;
}

/** `{n} widgets` and friends: the `<key>-one` or `<key>-other` text for `n`, by the language's plural rules. */
export function plural(texts, lang, key, n) {
  const form = new Intl.PluralRules(lang).select(n) === 'one' ? 'one' : 'other';
  return text(texts, lang, `${key}-${form}`).replaceAll('{n}', String(n));
}

/**
 * On the English page only: a first visit goes on to the visitor's language if the site has it,
 * before anything is painted. Once they pick one in the menu, that one is kept.
 */
function redirect() {
  const dirs = Object.fromEntries(LANGS.map((l) => [l.id, l.dir]));
  return `  <script>
    (function () {
      if (/[?&]card\\b/.test(location.search)) return;
      var dirs = ${JSON.stringify(dirs)}, go = null;
      try { go = localStorage.getItem(${JSON.stringify(LANG_KEY)}); } catch (e) {}
      if (!go) {
        var tags = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || 'en'];
        for (var i = 0; i < tags.length && !go; i++) {
          var t = String(tags[i]).toLowerCase();
          if (/^en\\b/.test(t)) go = 'en';
          else if (/^es\\b/.test(t)) go = 'es';
          else if (/^zh\\b/.test(t)) go = /hant|-tw|-hk|-mo/.test(t) ? 'zh-Hant' : 'zh-Hans';
        }
      }
      if (go && dirs[go]) {
        window.kioskoLeaving = true;
        location.replace(dirs[go] + location.search + location.hash);
      }
    })();
  </script>`;
}

/**
 * The page for `lang` from the template: its words, the links between languages and `fill`
 * (assets and counts, with paths from the site's root). Throws on anything left unfilled.
 */
export function renderPage(template, texts, langId, fill) {
  const lang = LANGS.find((l) => l.id === langId);
  if (!lang) throw new Error(`site build: no language ${langId}`);
  const root = lang.dir ? '../'.repeat(lang.dir.split('/').filter(Boolean).length) : '';
  const url = (l) => `${SITE}${l.dir}`;
  // Only what the page's script says, as data the script reads.
  const scriptTexts = Object.fromEntries(Object.keys(texts.en).filter((k) => k.startsWith('js-')).map((k) => [k, text(texts, langId, k)]));
  const all = {
    ...fill,
    CSS: root + fill.CSS,
    JS: root + fill.JS,
    POSTER: root + fill.POSTER[langId],
    LANG: lang.id,
    PANEL_LOCALE: lang.panel,
    ROOT: root,
    HOME: root || './',
    URL: url(lang),
    OG_LOCALE: lang.ogLocale,
    OG_ALTERNATES: LANGS.filter((l) => l !== lang).map((l) => `  <meta property="og:locale:alternate" content="${l.ogLocale}" />`).join('\n'),
    ALTERNATES: LANGS.flatMap((l) => l.hreflang.map((h) => `  <link rel="alternate" hreflang="${h}" href="${url(l)}" />`)).join('\n'),
    LANG_NAME: esc(lang.name),
    LANG_MENU: LANGS.map((l) => `<li><a href="${root}${l.dir || './'}" hreflang="${l.id}" lang="${l.id}" data-lang="${l.id}"${l === lang ? ' aria-current="page"' : ''}>${esc(l.name)}</a></li>`).join(''),
    REDIRECT: lang.dir ? '' : redirect(),
    JS_TEXTS: `<script type="application/json" id="kiosko-texts">${JSON.stringify(scriptTexts).replace(/</g, '\\u003c')}</script>`,
    PLUGINS: typeof fill.PLUGINS === 'function' ? fill.PLUGINS(langId, root) : fill.PLUGINS,
  };
  const words = template.replace(/\{\{([ta]):([a-z0-9-]+)\}\}/g, (_, kind, key) => (kind === 'a' ? plain(text(texts, langId, key)) : text(texts, langId, key)));
  return words.replace(/\{\{(\w+)\}\}/g, (whole, key) => {
    if (!(key in all)) throw new Error(`site build: index.html asks for ${whole}, which nothing fills`);
    return all[key];
  });
}

/** sitemap.xml: the front page in every language, each listing the others. */
export function sitemap() {
  const alternates = LANGS.flatMap((l) => l.hreflang.map((h) => `    <xhtml:link rel="alternate" hreflang="${h}" href="${SITE}${l.dir}"/>`)).join('\n');
  const urls = LANGS.map((l) => `  <url>\n    <loc>${SITE}${l.dir}</loc>\n${alternates}\n  </url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls}\n</urlset>\n`;
}

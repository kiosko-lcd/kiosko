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
import { existsSync, readFileSync } from 'node:fs';
import { LANGUAGES } from '../../sdk/src/languages.ts';
import { join } from 'node:path';

export const SITE = 'https://kioskolcd.dev/';
const REPO = 'https://github.com/kiosko-lcd/kiosko';
const DOCS = new URL('../../../docs/', import.meta.url);

/**
 * The guides in the page's language when they exist (docs/<id>/): as pages of this site (docs.mjs),
 * which reach where GitHub may not (mainland China). Else the English ones, on GitHub.
 */
function docsFor(id, root) {
  const has = (f) => id !== 'en' && existsSync(new URL(`${id}/${f}`, DOCS));
  return {
    DOCS_USB: has('usb.md') ? `${root}${id}/docs/usb/` : `${REPO}/blob/main/docs/usb.md`,
    DOCS_GUIDE: has('install.md') ? `${root}${id}/docs/install/` : `${REPO}#readme`,
  };
}

/**
 * The site's languages: Kiosko's (packages/sdk/src/languages.ts), each with
 * the folder its page lives in (`path`); English at the root.
 */
export const LANGS = LANGUAGES.map((l) => ({ ...l, path: l.id === 'en' ? '' : `${l.id}/` }));

/** Where the visitor's choice of language is kept (the menu writes it, the English page reads it). */
export const LANG_KEY = 'kiosko.lang';

export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
/** A text that may hold markup, as plain text for an attribute. */
const plain = (html) => esc(html.replace(/<[^>]+>/g, ''));

/** Every language's words, by language id. */
export function loadTexts(dir) {
  return Object.fromEntries(LANGS.map((l) => {
    const file = join(dir, `${l.id}.json`);
    if (!existsSync(file)) throw new Error(`no site texts for ${l.id}: copy i18n/en.json to i18n/${l.id}.json and translate it (CONTRIBUTING.md, "Translations")`);
    return [l.id, JSON.parse(readFileSync(file, 'utf8'))];
  }));
}

/** A word in `lang`, or English if that language lacks it (the test says which ones do). */
export function text(texts, lang, key) {
  const s = texts[lang]?.[key] ?? texts.en[key];
  if (s === undefined) throw new Error(`site build: no text "${key}" in i18n/en.json`);
  return s;
}

/** `{n} widgets` and friends: the `<key>-<form>` text the language's plural rules ask for (`-few` in Polish…), else `<key>-other`. */
export function plural(texts, lang, key, n) {
  const form = new Intl.PluralRules(lang).select(n);
  const s = texts[lang]?.[`${key}-${form}`] ?? (form === 'one' ? text(texts, lang, `${key}-one`) : text(texts, lang, `${key}-other`));
  return s.replaceAll('{n}', new Intl.NumberFormat(lang).format(n));
}

/**
 * On the English page only: a first visit goes on to the visitor's language if the site has it,
 * before anything is painted. Once they pick one in the menu, that one is kept.
 */
function redirect() {
  const paths = Object.fromEntries(LANGS.map((l) => [l.id, l.path]));
  // The same rule as pickLocale: the same language and writing (zh-TW reads zh-Hant, never zh-Hans).
  return `  <script>
    (function () {
      if (/[?&]card\\b/.test(location.search)) return;
      var paths = ${JSON.stringify(paths)}, go = null;
      try { go = localStorage.getItem(${JSON.stringify(LANG_KEY)}); } catch (e) {}
      // A choice made before the cookie existed: the edge (worker/choose.ts) only sees cookies.
      if (go && !/(^|; )kiosko_lang=/.test(document.cookie)) document.cookie = 'kiosko_lang=' + encodeURIComponent(go) + '; Path=/; Max-Age=31536000; SameSite=Lax; Secure';
      function key(tag) {
        try {
          var l = new Intl.Locale(String(tag).replace(/_/g, '-').replace(/[.@].*$/, '')).maximize();
          var lang = { yue: 'zh', cmn: 'zh', iw: 'he', no: 'nb' }[l.language] || l.language;
          return lang + '-' + l.script;
        } catch (e) { return null; }
      }
      if (!go) {
        var ids = Object.keys(paths), keys = ids.map(key);
        var tags = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || 'en'];
        for (var i = 0; i < tags.length && !go; i++) {
          var k = key(tags[i]);
          for (var j = 0; j < ids.length && !go; j++) if (k && k === keys[j]) go = ids[j];
        }
      }
      if (go && paths[go]) {
        window.kioskoLeaving = true;
        location.replace(paths[go] + location.search + location.hash);
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
  const root = lang.path ? '../'.repeat(lang.path.split('/').filter(Boolean).length) : '';
  const url = (l) => `${SITE}${l.path}`;
  // Only what the page's script says, as data the script reads.
  const scriptTexts = Object.fromEntries(Object.keys(texts.en).filter((k) => k.startsWith('js-')).map((k) => [k, text(texts, langId, k)]));
  const all = {
    ...fill,
    CSS: root + fill.CSS,
    JS: root + fill.JS,
    POSTER: root + fill.POSTER[langId],
    ...docsFor(lang.id, root),
    LANG: lang.id,
    DIR: lang.dir,
    PATH: lang.path,
    PANEL_LOCALE: lang.panel,
    ROOT: root,
    HOME: root || './',
    URL: url(lang),
    OG_LOCALE: lang.ogLocale,
    OG_ALTERNATES: LANGS.filter((l) => l !== lang).map((l) => `  <meta property="og:locale:alternate" content="${l.ogLocale}" />`).join('\n'),
    ALTERNATES: LANGS.flatMap((l) => l.hreflang.map((h) => `  <link rel="alternate" hreflang="${h}" href="${url(l)}" />`)).join('\n'),
    LANG_NAME: esc(lang.name),
    LANG_MENU: LANGS.map((l) => `<li><a href="${root}${l.path || './'}" hreflang="${l.id}" lang="${l.id}" data-lang="${l.id}"${l === lang ? ' aria-current="page"' : ''}>${esc(l.name)}</a></li>`).join(''),
    REDIRECT: lang.path ? '' : redirect(),
    JS_TEXTS: `<script type="application/json" id="kiosko-texts">${JSON.stringify(scriptTexts).replace(/</g, '\\u003c')}</script>`,
  };
  // What differs by language (the plugins it offers, how many) comes as a function of it.
  for (const [k, v] of Object.entries(all)) if (typeof v === 'function') all[k] = v(langId, root);
  const words = template.replace(/\{\{([ta]):([a-z0-9-]+)\}\}/g, (_, kind, key) => (kind === 'a' ? plain(text(texts, langId, key)) : text(texts, langId, key)));
  return words.replace(/\{\{(\w+)\}\}/g, (whole, key) => {
    if (!(key in all)) throw new Error(`site build: index.html asks for ${whole}, which nothing fills`);
    return all[key];
  });
}

/**
 * sitemap.xml: the front page in every language, each listing the others; and `more` pages
 * (the store's: `{ path: 'store/weather/', langs }`) in the languages each is offered in.
 */
export function sitemap(more = []) {
  const page = (path, langs) => {
    const alternates = langs.flatMap((l) => l.hreflang.map((h) => `    <xhtml:link rel="alternate" hreflang="${h}" href="${SITE}${l.path}${path}"/>`)).join('\n');
    return langs.map((l) => `  <url>\n    <loc>${SITE}${l.path}${path}</loc>\n${alternates}\n  </url>`);
  };
  const urls = [...page('', LANGS), ...more.flatMap((m) => page(m.path, m.langs))].join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls}\n</urlset>\n`;
}

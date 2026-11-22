// The plugin store on the site (https://kioskolcd.dev/store/), from the catalogue the index builder
// wrote (store/v1/index.json, scripts/store/build-index.ts): in every language, like the front page.
//
//   /store/              a panel showing real widgets, a few picked plugins, then every plugin with
//                        search, categories and filters (store.ts filters on the page itself)
//   /store/<id>/         one plugin: its pictures on a panel, what it does on your computer, its versions
//   /es/store/…          the same in each language (`hreflang` between them)
//
// Plain HTML first: every card and every fact is in the page (search engines, no JavaScript); the
// script only filters and sorts what is already there, switches the pictures and copies the command.
// No cookies, no analytics, nothing from another site: the pictures come from the gallery or from
// store/v1/img/, the icons are Lucide's (ISC), drawn into the page when it is built.
//
// The cards, the plugin page and their look are the store's parts (../store-kit/), the same ones the
// editor's store shows: this file only adds the site around them (the top bar, the hero, the filters).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LANGS, SITE, esc, plural, text } from './pages.mjs';
import { CLASSES, FEATURED, OS, card, categoryChip, feature, featuredIn, icon, installCommand, languageName, offeredIn, option, pageRegion, pluginPage } from '../store-kit/render.ts';

export { FEATURED, offeredIn };

/** Where "Open in Kiosko" goes: the editor of the Kiosko on this computer, at the plugin's page. Never an install. */
export const OPEN_IN_KIOSKO = 'http://127.0.0.1:7420/#/plugins/store/';

const date = (iso, lang) => (iso ? new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(iso)) : '');
const number = (n, lang) => new Intl.NumberFormat(lang).format(n);

/** The store's parts (store-kit/render.ts) as this page shows them: its language, its paths, its region. */
function kitFor({ index, texts, lang, root, presets, list }) {
  return { lang, texts, index, root, presets, region: pageRegion(lang), list, page: (id) => `${list}${id}/`, category: (id) => `${list}?cat=${encodeURIComponent(id)}#plugins` };
}

/** The top of every store page: the same bar as the front page, with this page in each language. */
export function pageHead(o) {
  const { lang, texts, title, description, path, root, css } = o;
  const l = LANGS.find((x) => x.id === lang);
  const langs = o.langs ?? LANGS;
  const url = (x) => `${SITE}${x.path}${path}`;
  return `<!doctype html>
<html lang="${l.id}" dir="${l.dir}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}" />
  <meta name="theme-color" content="#05060a" />
  <link rel="canonical" href="${url(l)}" />
${langs.flatMap((x) => x.hreflang.map((h) => `  <link rel="alternate" hreflang="${h}" href="${url(x)}" />`)).join('\n')}
  <meta property="og:title" content="${esc(title)}" />
  <meta property="og:site_name" content="Kiosko" />
  <meta property="og:description" content="${esc(description)}" />
  <meta property="og:type" content="website" />
  <meta property="og:url" content="${url(l)}" />
  <meta property="og:locale" content="${l.ogLocale}" />
  <meta property="og:image" content="${SITE}card.jpg" />
  <link rel="icon" href="${root}demo/icon.svg" type="image/svg+xml" />
  <link rel="stylesheet" href="${root}${css}" />
  <script>document.documentElement.classList.add('js')</script>
</head>
<body class="store">
  <nav class="top" aria-label="Kiosko">
    <a class="brand" href="${`${root}${l.path}` || './'}"><img src="${root}demo/icon.svg" alt="" width="26" height="26" />Kiosko</a>
    <span class="links">
      <a href="${root}${l.path}store/" aria-current="${path === 'store/' ? 'page' : 'false'}">${esc(text(texts, lang, 'store-nav'))}</a>
      <a href="${root}demo/?lang=${l.panel}">${esc(text(texts, lang, 'editor'))}</a>
      <a href="https://github.com/kiosko-lcd/kiosko">GitHub</a>
      <details class="lang">
        <summary aria-label="${esc(text(texts, lang, 'nav-language'))}">${esc(l.name)}</summary>
        <ul>${langs.map((x) => `<li><a href="${root}${x.path}${path}" hreflang="${x.id}" lang="${x.id}"${x === l ? ' aria-current="page"' : ''}>${esc(x.name)}</a></li>`).join('')}</ul>
      </details>
    </span>
  </nav>`;
}

const tail = (o) => `
  <script type="application/json" id="store-texts">${JSON.stringify(o.scriptTexts).replace(/</g, '\\u003c')}</script>
  <script type="module" src="${o.root}${o.js}"></script>
</body>
</html>
`;

/** The texts the page's script needs (counts, the copy button), in its language. */
function scriptTexts(texts, lang) {
  return {
    lang,
    'store-shown-one': text(texts, lang, 'store-shown-one'),
    'store-shown-other': text(texts, lang, 'store-shown-other'),
    'store-copied': text(texts, lang, 'store-copied'),
    ...Object.fromEntries(['zero', 'two', 'few', 'many'].map((f) => [`store-shown-${f}`, texts[lang]?.[`store-shown-${f}`]]).filter(([, v]) => v)),
  };
}

/** A sample page of the panel, as the gallery painted it in each language: `{ file: { en, es… }, width, height }`. */
function heroPanel(pages, lang, root, alt) {
  const shown = (pages ?? []).filter((p) => p.file?.[lang] ?? p.file?.en).slice(0, 3);
  if (!shown.length) return '';
  const imgs = shown.map((p, i) => `<img src="${root}gallery/${esc(p.file[lang] ?? p.file.en)}" width="${p.width ?? 1920}" height="${p.height ?? 462}" alt="${i === 0 ? esc(alt) : ''}"${i ? ' loading="lazy"' : ' fetchpriority="high"'} decoding="async" />`).join('');
  return `<div class="hero-panel${shown.length === 3 ? ' turns' : ''}"><div class="ks-slab"><div class="ks-glass">${imgs}</div></div></div>`;
}

/** The list page in `lang`. `pages` are the gallery's sample pages, for the panel at the top. */
export function storeListPage({ index, texts, lang, css, js, presets, pages = [] }) {
  const l = LANGS.find((x) => x.id === lang);
  const root = '../'.repeat(`${l.path}store/`.split('/').filter(Boolean).length);
  const plugins = offeredIn(index, lang);
  const t = (k) => esc(text(texts, lang, k));
  const categories = (index.categories ?? []).filter((c) => plugins.some((p) => p.categories.includes(c.id)));
  const tags = [...new Set(plugins.flatMap((p) => p.tags))].sort((a, b) => a.localeCompare(b));
  const languages = [...new Set(plugins.flatMap((p) => p.languages))].sort((a, b) => (a === 'en' ? -1 : b === 'en' ? 1 : a.localeCompare(b)));
  const usedPresets = presets.filter((x) => plugins.some((p) => p.widgets.some((w) => w.presets?.includes(x.id))));
  const licenses = ['permissive', 'copyleft', 'other'].filter((k) => plugins.some((p) => (p.licenseKind ?? 'other') === k));
  const region = pageRegion(lang);
  const k = kitFor({ index, texts, lang, root, presets, list: '' });
  const filters = `<form id="store-filters" class="filters" role="search" onsubmit="return false">
        <div class="ks-search-row">${icon('search', 18)}<input class="search" type="search" name="q" placeholder="${t('store-search')}" aria-label="${t('store-search')}" /></div>
        <fieldset class="ks-chips"><legend class="sr">${t('store-category')}</legend>${categoryChip(k, '', true, 'radio')}${categories.map((c) => categoryChip(k, c.id, false, 'radio')).join('')}</fieldset>
        <details class="more" open><summary>${icon('sliders-horizontal', 15)}${t('store-filters')}</summary><div class="more-body">
        <label>${t('store-panel')} <select name="panel">${option('', text(texts, lang, 'store-all'))}${CLASSES.map((c) => option(`class:${c}`, text(texts, lang, `store-class-${c}`))).join('')}<optgroup label="${t('store-models')}">${usedPresets.map((x) => option(`preset:${x.id}`, `${x.name} (${x.width}×${x.height})`)).join('')}</optgroup></select></label>
        <label>${t('store-orientation')} <select name="orient">${option('', text(texts, lang, 'store-all'))}${option('h', text(texts, lang, 'store-horizontal'))}${option('v', text(texts, lang, 'store-vertical'))}</select></label>
        <label>${t('store-system')} <select name="os">${option('', text(texts, lang, 'store-all'))}${Object.entries(OS).map(([k, v]) => option(k, v)).join('')}</select></label>
        <label>${t('store-language')} <select name="lang">${option('', text(texts, lang, 'store-all'))}${languages.map((x) => option(x, languageName(x, lang), false)).join('')}</select></label>
        <label>${t('store-license')} <select name="license">${option('', text(texts, lang, 'store-all'))}${licenses.map((k) => option(k, text(texts, lang, `store-license-${k}`))).join('')}</select></label>
        <label>${t('store-tier')} <select name="tier">${option('', text(texts, lang, 'store-all'))}${option('official', text(texts, lang, 'store-official'))}${option('found', text(texts, lang, 'store-unreviewed'))}</select></label>
        ${tags.length ? `<label>${t('store-tag')} <select name="tag">${option('', text(texts, lang, 'store-all'))}${tags.map((x) => option(x, x)).join('')}</select></label>` : ''}
        ${region ? `<label class="check"><input type="checkbox" name="region" checked /> ${t('store-region')}</label>` : ''}
        </div></details>
      </form>
      <div class="results-bar">
        <p class="count" aria-live="polite">${esc(plural(texts, lang, 'store-shown', plugins.length))}</p>
        <button type="button" class="button small clear" hidden>${icon('x', 14)}${t('store-clear')}</button>
        <label class="sort">${t('store-sort')} <select name="sort" form="store-filters">${option('featured', text(texts, lang, 'store-sort-featured'))}${option('recent', text(texts, lang, 'store-sort-recent'))}${option('name', text(texts, lang, 'store-sort-name'))}</select></label>
      </div>`;
  const updated = text(texts, lang, 'store-updated').replace('{date}', date(index.generatedAt, lang));
  const dataLink = text(texts, lang, 'store-index-link').replace('{url}', `<a href="${root}store/v1/index.json">store/v1/index.json</a>`).replace('{schema}', `<a href="${root}store/v1/schema/index.json">JSON Schema</a>`);
  const title = text(texts, lang, 'store-title');
  const featured = featuredIn(plugins);
  const widgets = plugins.reduce((n, p) => n + p.widgets.length, 0);
  const stat = (n, k) => `<li><b>${esc(number(n, lang))}</b><span>${t(k)}</span></li>`;
  const docs = 'https://github.com/kiosko-lcd/kiosko/blob/main/docs/plugins.md';
  return `${pageHead({ lang, texts, title, description: text(texts, lang, 'store-meta-description'), path: 'store/', root, css })}
  <main class="store-main">
    <header class="hero">
      <div class="hero-copy">
        <p class="kicker">${t('store-nav')}</p>
        <h1>${t('store-hero-title')} <em>${t('store-hero-em')}</em></h1>
        <p class="lede">${text(texts, lang, 'store-lede')}</p>
        <ul class="stats">${stat(plugins.length, 'store-stat-plugins')}${stat(widgets, 'store-stat-widgets')}${stat(LANGS.length, 'store-stat-languages')}<li class="free"><b>${t('store-free')}</b><span>${t('store-stat-free')}</span></li></ul>
        <p class="cta"><a class="button primary" href="#plugins">${t('store-browse')}${icon('arrow-down', 16)}</a><a class="button" href="${docs}">${icon('code-xml', 16)}${t('store-write-cta')}</a></p>
      </div>
      ${heroPanel(pages, lang, root, text(texts, lang, 'store-hero-alt'))}
    </header>
    ${featured.length ? `<section class="featured" aria-labelledby="featured-h">
      <h2 id="featured-h">${t('store-featured')}</h2>
      <div class="ks-features">
        ${featured.map((p) => feature(p, k)).join('\n        ')}
      </div>
    </section>` : ''}
    <section id="plugins" class="browse" aria-labelledby="all-h">
      <h2 id="all-h">${t('store-all-plugins')}</h2>
      ${filters}
      <p class="ks-empty" hidden>${icon('search-x', 28)}<span>${t('store-none')}</span> <button type="button" class="ks-button">${t('store-clear')}</button></p>
      <div class="ks-cards">
        ${plugins.map((p) => card(p, k)).join('\n        ')}
      </div>
    </section>
    <footer class="store-foot">
      <div class="yours">${icon('package-plus', 28)}<p>${text(texts, lang, 'store-write-yours')}</p><a class="button" href="${docs}">docs/plugins.md</a></div>
      <p class="fine"><a href="${root}gallery/${l.path}">${t('every-widget-full-size')}</a> · ${dataLink} ${esc(updated)}.</p>
    </footer>
  </main>${tail({ root, js, scriptTexts: scriptTexts(texts, lang) })}`;
}

/** One plugin's page in `lang`: the store's page of it (store-kit), with "Open in Kiosko" and the command. */
export function storePluginPage({ index, detail, plugin: p, texts, lang, css, js, presets }) {
  const l = LANGS.find((x) => x.id === lang);
  const path = `store/${p.id}/`;
  const root = '../'.repeat(`${l.path}${path}`.split('/').filter(Boolean).length);
  const t = (k) => esc(text(texts, lang, k));
  const k = kitFor({ index, texts, lang, root, presets, list: '../' });
  const name = p.name[lang] ?? p.name.en;
  const description = p.description?.[lang] ?? p.description?.en ?? text(texts, lang, 'store-meta-description');
  const offered = LANGS.filter((x) => offeredIn(index, x.id).some((y) => y.id === p.id));
  const action = `<a class="ks-button primary big" href="${OPEN_IN_KIOSKO}${esc(encodeURIComponent(p.id))}">${icon('monitor-play', 18)}${t('store-open')}</a>
        <p class="ks-fine">${t('store-open-hint')}</p>
        ${installCommand(p, k)}`;
  return `${pageHead({ lang, texts, title: `${name} · ${text(texts, lang, 'store-title')}`, description, path, root, css, langs: offered })}
  <main class="store-main">
    ${pluginPage(p, detail, k, { action })}
  </main>${tail({ root, js, scriptTexts: scriptTexts(texts, lang) })}`;
}

/**
 * Writes /store/ and /store/<id>/ in every language under `out`, and returns the pages for the
 * sitemap: `{ path, langs }` (each page lists the languages it is offered in). `pages` are the
 * gallery's sample pages (gallery.json), shown on a panel at the top of the list.
 */
export function buildStorePages({ out, index, details, texts, css, js, presets, pages = [] }) {
  const sitemapPages = [{ path: 'store/', langs: LANGS }];
  for (const l of LANGS) {
    mkdirSync(join(out, l.path, 'store'), { recursive: true });
    writeFileSync(join(out, l.path, 'store/index.html'), storeListPage({ index, texts, lang: l.id, css, js, presets, pages }));
  }
  for (const p of index.plugins.filter((x) => !x.hidden)) {
    const langs = LANGS.filter((l) => offeredIn(index, l.id).some((x) => x.id === p.id));
    sitemapPages.push({ path: `store/${p.id}/`, langs });
    for (const l of langs) {
      mkdirSync(join(out, l.path, 'store', p.id), { recursive: true });
      writeFileSync(join(out, l.path, 'store', p.id, 'index.html'), storePluginPage({ index, detail: details[p.id], plugin: p, texts, lang: l.id, css, js, presets }));
    }
  }
  return sitemapPages;
}

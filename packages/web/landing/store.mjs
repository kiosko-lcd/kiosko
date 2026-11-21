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
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { icons } from 'lucide';
import { LANGS, SITE, esc, plural, text } from './pages.mjs';
import { languageById } from '../../sdk/src/languages.ts';

/** Where "Open in Kiosko" goes: the editor of the Kiosko on this computer, at the plugin's page. Never an install. */
export const OPEN_IN_KIOSKO = 'http://127.0.0.1:7420/#/plugins/store/';

const CLASSES = ['bar', 'landscape', 'square', 'round', 'portrait'];
const OS = { linux: 'Linux', darwin: 'macOS', win32: 'Windows' };

/**
 * The plugins the list page puts first, in this order (the first three offered in a language):
 * an editorial choice of what shows best what Kiosko does, not a ranking. Nothing about them is made up.
 */
export const FEATURED = ['agents', 'cats', 'homeassistant', 'doom', 'gpu'];

/** Each category's drawing and colour (the glow behind its panels). */
const CATEGORY = {
  agents: ['bot', '#8b7bff'],
  system: ['cpu', '#22d3ee'],
  time: ['calendar', '#fbbf24'],
  productivity: ['list-checks', '#34d399'],
  dev: ['code-xml', '#4ade80'],
  info: ['newspaper', '#60a5fa'],
  media: ['clapperboard', '#f472b6'],
  scene: ['sparkles', '#fb923c'],
  fun: ['party-popper', '#e879f9'],
};
const tint = (p) => CATEGORY[p.categories[0]]?.[1] ?? '#8b7bff';

/** Names Lucide no longer draws (brands), and what to draw instead. */
const ICON_ALIAS = { github: 'git-pull-request', gitlab: 'git-merge' };
const pascal = (s) => s.replace(/(^|[-_ ])(\w)/g, (_m, _a, c) => c.toUpperCase());

/** A Lucide icon as inline SVG (a plugin's own SVG is not drawn: it would be its HTML in our page). */
export function icon(name, size = 18, cls = '') {
  const n = ICON_ALIAS[name] ?? name ?? 'puzzle';
  const node = icons[pascal(n)] ?? icons.Puzzle;
  const parts = node.map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).map(([k, v]) => `${k}="${esc(v)}"`).join(' ')}/>`).join('');
  return `<svg class="ic${cls ? ` ${cls}` : ''}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${parts}</svg>`;
}

/** A plugin's own drawing (from its manifest), else one for what it brings. */
const pluginIcon = (p) => (p.icon && !p.icon.trim().startsWith('<') ? p.icon : p.interludes.length && !p.widgets.length ? 'clapperboard' : CATEGORY[p.categories[0]]?.[0] ?? 'puzzle');
const appIcon = (p, size = 20, cls = '') => `<span class="app-icon${cls ? ` ${cls}` : ''}">${icon(pluginIcon(p), size)}</span>`;

/** The plugins the store offers in `lang`: not hidden ones, nor those whose service is missing where it is read (languages.ts). */
export function offeredIn(index, lang) {
  const without = languageById(lang)?.plugins?.without ?? [];
  return index.plugins.filter((p) => !p.hidden && !without.includes(p.id));
}

/** A text of the index in `lang`, else English. */
const say = (t, lang) => (t ? (t[lang] ?? t.en ?? '') : '');

/** A small drawing of each panel class (a bar, a square, a circle…), with its name. */
function classIcon(c, texts, lang) {
  const shape = {
    bar: '<rect x="1" y="6" width="22" height="6" rx="1"/>',
    landscape: '<rect x="3" y="4" width="18" height="10" rx="1"/>',
    square: '<rect x="5" y="2" width="14" height="14" rx="1"/>',
    round: '<circle cx="12" cy="9" r="7"/>',
    portrait: '<rect x="8" y="1" width="8" height="16" rx="1"/>',
  }[c];
  const name = esc(text(texts, lang, `store-class-${c}`));
  return `<svg class="cls" viewBox="0 0 24 18" width="22" height="16" role="img" aria-label="${name}"><title>${name}</title>${shape}</svg>`;
}

/** Every class any of its widgets fits (interludes and templates-only plugins fit every one). */
const classesOf = (p) => (p.widgets.length ? CLASSES.filter((c) => p.widgets.some((w) => (w.fits ?? CLASSES).includes(c))) : CLASSES);

/** The picture that shows a plugin best: its widest widget's (the panels are wide), else its cover or an interlude's poster. */
function bestPicture(p, lang) {
  const withShots = p.widgets.filter((x) => x.shots);
  const w = withShots.find((x) => x.shotSize && x.shotSize.w / x.shotSize.h >= 2.4) ?? withShots[0];
  if (w) return { src: w.shots[lang] ?? w.shots.en, size: w.shotSize };
  const cover = p.cover ?? p.interludes.find((i) => i.poster)?.poster;
  return cover ? { src: cover } : null;
}

/** A plugin's picture on a small screen; without one, a screen with its drawing and name. */
function screen(p, lang, root, alt = '') {
  const pic = bestPicture(p, lang);
  // With its size known, the screen has its shape before the picture arrives (no jump, and a lazy picture has a box to be seen in).
  if (pic?.size) return `<span class="bezel sized" style="--ar:${+(pic.size.w / pic.size.h).toFixed(4)}"><img src="${root}${esc(pic.src)}" alt="${esc(alt)}" loading="lazy" decoding="async" width="${pic.size.w}" height="${pic.size.h}" /></span>`;
  if (pic) return `<span class="bezel"><img src="${root}${esc(pic.src)}" alt="${esc(alt)}" decoding="async" /></span>`;
  return `<span class="bezel"><span class="poster">${icon(pluginIcon(p), 40)}<b>${esc(say(p.name, lang))}</b></span></span>`;
}

function tierBadge(p, texts, lang) {
  if (p.tier === 'official') return `<span class="badge official">${icon('badge-check', 13)}${esc(text(texts, lang, 'store-official'))}</span>`;
  if (p.tier === 'found') return `<span class="badge unreviewed">${icon('triangle-alert', 13)}${esc(text(texts, lang, 'store-unreviewed'))}</span>`;
  return '';
}

const regionName = (code, lang) => {
  try {
    return new Intl.DisplayNames([lang], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
};
const languageName = (tag, lang) => {
  const own = languageById(tag);
  if (own) return own.name;
  try {
    return new Intl.DisplayNames([lang], { type: 'language' }).of(tag) ?? tag;
  } catch {
    return tag;
  }
};
const list = (items, lang) => new Intl.ListFormat(lang, { type: 'conjunction' }).format(items);
const date = (iso, lang) => (iso ? new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(iso)) : '');
const number = (n, lang) => new Intl.NumberFormat(lang).format(n);

/** The region a page is read in, from its language alone (no setting, nothing asked): zh-Hant → TW, zh-Hans → CN. */
function pageRegion(lang) {
  if (!lang.startsWith('zh')) return null;
  try {
    return new Intl.Locale(lang).maximize().region ?? null;
  } catch {
    return null;
  }
}

function market(p, lang) {
  const r = pageRegion(lang);
  if (!r || !p.markets?.only?.length) return 'ok';
  return p.markets.only.includes(r) ? 'ok' : 'elsewhere';
}

const categoryName = (index, id, lang) => say((index.categories ?? []).find((c) => c.id === id)?.label, lang) || id;

/** One plugin's card: its widget on a small screen, its drawing, name and what it is for. `href` leads to its page. */
function card(p, index, texts, lang, root, href = `${p.id}/`) {
  const classes = classesOf(p);
  const presets = [...new Set(p.widgets.flatMap((w) => w.presets ?? []))];
  const searchText = [p.id, p.package, ...Object.values(p.name), ...Object.values(p.description ?? {}), ...p.tags, ...p.widgets.flatMap((w) => Object.values(w.name)), ...p.interludes.flatMap((i) => Object.values(i.name))].join(' ').toLowerCase();
  const data = {
    id: p.id,
    cats: p.categories.join(' '),
    tags: p.tags.join(' '),
    langs: p.languages.join(' '),
    classes: (p.widgets.length ? classes : ['any']).join(' '),
    presets: presets.join(' '),
    os: p.platforms.join(' '),
    license: p.licenseKind ?? 'other',
    tier: p.tier,
    market: market(p, lang),
    date: p.releases[0]?.date ?? '',
    name: say(p.name, lang).toLowerCase(),
    search: searchText,
  };
  const attrs = Object.entries(data).map(([k, v]) => `data-${k}="${esc(v)}"`).join(' ');
  const weekly = p.popularity?.weekly ? `<span title="${esc(text(texts, lang, 'store-downloads-hint'))}">${icon('download', 12)}${esc(text(texts, lang, 'store-downloads').replace('{n}', number(p.popularity.weekly, lang)))}</span>` : '';
  const only = p.markets?.only?.length ? `<p class="market">${icon('map-pin', 13)}${esc(text(texts, lang, 'store-only-in').replace('{regions}', list(p.markets.only.map((c) => regionName(c, lang)), lang)))}</p>` : '';
  const cat = p.categories[0] ? `<p class="cat">${esc(categoryName(index, p.categories[0], lang))}</p>` : '';
  return `<article class="card ${p.tier}" style="--tint:${tint(p)}" ${attrs}>
          <a class="card-link" href="${esc(href)}">
            <span class="screen">${screen(p, lang, root)}</span>
            <span class="about">
              <span class="title">${appIcon(p)}<span class="names"><h3>${esc(say(p.name, lang))}</h3>${cat}</span>${tierBadge(p, texts, lang)}</span>
              <p class="desc">${esc(say(p.description, lang))}</p>
              ${only}
              <p class="meta"><span class="classes" title="${esc(text(texts, lang, 'store-fits-on'))}">${classes.map((c) => classIcon(c, texts, lang)).join('')}</span><span>${esc(plural(texts, lang, 'store-languages', p.languages.length))}</span><span>${esc(p.license || '—')}</span>${weekly}</p>
            </span>
          </a>
        </article>`;
}

/** A picked plugin: a big panel with its widget, and what it is. */
function feature(p, index, texts, lang, root) {
  const cat = p.categories[0] ? esc(categoryName(index, p.categories[0], lang)) : '';
  return `<a class="feature" href="${esc(p.id)}/" style="--tint:${tint(p)}">
          <span class="stage">${screen(p, lang, root)}</span>
          <span class="feature-text">
            ${appIcon(p, 22, 'big')}
            <span class="names"><span class="cat">${cat}</span><b>${esc(say(p.name, lang))}</b><span class="desc">${esc(say(p.description, lang))}</span></span>
            <span class="go" aria-hidden="true">${icon('arrow-right', 18)}</span>
          </span>
        </a>`;
}

/** The top of every store page: the same bar as the front page, with this page in each language. */
function head(o) {
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

function option(value, label, selected = false) {
  return `<option value="${esc(value)}"${selected ? ' selected' : ''}>${esc(label)}</option>`;
}

/** A sample page of the panel, as the gallery painted it in each language: `{ file: { en, es… }, width, height }`. */
function heroPanel(pages, lang, root, alt) {
  const shown = (pages ?? []).filter((p) => p.file?.[lang] ?? p.file?.en).slice(0, 3);
  if (!shown.length) return '';
  const imgs = shown.map((p, i) => `<img src="${root}gallery/${esc(p.file[lang] ?? p.file.en)}" width="${p.width ?? 1920}" height="${p.height ?? 462}" alt="${i === 0 ? esc(alt) : ''}"${i ? ' loading="lazy"' : ' fetchpriority="high"'} decoding="async" />`).join('');
  return `<div class="hero-panel${shown.length === 3 ? ' turns' : ''}"><div class="slab"><div class="glass">${imgs}</div></div></div>`;
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
  const chip = (value, label, ico, checked = false) => `<label class="chip"><input type="radio" name="cat" value="${esc(value)}"${checked ? ' checked' : ''} /><span>${icon(ico, 15)}${esc(label)}</span></label>`;
  const filters = `<form id="store-filters" class="filters" role="search" onsubmit="return false">
        <div class="search-row">${icon('search', 18)}<input class="search" type="search" name="q" placeholder="${t('store-search')}" aria-label="${t('store-search')}" /></div>
        <fieldset class="chips"><legend class="sr">${t('store-category')}</legend>${chip('', text(texts, lang, 'store-all'), 'layout-grid', true)}${categories.map((c) => chip(c.id, say(c.label, lang), CATEGORY[c.id]?.[0] ?? 'tag')).join('')}</fieldset>
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
  const featured = FEATURED.map((id) => plugins.find((p) => p.id === id)).filter(Boolean).slice(0, 3);
  const widgets = plugins.reduce((n, p) => n + p.widgets.length, 0);
  const stat = (n, k) => `<li><b>${esc(number(n, lang))}</b><span>${t(k)}</span></li>`;
  const docs = 'https://github.com/kiosko-lcd/kiosko/blob/main/docs/plugins.md';
  return `${head({ lang, texts, title, description: text(texts, lang, 'store-meta-description'), path: 'store/', root, css })}
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
      <div class="features">
        ${featured.map((p) => feature(p, index, texts, lang, root)).join('\n        ')}
      </div>
    </section>` : ''}
    <section id="plugins" class="browse" aria-labelledby="all-h">
      <h2 id="all-h">${t('store-all-plugins')}</h2>
      ${filters}
      <p class="empty" hidden>${icon('search-x', 28)}<span>${t('store-none')}</span> <button type="button" class="button">${t('store-clear')}</button></p>
      <div class="cards">
        ${plugins.map((p) => card(p, index, texts, lang, root)).join('\n        ')}
      </div>
    </section>
    <footer class="store-foot">
      <div class="yours">${icon('package-plus', 28)}<p>${text(texts, lang, 'store-write-yours')}</p><a class="button" href="${docs}">docs/plugins.md</a></div>
      <p class="fine">${dataLink} ${esc(updated)}.</p>
    </footer>
  </main>${tail({ root, js, scriptTexts: scriptTexts(texts, lang) })}`;
}

const PERMS = [
  ['network', 'globe'],
  ['exec', 'square-terminal'],
  ['files', 'folder-open'],
  ['devices', 'usb'],
];

/** One plugin's page in `lang`. */
export function storePluginPage({ index, detail, plugin: p, texts, lang, css, js, presets }) {
  const l = LANGS.find((x) => x.id === lang);
  const path = `store/${p.id}/`;
  const root = '../'.repeat(`${l.path}${path}`.split('/').filter(Boolean).length);
  const t = (k) => esc(text(texts, lang, k));
  const name = say(p.name, lang);
  const offered = LANGS.filter((x) => offeredIn(index, x.id).some((y) => y.id === p.id));
  const what = (v) => (v === 'user' ? text(texts, lang, 'store-perm-user') : v === 'lan' ? text(texts, lang, 'store-perm-lan') : v);
  const perms = PERMS.filter(([k]) => p.permissions[k]?.length);
  const risky = detail?.riskyOptions ?? [];
  const latest = p.releases[0];
  const shotLangs = [...new Set(p.widgets.flatMap((w) => Object.keys(w.shots ?? {})))];
  const presetName = (id) => presets.find((x) => x.id === id)?.name ?? id;
  const notes = [
    p.tier === 'found' ? `<p class="note unreviewed">${icon('triangle-alert', 16)}<span><b>${t('store-unreviewed')}.</b> ${t('store-unreviewed-note')}</span></p>` : '',
    p.markets?.only?.length ? `<p class="note">${icon('map-pin', 16)}<span>${esc(text(texts, lang, 'store-only-in').replace('{regions}', list(p.markets.only.map((c) => regionName(c, lang)), lang)))}${p.markets.note ? `: ${esc(say(p.markets.note, lang))}` : ''}</span></p>` : '',
    p.markets?.without?.length ? `<p class="note">${icon('map-pin-off', 16)}<span>${esc(text(texts, lang, 'store-not-here').replace('{regions}', list(p.markets.without.map((c) => regionName(c, lang)), lang)))}</span></p>` : '',
    p.health.manifest === 'missing' ? `<p class="note">${icon('info', 16)}<span>${t('store-no-manifest')}</span></p>` : '',
  ].join('');
  const size = (s) => (s ? `${s.w}×${s.h}` : '—');
  const withShots = p.widgets.filter((w) => w.shots);
  const shotsJson = (w) => esc(JSON.stringify(Object.fromEntries(Object.entries(w.shots).map(([k, v]) => [k, root + v]))));
  const img = (w, alt, extra = '') => `<img src="${root}${esc(w.shots[lang] ?? w.shots.en)}" data-shots="${shotsJson(w)}" alt="${esc(alt)}" decoding="async"${w.shotSize ? ` width="${w.shotSize.w}" height="${w.shotSize.h}"` : ''}${extra} />`;
  const cover = !withShots.length && (p.cover ?? p.interludes.find((i) => i.poster)?.poster);
  // The pictures: one big panel and, with a script, the others as thumbnails that bring theirs onto it (without one, all of them, one under the other).
  const stage = withShots.length
    ? `<div class="stage-panel"><div class="slab">${withShots.map((w, i) => `<figure class="${i === 0 ? 'on' : ''}" id="shot-${i}"><div class="glass">${img(w, say(w.name, lang))}</div><figcaption><b>${esc(say(w.name, lang))}</b> <span>${esc(say(w.description, lang))}</span></figcaption></figure>`).join('')}</div></div>
      ${withShots.length > 1 ? `<div class="thumbs">${withShots.map((w, i) => `<button type="button" data-shot="${i}" aria-controls="shot-${i}" aria-pressed="${i === 0}"><span class="thumb">${img(w, '', ' loading="lazy"')}</span><span>${esc(say(w.name, lang))}</span></button>`).join('')}</div>` : ''}`
    : cover
      ? `<div class="stage-panel"><div class="slab"><figure class="on"><div class="glass"><img src="${root}${esc(cover)}" alt="${esc(name)}" decoding="async" /></div></figure></div></div>`
      : '';
  const shots = stage
    ? `<section class="shots" aria-labelledby="shots-h"><div class="shots-head"><h2 id="shots-h">${t('store-pictures')}</h2>${shotLangs.length > 1 ? `<label>${icon('languages', 15)}${t('store-shots-language')} <select class="shot-lang">${shotLangs.map((x) => option(x, languageName(x, lang), x === lang || (x === 'en' && !shotLangs.includes(lang)))).join('')}</select></label>` : ''}</div>${stage}</section>`
    : '';
  const widgets = p.widgets.length
    ? `<section><h2>${t('store-widgets')} <small>${p.widgets.length}</small></h2><ul class="widget-list">${p.widgets
        .map((w) => `<li>${w.shots ? `<span class="thumb">${img(w, '', ' loading="lazy"')}</span>` : `<span class="thumb none">${icon(w.icon ?? pluginIcon(p), 22)}</span>`}<div><b>${esc(say(w.name, lang))}</b><p class="muted">${esc(say(w.description, lang))}</p><p class="specs"><span class="spec"><span>${t('store-min')}</span> <span class="mono">${size(w.min)}</span></span><span class="spec"><span>${t('store-preferred')}</span> <span class="mono">${size(w.preferred)}</span></span><span class="classes" title="${t('store-fits-on')}">${(w.fits ?? []).map((c) => classIcon(c, texts, lang)).join('')}</span>${w.presets?.length ? `<span class="muted presets">${esc(list(w.presets.slice(0, 2).map(presetName), lang))}${w.presets.length > 2 ? ` +${w.presets.length - 2}` : ''}</span>` : ''}</p></div></li>`)
        .join('')}</ul></section>`
    : '';
  const interludes = p.interludes.length ? `<section><h2>${t('store-interludes')} <small>${p.interludes.length}</small></h2><ul class="widget-list">${p.interludes.map((i) => `<li>${(i.poster ?? (p.interludes.length === 1 && p.cover)) ? `<span class="thumb"><img src="${root}${esc(i.poster ?? p.cover)}" alt="" loading="lazy" decoding="async" /></span>` : `<span class="thumb none">${icon(i.icon ?? 'clapperboard', 22)}</span>`}<div><b>${esc(say(i.name, lang))}</b><p class="muted">${esc(say(i.description, lang))}</p></div></li>`).join('')}</ul></section>` : '';
  const templates = p.templates.length ? `<section><h2>${t('store-templates')}</h2><ul class="plain">${p.templates.map((x) => `<li>${icon('layout-template', 15)} ${esc(say(x.name, lang))}</li>`).join('')}</ul></section>` : '';
  const permsHtml = perms.length
    ? `<ul class="perms">${perms.map(([k, ico]) => `<li><span class="perm-ic">${icon(ico, 16)}</span><span><b>${t(`store-perm-${k}`)}</b> ${esc(list(p.permissions[k].map(what), lang))}</span></li>`).join('')}</ul>`
    : `<p class="perm-none">${icon('shield-check', 18)}<span>${t('store-perm-none')}</span></p>`;
  const riskyHtml = risky.length ? `<details class="risky"><summary>${icon('info', 15)}<span>${esc(plural(texts, lang, 'store-risky', risky.length))}</span></summary><ul class="mono small">${risky.map((r) => `<li>${esc(r.path)}</li>`).join('')}</ul></details>` : '';
  const pluginName = (id) => say(index.plugins.find((x) => x.id === id)?.name, lang) || id;
  const pluginLink = (id) => (index.plugins.some((x) => x.id === id && !x.hidden) ? `<a href="../${esc(id)}/">${esc(pluginName(id))}</a>` : esc(id));
  const facts = [
    [t('store-needs'), p.requires.length ? p.requires.map(pluginLink).join(', ') : t('store-requires-none')],
    p.optional.length ? [t('store-uses'), p.optional.map(pluginLink).join(', ')] : null,
    [t('store-works-on'), esc(list(p.platforms.map((x) => OS[x] ?? x), lang))],
    latest?.sdk ? [t('store-api'), `<code>${esc(latest.sdk)}</code>`] : null,
    [t('store-language'), esc(list(p.languages.map((x) => languageName(x, lang)), lang))],
    [t('store-license'), esc(p.license || '—')],
    p.publisher?.name ? [t('store-author'), esc(p.publisher.name)] : null,
  ].filter(Boolean);
  const versions = p.releases.slice(0, 8).map((r) => `<li><span class="mono">${esc(r.version)}</span> <span class="muted">${esc(date(r.date, lang))}</span>${r.deprecated ? ` <span class="badge" title="${esc(r.deprecated)}">${t('store-deprecated')}</span>` : ''}${r.withdrawn ? ` <span class="badge unreviewed">${t('store-withdrawn')}</span>` : ''}${r.addedPermissions ? ` <span class="badge">${t('store-more-permissions')}</span>` : ''}</li>`).join('');
  const links = [
    p.links.repository && `<a class="link-chip" href="${esc(p.links.repository)}" rel="noopener">${icon('code-xml', 15)}${t('store-source')}</a>`,
    p.links.issues && `<a class="link-chip" href="${esc(p.links.issues)}" rel="noopener">${icon('bug', 15)}${t('store-issues')}</a>`,
    p.links.discussions && `<a class="link-chip" href="${esc(p.links.discussions)}" rel="noopener">${icon('messages-square', 15)}${t('store-discussions')}</a>`,
    (p.links.docs ?? p.links.homepage) && `<a class="link-chip" href="${esc(p.links.docs ?? p.links.homepage)}" rel="noopener">${icon('book-open', 15)}${t('store-docs')}</a>`,
    p.links.npm && `<a class="link-chip" href="${esc(p.links.npm)}" rel="noopener">${icon('package', 15)}npm</a>`,
    p.links.funding && `<a class="link-chip" href="${esc(p.links.funding)}" rel="noopener">${icon('heart', 15)}${t('store-funding')}</a>`,
  ].filter(Boolean).join('');
  const weekly = p.popularity?.weekly ? `<p class="fine">${esc(text(texts, lang, 'store-downloads').replace('{n}', number(p.popularity.weekly, lang)))}. ${t('store-downloads-hint')}</p>` : '';
  const problems = p.health.problems?.length ? `<details class="problems"><summary>${t('store-notes')}</summary><ul>${p.health.problems.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></details>` : '';
  const install = `kiosko plugins install ${p.package}@${p.latest}`;
  const description = say(p.description, lang) || text(texts, lang, 'store-meta-description');
  const cat = p.categories[0];
  const related = cat ? offeredIn(index, lang).filter((x) => x.id !== p.id && x.categories.includes(cat)).slice(0, 3) : [];
  const status = p.tier === 'official' ? `<p class="seal">${icon('shield-check', 15)}<span>${t('store-official-note')}</span></p>` : '';
  return `${head({ lang, texts, title: `${name} · ${text(texts, lang, 'store-title')}`, description, path, root, css, langs: offered })}
  <main class="store-main plugin-page" data-id="${esc(p.id)}" style="--tint:${tint(p)}">
    <p class="crumbs"><a class="back" href="../">${icon('chevron-left', 15)}${t('store-nav')}</a>${cat ? `<span aria-hidden="true">/</span><a href="../?cat=${esc(cat)}#plugins">${esc(categoryName(index, cat, lang))}</a>` : ''}</p>
    <header class="plugin-head">
      <div class="who">
        ${appIcon(p, 34, 'huge')}
        <div>
          <h1>${esc(name)}</h1>
          <p class="badges">${tierBadge(p, texts, lang)}${p.bundled ? `<span class="badge">${t('store-bundled')}</span>` : p.tier === 'official' ? `<span class="badge">${t('store-optional')}</span>` : ''}<span class="badge free">${t('store-free')}</span></p>
          <p class="lede">${esc(say(p.description, lang))}</p>
          <p class="sub mono">${esc(p.package)} · v${esc(p.latest)} · ${esc(date(latest?.date, lang))} · ${esc(p.license || '—')}</p>
          ${status}
        </div>
      </div>
      <div class="install">
        <a class="button primary big" href="${OPEN_IN_KIOSKO}${esc(encodeURIComponent(p.id))}">${icon('monitor-play', 18)}${t('store-open')}</a>
        <p class="fine">${t('store-open-hint')}</p>
        <div class="cmd"><pre><code>${esc(install)}</code></pre><button type="button" class="copy" data-copy="${esc(install)}">${icon('copy', 15)}<span>${t('store-copy')}</span></button></div>
      </div>
    </header>
    ${notes}
    ${shots}
    <div class="columns">
      <div>
        ${widgets}
        ${interludes}
        ${templates}
      </div>
      <aside>
        <section class="box does"><h2>${icon('shield', 17)}${t('store-does')}</h2>${permsHtml}${riskyHtml}<p class="fine">${t('store-perm-note')}</p></section>
        <section class="box"><dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl></section>
        <section class="box"><h2>${icon('history', 17)}${t('store-versions')}</h2><ul class="plain versions">${versions}</ul>${weekly}</section>
        <section class="box"><h2>${icon('life-buoy', 17)}${t('store-support')}</h2><p class="links-row">${links}</p></section>
        ${problems}
      </aside>
    </div>
    ${related.length ? `<section class="related"><h2>${esc(text(texts, lang, 'store-more-in').replace('{category}', categoryName(index, cat, lang)))}</h2><div class="cards">${related.map((x) => card(x, index, texts, lang, root, `../${x.id}/`)).join('')}</div></section>` : ''}
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

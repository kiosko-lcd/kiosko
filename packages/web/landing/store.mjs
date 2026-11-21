// The plugin store on the site (https://kioskolcd.dev/store/), from the catalogue the index builder
// wrote (store/v1/index.json, scripts/store/build-index.ts): in every language, like the front page.
//
//   /store/              every plugin, with search and filters (store.ts filters on the page itself)
//   /store/<id>/         one plugin: its pictures, what it does on your computer, its versions
//   /es/store/…          the same in each language (`hreflang` between them)
//
// Plain HTML first: every card and every fact is in the page (search engines, no JavaScript); the
// script only filters and sorts what is already there. No cookies, no analytics, nothing from
// another site: the pictures come from the gallery or from store/v1/img/.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LANGS, SITE, esc, plural, text } from './pages.mjs';
import { languageById } from '../../sdk/src/languages.ts';

/** Where "Open in Kiosko" goes: the editor of the Kiosko on this computer, at the plugin's page. Never an install. */
export const OPEN_IN_KIOSKO = 'http://127.0.0.1:7420/#/plugins/store/';

const CLASSES = ['bar', 'landscape', 'square', 'round', 'portrait'];
const OS = { linux: 'Linux', darwin: 'macOS', win32: 'Windows' };

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

/** The picture of a card: its first widget's, else its cover or an interlude's poster. */
function cardPicture(p, lang, root) {
  const w = p.widgets.find((x) => x.shots);
  if (w) {
    const src = w.shots[lang] ?? w.shots.en;
    return `<img src="${root}${esc(src)}" alt="" loading="lazy" decoding="async"${w.shotSize ? ` width="${w.shotSize.w}" height="${w.shotSize.h}"` : ''} />`;
  }
  const cover = p.cover ?? p.interludes.find((i) => i.poster)?.poster;
  if (cover) return `<img src="${root}${esc(cover)}" alt="" loading="lazy" decoding="async" />`;
  return `<span class="placeholder" aria-hidden="true">${esc(say(p.name, lang).slice(0, 1).toUpperCase())}</span>`;
}

function tierBadge(p, texts, lang) {
  if (p.tier === 'official') return `<span class="badge official">${esc(text(texts, lang, 'store-official'))}</span>`;
  if (p.tier === 'found') return `<span class="badge unreviewed">${esc(text(texts, lang, 'store-unreviewed'))}</span>`;
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

function card(p, texts, lang, root) {
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
  const weekly = p.popularity?.weekly ? `<span title="${esc(text(texts, lang, 'store-downloads-hint'))}">${esc(text(texts, lang, 'store-downloads').replace('{n}', number(p.popularity.weekly, lang)))}</span>` : '';
  const only = p.markets?.only?.length ? `<p class="market">${esc(text(texts, lang, 'store-only-in').replace('{regions}', list(p.markets.only.map((c) => regionName(c, lang)), lang)))}</p>` : '';
  return `<article class="card ${p.tier}" ${attrs}>
          <a class="card-link" href="${esc(p.id)}/">
            <div class="shot">${cardPicture(p, lang, root)}</div>
            <div class="about">
              <h2>${esc(say(p.name, lang))} ${tierBadge(p, texts, lang)}</h2>
              <p class="desc">${esc(say(p.description, lang))}</p>
              ${only}
              <p class="meta"><span class="classes" title="${esc(text(texts, lang, 'store-fits-on'))}">${classes.map((c) => classIcon(c, texts, lang)).join('')}</span> · ${esc(plural(texts, lang, 'store-languages', p.languages.length))} · ${esc(p.license || '—')}</p>
              <p class="meta">${weekly ? `${weekly} · ` : ''}v${esc(p.latest)}${p.bundled ? ` · ${esc(text(texts, lang, 'store-bundled'))}` : ''}</p>
            </div>
          </a>
        </article>`;
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

/** The texts the page's script needs (counts), in its language. */
function scriptTexts(texts, lang) {
  return { lang, 'store-shown-one': text(texts, lang, 'store-shown-one'), 'store-shown-other': text(texts, lang, 'store-shown-other'), ...Object.fromEntries(['zero', 'two', 'few', 'many'].map((f) => [`store-shown-${f}`, texts[lang]?.[`store-shown-${f}`]]).filter(([, v]) => v)) };
}

function option(value, label, selected = false) {
  return `<option value="${esc(value)}"${selected ? ' selected' : ''}>${esc(label)}</option>`;
}

/** The list page in `lang`. */
export function storeListPage({ index, texts, lang, css, js, presets }) {
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
  const filters = `<form class="filters" role="search" onsubmit="return false">
        <input class="search" type="search" name="q" placeholder="${t('store-search')}" aria-label="${t('store-search')}" />
        <details class="more" open><summary>${t('store-filters')}</summary><div class="more-body">
        <label>${t('store-category')} <select name="cat">${option('', text(texts, lang, 'store-all'))}${categories.map((c) => option(c.id, say(c.label, lang))).join('')}</select></label>
        <label>${t('store-panel')} <select name="panel">${option('', text(texts, lang, 'store-all'))}${CLASSES.map((c) => option(`class:${c}`, text(texts, lang, `store-class-${c}`))).join('')}<optgroup label="${t('store-models')}">${usedPresets.map((x) => option(`preset:${x.id}`, `${x.name} (${x.width}×${x.height})`)).join('')}</optgroup></select></label>
        <label>${t('store-orientation')} <select name="orient">${option('', text(texts, lang, 'store-all'))}${option('h', text(texts, lang, 'store-horizontal'))}${option('v', text(texts, lang, 'store-vertical'))}</select></label>
        <label>${t('store-system')} <select name="os">${option('', text(texts, lang, 'store-all'))}${Object.entries(OS).map(([k, v]) => option(k, v)).join('')}</select></label>
        <label>${t('store-language')} <select name="lang">${option('', text(texts, lang, 'store-all'))}${languages.map((x) => option(x, languageName(x, lang), false)).join('')}</select></label>
        <label>${t('store-license')} <select name="license">${option('', text(texts, lang, 'store-all'))}${licenses.map((k) => option(k, text(texts, lang, `store-license-${k}`))).join('')}</select></label>
        <label>${t('store-tier')} <select name="tier">${option('', text(texts, lang, 'store-all'))}${option('official', text(texts, lang, 'store-official'))}${option('found', text(texts, lang, 'store-unreviewed'))}</select></label>
        ${tags.length ? `<label>${t('store-tag')} <select name="tag">${option('', text(texts, lang, 'store-all'))}${tags.map((x) => option(x, x)).join('')}</select></label>` : ''}
        ${region ? `<label class="check"><input type="checkbox" name="region" checked /> ${t('store-region')}</label>` : ''}
        </div></details>
        <label>${t('store-sort')} <select name="sort">${option('featured', text(texts, lang, 'store-sort-featured'))}${option('recent', text(texts, lang, 'store-sort-recent'))}${option('name', text(texts, lang, 'store-sort-name'))}</select></label>
        <p class="count" aria-live="polite">${esc(plural(texts, lang, 'store-shown', plugins.length))}</p>
        <button type="button" class="button clear" hidden>${t('store-clear')}</button>
      </form>`;
  const updated = text(texts, lang, 'store-updated').replace('{date}', date(index.generatedAt, lang));
  const dataLink = text(texts, lang, 'store-index-link').replace('{url}', `<a href="${root}store/v1/index.json">store/v1/index.json</a>`).replace('{schema}', `<a href="${root}store/v1/schema/index.json">JSON Schema</a>`);
  const title = text(texts, lang, 'store-title');
  return `${head({ lang, texts, title, description: text(texts, lang, 'store-meta-description'), path: 'store/', root, css })}
  <main class="store-main">
    <header class="store-head">
      <h1>${t('store-nav')}</h1>
      <p class="lede">${text(texts, lang, 'store-lede')}</p>
    </header>
    ${filters}
    <p class="empty" hidden>${t('store-none')} <button type="button" class="button">${t('store-clear')}</button></p>
    <div class="cards">
        ${plugins.map((p) => card(p, texts, lang, root)).join('\n        ')}
    </div>
    <footer class="store-foot">
      <p>${text(texts, lang, 'store-write-yours')} <a href="https://github.com/kiosko-lcd/kiosko/blob/main/docs/plugins.md">docs/plugins.md</a></p>
      <p class="fine">${dataLink} ${esc(updated)}.</p>
    </footer>
  </main>${tail({ root, js, scriptTexts: scriptTexts(texts, lang) })}`;
}

const permKeys = ['network', 'exec', 'files', 'devices'];

/** One plugin's page in `lang`. */
export function storePluginPage({ index, detail, plugin: p, texts, lang, css, js, presets }) {
  const l = LANGS.find((x) => x.id === lang);
  const path = `store/${p.id}/`;
  const root = '../'.repeat(`${l.path}${path}`.split('/').filter(Boolean).length);
  const t = (k) => esc(text(texts, lang, k));
  const name = say(p.name, lang);
  const offered = LANGS.filter((x) => offeredIn(index, x.id).some((y) => y.id === p.id));
  const what = (v) => (v === 'user' ? text(texts, lang, 'store-perm-user') : v === 'lan' ? text(texts, lang, 'store-perm-lan') : v);
  const perms = permKeys.filter((k) => p.permissions[k]?.length);
  const risky = detail?.riskyOptions ?? [];
  const latest = p.releases[0];
  const shotLangs = [...new Set(p.widgets.flatMap((w) => Object.keys(w.shots ?? {})))];
  const presetName = (id) => presets.find((x) => x.id === id)?.name ?? id;
  const notes = [
    p.tier === 'official' ? `<p class="note official">${t('store-official-note')}</p>` : '',
    p.tier === 'found' ? `<p class="note unreviewed"><b>${t('store-unreviewed')}.</b> ${t('store-unreviewed-note')}</p>` : '',
    p.markets?.only?.length ? `<p class="note">${esc(text(texts, lang, 'store-only-in').replace('{regions}', list(p.markets.only.map((c) => regionName(c, lang)), lang)))}${p.markets.note ? `: ${esc(say(p.markets.note, lang))}` : ''}</p>` : '',
    p.markets?.without?.length ? `<p class="note">${esc(text(texts, lang, 'store-not-here').replace('{regions}', list(p.markets.without.map((c) => regionName(c, lang)), lang)))}</p>` : '',
    p.health.manifest === 'missing' ? `<p class="note">${t('store-no-manifest')}</p>` : '',
  ].join('');
  const shots = p.widgets.filter((w) => w.shots).map((w) => {
    const src = w.shots[lang] ?? w.shots.en;
    const wide = w.shotSize && w.shotSize.w / w.shotSize.h >= 2;
    return `<figure${wide ? ' class="wide"' : ''}><div class="shot"><img src="${root}${esc(src)}" data-shots="${esc(JSON.stringify(Object.fromEntries(Object.entries(w.shots).map(([k, v]) => [k, root + v]))))}" alt="${esc(say(w.name, lang))}" loading="lazy" decoding="async"${w.shotSize ? ` width="${w.shotSize.w}" height="${w.shotSize.h}"` : ''} /></div><figcaption>${esc(say(w.name, lang))}</figcaption></figure>`;
  });
  const cover = !shots.length && (p.cover ?? p.interludes.find((i) => i.poster)?.poster);
  const size = (s) => (s ? `${s.w}×${s.h}` : '—');
  const widgets = p.widgets.length
    ? `<section><h2>${t('store-widgets')} <small>${p.widgets.length}</small></h2><table class="widgets"><thead><tr><th></th><th>${t('store-min')}</th><th>${t('store-preferred')}</th><th>${t('store-fits-on')}</th></tr></thead><tbody>${p.widgets
        .map((w) => `<tr><th scope="row">${esc(say(w.name, lang))}<span class="muted">${esc(say(w.description, lang))}</span></th><td class="mono">${size(w.min)}</td><td class="mono">${size(w.preferred)}</td><td><span class="classes">${(w.fits ?? []).map((c) => classIcon(c, texts, lang)).join('')}</span> <span class="muted">${esc(list((w.presets ?? []).slice(0, 3).map(presetName), lang))}${(w.presets?.length ?? 0) > 3 ? '…' : ''}</span></td></tr>`)
        .join('')}</tbody></table></section>`
    : '';
  const interludes = p.interludes.length ? `<section><h2>${t('store-interludes')} <small>${p.interludes.length}</small></h2><ul class="plain">${p.interludes.map((i) => `<li><b>${esc(say(i.name, lang))}</b> <span class="muted">${esc(say(i.description, lang))}</span></li>`).join('')}</ul></section>` : '';
  const templates = p.templates.length ? `<section><h2>${t('store-templates')}</h2><ul class="plain">${p.templates.map((x) => `<li>${esc(say(x.name, lang))}</li>`).join('')}</ul></section>` : '';
  const permsHtml = perms.length
    ? `<ul class="perms">${perms.map((k) => `<li><b>${t(`store-perm-${k}`)}</b> ${esc(list(p.permissions[k].map(what), lang))}</li>`).join('')}</ul>`
    : `<p>${t('store-perm-none')}</p>`;
  const riskyHtml = risky.length ? `<p class="risky">${esc(plural(texts, lang, 'store-risky', risky.length))}</p><ul class="mono small">${risky.map((r) => `<li>${esc(r.path)}</li>`).join('')}</ul>` : '';
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
    p.links.repository && `<a href="${esc(p.links.repository)}" rel="noopener">${t('store-source')}</a>`,
    p.links.issues && `<a href="${esc(p.links.issues)}" rel="noopener">${t('store-issues')}</a>`,
    p.links.discussions && `<a href="${esc(p.links.discussions)}" rel="noopener">${t('store-discussions')}</a>`,
    (p.links.docs ?? p.links.homepage) && `<a href="${esc(p.links.docs ?? p.links.homepage)}" rel="noopener">${t('store-docs')}</a>`,
    p.links.npm && `<a href="${esc(p.links.npm)}" rel="noopener">npm</a>`,
    p.links.funding && `<a href="${esc(p.links.funding)}" rel="noopener">♥ ${t('store-funding')}</a>`,
  ].filter(Boolean).join(' · ');
  const weekly = p.popularity?.weekly ? `<p class="fine">${esc(text(texts, lang, 'store-downloads').replace('{n}', number(p.popularity.weekly, lang)))}. ${t('store-downloads-hint')}</p>` : '';
  const problems = p.health.problems?.length ? `<details class="problems"><summary>${t('store-notes')}</summary><ul>${p.health.problems.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></details>` : '';
  const install = `kiosko plugins install ${p.package}@${p.latest}`;
  const description = say(p.description, lang) || text(texts, lang, 'store-meta-description');
  return `${head({ lang, texts, title: `${name} · ${text(texts, lang, 'store-title')}`, description, path, root, css, langs: offered })}
  <main class="store-main plugin-page" data-id="${esc(p.id)}">
    <p><a class="back" href="../">${t('store-back')}</a></p>
    <header class="plugin-head">
      <div>
        <h1>${esc(name)} ${tierBadge(p, texts, lang)}${p.bundled ? ` <span class="badge">${t('store-bundled')}</span>` : p.tier === 'official' ? ` <span class="badge">${t('store-optional')}</span>` : ''} <span class="badge free">${t('store-free')}</span></h1>
        <p class="lede">${esc(say(p.description, lang))}</p>
        <p class="sub mono">${esc(p.package)} · v${esc(p.latest)} · ${esc(date(latest?.date, lang))} · ${esc(p.license || '—')}</p>
      </div>
      <div class="install">
        <a class="button primary" href="${OPEN_IN_KIOSKO}${esc(encodeURIComponent(p.id))}">${t('store-open')}</a>
        <p class="fine">${t('store-open-hint')}</p>
        <pre><code>${esc(install)}</code></pre>
      </div>
    </header>
    ${notes}
    ${shots.length ? `<section class="shots"><div class="shots-head"><h2>${t('store-pictures')}</h2>${shotLangs.length > 1 ? `<label>${t('store-shots-language')} <select class="shot-lang">${shotLangs.map((x) => option(x, languageName(x, lang), x === lang || (x === 'en' && !shotLangs.includes(lang)))).join('')}</select></label>` : ''}</div><div class="gallery">${shots.join('')}</div></section>` : cover ? `<section class="shots"><div class="gallery"><figure><div class="shot"><img src="${root}${esc(cover)}" alt="${esc(name)}" loading="lazy" /></div></figure></div></section>` : ''}
    <div class="columns">
      <div>
        ${widgets}
        ${interludes}
        ${templates}
      </div>
      <aside>
        <section class="does"><h2>${t('store-does')}</h2>${permsHtml}${riskyHtml}<p class="fine">${t('store-perm-note')}</p></section>
        <section><dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl></section>
        <section><h2>${t('store-versions')}</h2><ul class="plain versions">${versions}</ul>${weekly}</section>
        <section><h2>${t('store-support')}</h2><p class="links-row">${links}</p></section>
        ${problems}
      </aside>
    </div>
  </main>${tail({ root, js, scriptTexts: scriptTexts(texts, lang) })}`;
}

/**
 * Writes /store/ and /store/<id>/ in every language under `out`, and returns the pages for the
 * sitemap: `{ path, langs }` (each page lists the languages it is offered in).
 */
export function buildStorePages({ out, index, details, texts, css, js, presets }) {
  const pages = [{ path: 'store/', langs: LANGS }];
  for (const l of LANGS) {
    mkdirSync(join(out, l.path, 'store'), { recursive: true });
    writeFileSync(join(out, l.path, 'store/index.html'), storeListPage({ index, texts, lang: l.id, css, js, presets }));
  }
  for (const p of index.plugins.filter((x) => !x.hidden)) {
    const langs = LANGS.filter((l) => offeredIn(index, l.id).some((x) => x.id === p.id));
    pages.push({ path: `store/${p.id}/`, langs });
    for (const l of langs) {
      mkdirSync(join(out, l.path, 'store', p.id), { recursive: true });
      writeFileSync(join(out, l.path, 'store', p.id, 'index.html'), storePluginPage({ index, detail: details[p.id], plugin: p, texts, lang: l.id, css, js, presets }));
    }
  }
  return pages;
}

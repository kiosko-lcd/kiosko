/**
 * The plugin store's parts, written once for both stores: the site's (landing/store.mjs writes
 * them into static pages at build time) and the editor's (views/Store.tsx puts them in the page
 * and adds what only a running Kiosko can do: install, update, what is installed, what fits the
 * person's screens). The same cards, the same plugin page, the same pictures on a panel, from the
 * same functions and the same stylesheet (kit.css, every class `ks-`), so the two cannot drift.
 *
 * Plain HTML strings: the site has no script to render with, and the editor puts them in a
 * container and listens there (client.ts wires the pictures; the editor its buttons, by
 * `data-act`). Every text of the catalogue is escaped; links are only http(s) or relative ones.
 * The words are the site's (landing/i18n/<lang>.json, `store-*`), in every language Kiosko speaks.
 * Node runs this file as it is (type stripping): no enums, no parameter properties.
 */
import { icons } from 'lucide';
import type { StoreIndex, StorePlugin, StorePluginFile, StoreWidget } from '../../core/src/store/types.ts';
import { languageById, listIn, regionName } from '../../sdk/src/languages.ts';

/** The words of one language, as in landing/i18n/<lang>.json. */
export type Words = Record<string, string | undefined>;

/** What the parts need to know about where they are shown. */
export interface Kit {
  /** The language of the page (a Kiosko language id: en, es, de, zh-Hant, zh-Hans). */
  lang: string;
  /** Every language's words, by language id (English is the fallback). */
  texts: Record<string, Words>;
  /** The catalogue (for the categories' names, and the plugins a page links to). */
  index: StoreIndex;
  /** Where the site's files are, as a prefix: `../../` on the site, `https://kioskolcd.dev/` in the editor. */
  root: string;
  /** A plugin's page. */
  page: (id: string) => string;
  /** The list. */
  list: string;
  /** The list showing one category. */
  category: (id: string) => string;
  /** The region the reader is in (`CN`), for "only useful in…" (null: not known). */
  region: string | null;
  /** Panel models, for the names under each widget. */
  presets?: { id: string; name: string; width: number; height: number }[];
  /** Links to other sites open in a new tab (the editor: it is an app). */
  newTab?: boolean;
  /** Whether a plugin is meant for where it is read, when the reader's region says more than the page's language (the editor's config). */
  market?: (p: StorePlugin) => 'ok' | 'elsewhere' | 'missing';
}

export const CLASSES = ['bar', 'landscape', 'square', 'round', 'portrait'] as const;
export const OS: Record<string, string> = { linux: 'Linux', darwin: 'macOS', win32: 'Windows' };
export const PERMS = [
  ['network', 'globe'],
  ['exec', 'square-terminal'],
  ['files', 'folder-open'],
  ['devices', 'usb'],
] as const;
export type PermKey = (typeof PERMS)[number][0];

/**
 * The plugins the list puts first, in this order (the first three offered in a language): an
 * editorial choice of what shows best what Kiosko does, not a ranking. Nothing about them is made up.
 */
export const FEATURED = ['agents', 'cats', 'homeassistant', 'doom', 'gpu'];

/** Each category's drawing and colour (the glow behind its panels). */
export const CATEGORY: Record<string, [string, string]> = {
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
export const tint = (p: StorePlugin): string => CATEGORY[p.categories[0] ?? '']?.[1] ?? '#8b7bff';

export const esc = (s: unknown): string => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** A link of the catalogue's, only if it is a web address (never `javascript:` or the like). */
export const safeUrl = (u: string | undefined): string | null => (u && /^https?:\/\//i.test(u) ? u : null);

/** A word in the page's language, or English (a missing one is a build error on the site: tests say which). */
export function say(k: Kit, key: string): string {
  const s = k.texts[k.lang]?.[key] ?? k.texts.en?.[key];
  if (s === undefined) throw new Error(`store: no text "${key}" in landing/i18n/en.json`);
  return s;
}

/** `{n} plugins` and friends: the `<key>-<form>` the language's plural rules ask for, else `<key>-other`. */
export function plural(k: Kit, key: string, n: number): string {
  const form = new Intl.PluralRules(k.lang).select(n);
  const s = k.texts[k.lang]?.[`${key}-${form}`] ?? (form === 'one' ? say(k, `${key}-one`) : say(k, `${key}-other`));
  return s.replaceAll('{n}', new Intl.NumberFormat(k.lang).format(n));
}

const w = (k: Kit, key: string) => esc(say(k, key));

/** A text of the catalogue in the page's language, else English. */
export const textIn = (t: Record<string, string> | undefined, lang: string): string => (t ? (t[lang] ?? t.en ?? '') : '');

/** Chinese and Japanese: full-width punctuation with no space after it. */
export const fullWidth = (lang: string): boolean => /^(zh|ja|ko)\b/.test(lang);
export const list = (items: string[], lang: string): string => listIn(items, lang);
export const date = (iso: string | undefined, lang: string): string => (iso ? new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(iso)) : '');
const number = (n: number, lang: string) => new Intl.NumberFormat(lang).format(n);
export function languageName(tag: string, lang: string): string {
  const own = languageById(tag);
  if (own) return own.name;
  try {
    return new Intl.DisplayNames([lang], { type: 'language' }).of(tag) ?? tag;
  } catch {
    return tag;
  }
}

/** The region a page is read in, from its language alone (no setting, nothing asked): zh-Hant → TW, zh-Hans → CN. */
export function pageRegion(lang: string): string | null {
  if (!lang.startsWith('zh')) return null;
  try {
    return new Intl.Locale(lang).maximize().region ?? null;
  } catch {
    return null;
  }
}

/** Whether a plugin is meant for where it is read: `elsewhere` when it says it is only useful in other regions. */
export function marketIn(p: StorePlugin, region: string | null): 'ok' | 'elsewhere' {
  if (!region || !p.markets?.only?.length) return 'ok';
  return p.markets.only.includes(region) ? 'ok' : 'elsewhere';
}

const marketOf = (p: StorePlugin, k: Kit) => k.market?.(p) ?? marketIn(p, k.region);

/** The plugins the store offers in `lang`: not hidden ones, nor those whose service is missing where it is read (languages.ts). */
export function offeredIn<P extends Pick<StorePlugin, 'id' | 'hidden'>>(index: { plugins: P[] }, lang: string): P[] {
  const without = languageById(lang)?.plugins?.without ?? [];
  return index.plugins.filter((p) => !p.hidden && !without.includes(p.id));
}

export const categoryName = (k: Kit, id: string): string => textIn(k.index.categories?.find((c) => c.id === id)?.label, k.lang) || id;

/** Names Lucide no longer draws (brands), and what to draw instead. */
const ICON_ALIAS: Record<string, string> = { github: 'git-pull-request', gitlab: 'git-merge' };
const pascal = (s: string) => s.replace(/(^|[-_ ])(\w)/g, (_m, _a, c: string) => c.toUpperCase());
type IconNode = [string, Record<string, string | number>][];

/** A Lucide icon as inline SVG (a plugin's own SVG is not drawn: it would be its HTML in our page). */
export function icon(name: string | undefined, size = 18, cls = ''): string {
  const n = ICON_ALIAS[name ?? ''] ?? name ?? 'puzzle';
  const all = icons as unknown as Record<string, IconNode>;
  const node = all[pascal(n)] ?? all.Puzzle!;
  const parts = node.map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).map(([a, v]) => `${a}="${esc(v)}"`).join(' ')}/>`).join('');
  return `<svg class="ks-ic${cls ? ` ${cls}` : ''}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${parts}</svg>`;
}

/** A plugin's own drawing (from its manifest), else one for what it brings. */
export const pluginIcon = (p: StorePlugin): string => (p.icon && !p.icon.trim().startsWith('<') ? p.icon : p.interludes.length && !p.widgets.length ? 'clapperboard' : (CATEGORY[p.categories[0] ?? '']?.[0] ?? 'puzzle'));
export const appIcon = (p: StorePlugin, size = 20, cls = ''): string => `<span class="ks-app-icon${cls ? ` ${cls}` : ''}">${icon(pluginIcon(p), size)}</span>`;

/** A small drawing of each panel class (a bar, a square, a circle…), with its name. */
export function classIcon(c: string, k: Kit): string {
  const shape = {
    bar: '<rect x="1" y="6" width="22" height="6" rx="1"/>',
    landscape: '<rect x="3" y="4" width="18" height="10" rx="1"/>',
    square: '<rect x="5" y="2" width="14" height="14" rx="1"/>',
    round: '<circle cx="12" cy="9" r="7"/>',
    portrait: '<rect x="8" y="1" width="8" height="16" rx="1"/>',
  }[c];
  const name = w(k, `store-class-${c}`);
  return `<svg class="ks-cls" viewBox="0 0 24 18" width="22" height="16" role="img" aria-label="${name}"><title>${name}</title>${shape}</svg>`;
}

/** Every class any of its widgets fits (interludes and templates-only plugins fit every one). */
export const classesOf = (p: StorePlugin): string[] => (p.widgets.length ? CLASSES.filter((c) => p.widgets.some((x) => (x.fits ?? CLASSES).includes(c))) : [...CLASSES]);

/** The picture that shows a plugin best: its widest widget's (the panels are wide), else its cover or an interlude's poster. */
export function bestPicture(p: StorePlugin, lang: string): { src: string; size?: { w: number; h: number } } | null {
  const withShots = p.widgets.filter((x) => x.shots);
  const x = withShots.find((y) => y.shotSize && y.shotSize.w / y.shotSize.h >= 2.4) ?? withShots[0];
  if (x?.shots) return { src: (x.shots[lang] ?? x.shots.en)!, size: x.shotSize };
  const cover = p.cover ?? p.interludes.find((i) => i.poster)?.poster;
  return cover ? { src: cover } : null;
}

/** Its drawing and name on a dark screen: when it has no picture, or its picture cannot be loaded (offline). */
const poster = (p: StorePlugin, lang: string) => `<span class="ks-poster">${icon(pluginIcon(p), 40)}<b>${esc(textIn(p.name, lang))}</b></span>`;

/**
 * A plugin's picture on a small screen; without one, a screen with its drawing and name. With
 * its size known, the screen has its shape before the picture arrives (no jump, and a lazy
 * picture has a box to be seen in). If the picture fails (client.ts), the drawing takes its place.
 */
export function screen(p: StorePlugin, k: Kit, alt = ''): string {
  const pic = bestPicture(p, k.lang);
  if (pic?.size) return `<span class="ks-bezel sized" style="--ar:${+(pic.size.w / pic.size.h).toFixed(4)}"><img src="${esc(k.root + pic.src)}" alt="${esc(alt)}" loading="lazy" decoding="async" width="${pic.size.w}" height="${pic.size.h}" />${poster(p, k.lang)}</span>`;
  if (pic) return `<span class="ks-bezel"><img src="${esc(k.root + pic.src)}" alt="${esc(alt)}" decoding="async" />${poster(p, k.lang)}</span>`;
  return `<span class="ks-bezel none">${poster(p, k.lang)}</span>`;
}

export function tierBadge(p: StorePlugin, k: Kit): string {
  if (p.tier === 'official') return `<span class="ks-badge official">${icon('badge-check', 13)}${w(k, 'store-official')}</span>`;
  if (p.tier === 'found') return `<span class="ks-badge unreviewed">${icon('triangle-alert', 13)}${w(k, 'store-unreviewed')}</span>`;
  return '';
}

/** What a search finds it by, in every language. */
export const searchText = (p: StorePlugin): string =>
  [p.id, p.package, ...Object.values(p.name), ...Object.values(p.description ?? {}), ...p.tags, ...p.widgets.flatMap((x) => Object.values(x.name)), ...p.interludes.flatMap((i) => Object.values(i.name))].join(' ').toLowerCase();

/**
 * One plugin's card: its widget on a small screen, its drawing, name and what it is for, the
 * panels it fits. The whole card leads to its page. `foot` goes under it, outside the link
 * (the editor's: does it run here, does it fit, Install).
 */
export function card(p: StorePlugin, k: Kit, o: { foot?: string; installed?: boolean } = {}): string {
  const classes = classesOf(p);
  const presets = [...new Set(p.widgets.flatMap((x) => x.presets ?? []))];
  const data: Record<string, string> = {
    id: p.id,
    cats: p.categories.join(' '),
    tags: p.tags.join(' '),
    langs: p.languages.join(' '),
    classes: (p.widgets.length ? classes : ['any']).join(' '),
    presets: presets.join(' '),
    os: p.platforms.join(' '),
    license: p.licenseKind ?? 'other',
    tier: p.tier,
    market: marketOf(p, k),
    date: p.releases[0]?.date ?? '',
    name: textIn(p.name, k.lang).toLowerCase(),
    search: searchText(p),
  };
  const attrs = Object.entries(data).map(([a, v]) => `data-${a}="${esc(v)}"`).join(' ');
  const weekly = p.popularity?.weekly ? `<span title="${w(k, 'store-downloads-hint')}">${icon('download', 12)}${esc(say(k, 'store-downloads').replace('{n}', number(p.popularity.weekly, k.lang)))}</span>` : '';
  const only = p.markets?.only?.length ? `<p class="ks-market">${icon('map-pin', 13)}${esc(say(k, 'store-only-in').replace('{regions}', list(p.markets.only.map((c) => regionName(c, k.lang)), k.lang)))}</p>` : '';
  const cat = p.categories[0] ? `<p class="ks-cat">${esc(categoryName(k, p.categories[0]))}</p>` : '';
  return `<article class="ks-card ${p.tier}${o.foot ? ' has-foot' : ''}" style="--tint:${tint(p)}" ${attrs}>
          <a class="ks-card-link" href="${esc(k.page(p.id))}">
            <span class="ks-screen">${screen(p, k)}</span>
            <span class="ks-about">
              <span class="ks-title">${appIcon(p)}<span class="ks-names"><h3>${esc(textIn(p.name, k.lang))}</h3>${cat}</span>${tierBadge(p, k)}</span>
              <p class="ks-desc">${esc(textIn(p.description, k.lang))}</p>
              ${only}
              <p class="ks-meta"><span class="ks-classes" title="${w(k, 'store-fits-on')}">${classes.map((c) => classIcon(c, k)).join('')}</span><span>${esc(plural(k, 'store-languages', p.languages.length))}</span><span>${esc(p.license || '—')}</span>${weekly}</p>
            </span>
          </a>${o.foot ? `\n          <div class="ks-card-foot">${o.foot}</div>` : ''}
        </article>`;
}

/** A picked plugin: a big panel with its widget, and what it is. */
export function feature(p: StorePlugin, k: Kit): string {
  const cat = p.categories[0] ? esc(categoryName(k, p.categories[0])) : '';
  return `<a class="ks-feature" href="${esc(k.page(p.id))}" style="--tint:${tint(p)}">
          <span class="ks-stage">${screen(p, k)}</span>
          <span class="ks-feature-text">
            ${appIcon(p, 22, 'big')}
            <span class="ks-names"><span class="ks-cat">${cat}</span><b>${esc(textIn(p.name, k.lang))}</b><span class="ks-desc">${esc(textIn(p.description, k.lang))}</span></span>
            <span class="ks-go" aria-hidden="true">${icon('arrow-right', 18)}</span>
          </span>
        </a>`;
}

/** The picked ones offered here, at most three. */
export const featuredIn = (plugins: StorePlugin[]): StorePlugin[] => FEATURED.map((id) => plugins.find((p) => p.id === id)).filter((p): p is StorePlugin => !!p).slice(0, 3);

/** A category's chip: a radio on the site (its form), a button in the editor (`data-cat`). */
export function categoryChip(k: Kit, id: string, checked: boolean, as: 'radio' | 'button'): string {
  const label = id ? categoryName(k, id) : say(k, 'store-all');
  const ico = icon(id ? (CATEGORY[id]?.[0] ?? 'tag') : 'layout-grid', 15);
  return as === 'radio'
    ? `<label class="ks-chip"><input type="radio" name="cat" value="${esc(id)}"${checked ? ' checked' : ''} /><span>${ico}${esc(label)}</span></label>`
    : `<button type="button" class="ks-chip" data-cat="${esc(id)}" aria-pressed="${checked}"><span>${ico}${esc(label)}</span></button>`;
}

const ext = (k: Kit) => (k.newTab ? ' target="_blank" rel="noopener noreferrer"' : ' rel="noopener"');
const what = (k: Kit, v: string) => (v === 'user' ? say(k, 'store-perm-user') : v === 'lan' ? say(k, 'store-perm-lan') : v);

/** What a plugin says it does on the computer, calmly: each kind with its icon, or that it declares nothing. */
export function permissions(perms: StorePlugin['permissions'], k: Kit): string {
  const any = PERMS.filter(([key]) => perms[key]?.length);
  return any.length
    ? `<ul class="ks-perms">${any.map(([key, ico]) => `<li><span class="ks-perm-ic">${icon(ico, 16)}</span><span><b>${w(k, `store-perm-${key}`)}</b> ${esc(list(perms[key]!.map((v) => what(k, v)), k.lang))}</span></li>`).join('')}</ul>`
    : `<p class="ks-perm-none">${icon('shield-check', 18)}<span>${w(k, 'store-perm-none')}</span></p>`;
}

/** Its options that act for the person (they run, connect or read what is written in them), folded. */
export function riskyOptions(risky: StorePluginFile['riskyOptions'], k: Kit): string {
  return risky.length ? `<details class="ks-risky"><summary>${icon('info', 15)}<span>${esc(plural(k, 'store-risky', risky.length))}</span></summary><ul class="ks-mono">${risky.map((r) => `<li>${esc(r.path)}</li>`).join('')}</ul></details>` : '';
}

/** The parts of a plugin's page an embedding adds to (the editor: its button, how each widget fits the person's screens). */
export interface PageSlots {
  /** The box at the top right: the site's "Open in Kiosko" and command; the editor's Install. */
  action: string;
  /** More notes under the head (the editor's: it does not run here). */
  notes?: string;
  /** Under each widget (the editor: how it fits each screen). */
  widget?: (x: StoreWidget) => string;
  /** More links in "Support". */
  links?: string;
}

/** One plugin's page: its head, its pictures on a panel, its widgets, what it does, its facts and versions, more like it. */
export function pluginPage(p: StorePlugin, detail: Pick<StorePluginFile, 'riskyOptions'> | null | undefined, k: Kit, slots: PageSlots): string {
  const lang = k.lang;
  const name = textIn(p.name, lang);
  const risky = detail?.riskyOptions ?? [];
  const latest = p.releases[0];
  const shotLangs = [...new Set(p.widgets.flatMap((x) => Object.keys(x.shots ?? {})))];
  const presetName = (id: string) => k.presets?.find((x) => x.id === id)?.name ?? id;
  const sep = fullWidth(lang) ? '：' : ': ';
  const notes = [
    p.tier === 'found' ? `<p class="ks-note unreviewed">${icon('triangle-alert', 16)}<span><b>${w(k, 'store-unreviewed')}.</b> ${w(k, 'store-unreviewed-note')}</span></p>` : '',
    p.markets?.only?.length ? `<p class="ks-note${marketOf(p, k) === 'elsewhere' ? ' warn' : ''}">${icon('map-pin', 16)}<span>${esc(say(k, 'store-only-in').replace('{regions}', list(p.markets.only.map((c) => regionName(c, lang)), lang)))}${p.markets.note ? `${sep}${esc(textIn(p.markets.note, lang))}` : ''}</span></p>` : '',
    p.markets?.without?.length ? `<p class="ks-note">${icon('map-pin-off', 16)}<span>${esc(say(k, 'store-not-here').replace('{regions}', list(p.markets.without.map((c) => regionName(c, lang)), lang)))}</span></p>` : '',
    p.health.manifest === 'missing' ? `<p class="ks-note">${icon('info', 16)}<span>${w(k, 'store-no-manifest')}</span></p>` : '',
    slots.notes ?? '',
  ].join('');
  const size = (s?: { w: number; h: number }) => (s ? `${s.w}×${s.h}` : '—');
  const withShots = p.widgets.filter((x) => x.shots);
  const shotsJson = (x: StoreWidget) => esc(JSON.stringify(Object.fromEntries(Object.entries(x.shots!).map(([l, v]) => [l, k.root + v]))));
  const img = (x: StoreWidget, alt: string, extra = '') => `<img src="${esc(k.root + (x.shots![lang] ?? x.shots!.en))}" data-shots="${shotsJson(x)}" alt="${esc(alt)}" decoding="async"${x.shotSize ? ` width="${x.shotSize.w}" height="${x.shotSize.h}"` : ''}${extra} />`;
  const cover = !withShots.length && (p.cover ?? p.interludes.find((i) => i.poster)?.poster);
  // An interlude's clip where it has one, on the big panel: silent, looping, played by client.ts only while on screen
  // (and never with reduced motion); its still is the poster, which is all that shows without a script. The list
  // below keeps the stills: they show each one fully developed.
  const clip = (i: StorePlugin['interludes'][number], alt: string) => `<video class="ks-clip" src="${esc(k.root + i.video)}" poster="${esc(k.root + i.poster)}" muted loop playsinline preload="none" aria-label="${esc(alt)}"></video>`;
  // Only interludes: each one with a still goes on the big panel (its clip where it has one), the others as thumbnails.
  const scenes = withShots.length ? [] : p.interludes.filter((i) => i.poster);
  const thumbButton = (n: number, pic: string, label: string) => `<button type="button" data-shot="${n}" aria-controls="shot-${n}" aria-pressed="${n === 0}"><span class="ks-thumb">${pic}</span><span>${esc(label)}</span></button>`;
  // The pictures: one big panel and, with a script, the others as thumbnails that bring theirs onto it (without one, all of them, one under the other).
  const stage = withShots.length
    ? `<div class="ks-stage-panel"><div class="ks-slab">${withShots.map((x, i) => `<figure class="${i === 0 ? 'on' : ''}" id="shot-${i}"><div class="ks-glass">${img(x, textIn(x.name, lang))}</div><figcaption><b>${esc(textIn(x.name, lang))}</b> <span>${esc(textIn(x.description, lang))}</span></figcaption></figure>`).join('')}</div></div>
      ${withShots.length > 1 ? `<div class="ks-thumbs">${withShots.map((x, i) => thumbButton(i, img(x, '', ' loading="lazy"'), textIn(x.name, lang))).join('')}</div>` : ''}`
    : scenes.length
      ? `<div class="ks-stage-panel"><div class="ks-slab">${scenes.map((i, n) => `<figure class="${n === 0 ? 'on' : ''}" id="shot-${n}"><div class="ks-glass">${i.video ? clip(i, textIn(i.name, lang)) : `<img src="${esc(k.root + i.poster)}" alt="${esc(textIn(i.name, lang))}" decoding="async" />`}</div><figcaption><b>${esc(textIn(i.name, lang))}</b> <span>${esc(textIn(i.description, lang))}</span></figcaption></figure>`).join('')}</div></div>
      ${scenes.length > 1 ? `<div class="ks-thumbs">${scenes.map((i, n) => thumbButton(n, `<img src="${esc(k.root + i.poster)}" alt="" loading="lazy" decoding="async" />`, textIn(i.name, lang))).join('')}</div>` : ''}`
      : cover
        ? `<div class="ks-stage-panel"><div class="ks-slab"><figure class="on"><div class="ks-glass"><img src="${esc(k.root + cover)}" alt="${esc(name)}" decoding="async" /></div></figure></div></div>`
        : '';
  const shots = stage
    ? `<section class="ks-section ks-shots" aria-labelledby="shots-h"><div class="ks-shots-head"><h2 id="shots-h">${w(k, 'store-pictures')}</h2>${shotLangs.length > 1 ? `<label>${icon('languages', 15)}${w(k, 'store-shots-language')} <select class="ks-shot-lang">${shotLangs.map((x) => option(x, languageName(x, lang), x === lang || (x === 'en' && !shotLangs.includes(lang)))).join('')}</select></label>` : ''}</div>${stage}</section>`
    : '';
  const widgets = p.widgets.length
    ? `<section class="ks-section"><h2>${w(k, 'store-widgets')} <small>${p.widgets.length}</small></h2><ul class="ks-widget-list">${p.widgets
        .map((x) => `<li>${x.shots ? `<span class="ks-thumb">${img(x, '', ' loading="lazy"')}</span>` : `<span class="ks-thumb none">${icon(x.icon ?? pluginIcon(p), 22)}</span>`}<div><b>${esc(textIn(x.name, lang))}</b><p class="ks-dim">${esc(textIn(x.description, lang))}</p><p class="ks-specs"><span class="ks-spec"><span>${w(k, 'store-min')}</span> <span class="ks-mono">${size(x.min)}</span></span><span class="ks-spec"><span>${w(k, 'store-preferred')}</span> <span class="ks-mono">${size(x.preferred)}</span></span><span class="ks-classes" title="${w(k, 'store-fits-on')}">${(x.fits ?? []).map((c) => classIcon(c, k)).join('')}</span>${x.presets?.length ? `<span class="ks-dim ks-presets">${esc(list(x.presets.slice(0, 2).map(presetName), lang))}${x.presets.length > 2 ? ` +${x.presets.length - 2}` : ''}</span>` : ''}</p>${slots.widget?.(x) ?? ''}</div></li>`)
        .join('')}</ul></section>`
    : '';
  const interludes = p.interludes.length ? `<section class="ks-section"><h2>${w(k, 'store-interludes')} <small>${p.interludes.length}</small></h2><ul class="ks-widget-list">${p.interludes.map((i) => `<li>${(i.poster ?? (p.interludes.length === 1 && p.cover)) ? `<span class="ks-thumb"><img src="${esc(k.root + (i.poster ?? p.cover))}" alt="" loading="lazy" decoding="async" /></span>` : `<span class="ks-thumb none">${icon(i.icon ?? 'clapperboard', 22)}</span>`}<div><b>${esc(textIn(i.name, lang))}</b><p class="ks-dim">${esc(textIn(i.description, lang))}</p></div></li>`).join('')}</ul></section>` : '';
  const templates = p.templates.length ? `<section class="ks-section"><h2>${w(k, 'store-templates')}</h2><ul class="ks-plain">${p.templates.map((x) => `<li>${icon('layout-template', 15)} ${esc(textIn(x.name, lang))}</li>`).join('')}</ul></section>` : '';
  const pluginName = (id: string) => textIn(k.index.plugins.find((x) => x.id === id)?.name, lang) || id;
  const pluginLink = (id: string) => (k.index.plugins.some((x) => x.id === id && !x.hidden) ? `<a href="${esc(k.page(id))}">${esc(pluginName(id))}</a>` : esc(id));
  const comma = fullWidth(lang) ? '、' : ', ';
  const facts = [
    [w(k, 'store-needs'), p.requires.length ? p.requires.map(pluginLink).join(comma) : w(k, 'store-requires-none')],
    p.optional.length ? [w(k, 'store-uses'), p.optional.map(pluginLink).join(comma)] : null,
    [w(k, 'store-works-on'), esc(list(p.platforms.map((x) => OS[x] ?? x), lang))],
    latest?.sdk ? [w(k, 'store-api'), `<code>${esc(latest.sdk)}</code>`] : null,
    [w(k, 'store-language'), esc(list(p.languages.map((x) => languageName(x, lang)), lang))],
    [w(k, 'store-license'), esc(p.license || '—')],
    p.publisher?.name ? [w(k, 'store-author'), esc(p.publisher.name)] : null,
  ].filter((x): x is string[] => !!x);
  const versions = p.releases.slice(0, 8).map((r) => `<li><span class="ks-mono">${esc(r.version)}</span> <span class="ks-dim">${esc(date(r.date, lang))}</span>${r.deprecated ? ` <span class="ks-badge" title="${esc(r.deprecated)}">${w(k, 'store-deprecated')}</span>` : ''}${r.withdrawn ? ` <span class="ks-badge unreviewed">${w(k, 'store-withdrawn')}</span>` : ''}${r.addedPermissions ? ` <span class="ks-badge">${w(k, 'store-more-permissions')}</span>` : ''}</li>`).join('');
  const linkChip = (href: string | null, ico: string, label: string) => (href ? `<a class="ks-link-chip" href="${esc(href)}"${ext(k)}>${icon(ico, 15)}${label}</a>` : '');
  const links = [
    linkChip(safeUrl(p.links.repository), 'code-xml', w(k, 'store-source')),
    linkChip(safeUrl(p.links.issues), 'bug', w(k, 'store-issues')),
    linkChip(safeUrl(p.links.discussions), 'messages-square', w(k, 'store-discussions')),
    linkChip(safeUrl(p.links.docs ?? p.links.homepage), 'book-open', w(k, 'store-docs')),
    linkChip(safeUrl(p.links.npm), 'package', 'npm'),
    linkChip(safeUrl(p.links.funding), 'heart', w(k, 'store-funding')),
    slots.links ?? '',
  ].join('');
  const weekly = p.popularity?.weekly ? `<p class="ks-fine">${esc(say(k, 'store-downloads').replace('{n}', number(p.popularity.weekly, lang)))}${fullWidth(lang) ? '。' : '. '}${w(k, 'store-downloads-hint')}</p>` : '';
  const problems = p.health.problems?.length ? `<details class="ks-problems"><summary>${w(k, 'store-notes')}</summary><ul>${p.health.problems.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></details>` : '';
  const cat = p.categories[0];
  const related = cat ? offeredIn(k.index, lang).filter((x) => x.id !== p.id && x.categories.includes(cat)).slice(0, 3) : [];
  const seal = p.tier === 'official' ? `<p class="ks-seal">${icon('shield-check', 15)}<span>${w(k, 'store-official-note')}</span></p>` : '';
  return `<div class="ks-plugin-page" data-id="${esc(p.id)}" style="--tint:${tint(p)}">
    <p class="ks-crumbs"><a class="ks-back" href="${esc(k.list)}">${icon('chevron-left', 15)}${w(k, 'store-nav')}</a>${cat ? `<span aria-hidden="true">/</span><a href="${esc(k.category(cat))}">${esc(categoryName(k, cat))}</a>` : ''}</p>
    <header class="ks-plugin-head">
      <div class="ks-who">
        ${appIcon(p, 34, 'huge')}
        <div>
          <h1>${esc(name)}</h1>
          <p class="ks-badges">${tierBadge(p, k)}${p.bundled ? `<span class="ks-badge">${w(k, 'store-bundled')}</span>` : p.tier === 'official' ? `<span class="ks-badge">${w(k, 'store-optional')}</span>` : ''}<span class="ks-badge free">${w(k, 'store-free')}</span></p>
          <p class="ks-lede">${esc(textIn(p.description, lang))}</p>
          <p class="ks-sub ks-mono">${esc(p.package)} · v${esc(p.latest)} · ${esc(date(latest?.date, lang))} · ${esc(p.license || '—')}</p>
          ${seal}
        </div>
      </div>
      <div class="ks-install">${slots.action}</div>
    </header>
    ${notes}
    ${shots}
    <div class="ks-columns">
      <div>
        ${widgets}
        ${interludes}
        ${templates}
      </div>
      <aside>
        <section class="ks-section ks-box"><h2>${icon('shield', 17)}${w(k, 'store-does')}</h2>${permissions(p.permissions, k)}${riskyOptions(risky, k)}<p class="ks-fine">${w(k, 'store-perm-note')}</p></section>
        <section class="ks-section ks-box"><dl class="ks-facts">${facts.map(([dt, dd]) => `<dt>${dt}</dt><dd>${dd}</dd>`).join('')}</dl></section>
        <section class="ks-section ks-box"><h2>${icon('history', 17)}${w(k, 'store-versions')}</h2><ul class="ks-plain ks-versions">${versions}</ul>${weekly}</section>
        ${links ? `<section class="ks-section ks-box"><h2>${icon('life-buoy', 17)}${w(k, 'store-support')}</h2><p class="ks-links-row">${links}</p></section>` : ''}
        ${problems}
      </aside>
    </div>
    ${related.length ? `<section class="ks-section ks-related"><h2>${esc(say(k, 'store-more-in').replace('{category}', categoryName(k, cat!)))}</h2><div class="ks-cards">${related.map((x) => card(x, k)).join('')}</div></section>` : ''}
  </div>`;
}

export function option(value: string, label: string, selected = false): string {
  return `<option value="${esc(value)}"${selected ? ' selected' : ''}>${esc(label)}</option>`;
}

/** The command that installs it from a terminal, with a button that copies it (client.ts; the page works without). */
export const installCommand = (p: StorePlugin, k: Kit): string => {
  const cmd = `kiosko plugins install ${p.package}@${p.latest}`;
  return `<div class="ks-cmd"><pre><code>${esc(cmd)}</code></pre><button type="button" class="ks-copy" data-copy="${esc(cmd)}">${icon('copy', 15)}<span>${w(k, 'store-copy')}</span></button></div>`;
};

/**
 * The plugin store inside the Plugins page (docs/es/tienda.md, §6.2–6.3): the
 * same catalogue as https://kioskolcd.dev/store/, drawn by the same parts
 * (packages/web/store-kit: the cards, the plugin page, the pictures on a
 * panel, their stylesheet and their words), crossed with this Kiosko: its
 * system and plugin API, what is installed, these screens and this language.
 * What only a Kiosko can do is added here: Install, Update, "does it run
 * here", "does it fit my screens", and the dialog that says what a plugin
 * does before it is installed. `#/plugins/store/<id>` opens a plugin's page
 * (the site's "Open in Kiosko" lands there): nothing is installed without a
 * click. Without a connection it works from the catalogue that comes with
 * Kiosko; pictures that do not come give way to the plugins' drawings.
 */
import { signal } from '@preact/signals';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { fitsScreens, installableRelease, marketFor, matches, regionOf, releaseProblem, searchText, type StorePlugin, type StorePluginFile } from '@kiosko/core/store';
import { listIn, regionName as regionNameIn } from '@kiosko/sdk/languages';
import { api, type StoreState } from '../api.ts';
import { Icon } from '../icons.tsx';
import { dateTime, errorText, fullWidth, listOf, t, tr, uiLanguage } from '../i18n.ts';
import { app, config, locale, notify, route, status } from '../store.ts';
import { DemoNote } from '../demo/ui.tsx';
import { OS, PERMS, appIcon, card, categoryChip, esc, featuredIn, feature, icon, offeredIn, plural, pluginPage, say, textIn, type Kit } from '../../store-kit/render.ts';
import { wireStore } from '../../store-kit/client.ts';
import en from '../../landing/i18n/en.json';
import es from '../../landing/i18n/es.json';
import de from '../../landing/i18n/de.json';
import zhHant from '../../landing/i18n/zh-Hant.json';
import zhHans from '../../landing/i18n/zh-Hans.json';

/** The store's words: the site's, so both stores say the same (a language without them reads English). */
const WORDS: Kit['texts'] = { en, es, de, 'zh-Hant': zhHant, 'zh-Hans': zhHans };

/** The catalogue as this Kiosko sees it, once loaded (the setup wizard offers plugins from it too). */
export const store = signal<StoreState | null>(null);
const loading = signal(false);

export async function loadStore(refresh = false): Promise<void> {
  if (loading.value) return;
  loading.value = true;
  try {
    if (refresh) await api.refreshStore().catch(() => undefined);
    store.value = await api.store();
  } catch (err) {
    notify(errorText(err), 'error');
  } finally {
    loading.value = false;
  }
}

/** This Kiosko, for "does it run here" (the browser demo has no real system: it is not judged). */
function env(st: StoreState) {
  return { sdk: st.sdk, platform: OS[st.platform] ? st.platform : 'linux' };
}

/** The user's screens as designed (after any turn), for "fits my screens". */
function myScreens() {
  return (config.value?.screens ?? []).filter((s) => s.enabled !== false).map((s) => ({ id: s.id, name: s.name, width: s.width, height: s.height }));
}

export const where = () => ({ region: regionOf(locale.value), lang: uiLanguage() });

/** The store's parts as the editor shows them: in its language, the pictures from the site, links to its own pages. */
function kitOf(st: StoreState): Kit {
  return {
    lang: uiLanguage(),
    texts: WORDS,
    index: st.index!,
    // The pictures are on the site, next to the catalogue (they are not there offline: client.ts draws the plugins instead).
    root: new URL('../../', st.url).href,
    page: (id) => `#/plugins/store/${encodeURIComponent(id)}`,
    list: '#/plugins/store',
    category: (id) => `#/plugins/store?cat=${encodeURIComponent(id)}`,
    region: regionOf(locale.value),
    presets: st.index?.presets,
    newTab: true,
    market: (p) => marketFor(p, where()),
  };
}

const list = (items: string[]) => listIn(items, uiLanguage());
const regionName = (code: string) => regionNameIn(code, uiLanguage());
const what = (v: string) => (v === 'user' ? tr('perm.user') : v === 'lan' ? tr('perm.lan') : v);

/** Whether it runs here, and why not. */
export function problemOf(p: StorePlugin, st: StoreState): string | null {
  const latest = p.releases[0];
  if (installableRelease(p, env(st))) return null;
  const why = latest && releaseProblem({ sdk: latest.sdk, platforms: latest.platforms ?? p.platforms }, env(st));
  if (why?.code === 'os') return t('store.cantOs', { os: OS[env(st).platform] ?? env(st).platform });
  if (why?.code === 'sdk') return t('store.cantSdk', { range: why.range });
  return tr('store.noRelease');
}

function fitLine(p: StorePlugin): { text: string; level: 'ok' | 'some' | 'none' } | null {
  const screens = myScreens();
  if (!screens.length || !p.widgets.length) return null;
  const per = fitsScreens(p.widgets, screens);
  const n = per.filter((s) => s.fits.length).length;
  if (n === screens.length) return { text: tr('store.fitsAll'), level: 'ok' };
  if (n === 0) return { text: tr('store.fitsNone'), level: 'none' };
  return { text: t('store.fitsSome', { n, total: screens.length }), level: 'some' };
}

function isNewer(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
}

/** What this Kiosko can do with it: nothing (installed, or it does not run here), update or install. */
function stateOf(p: StorePlugin, st: StoreState): { kind: 'installed' | 'update' | 'install' | 'cant'; version?: string } {
  const have = st.installed[p.id];
  const release = installableRelease(p, env(st));
  if (have && (!release || release.version === have || !isNewer(release.version, have))) return { kind: 'installed', version: have };
  if (!release) return { kind: 'cant' };
  return { kind: have ? 'update' : 'install', version: release.version };
}

/** Its button, as markup for the store's parts (a click on `data-act` comes back to the view). */
function actionButton(p: StorePlugin, st: StoreState, size: 'small' | 'big'): string {
  const s = stateOf(p, st);
  if (s.kind === 'installed') return `<span class="ks-badge installed">${icon('check', 13)}${esc(tr('store.installed'))}</span>`;
  if (s.kind === 'cant') return '';
  const label = s.kind === 'update' ? t('store.update', { v: s.version! }) : p.tier === 'found' ? tr('store.installMore') : tr('store.install');
  return `<button type="button" class="ks-button ${size} ${p.tier === 'found' ? '' : 'primary'}" data-act="install" data-id="${esc(p.id)}"${KIOSKO_DEMO ? ' disabled' : ''}>${icon(s.kind === 'update' ? 'arrow-up-circle' : 'download', size === 'big' ? 18 : 14)}${esc(label)}</button>`;
}

/** Under a card: does it run here, does it fit, is it meant for where you are, and its button. */
function cardFoot(p: StorePlugin, st: StoreState): string {
  const problem = problemOf(p, st);
  const market = marketFor(p, where());
  const fit = fitLine(p);
  const state = problem
    ? `<span class="ks-state ks-bad">${icon('circle-x', 14)}${esc(problem)}</span>`
    : market === 'missing'
      ? `<span class="ks-state ks-warn">${icon('map-pin-off', 14)}${esc(tr('store.missingHere'))}</span>`
      : market === 'elsewhere'
        ? `<span class="ks-state ks-warn">${icon('map-pin', 14)}${esc(t('store.elsewhere', { regions: list((p.markets?.only ?? []).map(regionName)) }))}</span>`
        : fit
          ? `<span class="ks-state ${fit.level === 'ok' ? 'ks-good' : fit.level === 'some' ? 'ks-warn' : 'ks-bad'}">${icon(fit.level === 'ok' ? 'circle-check' : fit.level === 'some' ? 'circle-alert' : 'circle-x', 14)}${esc(fit.text)}</span>`
          : '';
  return `${state}<span class="ks-act">${actionButton(p, st, 'small')}</span>`;
}

/**
 * Markup from the store's parts, wired as on the site (pictures, thumbnails, clips, copying), with
 * the editor's buttons (`data-act`) and category chips (`data-cat`) coming back here.
 */
function KitHtml({ html, class: cls, onAct, onCat }: { html: string; class?: string; onAct?: (act: string, id: string) => void; onCat?: (id: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => wireStore(ref.current!, { copied: tr('common.copied') }), [html]);
  return (
    <div
      ref={ref}
      class={cls}
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={(e) => {
        const el = e.target as HTMLElement;
        const act = el.closest<HTMLElement>('[data-act]');
        if (act && onAct) {
          e.preventDefault();
          onAct(act.dataset.act!, act.dataset.id!);
          return;
        }
        const cat = el.closest<HTMLElement>('[data-cat]');
        if (cat && onCat) onCat(cat.dataset.cat!);
      }}
    />
  );
}

/** While the catalogue comes (it is read from this Kiosko: fast, but not instant). */
function Loading() {
  return (
    <p class="muted store-loading" role="status">
      <Icon name="loader" size={16} class="spin" /> {tr('store.loading')}
    </p>
  );
}

/** The store's list: search, categories, "fits my screens", "useful where I am", the picked ones, then every plugin. */
export function StoreView() {
  const st = store.value;
  const query = new URLSearchParams(route.value.split('?')[1] ?? '');
  const [q, setQ] = useState('');
  const [cat, setCat] = useState(query.get('cat') ?? '');
  const [fitsMine, setFitsMine] = useState(true);
  const [mine, setMine] = useState(true);
  const [installing, setInstalling] = useState<StorePlugin | null>(null);
  useEffect(() => {
    if (!store.value) void loadStore();
  }, []);
  // A category from a plugin's page (its crumbs) or from the site.
  useEffect(() => setCat(query.get('cat') ?? ''), [route.value]);
  if (!st) return <Loading />;
  const index = st.index;
  const k = index ? kitOf(st) : null;
  const screens = myScreens();
  const offered = index ? offeredIn(index, uiLanguage()).length : 0;
  const categories = (index?.categories ?? []).filter((c) => index!.plugins.some((p) => p.categories.includes(c.id)));
  const filtering = !!q.trim() || !!cat;
  const shown = (index?.plugins ?? []).filter((p) => {
    if (p.hidden) return false;
    if (cat && !p.categories.includes(cat)) return false;
    if (q.trim()) return matches(p, q, searchText(p));
    // Never hidden from a search: only from the browsing.
    if (mine && marketFor(p, where()) !== 'ok') return false;
    if (fitsMine && screens.length && p.widgets.length && !fitsScreens(p.widgets, screens).some((s) => s.fits.length)) return false;
    return true;
  });
  const fetched = st.fetchedAt ?? (index ? Date.parse(index.generatedAt) : null);
  const stale = !!st.error || st.from === 'snapshot' || (fetched !== null && Date.now() - fetched > 7 * 86400_000);
  const clear = () => {
    setQ('');
    setCat('');
    setFitsMine(false);
    setMine(false);
  };
  const featured = k && !filtering ? featuredIn(shown) : [];
  const onAct = (act: string, id: string) => {
    const p = index?.plugins.find((x) => x.id === id);
    if (act === 'install' && p) setInstalling(p);
  };
  return (
    <div class="store-view">
      <div class="store-tools" role="search">
        <div class="ks-search-row">
          <span dangerouslySetInnerHTML={{ __html: icon('search', 18) }} />
          <input type="search" placeholder={k ? say(k, 'store-search') : tr('store.search')} value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} aria-label={k ? say(k, 'store-search') : tr('store.search')} />
        </div>
        {k && categories.length > 0 && (
          <KitHtml class="ks-chips store-cats" html={[categoryChip(k, '', !cat, 'button'), ...categories.map((c) => categoryChip(k, c.id, cat === c.id, 'button'))].join('')} onCat={(id) => setCat(id === cat ? '' : id)} />
        )}
        <div class="store-meta">
          <label class="check"><input type="checkbox" checked={fitsMine} onChange={(e) => setFitsMine((e.target as HTMLInputElement).checked)} /> {tr('store.fitsMine')}</label>
          <label class="check"><input type="checkbox" checked={mine} onChange={(e) => setMine((e.target as HTMLInputElement).checked)} /> {tr('store.myRegion')}</label>
          {screens.length > 0 && (
            <span class="muted small" title={screens.map((s) => `${s.name} ${s.width}×${s.height}`).join('\n')}>
              <Icon name="monitor" size={13} /> {tr('store.yourScreens')} {screens.map((s) => `${s.name} ${s.width}×${s.height}`).join(' · ')}
            </span>
          )}
          <span class="tb-spacer" />
          {index && (
            <span class={`muted small ${stale && st.error ? 'store-stale' : ''}`} title={st.error ?? ''}>
              {stale && st.error && <Icon name="wifi-off" size={13} />} {t(stale && st.error ? 'store.offline' : 'store.catalogue', { date: dateTime(Date.parse(index.generatedAt)) })}
              {st.from === 'snapshot' ? ` (${tr('store.bundledCopy')})` : ''}
            </span>
          )}
          {!KIOSKO_DEMO && st.online && (
            <button class="btn ghost small" disabled={loading.value} onClick={() => loadStore(true)}>
              <Icon name={loading.value ? 'loader' : 'refresh-cw'} size={13} class={loading.value ? 'spin' : ''} /> {tr('store.refresh')}
            </button>
          )}
        </div>
      </div>
      {KIOSKO_DEMO && <DemoNote k="installHint" />}
      {!index && <p class="ks-empty">{tr('store.empty')}</p>}
      {k && featured.length > 0 && (
        <section class="store-section" aria-labelledby="store-featured-h">
          <h2 id="store-featured-h">{say(k, 'store-featured')}</h2>
          <KitHtml class="ks-features" html={featured.map((p) => feature(p, k)).join('')} />
        </section>
      )}
      {k && (
        <section class="store-section" aria-labelledby="store-all-h">
          <div class="store-section-head">
            <h2 id="store-all-h">{filtering ? (cat ? (textIn(categories.find((c) => c.id === cat)?.label, uiLanguage()) || cat) : say(k, 'store-all-plugins')) : say(k, 'store-all-plugins')}</h2>
            <p class="muted small" aria-live="polite">{plural(k, 'store-shown', shown.length)}{shown.length < offered && !filtering ? ` · ${t('store.hiddenByFilters', { n: offered - shown.length })}` : ''}</p>
          </div>
          {shown.length > 0 ? (
            <KitHtml class="ks-cards" html={shown.map((p) => card(p, k, { foot: cardFoot(p, st) })).join('')} onAct={onAct} />
          ) : (
            <div class="ks-empty">
              <span dangerouslySetInnerHTML={{ __html: icon('search-x', 28) }} />
              <span>{say(k, 'store-none')}</span>
              <button type="button" class="ks-button" onClick={clear}>{say(k, 'store-clear')}</button>
            </div>
          )}
        </section>
      )}
      {installing && <InstallDialog p={installing} st={st} onClose={() => setInstalling(null)} />}
    </div>
  );
}

/** One plugin's page: the site's, with this Kiosko's button and how each widget fits each of this person's screens. */
export function StoreSheet({ id }: { id: string }) {
  const st = store.value;
  const [sheet, setSheet] = useState<StorePluginFile | null>(null);
  const [installing, setInstalling] = useState(false);
  useEffect(() => {
    if (!store.value) void loadStore();
  }, []);
  useEffect(() => {
    setSheet(null);
    api.storePlugin(id).then(setSheet).catch(() => undefined);
  }, [id, st?.index?.generatedAt]);
  // A new plugin's page opens at its top.
  useEffect(() => document.querySelector('.page-view')?.scrollTo({ top: 0 }), [id]);
  if (!st) return <Loading />;
  const p = st.index?.plugins.find((x) => x.id === id);
  if (!p || !st.index) {
    return (
      <div class="ks-empty">
        <span dangerouslySetInnerHTML={{ __html: icon('search-x', 28) }} />
        <span>{t('store.notFound', { id })}</span>
        <a class="ks-button" href="#/plugins/store">{tr('store.back')}</a>
      </div>
    );
  }
  const k = kitOf(st);
  const lang = uiLanguage();
  const screens = myScreens();
  const per = fitsScreens(p.widgets, screens);
  const problem = problemOf(p, st);
  const state = stateOf(p, st);
  const market = marketFor(p, where());
  const site = new URL(`../../${lang === 'en' ? '' : `${lang}/`}store/${p.id}/`, st.url).href;
  const fitsHere = screens.length > 0 && p.widgets.length > 0
    ? `<p class="ks-fine">${esc(tr('store.onYourScreens'))}</p><p class="ks-fits">${per.map((s) => `<span class="ks-fit ${s.ideal.length === p.widgets.length ? 'ks-good' : s.fits.length ? 'ks-warn' : 'ks-bad'}"><b>${esc(s.name)}</b> ${s.fits.length}/${p.widgets.length}</span>`).join('')}</p>`
    : '';
  const action = [
    problem ? `<p class="ks-state ks-bad">${icon('circle-x', 16)}<span>${esc(problem)}</span></p>` : '',
    state.kind === 'installed'
      ? `<p class="ks-state ks-good">${icon('circle-check', 16)}<span>${esc(tr('store.installed'))} · v${esc(state.version ?? '')}</span></p><a class="ks-button" href="#/editor">${icon('layout-dashboard', 16)}${esc(tr('store.toEditor'))}</a>`
      : actionButton(p, st, 'big'),
    fitsHere,
  ].join('');
  const fitOf = (type: string) =>
    per.length
      ? `<p class="ks-fits">${per.map((s) => `<span class="ks-fit ${s.ideal.includes(type) ? 'ks-good' : s.fits.includes(type) ? 'ks-warn' : 'ks-bad'}"><b>${esc(s.name)}</b> ${esc(s.ideal.includes(type) ? tr('store.ideal') : s.fits.includes(type) ? tr('store.fits') : tr('store.tooBig'))}</span>`).join('')}</p>`
      : '';
  const notes = market === 'missing' ? `<p class="ks-note warn">${icon('map-pin-off', 16)}<span>${esc(tr('store.missingHere'))}</span></p>` : '';
  const links = `<a class="ks-link-chip" href="${esc(site)}" target="_blank" rel="noopener noreferrer">${icon('external-link', 15)}${esc(tr('store.onSite'))}</a>`;
  const html = pluginPage(p, sheet, k, { action, notes, widget: (x) => fitOf(x.type), links });
  return (
    <div class="store-sheet">
      {KIOSKO_DEMO && state.kind !== 'installed' && <DemoNote k="installHint" />}
      <KitHtml html={html} onAct={(act) => act === 'install' && setInstalling(true)} />
      {installing && <InstallDialog p={p} st={st} risky={sheet?.riskyOptions.length || p.riskyOptions} onClose={() => setInstalling(false)} />}
    </div>
  );
}

/**
 * Before installing: who it is from, what it says it does on the computer,
 * what else comes with it and where it fits. An unreviewed one needs the
 * "I understand" box ticked first.
 */
export function InstallDialog({ p, st, risky = p.riskyOptions, onClose }: { p: StorePlugin; st: StoreState; risky?: number; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [ok, setOk] = useState(p.tier !== 'found');
  const [busy, setBusy] = useState(false);
  const lang = uiLanguage();
  const release = installableRelease(p, env(st))!;
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  const missing = p.requires.filter((id) => !st.installed[id]).map((id) => st.index?.plugins.find((x) => x.id === id)).filter((x): x is StorePlugin => !!x);
  // What comes along asks too: its permissions add up in the same dialog.
  const perms: StorePlugin['permissions'] = {};
  for (const x of [p, ...missing]) for (const [key] of PERMS) if (x.permissions[key]?.length) perms[key] = [...new Set([...(perms[key] ?? []), ...x.permissions[key]!])];
  const per = fitsScreens(p.widgets, myScreens());
  const install = async () => {
    setBusy(true);
    try {
      const r = await api.installFromStore(p.id, release.version, p.tier === 'found');
      app.value = r.state;
      config.value = r.state.config;
      status.value = r.state.status;
      notify(r.problem ?? t('store.done', { name: textIn(p.name, lang), v: release.version }), r.problem ? 'error' : 'ok');
      await loadStore();
      ref.current?.close();
      onClose();
    } catch (err) {
      notify(errorText(err), 'error');
    } finally {
      setBusy(false);
    }
  };
  const who = [p.publisher?.name, p.tier === 'official' ? tr('store.official') : p.tier === 'found' ? tr('store.unreviewed') : null, p.license].filter(Boolean).join(' · ');
  const sep = fullWidth() ? '：' : ': ';
  return (
    <dialog ref={ref} class="store-dialog" aria-labelledby="install-h" onClose={onClose} onClick={(e) => e.target === ref.current && ref.current?.close()}>
      <header class="store-dialog-head">
        <span dangerouslySetInnerHTML={{ __html: appIcon(p, 20) }} />
        <div>
          <h3 id="install-h">{t('store.dialogTitle', { name: textIn(p.name, lang), v: release.version })}</h3>
          <p class="muted small">{t('store.by', { who })}</p>
        </div>
      </header>
      <p>{tr('store.codeRuns')}</p>
      <ul class="ks-perms">
        {PERMS.map(([key, ico]) => (
          <li class={perms[key]?.length ? '' : 'ks-none'}>
            <span class="ks-perm-ic" dangerouslySetInnerHTML={{ __html: icon(ico, 16) }} />
            <span>
              <b>{tr(`perm.${key}`)}</b>
              {perms[key]?.length ? listOf(perms[key]!.map(what)) : '—'}
            </span>
          </li>
        ))}
      </ul>
      {risky > 0 && <p class="ks-note warn small"><Icon name="triangle-alert" size={15} /> <span>{t('store.risky', { n: risky })}</span></p>}
      <p class="muted small">{tr('store.permNote')}</p>
      {missing.length > 0 && <p class="small">{t('store.alsoInstalls', { list: list(missing.map((x) => textIn(x.name, lang))) })}</p>}
      {per.length > 0 && p.widgets.length > 0 && (
        <p class="ks-fits">
          {per.map((s) => (
            <span class={`ks-fit ${s.ideal.length === p.widgets.length ? 'ks-good' : s.fits.length ? 'ks-warn' : 'ks-bad'}`}>
              <b>{s.name}</b>{sep}{s.fits.length}/{p.widgets.length}
            </span>
          ))}
        </p>
      )}
      {p.tier === 'found' && (
        <div class="banner warn small">
          <label class="check">
            <input type="checkbox" checked={ok} onChange={(e) => setOk((e.target as HTMLInputElement).checked)} />
            <span>{tr('store.nobodyLooked')}</span>
            <b>{tr('store.understand')}</b>
          </label>
        </div>
      )}
      <div class="dialog-actions">
        <button class="btn ghost" onClick={() => ref.current?.close()}>{tr('common.cancel')}</button>
        <button class="btn primary" disabled={!ok || busy} onClick={install}>
          <Icon name={busy ? 'loader' : 'download'} size={14} class={busy ? 'spin' : ''} /> {busy ? tr('store.installing') : t('store.installVersion', { v: release.version })}
        </button>
      </div>
    </dialog>
  );
}

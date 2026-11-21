/**
 * The plugin store inside the Plugins page (docs/es/tienda.md, §6.2–6.3):
 * the same catalogue as https://kioskolcd.dev/store/, crossed with this
 * Kiosko (its system and plugin API), these screens and this language.
 * `#/plugins/store/<id>` opens a plugin's page (the site's "Open in
 * Kiosko" lands there): it never installs anything without a click, and
 * installing always goes through the dialog that says what the plugin
 * does first.
 */
import { signal } from '@preact/signals';
import { useEffect, useRef, useState } from 'preact/hooks';
import { fitsScreens, installableRelease, marketFor, matches, regionOf, releaseProblem, searchText, textIn, type StorePlugin, type StorePluginFile } from '@kiosko/core/store';
import { api, type StoreState } from '../api.ts';
import { Icon } from '../icons.tsx';
import { dateTime, errorText, t, tr, uiLanguage } from '../i18n.ts';
import { app, config, locale, notify, status } from '../store.ts';
import { DemoNote } from '../demo/ui.tsx';

const store = signal<StoreState | null>(null);
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

const OS: Record<string, string> = { linux: 'Linux', darwin: 'macOS', win32: 'Windows' };
const PERMS = [
  ['network', 'globe'],
  ['exec', 'square-terminal'],
  ['files', 'folder-open'],
  ['devices', 'usb'],
] as const;

/** This Kiosko, for "does it run here" (the browser demo has no real system: it is not judged). */
function env(st: StoreState) {
  return { sdk: st.sdk, platform: OS[st.platform] ? st.platform : 'linux' };
}

/** The user's screens as designed (after any turn), for "fits my screens". */
function myScreens() {
  return (config.value?.screens ?? []).filter((s) => s.enabled !== false).map((s) => ({ id: s.id, name: s.name, width: s.width, height: s.height }));
}

/** A picture of the site (a path from its root), from where the catalogue lives. */
const siteUrl = (st: StoreState, path: string) => new URL(path, new URL('../../', st.url)).href;

/** The picture that shows a plugin best on a panel: its widest widget's (panels are wide), else its cover or an interlude's poster. */
function bestPicture(p: StorePlugin, lang: string): { src: string; size?: { w: number; h: number } } | null {
  const withShots = p.widgets.filter((w) => w.shots);
  const w = withShots.find((x) => x.shotSize && x.shotSize.w / x.shotSize.h >= 2.4) ?? withShots[0];
  const shot = w?.shots?.[lang] ?? w?.shots?.en;
  if (shot) return { src: shot, size: w!.shotSize };
  const cover = p.cover ?? p.interludes.find((i) => i.poster)?.poster;
  return cover ? { src: cover } : null;
}

/** A plugin's picture on a small screen, as on the site's cards; without one (or offline), its drawing. */
function StoreScreen({ p, st, lang }: { p: StorePlugin; st: StoreState; lang: string }) {
  const [failed, setFailed] = useState(false);
  const pic = bestPicture(p, lang);
  const sized = !!pic?.size && !failed;
  return (
    <span class="store-screen" aria-hidden="true">
      {/* With its size known, the screen has its shape before the picture arrives. */}
      <span class={`store-bezel ${sized ? 'sized' : ''}`} style={sized ? { '--ar': String(pic!.size!.w / pic!.size!.h) } : undefined}>
        {pic && !failed ? <img src={siteUrl(st, pic.src)} alt="" loading="lazy" decoding="async" width={pic.size?.w} height={pic.size?.h} onError={() => setFailed(true)} /> : <span class="store-poster"><Icon name={p.icon ?? 'puzzle'} size={30} /></span>}
      </span>
    </span>
  );
}

const regionName = (code: string) => {
  try {
    return new Intl.DisplayNames([uiLanguage()], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
};
const languageName = (tag: string) => {
  try {
    return new Intl.DisplayNames([tag], { type: 'language' }).of(tag) ?? tag;
  } catch {
    return tag;
  }
};
const list = (items: string[]) => new Intl.ListFormat(uiLanguage(), { type: 'conjunction' }).format(items);
const what = (v: string) => (v === 'user' ? tr('perm.user') : v === 'lan' ? tr('perm.lan') : v);

/** Whether it runs here, and why not. */
function problemOf(p: StorePlugin, st: StoreState): string | null {
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

function TierPill({ p }: { p: StorePlugin }) {
  if (p.tier === 'official') return <span class="pill official-pill">{tr('store.official')}</span>;
  if (p.tier === 'found') return <span class="pill warn-pill">{tr('store.unreviewed')}</span>;
  return null;
}

function PermissionChips({ perms }: { perms: StorePlugin['permissions'] }) {
  const any = PERMS.filter(([k]) => perms[k]?.length);
  if (!any.length) return <span class="perm-chip"><Icon name="shield-check" size={12} /> {tr('store.noPermissions')}</span>;
  return (
    <>
      {any.map(([k, icon]) => (
        <span class="perm-chip" title={tr(`perm.${k}Help`)}>
          <Icon name={icon} size={12} /> {tr(`perm.${k}`)}: {perms[k]!.map(what).join(', ')}
        </span>
      ))}
    </>
  );
}

/** The button of a plugin: installed, update, install (unreviewed ones ask more), or why not. */
function Action({ p, st, onInstall }: { p: StorePlugin; st: StoreState; onInstall: (p: StorePlugin) => void }) {
  const have = st.installed[p.id];
  const release = installableRelease(p, env(st));
  if (have && (!release || release.version === have || !isNewer(release.version, have))) return <span class="store-installed"><Icon name="check" size={14} /> {tr('store.installed')}</span>;
  if (!release) return null;
  if (KIOSKO_DEMO) return <button class="btn small" disabled>{tr('store.install')}</button>;
  return (
    <button class={`btn small ${p.tier === 'found' ? '' : 'primary'}`} onClick={(e) => {
      e.stopPropagation();
      onInstall(p);
    }}>
      <Icon name="download" size={13} /> {have ? t('store.update', { v: release.version }) : p.tier === 'found' ? tr('store.installMore') : tr('store.install')}
    </button>
  );
}

function isNewer(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
}

/** The store's list: search, category, fits my screens, my region. */
export function StoreView() {
  const st = store.value;
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const [fitsMine, setFitsMine] = useState(true);
  const [mine, setMine] = useState(true);
  const [installing, setInstalling] = useState<StorePlugin | null>(null);
  useEffect(() => {
    if (!store.value) void loadStore();
  }, []);
  const lang = uiLanguage();
  if (!st) return <p class="muted">…</p>;
  const index = st.index;
  const where = { region: regionOf(locale.value), lang };
  const screens = myScreens();
  const categories = (index?.categories ?? []).filter((c) => index!.plugins.some((p) => p.categories.includes(c.id)));
  const shown = (index?.plugins ?? []).filter((p) => {
    if (cat && !p.categories.includes(cat)) return false;
    if (q.trim()) return matches(p, q, searchText(p));
    // Never hidden from a search: only from the browsing.
    if (mine && marketFor(p, where) !== 'ok') return false;
    if (fitsMine && screens.length && p.widgets.length && !fitsScreens(p.widgets, screens).some((s) => s.fits.length)) return false;
    return true;
  });
  const fetched = st.fetchedAt ?? (index ? Date.parse(index.generatedAt) : null);
  const stale = !!st.error || st.from === 'snapshot' || (fetched !== null && Date.now() - fetched > 7 * 86400_000);
  return (
    <div class="store-view">
      <div class="store-bar">
        <input class="input" type="search" placeholder={tr('store.search')} value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} aria-label={tr('store.search')} />
        <label class="check"><input type="checkbox" checked={fitsMine} onChange={(e) => setFitsMine((e.target as HTMLInputElement).checked)} /> {tr('store.fitsMine')}</label>
        <label class="check"><input type="checkbox" checked={mine} onChange={(e) => setMine((e.target as HTMLInputElement).checked)} /> {tr('store.myRegion')}</label>
      </div>
      {categories.length > 0 && (
        <div class="store-cats" role="group" aria-label={tr('store.allCategories')}>
          <button type="button" class={`chip ${cat ? '' : 'on'}`} aria-pressed={!cat} onClick={() => setCat('')}>{tr('store.allCategories')}</button>
          {categories.map((c) => (
            <button type="button" class={`chip ${cat === c.id ? 'on' : ''}`} aria-pressed={cat === c.id} onClick={() => setCat(cat === c.id ? '' : c.id)}>{textIn(c.label, lang)}</button>
          ))}
        </div>
      )}
      <div class="store-meta muted small">
        {screens.length > 0 && (
          <span>
            <Icon name="monitor" size={13} /> {tr('store.yourScreens')} {screens.map((s) => `${s.name} ${s.width}×${s.height}`).join(' · ')}
          </span>
        )}
        <span class="tb-spacer" />
        {index && (
          <span title={st.error ?? ''}>
            {t(stale && st.error ? 'store.offline' : 'store.catalogue', { date: dateTime(Date.parse(index.generatedAt)) })}
            {st.from === 'snapshot' ? ` (${tr('store.bundledCopy')})` : ''}
          </span>
        )}
        {!KIOSKO_DEMO && st.online && (
          <button class="btn ghost small" disabled={loading.value} onClick={() => loadStore(true)}>
            <Icon name={loading.value ? 'loader' : 'refresh-cw'} size={13} /> {tr('store.refresh')}
          </button>
        )}
      </div>
      {KIOSKO_DEMO && <DemoNote k="installHint" />}
      {!index && <p class="muted">{tr('store.empty')}</p>}
      {index && !shown.length && <p class="muted">{tr('store.none')}</p>}
      <div class="store-list">
        {shown.map((p) => {
          const fit = fitLine(p);
          const problem = problemOf(p, st);
          const market = marketFor(p, where);
          return (
            <article class={`card store-row ${p.tier}`} onClick={() => (location.hash = `#/plugins/store/${p.id}`)}>
              <StoreScreen p={p} st={st} lang={lang} />
              <div class="store-row-main">
                <div class="store-row-title">
                  <span class="plugin-icon small"><Icon name={p.icon ?? 'puzzle'} size={15} /></span>
                  <a href={`#/plugins/store/${p.id}`} onClick={(e) => e.stopPropagation()}><b>{textIn(p.name, lang)}</b></a>
                  <TierPill p={p} />
                  <span class="muted mono small">v{p.latest}</span>
                  {p.bundled && <span class="pill">{tr('store.bundled')}</span>}
                </div>
                <p class="muted small store-desc">{textIn(p.description, lang)}</p>
                <div class="store-facts small">
                  {problem ? (
                    <span class="bad"><Icon name="circle-x" size={13} /> {problem}</span>
                  ) : (
                    <>
                      {fit && <span class={fit.level === 'ok' ? 'good' : fit.level === 'some' ? 'warn' : 'bad'}><Icon name={fit.level === 'ok' ? 'circle-check' : fit.level === 'some' ? 'circle-alert' : 'circle-x'} size={13} /> {fit.text}</span>}
                      <span class="good"><Icon name="circle-check" size={13} /> {list(p.platforms.map((x) => OS[x] ?? x))}</span>
                    </>
                  )}
                  {market === 'elsewhere' && <span class="warn">{t('store.elsewhere', { regions: list((p.markets?.only ?? []).map(regionName)) })}</span>}
                  {market === 'missing' && <span class="warn">{tr('store.missingHere')}</span>}
                  <PermissionChips perms={p.permissions} />
                </div>
              </div>
              <div class="store-row-action">
                <Action p={p} st={st} onInstall={setInstalling} />
              </div>
            </article>
          );
        })}
      </div>
      {installing && <InstallDialog p={installing} st={st} onClose={() => setInstalling(null)} />}
    </div>
  );
}

/** One plugin's page: the same facts as the site's, plus how it fits each of this person's screens. */
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
  const lang = uiLanguage();
  if (!st) return <p class="muted">…</p>;
  const p = st.index?.plugins.find((x) => x.id === id);
  const back = (
    <a class="btn ghost small" href="#/plugins/store">
      <Icon name="arrow-left" size={13} /> {tr('store.back')}
    </a>
  );
  if (!p) return (
    <div class="store-sheet">
      {back}
      <p class="muted">{t('store.notFound', { id })}</p>
    </div>
  );
  const screens = myScreens();
  const per = fitsScreens(p.widgets, screens);
  const problem = problemOf(p, st);
  const latest = p.releases[0];
  const risky = sheet?.riskyOptions ?? [];
  const where = { region: regionOf(locale.value), lang };
  const market = marketFor(p, where);
  const site = new URL(`../../${lang === 'en' ? '' : `${lang}/`}store/${p.id}/`, st.url).href;
  return (
    <div class="store-sheet">
      {back}
      <header class="store-sheet-head">
        <span class="plugin-icon big"><Icon name={p.icon ?? 'puzzle'} size={28} /></span>
        <div class="store-sheet-title">
          <h2>
            {textIn(p.name, lang)} <TierPill p={p} /> {p.bundled && <span class="pill">{tr('store.bundled')}</span>}
          </h2>
          <p class="muted">{textIn(p.description, lang)}</p>
          <p class="muted mono small">
            {p.package} · v{p.latest}{latest?.date ? ` · ${dateTime(Date.parse(latest.date))}` : ''} · {p.license || '—'}
          </p>
        </div>
        <div class="store-sheet-action">
          {problem ? <span class="bad small"><Icon name="circle-x" size={13} /> {problem}</span> : <Action p={p} st={st} onInstall={() => setInstalling(true)} />}
        </div>
      </header>
      {p.tier === 'found' && (
        <div class="banner warn">
          <Icon name="triangle-alert" size={16} /> {tr('store.nobodyLooked')}
        </div>
      )}
      {market === 'elsewhere' && <div class="banner info">{t('store.elsewhere', { regions: list((p.markets?.only ?? []).map(regionName)) })}{p.markets?.note ? `: ${textIn(p.markets.note, lang)}` : ''}</div>}
      {market === 'missing' && <div class="banner info">{tr('store.missingHere')}</div>}
      <StoreGallery p={p} st={st} lang={lang} />
      <div class="grid-2 gap-lg">
        <section class="card">
          {p.widgets.length > 0 && (
            <>
              <h3><Icon name="layout-grid" size={16} /> {tr('store.widgets')} · {tr('store.onYourScreens')}</h3>
              <table class="store-table small">
                <thead>
                  <tr>
                    <th />
                    <th>{tr('store.min')}</th>
                    <th>{tr('store.preferred')}</th>
                    {screens.map((s) => <th>{s.name}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {p.widgets.map((w) => (
                    <tr>
                      <th scope="row">{textIn(w.name, lang)}</th>
                      <td class="mono">{w.min ? `${w.min.w}×${w.min.h}` : '—'}</td>
                      <td class="mono">{w.preferred ? `${w.preferred.w}×${w.preferred.h}` : '—'}</td>
                      {per.map((s) => (
                        <td class={s.ideal.includes(w.type) ? 'good' : s.fits.includes(w.type) ? 'warn' : 'bad'}>
                          {s.ideal.includes(w.type) ? tr('store.ideal') : s.fits.includes(w.type) ? tr('store.fits') : tr('store.tooBig')}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          {p.interludes.length > 0 && (
            <>
              <h3><Icon name="clapperboard" size={16} /> {tr('store.interludes')}</h3>
              <ul class="plain small">
                {p.interludes.map((i) => <li><b>{textIn(i.name, lang)}</b> <span class="muted">{textIn(i.description, lang)}</span></li>)}
              </ul>
            </>
          )}
          <h3><Icon name="history" size={16} /> {tr('store.versions')}</h3>
          <ul class="plain small">
            {p.releases.slice(0, 6).map((r) => (
              <li>
                <span class="mono">{r.version}</span> <span class="muted">{r.date ? dateTime(Date.parse(r.date)) : ''}</span>
                {r.deprecated && <span class="pill" title={r.deprecated}>{tr('store.deprecated')}</span>}
                {r.addedPermissions && <span class="pill warn-pill">{tr('store.morePermissions')}</span>}
              </li>
            ))}
          </ul>
        </section>
        <section class="card">
          <h3><Icon name="shield" size={16} /> {tr('store.does')}</h3>
          <div class="plugin-perms"><PermissionChips perms={p.permissions} /></div>
          {(risky.length > 0 || p.riskyOptions > 0) && <p class="small warn">{t('store.risky', { n: risky.length || p.riskyOptions })}</p>}
          {risky.length > 0 && <ul class="plain mono small muted">{risky.map((r) => <li>{r.path}</li>)}</ul>}
          <p class="muted small">{tr('store.permNote')}</p>
          <dl class="store-facts-list small">
            <dt>{tr('store.works')}</dt>
            <dd>{list(p.platforms.map((x) => OS[x] ?? x))}{latest?.sdk ? ` · API ${latest.sdk}` : ''}</dd>
            <dt>{tr('store.languages')}</dt>
            <dd>{list(p.languages.map(languageName))}</dd>
            {p.requires.length > 0 && (
              <>
                <dt>{tr('plugins.needs')}</dt>
                <dd>{p.requires.join(', ')}</dd>
              </>
            )}
            {p.publisher?.name && (
              <>
                <dt>{tr('store.author')}</dt>
                <dd>{p.publisher.name}</dd>
              </>
            )}
          </dl>
          {p.popularity?.weekly ? <p class="muted small">{t('store.downloads', { n: p.popularity.weekly })}</p> : null}
          <p class="store-links small">
            {p.links.repository && <a href={p.links.repository} target="_blank" rel="noopener noreferrer"><Icon name="code-xml" size={12} /> {tr('store.source')}</a>}
            {p.links.issues && <a href={p.links.issues} target="_blank" rel="noopener noreferrer"><Icon name="bug" size={12} /> {tr('store.issues')}</a>}
            {p.links.funding && <a href={p.links.funding} target="_blank" rel="noopener noreferrer"><Icon name="heart" size={12} /> {tr('store.funding')}</a>}
            <a href={site} target="_blank" rel="noopener noreferrer"><Icon name="external-link" size={12} /> {tr('store.onSite')}</a>
          </p>
        </section>
      </div>
      {installing && <InstallDialog p={p} st={st} risky={risky.length || p.riskyOptions} onClose={() => setInstalling(false)} />}
    </div>
  );
}

/** A plugin's pictures: one big, on a panel, and the others as thumbnails that bring theirs onto it. */
function StoreGallery({ p, st, lang }: { p: StorePlugin; st: StoreState; lang: string }) {
  const [on, setOn] = useState(0);
  const [failed, setFailed] = useState<Set<number>>(new Set());
  const shots = p.widgets.filter((w) => w.shots).map((w, i) => ({ i, name: textIn(w.name, lang), description: textIn(w.description, lang), src: siteUrl(st, w.shots![lang] ?? w.shots!.en!) })).filter((x) => !failed.has(x.i));
  const cover = !p.widgets.some((w) => w.shots) ? bestPicture(p, lang)?.src : null;
  if (!shots.length && !cover) return null;
  const fail = (i: number) => setFailed((f) => new Set(f).add(i));
  const main = shots.find((x) => x.i === on) ?? shots[0];
  return (
    <div class="store-gallery">
      <figure class="store-stage">
        <span class="store-slab">
          {main ? <img key={main.src} src={main.src} alt={main.name} onError={() => fail(main.i)} /> : <img src={siteUrl(st, cover!)} alt={textIn(p.name, lang)} onError={() => fail(-1)} />}
        </span>
        {main && <figcaption class="small"><b>{main.name}</b> <span class="muted">{main.description}</span></figcaption>}
      </figure>
      {shots.length > 1 && (
        <div class="store-thumbs">
          {shots.map((x) => (
            <button type="button" aria-pressed={x === main} onClick={() => setOn(x.i)}>
              <span class="store-thumb"><img src={x.src} alt="" loading="lazy" /></span>
              <span>{x.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Before installing: who it is from, what it says it does on the computer,
 * what else comes with it and where it fits. An unreviewed one needs the
 * "I understand" box ticked first.
 */
function InstallDialog({ p, st, risky = p.riskyOptions, onClose }: { p: StorePlugin; st: StoreState; risky?: number; onClose: () => void }) {
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
  for (const x of [p, ...missing]) for (const [k] of PERMS) if (x.permissions[k]?.length) perms[k] = [...new Set([...(perms[k] ?? []), ...x.permissions[k]!])];
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
  return (
    <dialog ref={ref} class="store-dialog" onClose={onClose} onClick={(e) => e.target === ref.current && ref.current?.close()}>
      <h3>{t('store.dialogTitle', { name: textIn(p.name, lang), v: release.version })}</h3>
      <p class="muted small">{t('store.by', { who })}</p>
      <p>{tr('store.codeRuns')}</p>
      <ul class="store-perm-list">
        {PERMS.map(([k, icon]) => (
          <li class={perms[k]?.length ? '' : 'muted'}>
            <Icon name={icon} size={14} />
            <b>{tr(`perm.${k}`)}:</b> {perms[k]?.length ? perms[k]!.map(what).join(', ') : '—'}
          </li>
        ))}
        {risky > 0 && <li class="warn"><Icon name="triangle-alert" size={14} /> {t('store.risky', { n: risky })}</li>}
      </ul>
      <p class="muted small">{tr('store.permNote')}</p>
      {missing.length > 0 && <p class="small">{t('store.alsoInstalls', { list: list(missing.map((x) => textIn(x.name, lang))) })}</p>}
      {per.length > 0 && p.widgets.length > 0 && (
        <p class="small">
          {per.map((s) => (
            <span class={`store-fit ${s.ideal.length === p.widgets.length ? 'good' : s.fits.length ? 'warn' : 'bad'}`}>
              {s.name}: {s.fits.length}/{p.widgets.length}
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
          <Icon name={busy ? 'loader' : 'download'} size={14} /> {busy ? tr('store.installing') : t('store.installVersion', { v: release.version })}
        </button>
      </div>
    </dialog>
  );
}

/**
 * The first-run setup wizard: welcome and language, your panel(s), what to
 * show, finishing touches, done. Offered on its own while the config is the
 * first run's (`offersSetup`), and from Settings and Screens any time; it
 * can always be skipped. Its progress is kept in this browser (a reload goes
 * on where it was), and what it makes is one edit of the config, through
 * the editor's own store (Ctrl+Z undoes it). The logic is in logic.ts.
 */
import { effect, signal } from '@preact/signals';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { offersSetup } from '@kiosko/core/starter';
import { installableRelease, marketFor, type StorePlugin } from '@kiosko/core/store';
import { api } from '../api.ts';
import { Icon } from '../icons.tsx';
import { UI_LANGUAGES, aside, errorText, t, tr, uiLanguage, usbGuideUrl } from '../i18n.ts';
import { app, commit, config, edit, go, lastFrame, notify, pageId, screenId, toast, widgets } from '../store.ts';
import { InstallDialog, loadStore, store, where } from '../views/Store.tsx';
import { appIcon, textIn } from '../../store-kit/render.ts';
import { DemoFrame } from '../demo/ui.tsx';
import {
  CURRENT,
  STARTER,
  STEPS,
  STORAGE_KEY,
  addsTo,
  alreadyThere,
  applySetup,
  canGoOn,
  freshState,
  fromModel,
  fromStarter,
  fromTrcc,
  fromUsb,
  nextStep,
  pictureOf,
  presetOf,
  prevStep,
  previewScreen,
  readState,
  templatesFor,
  tryIt,
  uniqueName,
  type BuildContext,
  type PanelChoice,
  type StepId,
  type WizardState,
} from './logic.ts';
import type { Template } from '../editor/templates.ts';
import { STARTER_NAMES } from '@kiosko/core/model';
import { localize, pickLocale, type Localized } from '@kiosko/sdk/i18n';

/** Open now. */
export const wizardOpen = signal(false);
const state = signal<WizardState>(freshState());

function readSaved(): WizardState | null {
  try {
    return readState(localStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}
function save(s: WizardState | null): void {
  try {
    if (s) localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* private mode: it just won't resume */
  }
}

/** Opens the wizard where it was left (or at `at`). A first run's panels, found at its start, are where it starts from. */
export function openWizard(at?: StepId): void {
  const cfg = config.value;
  const saved = readSaved();
  const s = saved && !saved.made ? saved : { ...freshState(), panels: cfg ? fromStarter(cfg) : [] };
  state.value = at ? { ...s, step: at } : s;
  wizardOpen.value = true;
}

/** After boot: offered on its own while the setup is to do (never in the browser demo, whose sample is not a first run). */
export function offerWizard(): void {
  const cfg = config.value;
  if (!KIOSKO_DEMO && cfg && offersSetup(cfg)) openWizard();
}

function set(fn: (s: WizardState) => WizardState): void {
  state.value = fn(state.value);
  save(state.value);
}

/** The panel's language: the config's, or with "auto" the system's (what the panel paints in). */
function panelLocale(): string {
  const l = config.value?.locale;
  return !l || l === 'auto' ? (app.value?.locale ?? 'en') : l;
}

function templateName(tp: Template): string {
  if (tp.id === STARTER) return localize(STARTER_NAMES.page as Localized, uiLanguage());
  if (tp.id === CURRENT) return tr('wiz.current');
  return tp.name ?? tr(`tpl.${tp.id}` as Parameters<typeof tr>[0]);
}

function buildContext(): BuildContext {
  const cfg = config.value!;
  const catalog = (app.value?.catalog ?? []).filter((p) => p.enabled);
  const has = (type: string) => widgets.value.has(type);
  const locale = panelLocale();
  const used = cfg.screens.flatMap((s) => s.pages.flatMap((p) => p.tiles.flatMap((x) => x.widgets.map((w) => w.type))));
  return {
    has,
    hasInterlude: (type) => catalog.some((p) => p.interludes.some((i) => i.type === type)),
    templates: templatesFor(catalog, has, locale),
    locale,
    pageName: templateName,
    titleOf: (type) => widgets.value.get(type)?.name,
    // Where the first start found agents in use, its page has them: so does the wizard's.
    agents: cfg.screens.length === 0 || used.includes('agents/sessions') || addsTo(cfg),
    weather: !!(state.value.location ?? cfg.location),
    screens: cfg.screens,
  };
}

/** Builds the config, as one edit (one Ctrl+Z), and goes to the last step. */
function finish(): void {
  const s = state.value;
  const ctx = buildContext();
  let made: string[] = [];
  edit((d) => {
    const before = new Set(d.screens.map((x) => x.id));
    const next = applySetup(d, s, ctx);
    Object.assign(d, next);
    // Every screen it builds is new (a fresh id), whether it replaced the first run's or was added.
    made = next.screens.filter((x) => !before.has(x.id)).map((x) => x.id);
  });
  const first = config.value?.screens.find((x) => made.includes(x.id));
  if (first) {
    screenId.value = first.id;
    pageId.value = first.pages[0]?.id ?? null;
  }
  set((x) => ({ ...x, step: 'done', made }));
}

/** "Skip, I'll set it up myself": not offered again; its progress stays for Settings → Setup. */
function skip(): void {
  if (!config.value?.setup || config.value.setup === 'pending') commit((d) => (d.setup = 'skipped'));
  wizardOpen.value = false;
}

function close(): void {
  // Finished: nothing to resume.
  if (state.value.step === 'done') save(null);
  wizardOpen.value = false;
}

export function Wizard() {
  const ref = useRef<HTMLDialogElement>(null);
  const head = useRef<HTMLHeadingElement>(null);
  const s = state.value;
  const i = STEPS.indexOf(s.step);
  // Each step's title takes the focus (after the dialog opens: it gives it to its first button), so a screen reader reads where it is.
  useLayoutEffect(() => {
    if (!ref.current?.open) ref.current?.showModal();
    head.current?.focus();
    ref.current?.querySelector('.wiz-body')?.scrollTo(0, 0);
  }, [s.step]);
  const done = s.step === 'done';
  return (
    <dialog
      ref={ref}
      class="wizard"
      aria-labelledby="wiz-title"
      onCancel={(e) => {
        e.preventDefault();
        if (done) close();
        else skip();
      }}
    >
      <header class="wiz-head">
        <div class="wiz-brand">
          <WizLogo />
          <span id="wiz-title">{tr('wiz.title')}</span>
        </div>
        <ol class="wiz-steps" aria-label={tr('wiz.progress')}>
          {STEPS.map((id, n) => (
            <li class={n < i ? 'past' : n === i ? 'on' : ''} aria-current={n === i ? 'step' : undefined}>
              <span class="wiz-dot" aria-hidden="true">{n < i ? <Icon name="check" size={12} /> : n + 1}</span>
              <span class="wiz-step-name">{tr(`wiz.step.${id}` as Parameters<typeof tr>[0])}</span>
            </li>
          ))}
        </ol>
        {!done && (
          <button class="ks-button small wiz-skip" onClick={skip}>
            {tr('wiz.skip')}
          </button>
        )}
      </header>
      <div class="wiz-body">
        <h2 ref={head} tabIndex={-1} class="wiz-h">
          {tr(`wiz.h.${s.step}` as Parameters<typeof tr>[0])}
        </h2>
        {s.step === 'welcome' && <Welcome />}
        {s.step === 'panel' && <Panels />}
        {s.step === 'show' && <Show />}
        {s.step === 'touches' && <Touches />}
        {s.step === 'done' && <Done />}
      </div>
      <footer class="wiz-foot">
        {i > 0 && !done && (
          <button class="ks-button" onClick={() => set((x) => ({ ...x, step: prevStep(x.step) }))}>
            <Icon name="arrow-left" size={16} /> {tr('wiz.back')}
          </button>
        )}
        <span class="tb-spacer" />
        {/* The editor's toasts are under the dialog: what it says shows here too. */}
        {toast.value && <span class={`wiz-toast ${toast.value.kind}`} role="status">{toast.value.text}</span>}
        {s.step === 'panel' && !canGoOn(s) && <span class="muted small" role="status">{tr('wiz.needPanel')}</span>}
        {s.step === 'touches' ? (
          <button class="ks-button primary" onClick={finish}>
            <Icon name="sparkles" size={16} /> {tr('wiz.finish')}
          </button>
        ) : done ? (
          <button class="ks-button primary" onClick={() => (close(), go('editor'))}>
            {tr('wiz.toEditor')} <Icon name="arrow-right" size={16} />
          </button>
        ) : (
          <button class="ks-button primary" disabled={!canGoOn(s)} onClick={() => set((x) => ({ ...x, step: nextStep(x.step) }))}>
            {tr(s.step === 'welcome' ? 'wiz.start' : 'wiz.next')} <Icon name="arrow-right" size={16} />
          </button>
        )}
      </footer>
    </dialog>
  );
}

function WizLogo() {
  return (
    <svg viewBox="0 0 64 64" width="26" height="26" aria-hidden="true">
      <defs>
        <linearGradient id="wlg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#8B5CF6" />
          <stop offset="1" stop-color="#22D3EE" />
        </linearGradient>
      </defs>
      <rect x="6" y="6" width="30" height="22" rx="5" fill="url(#wlg)" />
      <rect x="40" y="6" width="18" height="22" rx="5" fill="#22D3EE" opacity=".55" />
      <rect x="6" y="32" width="18" height="26" rx="5" fill="#8B5CF6" opacity=".55" />
      <rect x="28" y="32" width="30" height="26" rx="5" fill="url(#wlg)" opacity=".85" />
    </svg>
  );
}

// ---------- 1. Welcome and language ----------

function Welcome() {
  const cfg = config.value!;
  const system = app.value?.locale ?? navigator.language;
  const auto = !cfg.locale || cfg.locale === 'auto';
  const name = (l: string) => UI_LANGUAGES.find((x) => x.id === l)?.name ?? l;
  const editorLang = uiLanguage();
  const panelLang = pickLocale(UI_LANGUAGES.map((l) => l.id), panelLocale());
  const panelName = (() => {
    try {
      return new Intl.DisplayNames([editorLang], { type: 'language' }).of(panelLocale()) ?? panelLocale();
    } catch {
      return panelLocale();
    }
  })();
  // Not an edit of the person's work: the setup is still to do after it.
  const choose = (v: string) => commit((d) => (d.locale = v === 'auto' ? 'auto' : v));
  const current = auto ? 'auto' : editorLang;
  return (
    <>
      <p class="wiz-lead">{tr('wiz.what')}</p>
      <ul class="wiz-points">
        <li><Icon name="usb" size={16} /> {tr('wiz.point1')}</li>
        <li><Icon name="layout-dashboard" size={16} /> {tr('wiz.point2')}</li>
        <li><Icon name="sparkles" size={16} /> {tr('wiz.point3')}</li>
      </ul>
      <fieldset class="wiz-field">
        <legend>{tr('wiz.language')}</legend>
        <div class="wiz-choices" role="radiogroup" aria-label={tr('wiz.language')}>
          {[['auto', aside(name(editorLang), tr('settings.auto'))] as const, ...UI_LANGUAGES.map((l) => [l.id, l.name] as const)].map(([v, l]) => (
            <button class={`wiz-choice ${current === v ? 'on' : ''}`} role="radio" aria-checked={current === v} lang={v === 'auto' ? undefined : v} onClick={() => choose(v)}>
              {l}
            </button>
          ))}
        </div>
        <p class="muted small">
          {auto && panelLang !== editorLang ? t('wiz.langBoth', { editor: name(editorLang), panel: panelName, system }) : t('wiz.langOne', { lang: name(editorLang) })}
        </p>
      </fieldset>
    </>
  );
}

// ---------- 2. Your panel(s) ----------

type Found = Awaited<ReturnType<typeof api.discover>>;
/** What the last detection found (kept while the editor is open). */
const found = signal<Found | null>(null);
const detecting = signal(false);
const TRCC_URL = 'http://127.0.0.1:8099';

/** The browser demo has no panels: it shows one, said to be simulated. */
const SIMULATED: Found = { trcc: [], usb: [{ serial: 'DEMO-0001', key: 'DEMO-0001', width: 1920, height: 462, location: 'demo' }] };

async function detect(): Promise<void> {
  if (detecting.value) return;
  detecting.value = true;
  try {
    found.value = KIOSKO_DEMO ? (await new Promise((r) => setTimeout(r, 600)), SIMULATED) : await api.discover();
  } catch (err) {
    notify(errorText(err), 'error');
    found.value = { trcc: [], usb: [] };
  } finally {
    detecting.value = false;
  }
}

/** A model's name for a size, else its size. */
function modelName(w: number, h: number): string {
  return presetOf(app.value?.presets ?? [], w, h)?.name ?? `${w}×${h}`;
}

function Panels() {
  const s = state.value;
  const cfg = config.value!;
  const presets = app.value?.presets ?? [];
  const platform = app.value?.platform ?? 'linux';
  const [model, setModel] = useState(presets[0]?.id ?? '');
  // Looked for at once the first time, unless panels are already connected (detecting opens them).
  useEffect(() => {
    if (!found.value && !cfg.screens.some((x) => x.device.driver === 'usb' || x.device.driver === 'trcc')) void detect();
  }, []);
  const taken = () => state.value.panels.map((p) => p.name);
  const add = (p: PanelChoice) => set((x) => ({ ...x, panels: [...x.panels.filter((y) => y.id !== p.id && !(p.from === 'try' && y.from === 'try')), p] }));
  const remove = (id: string) => set((x) => ({ ...x, panels: x.panels.filter((y) => y.id !== id) }));
  const update = (id: string, fn: (p: PanelChoice) => PanelChoice) => set((x) => ({ ...x, panels: x.panels.map((y) => (y.id === id ? fn(y) : y)) }));
  const f = found.value;
  const list = f ? [...f.usb.map((u) => fromUsb(u, uniqueName(modelName(u.width || 1920, u.height || 462), taken()))), ...f.trcc.map((x) => fromTrcc(x, TRCC_URL, uniqueName(modelName(x.width, x.height), taken())))] : [];
  const none = f && !list.length;
  const errors = f?.usb.filter((u) => u.error) ?? [];
  return (
    <>
      <p class="wiz-lead">{tr('wiz.panelLead')}</p>
      <div class="wiz-detect">
        <button class="ks-button" onClick={() => void detect()} disabled={detecting.value}>
          <Icon name={detecting.value ? 'loader' : 'radar'} size={16} class={detecting.value ? 'spin' : ''} /> {f ? tr('wiz.detectAgain') : tr('screens.detect')}
        </button>
        <span class="muted small" role="status" aria-live="polite">
          {detecting.value ? tr('wiz.detecting') : f ? (list.length ? t('wiz.foundN', { n: list.length }) : tr('wiz.foundNone')) : ''}
          {KIOSKO_DEMO && f ? ` · ${tr('wiz.simulated')}` : ''}
        </span>
      </div>
      {list.length > 0 && (
        <ul class="wiz-found">
          {list.map((p) => {
            const there = addsTo(cfg) ? alreadyThere(cfg, p) : undefined;
            const chosen = s.panels.find((x) => x.id === p.id || (x.device.driver === p.device.driver && JSON.stringify(x.device) === JSON.stringify(p.device)));
            const err = f!.usb.find((u) => `usb:${u.serial || u.location}` === p.id)?.error;
            return (
              <li>
                <label class={`wiz-found-item ${chosen ? 'on' : ''}`}>
                  <input type="checkbox" checked={!!chosen || !!there} disabled={!!there} onChange={(e) => ((e.target as HTMLInputElement).checked ? add(p) : remove(chosen?.id ?? p.id))} />
                  <PanelGlyph w={p.width} h={p.height} />
                  <span class="wiz-found-text">
                    <b>{modelName(p.width, p.height)}</b>
                    <small class="muted">
                      {p.width}×{p.height} · {p.device.driver === 'usb' ? 'USB' : 'trcc'}
                      {p.detail ? ` · ${p.detail}` : ''}
                      {there ? ` · ${t('wiz.already', { name: there.name })}` : ''}
                    </small>
                    {err && <small class="wiz-warn"><Icon name="triangle-alert" size={13} /> {tr('wiz.cantOpen')}</small>}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
      {s.panels.length > 0 && (
        <section class="wiz-chosen" aria-label={tr('wiz.yourPanels')}>
          <h3>{tr('wiz.yourPanels')}</h3>
          {s.panels.length > 1 && <p class="muted small">{tr('wiz.manyHint')}</p>}
          {s.panels.map((p, n) => (
            <div class="wiz-panel-row">
              <PanelGlyph w={pictureOf(p).width} h={pictureOf(p).height} />
              <label class="wiz-name">
                <span class="field-label">{t('wiz.nameOf', { n: n + 1 })}</span>
                <input class="input" value={p.name} onInput={(e) => update(p.id, (x) => ({ ...x, name: (e.target as HTMLInputElement).value }))} />
              </label>
              <div class="segmented" role="radiogroup" aria-label={tr('screens.orientation')}>
                {([false, true] as const).map((portrait) => (
                  <button role="radio" aria-checked={p.portrait === portrait} class={p.portrait === portrait ? 'on' : ''} onClick={() => update(p.id, (x) => ({ ...x, portrait }))}>
                    <Icon name={portrait ? 'rectangle-vertical' : 'rectangle-horizontal'} size={14} /> {tr(portrait ? 'screens.portrait' : 'screens.landscape')}
                  </button>
                ))}
              </div>
              <small class="muted wiz-size">
                {pictureOf(p).width}×{pictureOf(p).height} · {p.from === 'usb' || p.from === 'trcc' ? tr('wiz.connected') : tr('wiz.virtual')}
              </small>
              <button class="icon-btn" title={tr('wiz.remove')} aria-label={`${tr('wiz.remove')}: ${p.name}`} onClick={() => remove(p.id)}>
                <Icon name="x" size={15} />
              </button>
            </div>
          ))}
        </section>
      )}
      <details class="wiz-help" open={!!none || errors.length > 0}>
        <summary>{tr('wiz.notFound')}</summary>
        <ol>
          <li>{tr('wiz.help.plug')}</li>
          {platform === 'linux' && (
            <li>
              {tr('wiz.help.linux')}
              <Copy text={'SUBSYSTEM=="usb", ENV{DEVTYPE}=="usb_device", ATTR{idVendor}=="0416", ATTR{idProduct}=="540[89]", TAG+="uaccess"'} label="/etc/udev/rules.d/99-kiosko-lcd.rules" />
              <Copy text="sudo udevadm control --reload && sudo udevadm trigger" />
            </li>
          )}
          {platform === 'win32' && <li>{tr('wiz.help.windows')}</li>}
          {platform === 'darwin' && <li>{tr('wiz.help.mac')}</li>}
          <li>{tr('wiz.help.others')}</li>
        </ol>
        <a class="ks-button small" href={usbGuideUrl()} target="_blank" rel="noreferrer">
          <Icon name="book-open" size={14} /> {tr('wiz.help.guide')}
        </a>
      </details>
      <section class="wiz-nopanel">
        <h3>{tr('wiz.noPanel')}</h3>
        <div class="wiz-nopanel-row">
          <label class="wiz-model">
            <span class="field-label">{tr('wiz.model')}</span>
            <select class="input" value={model} onChange={(e) => setModel((e.target as HTMLSelectElement).value)}>
              {presets.map((p) => (
                <option value={p.id}>
                  {p.name} · {p.width}×{p.height}
                </option>
              ))}
            </select>
          </label>
          <button class="ks-button" onClick={() => {
            const p = presets.find((x) => x.id === model);
            if (p) add(fromModel(p, uniqueName(p.name, taken())));
          }}>
            <Icon name="plus" size={15} /> {tr('wiz.designFor')}
          </button>
          <button class="ks-button" onClick={() => add(tryIt(uniqueName(tr('wiz.tryName'), taken())))}>
            <Icon name="monitor" size={15} /> {tr('wiz.justTry')}
          </button>
        </div>
        <p class="muted small">{tr('wiz.noPanelHint')}</p>
      </section>
    </>
  );
}

function Copy({ text, label }: { text: string; label?: string }) {
  return (
    <div class="wiz-copy">
      {label && <small class="muted">{label}</small>}
      <div>
        <code>{text}</code>
        <button class="icon-btn" title={tr('wiz.copy')} aria-label={tr('wiz.copy')} onClick={() => navigator.clipboard?.writeText(text).then(() => notify(tr('wiz.copied'), 'ok'), () => undefined)}>
          <Icon name="copy" size={14} />
        </button>
      </div>
    </div>
  );
}

function PanelGlyph({ w, h }: { w: number; h: number }) {
  const s = 26 / Math.max(w, h);
  return (
    <span class="panel-glyph" aria-hidden="true">
      <span style={{ width: Math.max(4, w * s), height: Math.max(4, h * s) }} />
    </span>
  );
}

// ---------- 3. What to show ----------

function Show() {
  const s = state.value;
  const [tab, setTab] = useState(s.panels[0]?.id ?? '');
  const p = s.panels.find((x) => x.id === tab) ?? s.panels[0];
  if (!p) return null;
  const ctx = buildContext();
  const options: Template[] = [...(p.template === CURRENT || p.screen ? [{ id: CURRENT, icon: 'monitor-check', needs: [], wide: [] } as Template] : []), ...ctx.templates];
  return (
    <>
      <p class="wiz-lead">{tr('wiz.showLead')}</p>
      {s.panels.length > 1 && (
        <div class="wiz-tabs" role="tablist" aria-label={tr('wiz.yourPanels')}>
          {s.panels.map((x) => (
            <button role="tab" aria-selected={x.id === p.id} class={x.id === p.id ? 'on' : ''} onClick={() => setTab(x.id)}>
              {x.name || x.detail}
            </button>
          ))}
        </div>
      )}
      <div class={`wiz-templates ${pictureOf(p).height > pictureOf(p).width ? 'tall' : ''}`} role="radiogroup" aria-label={t('wiz.showFor', { name: p.name })}>
        {options.map((tp) => {
          const on = p.template === tp.id || (tp.id === STARTER && !options.some((o) => o.id === p.template));
          return (
            <button role="radio" aria-checked={on} class={`wiz-template ${on ? 'on' : ''}`} onClick={() => set((x) => ({ ...x, panels: x.panels.map((y) => (y.id === p.id ? { ...y, template: tp.id } : y)) }))}>
              <Preview panel={p} template={tp.id} ctx={ctx} />
              <span class="wiz-template-name">
                <Icon name={tp.icon} size={15} /> {templateName(tp)}
                {on && <Icon name="circle-check" size={15} class="wiz-tick" />}
              </span>
            </button>
          );
        })}
      </div>
      {!KIOSKO_DEMO && <MorePlugins />}
    </>
  );
}

const previews = new Map<string, Promise<string>>();
/** A template on this panel, painted by Kiosko with sample data (POST /api/preview). */
function Preview({ panel, template, ctx }: { panel: PanelChoice; template: string; ctx: BuildContext }) {
  const pic = pictureOf(panel);
  const [url, setUrl] = useState<string | null>(null);
  const key = JSON.stringify([pic, template, ctx.locale, config.value?.theme, state.value.theme, panel.screen, (app.value?.catalog ?? []).length]);
  useEffect(() => {
    let alive = true;
    let p = previews.get(key);
    if (!p) {
      const screen = previewScreen(panel, template, ctx);
      p = api.preview(screen, screen.pages[0]!.id).then((r) => r.url);
      p.catch(() => previews.delete(key));
      previews.set(key, p);
    }
    p.then((u) => alive && setUrl(u), () => undefined);
    return () => {
      alive = false;
    };
  }, [key]);
  return (
    <span class="wiz-preview" style={{ aspectRatio: `${pic.width} / ${pic.height}` }}>
      {url ? <img src={url} alt="" /> : <span class="panel-loading" />}
    </span>
  );
}

/** Official plugins not installed yet that bring a starting page, offered where they are: installed only on a click, after the store's dialog. */
function MorePlugins() {
  const st = store.value;
  const [installing, setInstalling] = useState<StorePlugin | null>(null);
  useEffect(() => {
    if (!store.value) void loadStore();
  }, []);
  if (!st?.index) return null;
  const env = { sdk: st.sdk, platform: st.platform };
  const lang = uiLanguage();
  const offer = st.index.plugins.filter((p) => p.tier === 'official' && !p.hidden && !st.installed[p.id] && p.templates.length > 0 && marketFor(p, where()) === 'ok' && installableRelease(p, env)).slice(0, 4);
  if (!offer.length) return null;
  return (
    <section class="wiz-more">
      <h3>{tr('wiz.more')}</h3>
      <p class="muted small">{tr('wiz.moreHint')}</p>
      <ul>
        {offer.map((p) => (
          <li>
            <span dangerouslySetInnerHTML={{ __html: appIcon(p, 18) }} />
            <span class="wiz-more-text">
              <b>{textIn(p.name, lang)}</b>
              <small class="muted">{textIn(p.description, lang)}</small>
            </span>
            <button class="ks-button small" onClick={() => setInstalling(p)}>
              <Icon name="download" size={14} /> {tr('wiz.add')}
            </button>
          </li>
        ))}
      </ul>
      {installing && <InstallDialog p={installing} st={st} onClose={() => setInstalling(null)} />}
    </section>
  );
}

// ---------- 4. Finishing touches ----------

interface Place {
  name: string;
  latitude: number;
  longitude: number;
  country?: string;
  admin1?: string;
}

function Touches() {
  const s = state.value;
  const cfg = config.value!;
  const a = app.value!;
  const loc = s.location ?? cfg.location;
  const [q, setQ] = useState(loc?.name ?? '');
  const [results, setResults] = useState<Place[] | null>(null);
  const [busy, setBusy] = useState(false);
  const setLoc = (l: WizardState['location']) => set((x) => ({ ...x, ...(l ? { location: l } : {}) }));
  // Only the name typed goes out, and only on a click: to Open-Meteo, the weather's own service.
  const search = async () => {
    if (!q.trim()) return;
    setBusy(true);
    try {
      const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?count=6&format=json&language=${encodeURIComponent(uiLanguage().split('-')[0]!)}&name=${encodeURIComponent(q.trim())}`);
      const j = (await r.json()) as { results?: Place[] };
      setResults(j.results ?? []);
    } catch (err) {
      notify(errorText(err), 'error');
      setResults([]);
    } finally {
      setBusy(false);
    }
  };
  const service = a.kioskoUpdate?.install.service;
  const newer = a.updates?.kiosko;
  return (
    <>
      <p class="wiz-lead">{tr('wiz.touchesLead')}</p>
      <section class="wiz-section">
        <h3>
          <Icon name="map-pin" size={16} /> {tr('settings.location')}
        </h3>
        <p class="muted small">{tr('wiz.placeHint')}</p>
        <form class="wiz-row" onSubmit={(e) => (e.preventDefault(), void search())}>
          <input class="input" value={q} placeholder={tr('settings.cityPh')} aria-label={tr('wiz.city')} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
          <button class="ks-button small" type="submit" disabled={busy || !q.trim()}>
            <Icon name={busy ? 'loader' : 'search'} size={14} class={busy ? 'spin' : ''} /> {tr('wiz.search')}
          </button>
          <button class="ks-button small" type="button" onClick={() => navigator.geolocation?.getCurrentPosition((p) => setLoc({ latitude: +p.coords.latitude.toFixed(4), longitude: +p.coords.longitude.toFixed(4), ...(q.trim() ? { name: q.trim() } : {}) }), (err) => notify(err.message, 'error'))}>
            <Icon name="locate-fixed" size={14} /> {tr('settings.useMine')}
          </button>
        </form>
        <small class="muted">{tr('wiz.searchNote')}</small>
        {results && (
          <ul class="wiz-results" aria-live="polite">
            {!results.length && <li class="muted small">{tr('wiz.noPlaces')}</li>}
            {results.map((r) => (
              <li>
                <button class={`wiz-place ${loc && Math.abs(loc.latitude - r.latitude) < 1e-3 && Math.abs(loc.longitude - r.longitude) < 1e-3 ? 'on' : ''}`} onClick={() => setLoc({ latitude: +r.latitude.toFixed(4), longitude: +r.longitude.toFixed(4), name: r.name })}>
                  <b>{r.name}</b> <small class="muted">{[r.admin1, r.country].filter(Boolean).join(', ')}</small>
                </button>
              </li>
            ))}
          </ul>
        )}
        <div class="wiz-row">
          <label>
            <span class="field-label">{tr('settings.lat')}</span>
            <input class="input num" type="number" step="0.0001" min={-90} max={90} value={loc?.latitude ?? ''} onChange={(e) => {
              const v = Number((e.target as HTMLInputElement).value);
              if (Number.isFinite(v) && Math.abs(v) <= 90) setLoc({ latitude: v, longitude: loc?.longitude ?? 0, ...(loc?.name ? { name: loc.name } : {}) });
            }} />
          </label>
          <label>
            <span class="field-label">{tr('settings.lon')}</span>
            <input class="input num" type="number" step="0.0001" min={-180} max={180} value={loc?.longitude ?? ''} onChange={(e) => {
              const v = Number((e.target as HTMLInputElement).value);
              if (Number.isFinite(v) && Math.abs(v) <= 180) setLoc({ latitude: loc?.latitude ?? 0, longitude: v, ...(loc?.name ? { name: loc.name } : {}) });
            }} />
          </label>
          {loc && <span class="wiz-chosen-place"><Icon name="circle-check" size={14} /> {loc.name ?? `${loc.latitude}, ${loc.longitude}`}</span>}
        </div>
      </section>
      <section class="wiz-section">
        <h3>
          <Icon name="palette" size={16} /> {tr('settings.panelTheme')}
        </h3>
        <div class="theme-grid" role="radiogroup" aria-label={tr('settings.panelTheme')}>
          {a.themes.map((th) => {
            const on = (s.theme ?? cfg.theme) === th.id;
            return (
              <button role="radio" aria-checked={on} class={`theme-swatch ${on ? 'on' : ''}`} onClick={() => set((x) => ({ ...x, theme: th.id }))} style={{ background: th.colors.bg, color: th.colors.ink, borderRadius: `${Math.min(14, th.radius)}px` }}>
                <span class="sw-card" style={{ background: th.colors.surface, borderColor: th.colors.surfaceEdge, borderRadius: `${Math.min(10, th.radius / 1.5)}px` }}>
                  <span class="sw-line" style={{ background: th.colors.ink }} />
                  <span class="sw-line short" style={{ background: th.colors.inkDim }} />
                </span>
                <span class="sw-name">{th.name}</span>
              </button>
            );
          })}
        </div>
      </section>
      {!KIOSKO_DEMO && (
        <section class="wiz-section">
          <h3>
            <Icon name="power" size={16} /> {tr('wiz.session')}
          </h3>
          {service ? (
            <p class="wiz-ok"><Icon name="circle-check" size={15} /> {tr('wiz.sessionOn')}</p>
          ) : (
            <>
              <p class="muted small">{tr('wiz.sessionHow')}</p>
              <Copy text="kiosko service install" />
            </>
          )}
          <h3>
            <Icon name="refresh-cw" size={16} /> {tr('wiz.updates')}
          </h3>
          {newer ? (
            <p>
              {t('wiz.newer', { v: newer.latest })}{' '}
              <a href="#/plugins/updates" onClick={() => close()}>{tr('wiz.seeUpdates')}</a>
            </p>
          ) : (
            <p class="muted small">{tr('wiz.updatesHow')}</p>
          )}
        </section>
      )}
    </>
  );
}

// ---------- 5. Done ----------

function Done() {
  const s = state.value;
  const screens = (config.value?.screens ?? []).filter((x) => s.made?.includes(x.id));
  const real = screens.some((x) => x.device.driver !== 'virtual');
  const canPlay = (app.value?.catalog ?? []).some((p) => p.enabled && p.interludes.some((i) => i.input));
  return (
    <>
      <p class="wiz-lead">{real && !KIOSKO_DEMO ? tr('wiz.doneLit') : tr('wiz.doneVirtual')}</p>
      <div class="wiz-live">
        {screens.map((sc) => {
          const f = lastFrame.value[sc.id];
          return (
            <figure>
              <span class="wiz-preview" style={{ aspectRatio: `${sc.width} / ${sc.height}` }}>
                {KIOSKO_DEMO ? <DemoFrame screen={sc} pageId={f?.pageId} at={f?.at ?? null} /> : f ? <img src={api.liveFrameUrl(sc.id, f.at)} alt={t('wiz.liveOf', { name: sc.name })} /> : <span class="panel-loading" />}
              </span>
              <figcaption>{sc.name}</figcaption>
            </figure>
          );
        })}
      </div>
      <ul class="wiz-next">
        <li>
          <a href="#/editor" onClick={() => close()}>
            <Icon name="layout-dashboard" size={18} /> <span><b>{tr('nav.editor')}</b><small class="muted">{tr('wiz.nextEditor')}</small></span>
          </a>
        </li>
        <li>
          <a href="#/plugins/store" onClick={() => close()}>
            <Icon name="store" size={18} /> <span><b>{tr('plugins.tabStore')}</b><small class="muted">{tr('wiz.nextStore')}</small></span>
          </a>
        </li>
        {canPlay && (
          <li>
            <a href="#/play" onClick={() => close()}>
              <Icon name="gamepad-2" size={18} /> <span><b>{tr('nav.play')}</b><small class="muted">{tr('wiz.nextPlay')}</small></span>
            </a>
          </li>
        )}
      </ul>
      <p class="muted small">{tr('wiz.undo')}</p>
    </>
  );
}

// Keeps the progress of a wizard that is open in step with what is saved (another tab's edits leave it be).
effect(() => {
  if (wizardOpen.value) save(state.value);
});

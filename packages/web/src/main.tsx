import { render } from 'preact';
import { effect } from '@preact/signals';
import { Editor } from './editor/Editor.tsx';
import { Icon } from './icons.tsx';
import { UI_LANGUAGES, docsUrl, t, tr, uiLanguage } from './i18n.ts';
import { alerts, app, boot, config, go, online, pageId, saveError, saving, screen, screenId, selectedTile, status, toast, view, type View } from './store.ts';
import { Screens } from './views/Screens.tsx';
import { LanguageMenu, Logs, Plugins, Settings } from './views/Others.tsx';
import { Play } from './views/Play.tsx';
import { AlertBand } from './views/AlertBand.tsx';
import { startTour, touring } from './demo/tour.ts';
import { DemoBanner, demoBootError } from './demo/ui.tsx';
import { KioskoNotice, kioskoCount, watchKioskoUpdates } from './views/KioskoUpdate.tsx';
import { Wizard, offerWizard, wizardOpen } from './wizard/Wizard.tsx';

const NAV: { id: View; icon: string }[] = [
  { id: 'editor', icon: 'layout-dashboard' },
  { id: 'screens', icon: 'monitor' },
  { id: 'plugins', icon: 'blocks' },
  { id: 'settings', icon: 'settings-2' },
  { id: 'logs', icon: 'activity' },
  // Last, and only when a plugin has an interlude to play.
  { id: 'play', icon: 'gamepad-2' },
];

function Logo() {
  return (
    <svg class="logo" viewBox="0 0 64 64" width="28" height="28" aria-hidden="true">
      <defs>
        <linearGradient id="lg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#8B5CF6" />
          <stop offset="1" stop-color="#22D3EE" />
        </linearGradient>
      </defs>
      <rect x="6" y="6" width="30" height="22" rx="5" fill="url(#lg)" />
      <rect x="40" y="6" width="18" height="22" rx="5" fill="#22D3EE" opacity=".55" />
      <rect x="6" y="32" width="18" height="26" rx="5" fill="#8B5CF6" opacity=".55" />
      <rect x="28" y="32" width="30" height="26" rx="5" fill="url(#lg)" opacity=".85" />
    </svg>
  );
}

function SaveState() {
  const s = saving.value;
  if (s === 'idle') return null;
  const icon = s === 'saved' ? 'cloud-check' : s === 'error' ? 'cloud-alert' : 'cloud-upload';
  return (
    <span class={`save-state ${s}`} title={saveError.value ?? ''}>
      <Icon name={icon} size={15} /> <span class="hide-sm">{tr(`save.${s}` as 'save.saved')}</span>
    </span>
  );
}

function TopBar() {
  const screens = config.value?.screens ?? [];
  return (
    <header class="topbar">
      <div class="brand" onClick={() => go('editor')}>
        <Logo />
        <span>Kiosko</span>
      </div>
      {view.value === 'editor' && screens.length > 0 && (
        <nav class="screen-tabs" aria-label={tr('screens.title')}>
          {screens.map((s) => {
            const st = status.value?.screens.find((x) => x.id === s.id);
            return (
              <button class={`screen-tab ${screen.value?.id === s.id ? 'on' : ''}`} onClick={() => {
                screenId.value = s.id;
                pageId.value = s.pages[0]?.id ?? null;
                selectedTile.value = null;
              }}>
                <span class={`dot ${!s.enabled ? 'off' : st?.device.ok ? 'ok' : 'bad'}`} />
                {s.name}
                <small>
                  {s.width}×{s.height}
                </small>
              </button>
            );
          })}
        </nav>
      )}
      <div class="tb-spacer" />
      {!KIOSKO_DEMO && app.value?.demo && <span class="demo-pill" title="kiosko start --demo">DEMO</span>}
      <KioskoNotice />
      <SaveState />
      <LanguageMenu />
      <a class="icon-btn" href={docsUrl()} target="_blank" rel="noreferrer" title={tr('docs')}>
        <Icon name="book-open" size={17} />
      </a>
    </header>
  );
}

/** A plugin has an interlude that can be played: the Play page is offered. */
const canPlay = () => (app.value?.catalog ?? []).some((p) => p.enabled && p.interludes.some((i) => i.input));

/** Plugin updates that can be installed, and Kiosko's own. */
const updateCount = () => (KIOSKO_DEMO ? 0 : (app.value?.updates?.plugins.filter((u) => u.version).length ?? 0) + kioskoCount());

function Rail() {
  return (
    <nav class="rail" aria-label={tr('nav.main')}>
      {NAV.filter((n) => n.id !== 'play' || canPlay()).map((n) => (
        <button class={`rail-btn ${view.value === n.id ? 'on' : ''}`} data-view={n.id} onClick={() => go(n.id)} title={tr(`nav.${n.id}`)} aria-current={view.value === n.id}>
          <Icon name={n.icon} size={20} />
          {n.id === 'plugins' && updateCount() > 0 && (
            <b class="rail-badge" title={tr('updates.badge')}>{updateCount()}</b>
          )}
          <span>{tr(`nav.${n.id}`)}</span>
        </button>
      ))}
    </nav>
  );
}

function App() {
  if (!app.value || !config.value) {
    return (
      <div class="boot">
        <Logo />
      </div>
    );
  }
  const v = view.value;
  return (
    // With alerts, the band gets a row of its own under the top bar: it pushes the views down, never covers them.
    <div class={KIOSKO_DEMO ? 'shell demo' : alerts.value.some((a) => !a.snoozedUntil) ? 'shell has-alerts' : 'shell'}>
      {KIOSKO_DEMO ? (
        <>
          <DemoBanner />
          <TopBar />
        </>
      ) : (
        <>
          <TopBar />
          <AlertBand />
        </>
      )}
      <Rail />
      <div class="content">
        {v === 'editor' && <Editor />}
        {v === 'screens' && <Screens />}
        {v === 'plugins' && <Plugins />}
        {v === 'play' && <Play />}
        {v === 'settings' && <Settings />}
        {v === 'logs' && <Logs />}
      </div>
      {!online.value && (
        <div class="offline">
          <Icon name="wifi-off" size={15} /> {tr('offline')}
        </div>
      )}
      {wizardOpen.value && <Wizard />}
      {toast.value && (
        <div class={`toast ${toast.value.kind}`} role="status">
          <Icon name={toast.value.kind === 'error' ? 'circle-alert' : toast.value.kind === 'ok' ? 'circle-check' : 'info'} size={16} /> {toast.value.text}
        </div>
      )}
    </div>
  );
}

// The page's language picks the glyphs (the same Han character is drawn
// differently in Taiwan and mainland China) and what a screen reader speaks.
effect(() => {
  const lang = uiLanguage();
  document.documentElement.lang = lang;
  document.documentElement.dir = UI_LANGUAGES.find((l) => l.id === lang)?.dir ?? 'ltr';
});

// The store's parts (store-kit) show what needs a script only on `html.js`, as on the site.
document.documentElement.classList.add('js');
render(<App />, document.getElementById('app')!);
boot()
  .then(() => {
    // The site's front page shows the editor driving itself (demo/tour.ts).
    if (KIOSKO_DEMO && touring()) startTour();
    else offerWizard();
    watchKioskoUpdates();
  })
  .catch((err) => {
    document.getElementById('app')!.innerHTML = KIOSKO_DEMO ? demoBootError(err) : `<div class="boot-error"><h1>Kiosko</h1><p>${t('bootError', { error: String(err) })}</p></div>`;
  });

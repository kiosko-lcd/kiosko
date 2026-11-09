import { render } from 'preact';
import { Editor } from './editor/Editor.tsx';
import { Icon } from './icons.tsx';
import { tr } from './i18n.ts';
import { app, boot, config, go, online, pageId, saveError, saving, screen, screenId, selectedTile, status, toast, view, type View } from './store.ts';
import { Screens } from './views/Screens.tsx';
import { Logs, Plugins, Settings } from './views/Others.tsx';
import { DemoBanner, demoBootError } from './demo/ui.tsx';

const NAV: { id: View; icon: string }[] = [
  { id: 'editor', icon: 'layout-dashboard' },
  { id: 'screens', icon: 'monitor' },
  { id: 'plugins', icon: 'blocks' },
  { id: 'settings', icon: 'settings-2' },
  { id: 'logs', icon: 'activity' },
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
      <SaveState />
      <a class="icon-btn" href="https://github.com/kiosko-lcd/kiosko#readme" target="_blank" rel="noreferrer" title="Docs">
        <Icon name="book-open" size={17} />
      </a>
    </header>
  );
}

function Rail() {
  return (
    <nav class="rail" aria-label="main">
      {NAV.map((n) => (
        <button class={`rail-btn ${view.value === n.id ? 'on' : ''}`} onClick={() => go(n.id)} title={tr(`nav.${n.id}`)} aria-current={view.value === n.id}>
          <Icon name={n.icon} size={20} />
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
    <div class={KIOSKO_DEMO ? 'shell demo' : 'shell'}>
      {KIOSKO_DEMO ? (
        <>
          <DemoBanner />
          <TopBar />
        </>
      ) : <TopBar />}
      <Rail />
      <div class="content">
        {v === 'editor' && <Editor />}
        {v === 'screens' && <Screens />}
        {v === 'plugins' && <Plugins />}
        {v === 'settings' && <Settings />}
        {v === 'logs' && <Logs />}
      </div>
      {!online.value && (
        <div class="offline">
          <Icon name="wifi-off" size={15} /> {tr('offline')}
        </div>
      )}
      {toast.value && (
        <div class={`toast ${toast.value.kind}`} role="status">
          <Icon name={toast.value.kind === 'error' ? 'circle-alert' : toast.value.kind === 'ok' ? 'circle-check' : 'info'} size={16} /> {toast.value.text}
        </div>
      )}
    </div>
  );
}

render(<App />, document.getElementById('app')!);
boot().catch((err) => {
  document.getElementById('app')!.innerHTML = KIOSKO_DEMO ? demoBootError(err) : `<div class="boot-error"><h1>Kiosko</h1><p>Cannot reach the Kiosko service: ${String(err)}</p></div>`;
});

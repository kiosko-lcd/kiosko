/** Plugins, Settings and Activity views. */
import { useState } from 'preact/hooks';
import { api } from '../api.ts';
import { SchemaForm, Toggle } from '../forms/SchemaForm.tsx';
import { Icon } from '../icons.tsx';
import { fmtMs, tr } from '../i18n.ts';
import { app, config, edit, logs, notify, reloadState, setUiTheme, status, uiTheme } from '../store.ts';

export function Plugins() {
  const a = app.value!;
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const snippet = `// ${a.paths.plugins}/hello/index.js
import { definePlugin, defineWidget, t } from '@tessera/sdk';

export default definePlugin({
  id: 'hello', name: 'Hello', version: '1.0.0',
  widgets: [defineWidget({
    id: 'greeting', name: 'Greeting', icon: 'hand',
    options: t.object({ who: t.string({ default: 'world' }) }),
    render(g, { box, options, theme, kit }) {
      kit.drawTracked(g, \`Hello, \${options.who}!\`, box.x, box.y + 40,
        { size: 36, family: theme.fonts.sans, color: theme.colors.ink });
    },
  })],
});`;
  return (
    <div class="page-view">
      <header class="view-head">
        <div>
          <h1>{tr('plugins.title')}</h1>
          <p class="muted">{tr('plugins.subtitle')}</p>
        </div>
      </header>
      {a.restartNeeded && (
        <div class="banner warn">
          <Icon name="rotate-ccw" size={16} /> {tr('plugins.restart')}
        </div>
      )}
      {(status.value?.problems.length ?? 0) > 0 && (
        <div class="banner error">
          <b>{tr('plugins.problems')}</b>
          {status.value!.problems.map((p) => (
            <div class="mono small">
              {p.origin}: {p.message}
            </div>
          ))}
        </div>
      )}
      <div class="plugin-grid">
        {a.catalog.map((p) => (
          <article class={`card plugin-card ${p.enabled ? '' : 'disabled'}`}>
            <div class="card-head">
              <span class="plugin-icon">
                <Icon name={p.icon ?? 'puzzle'} size={20} />
              </span>
              <div class="plugin-title">
                <b>{p.name}</b>
                <small class="muted mono">
                  {p.id} · v{p.version}
                </small>
              </div>
              <div class="tb-spacer" />
              {p.builtin && <span class="pill">{tr('plugins.builtin')}</span>}
              <Toggle checked={p.enabled} onChange={async (v) => {
                app.value = await api.setPluginEnabled(p.id, v);
                config.value = app.value.config;
              }} />
            </div>
            <p class="muted small">{p.description}</p>
            <div class="plugin-stats">
              {p.widgets.length > 0 && <span>{p.widgets.length} {tr('plugins.widgets')}</span>}
              {p.sources.length > 0 && <span>{p.sources.length} {tr('plugins.sources')}</span>}
              {p.interludes.length > 0 && <span>{p.interludes.length} {tr('plugins.interludes')}</span>}
            </div>
            <div class="plugin-widgets">
              {p.widgets.map((w) => (
                <span class="mini-chip" title={w.description}>
                  <Icon name={w.icon ?? 'puzzle'} size={12} /> {w.name}
                </span>
              ))}
              {p.interludes.map((w) => (
                <span class="mini-chip" title={w.description}>
                  <Icon name={w.icon ?? 'clapperboard'} size={12} /> {w.name}
                </span>
              ))}
            </div>
          </article>
        ))}
      </div>
      <div class="grid-2 gap-lg">
        <section class="card">
          <h3>
            <Icon name="package-plus" size={16} /> {tr('plugins.install')}
          </h3>
          <p class="muted small">{tr('plugins.installWarn')}</p>
          <form class="row" onSubmit={async (e) => {
            e.preventDefault();
            if (!name.trim()) return;
            setBusy(true);
            try {
              await api.install(name.trim());
              notify(tr('toast.installed'), 'ok');
              await reloadState();
            } catch (err) {
              notify(String(err instanceof Error ? err.message : err), 'error');
            } finally {
              setBusy(false);
            }
          }}>
            <input class="input mono" placeholder={tr('plugins.installPh')} value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
            <button class="btn primary" disabled={busy}>
              {busy ? tr('plugins.installing') : tr('common.add')}
            </button>
          </form>
        </section>
        <section class="card">
          <h3>
            <Icon name="code-xml" size={16} /> {tr('plugins.write')}
          </h3>
          <p class="muted small">{tr('plugins.writeHint')}</p>
          <div class="code-wrap">
            <pre class="code">{snippet}</pre>
            <button class="btn ghost small copy" onClick={() => {
              void navigator.clipboard?.writeText(snippet);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}>
              <Icon name={copied ? 'check' : 'copy'} size={13} /> {copied ? tr('common.copied') : tr('common.copy')}
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}

export function Settings() {
  const cfg = config.value!;
  const a = app.value!;
  const days = tr('days.short').split(',');
  const sources = a.catalog.flatMap((p) => (p.enabled ? p.sources : [])).filter((s) => s.options && Object.keys(s.options.properties ?? {}).length);
  return (
    <div class="page-view">
      <header class="view-head">
        <h1>{tr('settings.title')}</h1>
      </header>
      <div class="grid-2 gap-lg">
        <section class="card">
          <h3>
            <Icon name="palette" size={16} /> {tr('settings.panelTheme')}
          </h3>
          <div class="theme-grid">
            {a.themes.map((t) => (
              <button class={`theme-swatch ${cfg.theme === t.id ? 'on' : ''}`} onClick={() => edit((d) => (d.theme = t.id))} style={{ background: t.colors.bg, color: t.colors.ink, borderRadius: `${Math.min(14, t.radius)}px` }}>
                <span class="sw-card" style={{ background: t.colors.surface, borderColor: t.colors.surfaceEdge, borderRadius: `${Math.min(10, t.radius / 1.5)}px` }}>
                  <span class="sw-line" style={{ background: t.colors.ink }} />
                  <span class="sw-line short" style={{ background: t.colors.inkDim }} />
                  <span class="sw-dots">
                    {['alert', 'warn', 'info', 'ok'].map((k) => (
                      <i style={{ background: t.colors[k] }} />
                    ))}
                  </span>
                </span>
                <span class="sw-name">{t.name}</span>
              </button>
            ))}
          </div>
          <h3>
            <Icon name="sun-moon" size={16} /> {tr('settings.editorTheme')}
          </h3>
          <div class="segmented">
            <button class={uiTheme.value === 'dark' ? 'on' : ''} onClick={() => setUiTheme('dark')}>
              <Icon name="moon" size={13} /> {tr('settings.dark')}
            </button>
            <button class={uiTheme.value === 'light' ? 'on' : ''} onClick={() => setUiTheme('light')}>
              <Icon name="sun" size={13} /> {tr('settings.light')}
            </button>
          </div>
          <h3>
            <Icon name="languages" size={16} /> {tr('settings.language')}
          </h3>
          <div class="segmented">
            {[
              ['auto', tr('settings.auto')],
              ['es', 'Español'],
              ['en', 'English'],
            ].map(([v, l]) => (
              <button class={cfg.locale === v ? 'on' : ''} onClick={() => edit((d) => (d.locale = v!))}>
                {l}
              </button>
            ))}
          </div>
        </section>
        <section class="card">
          <h3>
            <Icon name="map-pin" size={16} /> {tr('settings.location')}
          </h3>
          <p class="muted small">{tr('settings.locationHint')}</p>
          <div class="row">
            <input class="input" placeholder="Madrid" value={cfg.location?.name ?? ''} onInput={(e) => edit((d) => (d.location = { latitude: d.location?.latitude ?? 0, longitude: d.location?.longitude ?? 0, name: (e.target as HTMLInputElement).value }), 'loc-name')} />
          </div>
          <div class="row">
            <input class="input num" type="number" step="0.0001" placeholder="lat" value={cfg.location?.latitude ?? ''} onInput={(e) => edit((d) => (d.location = { ...(d.location ?? { longitude: 0 }), latitude: Number((e.target as HTMLInputElement).value) }), 'loc-lat')} />
            <input class="input num" type="number" step="0.0001" placeholder="lon" value={cfg.location?.longitude ?? ''} onInput={(e) => edit((d) => (d.location = { ...(d.location ?? { latitude: 0 }), longitude: Number((e.target as HTMLInputElement).value) }), 'loc-lon')} />
            <button class="btn ghost small" onClick={() => navigator.geolocation?.getCurrentPosition((p) => edit((d) => (d.location = { ...(d.location ?? {}), latitude: +p.coords.latitude.toFixed(4), longitude: +p.coords.longitude.toFixed(4) })), (err) => notify(err.message, 'error'))}>
              <Icon name="locate-fixed" size={14} /> {tr('settings.useMine')}
            </button>
          </div>
          <h3>
            <Icon name="briefcase" size={16} /> {tr('settings.workday')}
          </h3>
          <p class="muted small">{tr('settings.workdayHint')}</p>
          <div class="days">
            {[1, 2, 3, 4, 5, 6, 0].map((d) => (
              <button class={`day ${cfg.workday.days.includes(d) ? 'on' : ''}`} onClick={() => edit((c) => (c.workday.days = c.workday.days.includes(d) ? c.workday.days.filter((x) => x !== d) : [...c.workday.days, d].sort()))}>
                {days[d]}
              </button>
            ))}
          </div>
          <div class="row">
            <span class="muted small">{tr('settings.from')}</span>
            <input class="input" type="time" value={cfg.workday.start} onInput={(e) => edit((d) => (d.workday.start = (e.target as HTMLInputElement).value), 'wd-s')} />
            <span class="muted small">{tr('settings.to')}</span>
            <input class="input" type="time" value={cfg.workday.end} onInput={(e) => edit((d) => (d.workday.end = (e.target as HTMLInputElement).value), 'wd-e')} />
          </div>
        </section>
      </div>
      {sources.length > 0 && (
        <section class="card">
          <h3>
            <Icon name="database" size={16} /> {tr('settings.sources')}
          </h3>
          <p class="muted small">{tr('settings.sourcesHint')}</p>
          <div class="sources">
            {sources.map((s) => {
              const st = status.value?.sources.find((x) => x.type === s.type);
              return (
                <div class="source-block">
                  <div class="source-head">
                    <b>{s.name}</b>
                    <code class="muted">{s.type}</code>
                    {s.intervalMs && <span class="muted small">· {fmtMs(s.intervalMs)}</span>}
                    {st && <span class={`status-pill ${st.ok ? 'ok' : 'bad'}`} title={st.error ?? ''}><span class="dot" /> {st.ok ? (st.updatedAt ? new Date(st.updatedAt).toLocaleTimeString() : '…') : st.error}</span>}
                  </div>
                  <p class="muted small">{s.description}</p>
                  <SchemaForm schema={s.options!} value={cfg.sources[s.type] ?? {}} onChange={(v, k) => edit((d) => (d.sources[s.type] = v), `src-${s.type}-${k}`)} idPrefix={`src-${s.type}`} />
                </div>
              );
            })}
          </div>
        </section>
      )}
      <div class="grid-2 gap-lg">
        <section class="card">
          <h3>
            <Icon name="folder" size={16} /> {tr('settings.files')}
          </h3>
          <dl class="paths">
            <dt>config</dt>
            <dd class="mono">{a.paths.config}</dd>
            <dt>plugins</dt>
            <dd class="mono">{a.paths.plugins}</dd>
          </dl>
          <p class="muted small">
            Tessera {a.version} · {a.platform}
          </p>
        </section>
        <section class="card">
          <h3>
            <Icon name="arrow-right-left" size={16} /> {tr('settings.import')}
          </h3>
          <p class="muted small">{tr('settings.importHint')}</p>
          <pre class="code">tessera import-aimonitor --write</pre>
        </section>
      </div>
    </div>
  );
}

export function Logs() {
  const list = [...logs.value].reverse();
  return (
    <div class="page-view">
      <header class="view-head">
        <h1>{tr('logs.title')}</h1>
      </header>
      <section class="card logs">
        {!list.length && <div class="muted">{tr('logs.empty')}</div>}
        {list.map((l) => (
          <div class={`log-line ${/fail|error|cannot|not answering/i.test(l.message) ? 'bad' : ''}`}>
            <span class="log-time mono">{new Date(l.at).toLocaleTimeString()}</span>
            <span class="log-scope mono">{l.scope}</span>
            <span class="log-msg">{l.message}</span>
          </div>
        ))}
      </section>
    </div>
  );
}

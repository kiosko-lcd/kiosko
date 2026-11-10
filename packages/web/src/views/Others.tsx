/** Plugins, Settings and Activity views. */
import { useState } from 'preact/hooks';
import { api } from '../api.ts';
import { SchemaForm, Toggle } from '../forms/SchemaForm.tsx';
import { Icon } from '../icons.tsx';
import { fmtMs, tr } from '../i18n.ts';
import { app, config, edit, logs, notify, reloadState, setUiTheme, status, uiTheme } from '../store.ts';
import { DemoNote } from '../demo/ui.tsx';

export function Plugins() {
  const a = app.value!;
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const snippet = `// ${a.paths.plugins}/hello/index.js
import { definePlugin, defineWidget, t } from '@kiosko/sdk';

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
      {(() => {
        const missing = (a.official ?? []).filter((o) => !a.catalog.some((p) => p.id === o.id));
        if (!missing.length) return null;
        return (
          <section class="card official">
            <h3>
              <Icon name="badge-check" size={16} /> {tr('plugins.official')}
            </h3>
            <p class="muted small">{tr('plugins.officialHint')}</p>
            <div class="official-list">
              {missing.map((o) => (
                <div class="official-item">
                  <span class="mono">{o.npm}</span>
                  <button class="btn small primary" disabled={busy} onClick={async () => {
                    setBusy(true);
                    try {
                      await api.install(o.npm);
                      notify(tr('toast.installed'), 'ok');
                      await reloadState();
                    } catch (err) {
                      notify(String(err instanceof Error ? err.message : err), 'error');
                    } finally {
                      setBusy(false);
                    }
                  }}>
                    <Icon name="download" size={13} /> {tr('common.add')}
                  </button>
                </div>
              ))}
            </div>
          </section>
        );
      })()}
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
              {!p.builtin && (a.official ?? []).some((o) => o.id === p.id) && <span class="pill official-pill">{tr('plugins.officialShort')}</span>}
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
          {KIOSKO_DEMO ? (
            <>
              <DemoNote k="installHint" />
              <div class="row">
                <input class="input mono" placeholder={tr('plugins.installPh')} disabled />
                <button class="btn primary" disabled>{tr('common.add')}</button>
              </div>
            </>
          ) : <form class="row" onSubmit={async (e) => {
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
          </form>}
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
          <h3>
            <Icon name="clock" size={16} /> {tr('settings.timeFormat')}
          </h3>
          <p class="muted small">{tr('settings.timeFormatHint')}</p>
          <div class="segmented">
            {(
              [
                ['auto', tr('settings.auto')],
                ['24h', tr('time.24h')],
                ['12h', tr('time.12h')],
              ] as const
            ).map(([v, l]) => (
              <button class={(cfg.timeFormat ?? 'auto') === v ? 'on' : ''} onClick={() => edit((d) => (d.timeFormat = v))}>
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
          <WorkdayMore days={days} />
        </section>
      </div>
      {sources.length > 0 && (
        <section class="card">
          <h3>
            <Icon name="database" size={16} /> {tr('settings.sources')}
          </h3>
          {KIOSKO_DEMO ? (
            <>
              <p class="muted small">{tr('settings.sourcesHint')}</p>
              <DemoNote k="sources" />
            </>
          ) : <p class="muted small">{tr('settings.sourcesHint')}</p>}
          <div class="sources">
            {sources.map((s) => {
              const st = status.value?.sources.find((x) => x.type === s.type);
              return (
                <div class="source-block">
                  <div class="source-head">
                    <b>{s.name}</b>
                    <code class="muted">{s.type}</code>
                    {s.intervalMs && <span class="muted small">· {fmtMs(st?.intervalMs ?? (cfg.sources[s.type]?.intervalMs as number | undefined) ?? s.intervalMs)}</span>}
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
            Kiosko {a.version} · {a.platform}
          </p>
        </section>
        <section class="card">
          <h3>
            <Icon name="arrow-right-left" size={16} /> {tr('settings.import')}
          </h3>
          <p class="muted small">{tr('settings.importHint')}</p>
          <pre class="code">kiosko import-aimonitor --write</pre>
        </section>
      </div>
    </div>
  );
}

/** The rest of the working week: hours due, days with other hours, holidays. */
function WorkdayMore({ days }: { days: string[] }) {
  const w = config.value!.workday;
  const byDay = w.byDay ?? {};
  const holidays = w.holidays ?? [];
  const num = (v: string) => (v.trim() === '' || !Number.isFinite(Number(v)) ? undefined : Math.max(0, Math.min(24, Number(v))));
  const setDay = (day: string, k: 'start' | 'end' | 'hours', v: string) =>
    edit((d) => {
      const o = { ...(d.workday.byDay?.[day] ?? {}) };
      if (k === 'hours') o.hours = num(v);
      else o[k] = v || undefined;
      d.workday.byDay = { ...(d.workday.byDay ?? {}), [day]: JSON.parse(JSON.stringify(o)) };
    }, `wd-${day}-${k}`);
  return (
    <>
      <div class="row">
        <span class="muted small">{tr('settings.hours')}</span>
        <input class="input num" type="number" min={0} max={24} step={0.25} value={w.hours ?? 8} onInput={(e) => {
          const n = num((e.target as HTMLInputElement).value);
          if (n !== undefined) edit((d) => (d.workday.hours = n), 'wd-h');
        }} />
        <span class="muted small">h</span>
      </div>
      <p class="muted small">{tr('settings.hoursHint')}</p>
      <label class="field-label">{tr('settings.byDay')}</label>
      <p class="muted small">{tr('settings.byDayHint')}</p>
      {Object.keys(byDay)
        .sort((a, b) => ((Number(a) + 6) % 7) - ((Number(b) + 6) % 7))
        .map((day) => (
          <div class="row">
            <span class="day on">{days[Number(day)]}</span>
            <input class="input" type="time" value={byDay[day]?.start ?? ''} onInput={(e) => setDay(day, 'start', (e.target as HTMLInputElement).value)} aria-label={tr('settings.from')} />
            <span class="muted small">–</span>
            <input class="input" type="time" value={byDay[day]?.end ?? ''} onInput={(e) => setDay(day, 'end', (e.target as HTMLInputElement).value)} aria-label={tr('settings.to')} />
            <input class="input num" type="number" min={0} max={24} step={0.25} placeholder={String(w.hours ?? 8)} value={byDay[day]?.hours ?? ''} onInput={(e) => setDay(day, 'hours', (e.target as HTMLInputElement).value)} aria-label={tr('settings.hours')} />
            <span class="muted small">h</span>
            <button class="icon-btn danger" title={tr('common.delete')} onClick={() => edit((d) => {
              const next = { ...(d.workday.byDay ?? {}) };
              delete next[day];
              d.workday.byDay = next;
            })}>
              <Icon name="x" size={14} />
            </button>
          </div>
        ))}
      <select class="input" value="" onChange={(e) => {
        const day = (e.target as HTMLSelectElement).value;
        (e.target as HTMLSelectElement).value = '';
        if (day) edit((d) => (d.workday.byDay = { ...(d.workday.byDay ?? {}), [day]: {} }));
      }}>
        <option value="">{tr('settings.addDay')}</option>
        {[1, 2, 3, 4, 5, 6, 0].filter((d) => !(String(d) in byDay)).map((d) => (
          <option value={String(d)}>{days[d]}</option>
        ))}
      </select>
      <label class="field-label">{tr('settings.holidays')}</label>
      <p class="muted small">{tr('settings.holidaysHint')}</p>
      {holidays.length > 0 && (
        <div class="row">
          {holidays.map((h) => (
            <span class="mini-chip">
              {h}
              <button class="icon-btn" title={tr('common.delete')} onClick={() => edit((d) => (d.workday.holidays = (d.workday.holidays ?? []).filter((x) => x !== h)))}>
                <Icon name="x" size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div class="row">
        <input class="input" type="date" aria-label={tr('settings.addHoliday')} onChange={(e) => {
          const el = e.target as HTMLInputElement;
          const v = el.value;
          el.value = '';
          if (/^\d{4}-\d{2}-\d{2}$/.test(v)) edit((d) => (d.workday.holidays = [...new Set([...(d.workday.holidays ?? []), v])].sort()));
        }} />
      </div>
    </>
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

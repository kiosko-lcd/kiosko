/** Plugins, Settings and Activity views. */
import { typed } from '../forms/ime.ts';
import { useState } from 'preact/hooks';
import { api, type AppState, type JsonSchema, type PluginInfo } from '../api.ts';
import { SchemaForm, Toggle } from '../forms/SchemaForm.tsx';
import { Icon } from '../icons.tsx';
import { pickLocale } from '@kiosko/sdk/i18n';
import { UI_LANGUAGES, clock, count, dateTime, errorText, fmtMs, t, tr, uiLanguage, weekOrder } from '../i18n.ts';
import { app, config, edit, logs, notify, setUiTheme, status, uiTheme } from '../store.ts';
import { DemoNote } from '../demo/ui.tsx';

/** Runs a plugin action, shows how it went and takes the new state. */
async function pluginAction(run: () => Promise<AppState | { state: AppState; problem: string | null }>, done: string): Promise<void> {
  try {
    const r = await run();
    const st = 'state' in r ? r.state : r;
    app.value = st;
    config.value = st.config;
    status.value = st.status;
    const problem = 'problem' in r ? r.problem : null;
    notify(problem ?? done, problem ? 'error' : 'ok');
  } catch (err) {
    notify(errorText(err), 'error');
  }
}

const PERMISSION_ICONS: Record<keyof PluginInfo['permissions'], string> = { network: 'globe', exec: 'square-terminal', files: 'folder-open', devices: 'usb' };

/** What a plugin says it does on the machine, as chips: "Internet: api.github.com", "Runs: nvidia-smi". */
function Permissions({ p }: { p: PluginInfo }) {
  const entries = (Object.keys(PERMISSION_ICONS) as (keyof PluginInfo['permissions'])[]).filter((k) => p.permissions[k]?.length);
  if (!entries.length) return null;
  const what = (v: string) => (v === 'user' ? tr('perm.user') : v === 'lan' ? tr('perm.lan') : v);
  return (
    <div class="plugin-perms">
      {entries.map((k) => (
        <span class="perm-chip" title={`${tr(`perm.${k}Help`)} ${p.permissions[k]!.map(what).join(', ')}`}>
          <Icon name={PERMISSION_ICONS[k]} size={12} /> {tr(`perm.${k}`)}: {p.permissions[k]!.map(what).join(', ')}
        </span>
      ))}
    </div>
  );
}

/** What a permission list says, in one line ("Internet: b.dev · Runs: git"). */
const permissionsLine = (p: PluginInfo['permissions']) =>
  (Object.keys(PERMISSION_ICONS) as (keyof PluginInfo['permissions'])[])
    .filter((k) => p[k]?.length)
    .map((k) => `${tr(`perm.${k}`)}: ${p[k]!.join(', ')}`)
    .join(' · ');

/** Newer versions on npm: Kiosko itself, and every plugin, with Update and Update all. */
function Updates() {
  const a = app.value!;
  const u = a.updates;
  const [busy, setBusy] = useState<string | null>(null);
  if (KIOSKO_DEMO || !u) return null;
  const ready = u.plugins.filter((p) => p.version);
  const blocked = u.plugins.filter((p) => !p.version && p.blocked);
  const nameOf = (id: string) => a.catalog.find((p) => p.id === id)?.name ?? id;
  const update = async (id: string): Promise<void> => {
    setBusy(id);
    try {
      const r = await api.updatePlugin(id);
      app.value = r.state;
      config.value = r.state.config;
      status.value = r.state.status;
      if (r.problem) notify(tr(r.rolledBack ? 'updates.rolledBack' : 'updates.failed').replace('{name}', nameOf(id)).replace('{why}', r.problem), 'error');
      else if (r.addedPermissions && Object.keys(r.addedPermissions).length) notify(tr('updates.morePermissions').replace('{name}', nameOf(id)).replace('{v}', r.version).replace('{what}', permissionsLine(r.addedPermissions)), 'ok');
      else notify(tr('updates.done').replace('{name}', nameOf(id)).replace('{v}', r.version), 'ok');
    } catch (err) {
      notify(errorText(err), 'error');
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      {u.kiosko && (
        <div class="banner info">
          <Icon name="sparkles" size={16} /> {tr('updates.kiosko').replace('{latest}', u.kiosko.latest).replace('{current}', u.kiosko.current)}
        </div>
      )}
      {(ready.length > 0 || blocked.length > 0) && (
        <section class="card updates">
          <div class="card-head">
            <h3>
              <Icon name="circle-arrow-up" size={16} /> {tr('updates.title')}
            </h3>
            <div class="tb-spacer" />
            {ready.length > 1 && (
              <button class="btn small primary" disabled={!!busy} onClick={async () => {
                for (const p of ready) await update(p.id);
              }}>
                {tr('updates.all')}
              </button>
            )}
          </div>
          {ready.map((p) => (
            <div class="update-item">
              <b>{nameOf(p.id)}</b>
              <span class="mono muted">{p.current} → {p.version}</span>
              {p.blocked && <span class="muted small">{tr('updates.notLatest').replace('{latest}', p.latest)}</span>}
              <div class="tb-spacer" />
              <button class="btn small primary" disabled={!!busy} onClick={() => update(p.id)}>
                <Icon name={busy === p.id ? 'loader' : 'download'} size={13} /> {busy === p.id ? tr('updates.updating') : tr('updates.update')}
              </button>
            </div>
          ))}
          {blocked.map((p) => (
            <div class="update-item muted">
              <b>{nameOf(p.id)}</b>
              <span class="mono">{p.current} · {p.latest}</span>
              <span class="small">{p.blocked}</span>
            </div>
          ))}
          <p class="muted small">{t('updates.checked', { at: dateTime(u.checkedAt) })}</p>
        </section>
      )}
    </>
  );
}

export function Plugins() {
  const a = app.value!;
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const isOfficial = (id: string) => (a.official ?? []).find((o) => o.id === id);
  // Installed in the plugins folder (npm or a link): the ones that can be reloaded and removed here.
  const ownFolder = (p: PluginInfo) => !p.builtin && !p.origin.startsWith('npm:');
  const install = async (spec: string) => {
    setBusy(true);
    await pluginAction(() => api.install(spec), tr('toast.installed'));
    setBusy(false);
  };
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
      <Updates />
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
                  <button class="btn small primary" disabled={busy || KIOSKO_DEMO} onClick={() => install(o.npm)}>
                    <Icon name="download" size={13} /> {tr('common.add')}
                  </button>
                </div>
              ))}
            </div>
          </section>
        );
      })()}
      {(a.refused ?? []).length > 0 && (
        <section class="card refused">
          <h3>
            <Icon name="circle-slash" size={16} /> {tr('plugins.refused')}
          </h3>
          <p class="muted small">{tr('plugins.refusedHint')}</p>
          {a.refused.map((r) => (
            <div class="refused-item">
              <b class="mono">{r.id ?? r.origin}</b>
              {r.version && <span class="muted mono"> v{r.version}</span>}
              <span class="muted small"> · {r.reason}</span>
            </div>
          ))}
        </section>
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
              {a.updates?.plugins.find((x) => x.id === p.id && x.version) && <span class="pill update-pill" title={tr('updates.title')}>v{a.updates.plugins.find((x) => x.id === p.id)!.version}</span>}
              {p.builtin && <span class="pill">{tr('plugins.builtin')}</span>}
              {!p.builtin && (a.official ?? []).some((o) => o.id === p.id) && <span class="pill official-pill">{tr('plugins.officialShort')}</span>}
              <Toggle checked={p.enabled} onChange={async (v) => {
                app.value = await api.setPluginEnabled(p.id, v);
                config.value = app.value.config;
              }} />
            </div>
            <p class="muted small">{p.description}</p>
            <div class="plugin-meta muted small">
              {p.author && <span><Icon name="user" size={12} /> {p.author}</span>}
              {p.license && <span><Icon name="scale" size={12} /> {p.license}</span>}
              {p.sdk && <span title={tr('plugins.sdkHelp')}><Icon name="plug" size={12} /> API {p.sdk}</span>}
              {(p.repository ?? p.homepage) && (
                <a href={(p.repository ?? p.homepage)!.replace(/^git\+/, '').replace(/\.git$/, '')} target="_blank" rel="noopener noreferrer">
                  <Icon name="external-link" size={12} /> {tr('plugins.source')}
                </a>
              )}
            </div>
            <Permissions p={p} />
            {p.requires.filter((r) => !r.ok).map((r) => (
              <div class="plugin-needs">
                <Icon name="triangle-alert" size={13} /> {tr('plugins.needs')} <span class="mono">{r.type}</span>
                {isOfficial(r.plugin) && !a.catalog.some((x) => x.id === r.plugin) && (
                  <button class="btn small ghost" disabled={busy || KIOSKO_DEMO} onClick={() => install(isOfficial(r.plugin)!.npm)}>
                    <Icon name="download" size={12} /> {tr('plugins.installIt').replace('{id}', r.plugin)}
                  </button>
                )}
              </div>
            ))}
            <div class="plugin-stats">
              {p.widgets.length > 0 && <span>{count('plugins.widgets', p.widgets.length)}</span>}
              {p.sources.length > 0 && <span>{count('plugins.sources', p.sources.length)}</span>}
              {p.interludes.length > 0 && <span>{count('plugins.interludes', p.interludes.length)}</span>}
            </div>
            {/* Its texts fall back to English for this user: say so before they wonder. */}
            {p.languages.length > 0 && !pickLocale(p.languages, uiLanguage()) && (
              <p class="muted small" title={p.languages.join(', ')}>
                <Icon name="languages" size={13} /> {t('plugins.notYourLanguage', { languages: p.languages.join(', ') })}
              </p>
            )}
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
            {ownFolder(p) && !KIOSKO_DEMO && (
              <div class="plugin-actions">
                <button class="btn ghost small" title={tr('plugins.reloadHelp')} onClick={() => pluginAction(() => api.reloadPlugin(p.id), tr('toast.reloaded'))}>
                  <Icon name="refresh-cw" size={13} /> {tr('plugins.reload')}
                </button>
                <button class="btn ghost small danger" onClick={() => {
                  if (confirm(tr('plugins.removeConfirm').replace('{name}', p.name))) void pluginAction(() => api.removePlugin(p.id), tr('toast.removed'));
                }}>
                  <Icon name="trash-2" size={13} /> {tr('plugins.remove')}
                </button>
              </div>
            )}
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
            await install(name.trim());
            setName('');
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
              <button class={`theme-swatch ${cfg.theme === t.id ? 'on' : ''}`} data-theme-id={t.id} onClick={() => edit((d) => (d.theme = t.id))} style={{ background: t.colors.bg, color: t.colors.ink, borderRadius: `${Math.min(14, t.radius)}px` }}>
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
          <LanguagePicker />
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
            <input class="input" placeholder={tr('settings.cityPh')} value={cfg.location?.name ?? ''} {...typed((text) => edit((d) => (d.location = { latitude: d.location?.latitude ?? 0, longitude: d.location?.longitude ?? 0, name: text }), 'loc-name'))} />
          </div>
          <div class="row">
            <input class="input num" type="number" step="0.0001" placeholder={tr('settings.lat')} aria-label={tr('settings.lat')} value={cfg.location?.latitude ?? ''} onInput={(e) => edit((d) => (d.location = { ...(d.location ?? { longitude: 0 }), latitude: Number((e.target as HTMLInputElement).value) }), 'loc-lat')} />
            <input class="input num" type="number" step="0.0001" placeholder={tr('settings.lon')} aria-label={tr('settings.lon')} value={cfg.location?.longitude ?? ''} onInput={(e) => edit((d) => (d.location = { ...(d.location ?? { latitude: 0 }), longitude: Number((e.target as HTMLInputElement).value) }), 'loc-lon')} />
            <button class="btn ghost small" onClick={() => navigator.geolocation?.getCurrentPosition((p) => edit((d) => (d.location = { ...(d.location ?? {}), latitude: +p.coords.latitude.toFixed(4), longitude: +p.coords.longitude.toFixed(4) })), (err) => notify(err.message, 'error'))}>
              <Icon name="locate-fixed" size={14} /> {tr('settings.useMine')}
            </button>
          </div>
          <h3>
            <Icon name="briefcase" size={16} /> {tr('settings.workday')}
          </h3>
          <p class="muted small">{tr('settings.workdayHint')}</p>
          <div class="days">
            {weekOrder().map((d) => (
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
            {sources.map((s) => (
              <SourceRow key={s.type} s={s} />
            ))}
          </div>
        </section>
      )}
      {!KIOSKO_DEMO && <HomeAssistantCard />}
      <div class="grid-2 gap-lg">
        <section class="card">
          <h3>
            <Icon name="folder" size={16} /> {tr('settings.files')}
          </h3>
          <dl class="paths">
            <dt>{tr('settings.configFile')}</dt>
            <dd class="mono">{a.paths.config}</dd>
            <dt>{tr('nav.plugins')}</dt>
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

/**
 * One data source: a line with its name, how often it's read and how it's doing, that opens to
 * its settings. Folded by default (there are a dozen); one that is failing opens by itself.
 */
function SourceRow({ s }: { s: PluginInfo['sources'][number] }) {
  const cfg = config.value!;
  const st = status.value?.sources.find((x) => x.type === s.type);
  const [open, setOpen] = useState(!!st && !st.ok);
  const every = s.intervalMs && fmtMs(st?.intervalMs ?? (cfg.sources[s.type]?.intervalMs as number | undefined) ?? s.intervalMs);
  return (
    <div class={`source-block ${open ? 'open' : ''}`}>
      <button type="button" class="source-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={16} />
        <b>{s.name}</b>
        <code class="muted">{s.type}</code>
        {every && <span class="muted small">· {every}</span>}
        {!open && <span class="source-desc muted small">{s.description}</span>}
        {st && <span class={`status-pill ${st.ok ? 'ok' : 'bad'}`} title={st.error ?? ''}><span class="dot" /> {st.ok ? (st.updatedAt ? clock(st.updatedAt, { seconds: true }) : '…') : st.error}</span>}
      </button>
      {open && (
        <div class="source-body">
          <p class="muted small">{s.description}</p>
          <SchemaForm schema={s.options!} value={cfg.sources[s.type] ?? {}} onChange={(v, k) => edit((d) => (d.sources[s.type] = v), `src-${s.type}-${k}`)} idPrefix={`src-${s.type}`} />
        </div>
      )}
    </div>
  );
}

/** The settings of Kiosko as a device in Home Assistant, as a form, and how the link is doing. */
const HA_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    enabled: { type: 'boolean', default: false, 'x-ui': { label: { en: 'Show Kiosko in Home Assistant', es: 'Mostrar Kiosko en Home Assistant', 'zh-Hant': '在 Home Assistant 中顯示 Kiosko', 'zh-Hans': '在 Home Assistant 中显示 Kiosko' } } },
    broker: { type: 'string', default: '', 'x-ui': { label: { en: 'MQTT broker', es: 'Bróker MQTT', 'zh-Hant': 'MQTT 代理伺服器', 'zh-Hans': 'MQTT 代理服务器' }, placeholder: 'mqtt://homeassistant.local:1883', help: { en: "The one Home Assistant uses (its Mosquitto add-on, usually): mqtt://host:1883, or mqtts:// for TLS.", es: 'El que usa Home Assistant (normalmente su complemento Mosquitto): mqtt://host:1883, o mqtts:// con TLS.', 'zh-Hant': "Home Assistant 使用的那一個（通常是它的 Mosquitto 附加元件）：mqtt://host:1883，TLS 則用 mqtts://。", 'zh-Hans': "即 Home Assistant 所用的那个（通常是其 Mosquitto 加载项）：mqtt://host:1883，使用 TLS 时为 mqtts://。" } } },
    username: { type: 'string', default: '', 'x-ui': { label: { en: 'User', es: 'Usuario', 'zh-Hant': '使用者名稱', 'zh-Hans': '用户名' }, help: { en: 'A Home Assistant user works with the Mosquitto add-on; a dedicated one is better.', es: 'Con el complemento Mosquitto vale un usuario de Home Assistant; mejor uno solo para esto.', 'zh-Hant': '搭配 Mosquitto 附加元件時，可以使用 Home Assistant 的使用者；最好另建一個專用的。', 'zh-Hans': '配合 Mosquitto 加载项时可以使用 Home Assistant 用户；最好单独建一个专用用户。' } } },
    password: { type: 'string', default: '', 'x-ui': { label: { en: 'Password', es: 'Contraseña', 'zh-Hant': '密碼', 'zh-Hans': '密码' }, secret: true } },
    nodeId: { type: 'string', default: 'kiosko', 'x-ui': { advanced: true, label: { en: 'Id in the topics', es: 'Id en los temas', 'zh-Hant': '主題中的 ID', 'zh-Hans': '主题中的 ID' }, help: { en: 'kiosko/<id>/…: change it if two machines run Kiosko.', es: 'kiosko/<id>/…: cámbialo si dos máquinas tienen Kiosko.', 'zh-Hant': 'kiosko/<id>/…：如果有兩台電腦都在執行 Kiosko，請更改此值。', 'zh-Hans': 'kiosko/<id>/…：如果有两台机器都在运行 Kiosko，请修改此值。' } } },
    discoveryPrefix: { type: 'string', default: 'homeassistant', 'x-ui': { advanced: true, label: { en: 'Discovery prefix', es: 'Prefijo de descubrimiento', 'zh-Hant': '探索前綴', 'zh-Hans': '发现前缀' }, help: { en: "Home Assistant's, unless you changed it.", es: 'El de Home Assistant, salvo que lo cambiaras.', 'zh-Hant': "沿用 Home Assistant 的設定，除非你改過。", 'zh-Hans': "沿用 Home Assistant 的设置，除非你改过。" } } },
  },
};

function HomeAssistantCard() {
  const cfg = config.value!;
  const st = status.value?.homeassistant;
  const value = cfg.homeassistant ?? { enabled: false, broker: '', discoveryPrefix: 'homeassistant', nodeId: 'kiosko' };
  return (
    <section class="card">
      <h3>
        <Icon name="house" size={16} /> {tr('settings.ha')}
        {st?.enabled && (
          <span class={`status-pill ${st.state === 'connected' ? 'ok' : st.state === 'error' ? 'bad' : ''}`} title={st.error ?? ''} style="margin-left:auto">
            <span class="dot" /> {st.state === 'connected' ? tr('settings.haConnected') : st.state === 'error' ? st.error : tr('settings.haConnecting')}
          </span>
        )}
      </h3>
      <p class="muted small">{tr('settings.haHint')}</p>
      <div style="max-width:760px">
        <SchemaForm schema={HA_SCHEMA} value={value as unknown as Record<string, unknown>} onChange={(v, k) => edit((d) => (d.homeassistant = v as unknown as NonNullable<typeof d.homeassistant>), `ha-${k}`)} idPrefix="ha" />
      </div>
    </section>
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
        <span class="muted small">{tr('unit.hoursShort')}</span>
      </div>
      <p class="muted small">{tr('settings.hoursHint')}</p>
      <label class="field-label">{tr('settings.byDay')}</label>
      <p class="muted small">{tr('settings.byDayHint')}</p>
      {Object.keys(byDay)
        .sort((a, b) => weekOrder().indexOf(Number(a)) - weekOrder().indexOf(Number(b)))
        .map((day) => (
          <div class="row">
            <span class="day on">{days[Number(day)]}</span>
            <input class="input" type="time" value={byDay[day]?.start ?? ''} onInput={(e) => setDay(day, 'start', (e.target as HTMLInputElement).value)} aria-label={tr('settings.from')} />
            <span class="muted small">–</span>
            <input class="input" type="time" value={byDay[day]?.end ?? ''} onInput={(e) => setDay(day, 'end', (e.target as HTMLInputElement).value)} aria-label={tr('settings.to')} />
            <input class="input num" type="number" min={0} max={24} step={0.25} placeholder={String(w.hours ?? 8)} value={byDay[day]?.hours ?? ''} onInput={(e) => setDay(day, 'hours', (e.target as HTMLInputElement).value)} aria-label={tr('settings.hours')} />
            <span class="muted small">{tr('unit.hoursShort')}</span>
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
        {weekOrder().filter((d) => !(String(d) in byDay)).map((d) => (
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
            <span class="log-time mono">{clock(l.at, { seconds: true })}</span>
            <span class="log-scope mono">{l.scope}</span>
            <span class="log-msg">{l.message}</span>
          </div>
        ))}
      </section>
    </div>
  );
}

/**
 * The editor's language. Choosing one keeps the system's region when it is
 * the same language (en-GB stays en-GB: its clock and first day of the
 * week), and the one in use is marked even if the config says fr-CA.
 */
function LanguagePicker() {
  const cfg = config.value!;
  const system = app.value?.locale ?? navigator.language;
  const current = cfg.locale && cfg.locale !== 'auto' ? uiLanguage() : 'auto';
  const choose = (v: string) => edit((d) => (d.locale = v === 'auto' ? 'auto' : pickLocale([v], system) === v ? system : v));
  const options: [string, string][] = [['auto', tr('settings.auto')], ...UI_LANGUAGES.map((l): [string, string] => [l.id, l.name])];
  // A row of buttons holds a few languages; more go in a list.
  if (options.length > 5)
    return (
      <select class="input" value={current} onChange={(e) => choose((e.target as HTMLSelectElement).value)} aria-label={tr('settings.language')}>
        {options.map(([v, l]) => (
          <option value={v} lang={v === 'auto' ? undefined : v}>{l}</option>
        ))}
      </select>
    );
  return (
    <div class="segmented">
      {options.map(([v, l]) => (
        <button class={current === v ? 'on' : ''} lang={v === 'auto' ? undefined : v} onClick={() => choose(v)}>
          {l}
        </button>
      ))}
    </div>
  );
}

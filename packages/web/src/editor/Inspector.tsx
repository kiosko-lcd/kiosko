/** Right-hand panel: the selected tile, its widget stack and the widget's options; or the page settings. */
import { useState } from 'preact/hooks';
import type { Tile, When } from '@kiosko/core/model';
import { api } from '../api.ts';
import { DurationInput, SchemaForm, Toggle } from '../forms/SchemaForm.tsx';
import { Icon } from '../icons.tsx';
import { tr } from '../i18n.ts';
import { app, draftPage, draftTile, edit, page, screen, selectedTile, selectedWidget, status, tile, widget, widgets } from '../store.ts';
import { deleteTile, duplicateTile } from './Stage.tsx';

export function Inspector() {
  const t = tile.value;
  return <aside class="inspector panel">{t ? <TileInspector t={t} /> : <PageInspector />}</aside>;
}

function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { v: T; label: string; icon?: string }[]; onChange: (v: T) => void }) {
  return (
    <div class="segmented">
      {options.map((o) => (
        <button type="button" class={value === o.v ? 'on' : ''} onClick={() => onChange(o.v)} aria-pressed={value === o.v}>
          {o.icon && <Icon name={o.icon} size={13} />} {o.label}
        </button>
      ))}
    </div>
  );
}

const whenOptions = () => [
  { v: 'always' as When, label: tr('when.always') },
  { v: 'work' as When, label: tr('when.work'), icon: 'briefcase' },
  { v: 'off' as When, label: tr('when.off'), icon: 'coffee' },
];

function PageInspector() {
  const p = page.value;
  const s = screen.value;
  if (!p || !s) return <div class="empty-note">{tr('inspector.nothing')}</div>;
  const set = (fn: (pg: NonNullable<ReturnType<typeof draftPage>>) => void, key?: string) => edit((d) => {
    const pg = draftPage(d);
    if (pg) fn(pg);
  }, key);
  return (
    <div class="insp">
      <div class="insp-head">
        <div class="insp-kicker">
          <Icon name="file" size={13} /> {tr('inspector.page')}
        </div>
        <input class="title-input" value={p.name} onInput={(e) => set((pg) => (pg.name = (e.target as HTMLInputElement).value), `page-name-${p.id}`)} aria-label={tr('inspector.name')} />
      </div>
      <p class="muted small">{tr('inspector.pageHint')}</p>
      <section>
        <h3>{tr('inspector.background')}</h3>
        <div class="color-row">
          <input type="color" value={p.background.color || '#05080d'} onInput={(e) => set((pg) => (pg.background.color = (e.target as HTMLInputElement).value), 'bg')} aria-label={tr('inspector.background')} />
          <input class="input mono" placeholder="theme" value={p.background.color ?? ''} onInput={(e) => set((pg) => (pg.background.color = (e.target as HTMLInputElement).value || undefined), 'bg')} />
        </div>
        <label class="field-label">{tr('inspector.bgImage')}</label>
        <input class="input" value={p.background.image ?? ''} placeholder="/home/me/wallpaper.jpg" onInput={(e) => set((pg) => (pg.background.image = (e.target as HTMLInputElement).value || undefined), 'bgimg')} />
      </section>
      <section>
        <h3>{tr('inspector.when')}</h3>
        <Segmented value={p.when ?? 'always'} options={whenOptions()} onChange={(v) => set((pg) => (pg.when = v))} />
        {s.pages.length > 1 && (
          <>
            <label class="field-label">{tr('inspector.duration')}</label>
            <DurationInput value={p.durationMs ?? 600_000} min={10_000} onChange={(v) => set((pg) => (pg.durationMs = v), 'dur')} />
          </>
        )}
      </section>
    </div>
  );
}

function TileInspector({ t }: { t: Tile }) {
  const w = widget.value;
  const info = w ? widgets.value.get(w.type) : undefined;
  const [adding, setAdding] = useState(false);
  const setTile = (fn: (x: Tile) => void, key?: string) => edit((d) => {
    const x = draftTile(d, t.id);
    if (x) fn(x);
  }, key);
  const setWidget = (fn: (x: Tile['widgets'][number]) => void, key?: string) => setTile((x) => {
    const wi = x.widgets.find((y) => y.id === w?.id);
    if (wi) fn(wi);
  }, key);
  const p = page.value!;

  return (
    <div class="insp">
      <div class="insp-head">
        <div class="insp-kicker">
          <Icon name="square" size={13} /> {tr('inspector.tile')} · {t.w}×{t.h}
        </div>
        <div class="insp-actions">
          <button class="icon-btn" title={tr('inspector.lock')} aria-pressed={!!t.locked} onClick={() => setTile((x) => (x.locked = !x.locked || undefined))}>
            <Icon name={t.locked ? 'lock' : 'lock-open'} size={15} />
          </button>
          <button class="icon-btn" title={`${tr('pages.duplicate')} (Ctrl+D)`} onClick={() => duplicateTile(t.id)}>
            <Icon name="copy" size={15} />
          </button>
          <button class="icon-btn danger" title={`${tr('inspector.deleteTile')} (Supr)`} onClick={() => deleteTile(t.id)}>
            <Icon name="trash-2" size={15} />
          </button>
          <button class="icon-btn" title={tr('common.close')} onClick={() => (selectedTile.value = null)}>
            <Icon name="x" size={15} />
          </button>
        </div>
      </div>

      <section>
        <h3>{tr('inspector.stack')}</h3>
        <div class="stack-list">
          {t.widgets.map((x, i) => {
            const wi = widgets.value.get(x.type);
            const on = x.id === w?.id;
            return (
              <div class={`stack-item ${on ? 'on' : ''} ${x.disabled ? 'off' : ''}`} onClick={() => (selectedWidget.value = x.id)} role="button" tabIndex={0}>
                <span class="stack-icon">
                  <Icon name={wi?.icon ?? 'puzzle'} size={15} />
                </span>
                <span class="stack-name">
                  {x.title || wi?.name || x.type}
                  {x.when && x.when !== 'always' && <em class="pill">{tr(`when.${x.when}` as 'when.work')}</em>}
                </span>
                <span class="stack-tools">
                  <button class="icon-btn" disabled={i === 0} onClick={(e) => {
                    e.stopPropagation();
                    setTile((tt) => {
                      const [a] = tt.widgets.splice(i, 1);
                      tt.widgets.splice(i - 1, 0, a!);
                    });
                  }} title="↑">
                    <Icon name="chevron-up" size={13} />
                  </button>
                  <button class="icon-btn danger" onClick={(e) => {
                    e.stopPropagation();
                    if (t.widgets.length === 1) deleteTile(t.id);
                    else setTile((tt) => (tt.widgets = tt.widgets.filter((y) => y.id !== x.id)));
                  }} title={tr('inspector.remove')}>
                    <Icon name="x" size={13} />
                  </button>
                </span>
              </div>
            );
          })}
        </div>
        {adding ? (
          <WidgetPicker onPick={(type) => {
            const wi = widgets.value.get(type);
            setTile((tt) => tt.widgets.push({ id: `w-${Math.random().toString(36).slice(2, 9)}`, type, options: {}, ...(wi?.chrome === 'bare' ? {} : { title: wi?.name }) }));
            setAdding(false);
          }} onCancel={() => setAdding(false)} />
        ) : (
          <button class="btn ghost small" onClick={() => setAdding(true)}>
            <Icon name="layers" size={14} /> {tr('inspector.addToStack')}
          </button>
        )}
        {t.widgets.length > 1 && (
          <>
            <p class="muted small">{tr('inspector.stackHint')}</p>
            <label class="field-label">{tr('inspector.rotate')}</label>
            <DurationInput value={t.rotateMs} min={2000} onChange={(v) => setTile((x) => (x.rotateMs = v), 'rot')} />
          </>
        )}
        <label class="field-label">{tr('inspector.chrome')}</label>
        <Segmented value={t.chrome} options={[{ v: 'auto', label: tr('chrome.auto') }, { v: 'card', label: tr('chrome.card'), icon: 'square' }, { v: 'bare', label: tr('chrome.bare'), icon: 'maximize' }]} onChange={(v) => setTile((x) => (x.chrome = v))} />
      </section>

      {w && (
        <section class="widget-section">
          <div class="widget-head">
            <span class="widget-icon">
              <Icon name={info?.icon ?? 'puzzle'} size={20} />
            </span>
            <div>
              <div class="widget-name">{info?.name ?? w.type}</div>
              <div class="muted small">{info?.description ?? tr('inspector.unknown')}</div>
            </div>
          </div>
          <label class="field-label" for="w-title">
            {tr('inspector.title')}
          </label>
          <input id="w-title" class="input" placeholder={tr('inspector.titlePh')} value={w.title ?? ''} onInput={(e) => setWidget((x) => (x.title = (e.target as HTMLInputElement).value || undefined), `title-${w.id}`)} />
          {info?.options && Object.keys(info.options.properties ?? {}).length > 0 && (
            <>
              <h3>{tr('inspector.options')}</h3>
              <SchemaForm key={w.id} schema={info.options} value={w.options} onChange={(v, k) => setWidget((x) => (x.options = v), `opt-${w.id}-${k}`)} idPrefix={`o-${w.id}`} />
            </>
          )}
          <h3>{tr('inspector.when')}</h3>
          <Segmented value={w.when ?? 'always'} options={whenOptions()} onChange={(v) => setWidget((x) => (x.when = v === 'always' ? undefined : v))} />
          <DataStatus id={w.id} sources={info?.sources ?? []} hasFetch={!!info?.hasFetch} />
          {info?.hasFetch && (
            <>
              <label class="field-label">{tr('inspector.refreshEvery')}</label>
              <div class="row">
                <DurationInput value={w.intervalMs ?? info.intervalMs ?? 600_000} min={5000} onChange={(v) => setWidget((x) => (x.intervalMs = v), `int-${w.id}`)} />
                <button class="btn ghost small" onClick={() => api.refreshWidget(w.id)}>
                  <Icon name="refresh-cw" size={14} /> {tr('inspector.refreshNow')}
                </button>
              </div>
            </>
          )}
          <div class="field field-row">
            <Toggle checked={!!w.disabled} onChange={(v) => setWidget((x) => (x.disabled = v || undefined))} />
            <span>{tr('inspector.disabled')}</span>
          </div>
        </section>
      )}
      <section>
        <h3>{tr('inspector.size')}</h3>
        <div class="xywh">
          {(['x', 'y', 'w', 'h'] as const).map((k) => (
            <label>
              <span>{k}</span>
              <input class="input" type="number" min={k === 'w' || k === 'h' ? 1 : 0} max={k === 'x' || k === 'w' ? p.grid.cols : p.grid.rows} value={t[k]} onChange={(e) => setTile((x) => (x[k] = Math.max(k === 'w' || k === 'h' ? 1 : 0, Number((e.target as HTMLInputElement).value) || 0)))} />
            </label>
          ))}
        </div>
      </section>
    </div>
  );
}

export function WidgetPicker({ onPick, onCancel }: { onPick: (type: string) => void; onCancel: () => void }) {
  const [q, setQ] = useState('');
  const list = [...widgets.value.values()].filter((w) => !q || `${w.name} ${w.type}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div class="picker">
      <div class="search">
        <Icon name="search" size={14} />
        <input autoFocus placeholder={tr('library.search')} value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
        <button class="icon-btn" onClick={onCancel}>
          <Icon name="x" size={14} />
        </button>
      </div>
      <div class="picker-list">
        {list.map((w) => (
          <button class="picker-item" onClick={() => onPick(w.type)}>
            <Icon name={w.icon ?? 'puzzle'} size={14} /> <span>{w.name}</span> <small>{w.plugin.name}</small>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Where the widget's data stands: own fetch and shared sources, live from the server. */
function DataStatus({ id, sources, hasFetch }: { id: string; sources: string[]; hasFetch: boolean }) {
  if (!hasFetch && !sources.length) return null;
  if (app.value?.demo) return <div class="data-status demo"><Icon name="flask-conical" size={13} /> {tr('data.demo')}</div>;
  const st = status.value;
  const rows = [
    ...(hasFetch ? [st?.fetches.find((f) => f.id === id) ?? { type: tr('data.own'), ok: true, error: null, updatedAt: null }] : []),
    ...sources.map((s) => st?.sources.find((x) => x.type === s) ?? { type: s, ok: true, error: null, updatedAt: null }),
  ];
  return (
    <div class="data-status">
      {rows.map((r) => (
        <div class={`data-row ${r.ok ? (r.updatedAt ? 'ok' : 'wait') : 'bad'}`} title={r.error ?? ''}>
          <span class="dot" />
          <code>{'type' in r ? r.type : ''}</code>
          <span>{!r.ok ? r.error : r.updatedAt ? `${tr('data.updated')} ${new Date(r.updatedAt).toLocaleTimeString()}` : tr('data.waiting')}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Source profiles in the editor (see packages/core/src/config/profiles.ts):
 * several named configurations of a source that accepts them, edited as
 * tabs in Settings → Data sources, and picked per widget in the inspector,
 * where a new one can be made from the tile itself.
 */
import { useState } from 'preact/hooks';
import { deleteProfile, newProfileId, profileUsers, profilesOf, type Config } from '@kiosko/core/model';
import type { PluginInfo } from '../api.ts';
import { ChoicesProfile, SchemaForm } from '../forms/SchemaForm.tsx';
import { typed } from '../forms/ime.ts';
import { Icon } from '../icons.tsx';
import { count, t, tr } from '../i18n.ts';
import { app, config, edit, widgets } from '../store.ts';

export type SourceInfo = PluginInfo['sources'][number];

/** The sources of the enabled plugins that accept profiles, by type. */
export function profileSources(): Map<string, SourceInfo> {
  const m = new Map<string, SourceInfo>();
  for (const p of app.value?.catalog ?? []) if (p.enabled) for (const s of p.sources) if (s.profiles) m.set(s.type, s);
  return m;
}

/** The source whose profile a widget picks: the first it reads that accepts profiles. */
export function profileSourceOf(widgetType: string): SourceInfo | undefined {
  const all = profileSources();
  for (const s of widgets.value.get(widgetType)?.sources ?? []) {
    const info = all.get(s);
    if (info) return info;
  }
  return undefined;
}

/** Whether a widget type reads `sourceType`. */
const reader = (sourceType: string) => (widgetType: string) => !!widgets.value.get(widgetType)?.sources.includes(sourceType);

/** «Used by 3 tiles», or that none uses it yet. */
export const usedBy = (n: number) => (n ? count('profiles.usedBy', n) : tr('profiles.unused'));

/** How many widgets read profile `id` of `type`. */
export const usersOf = (cfg: Config, type: string, id: string) => profileUsers(cfg, id, reader(type)).length;

/** The source key a widget reads `type` under (see core's `resolveSourceKey`), for its status. */
export function keyFor(cfg: Config, type: string, profile: string | undefined): string {
  return profile && profileSources().has(type) && Object.hasOwn(profilesOf(cfg, type), profile) ? `${type}#${profile}` : type;
}

/**
 * Adds a profile to the config being edited, named `name`, with a copy of
 * the options of `from` (a profile id, or null for the default one). Its id.
 */
export function addProfile(d: Config, type: string, name: string, from: string | null): string {
  const list = (d.sourceProfiles ??= {})[type] ?? {};
  const id = newProfileId(name, Object.keys(list));
  const options = from ? list[from]?.options : d.sources[type];
  list[id] = { name, options: structuredClone(options ?? {}) };
  d.sourceProfiles[type] = list;
  return id;
}

/** A name not taken yet: «Profile 2», «Profile 3»… */
function freeName(cfg: Config, type: string, base: string): string {
  const names = new Set(Object.values(profilesOf(cfg, type)).map((p) => p.name));
  let n = Object.keys(profilesOf(cfg, type)).length + 2;
  while (names.has(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

/**
 * The profiles of a source as tabs (the default one first), with the
 * selected one's name, actions and options. `selected`: null for the default.
 */
export function ProfileTabs({ s }: { s: SourceInfo }) {
  const cfg = config.value!;
  const list = profilesOf(cfg, s.type);
  const [sel, setSel] = useState<string | null>(null);
  const current = sel && list[sel] ? sel : null;
  const add = (from: string | null) => {
    let id = '';
    const name = from ? t('profiles.copyOf', { name: list[from]?.name ?? from }) : freeName(cfg, s.type, tr('profiles.newName'));
    edit((d) => (id = addProfile(d, s.type, name, from)));
    setSel(id);
  };
  const remove = (id: string) => {
    const n = usersOf(cfg, s.type, id);
    const ask = n ? `${t('profiles.deleteConfirm', { name: list[id]!.name })} ${usedBy(n)}. ${tr('profiles.deleteMoves')}` : t('profiles.deleteConfirm', { name: list[id]!.name });
    if (!confirm(ask)) return;
    edit((d) => deleteProfile(d, s.type, id, reader(s.type)));
    setSel(null);
  };
  const tab = (id: string | null, label: string) => {
    const n = id ? usersOf(cfg, s.type, id) : null;
    return (
      <button type="button" role="tab" class={`profile-tab ${current === id ? 'on' : ''}`} aria-selected={current === id} onClick={() => setSel(id)} title={n !== null ? usedBy(n) : tr('profiles.defaultHint')}>
        {label}
        {n !== null && n > 0 && <span class="profile-count">{n}</span>}
      </button>
    );
  };
  return (
    <div class="profiles">
      <div class="profile-tabs" role="tablist" aria-label={tr('profiles.title')}>
        {tab(null, tr('profiles.default'))}
        {Object.entries(list).map(([id, p]) => tab(id, p.name))}
        <button type="button" class="profile-tab add" onClick={() => add(null)} title={tr('profiles.addHint')}>
          <Icon name="plus" size={13} /> {tr('profiles.add')}
        </button>
      </div>
      {current ? (
        <div class="profile-head">
          <label class="field-label" for={`pn-${s.type}`}>{tr('profiles.name')}</label>
          <div class="row">
            <input id={`pn-${s.type}`} class="input" value={list[current]!.name} {...typed((text) => edit((d) => {
              const p = d.sourceProfiles?.[s.type]?.[current];
              if (p) p.name = text;
            }, `pname-${s.type}-${current}`))} />
            <button type="button" class="btn ghost small" onClick={() => add(current)} title={tr('profiles.duplicate')}>
              <Icon name="copy" size={14} /> {tr('profiles.duplicate')}
            </button>
            <button type="button" class="btn ghost small danger" onClick={() => remove(current)}>
              <Icon name="trash-2" size={14} /> {tr('profiles.delete')}
            </button>
          </div>
          <p class="muted small">{t('profiles.idHint', { id: current })} {usedBy(usersOf(cfg, s.type, current))}.</p>
        </div>
      ) : (
        Object.keys(list).length > 0 && <p class="muted small">{tr('profiles.defaultHint')}</p>
      )}
      <ProfileOptions s={s} id={current} />
    </div>
  );
}

/** The options of one profile of a source (null: the default one), as a form. */
export function ProfileOptions({ s, id }: { s: SourceInfo; id: string | null }) {
  const cfg = config.value!;
  if (!s.options) return null;
  const value = id ? (cfg.sourceProfiles?.[s.type]?.[id]?.options ?? {}) : (cfg.sources[s.type] ?? {});
  const set = (v: Record<string, unknown>, k?: string) =>
    edit((d) => {
      if (!id) d.sources[s.type] = v;
      else {
        const p = d.sourceProfiles?.[s.type]?.[id];
        if (p) p.options = v;
      }
    }, `src-${s.type}-${id ?? ''}-${k}`);
  return (
    <ChoicesProfile.Provider value={id ?? undefined}>
      <SchemaForm key={`${s.type}#${id ?? ''}`} schema={s.options} value={value} onChange={set} idPrefix={`src-${s.type}-${id ?? 'default'}`} />
    </ChoicesProfile.Provider>
  );
}

/**
 * The inspector's picker: which profile of its source a widget reads, a new
 * one made here (a copy of the one it reads now), and that profile's options
 * folded below, so a «Technology» tile is set up without leaving the tile.
 */
export function ProfilePicker({ s, widgetId, profile, onPick }: { s: SourceInfo; widgetId: string; profile: string | undefined; onPick: (id: string | undefined) => void }) {
  const cfg = config.value!;
  const list = profilesOf(cfg, s.type);
  const current = profile && list[profile] ? profile : undefined;
  const [open, setOpen] = useState(false);
  const [naming, setNaming] = useState<string | null>(null);
  const create = () => {
    const name = (naming ?? '').trim() || freeName(cfg, s.type, tr('profiles.newName'));
    let id = '';
    edit((d) => {
      id = addProfile(d, s.type, name, current ?? null);
      for (const sc of d.screens) for (const pg of sc.pages) for (const tl of pg.tiles) for (const w of tl.widgets) if (w.id === widgetId) w.profile = id;
    });
    setNaming(null);
    setOpen(true);
  };
  return (
    <div class="field profile-picker">
      <label class="field-label" for={`wp-${widgetId}`}>
        {tr('profiles.picker')} <code class="muted">{s.name}</code>
      </label>
      <div class="row">
        <select
          id={`wp-${widgetId}`}
          class="input"
          value={naming !== null ? '+' : (current ?? '')}
          onChange={(e) => {
            const v = (e.target as HTMLSelectElement).value;
            if (v === '+') return setNaming('');
            setNaming(null);
            onPick(v || undefined);
          }}
        >
          <option value="">{tr('profiles.default')}</option>
          {Object.entries(list).map(([id, p]) => (
            <option value={id}>{p.name}</option>
          ))}
          <option value="+">{tr('profiles.new')}</option>
        </select>
        {s.options && naming === null && (
          <button type="button" class="btn ghost small" aria-expanded={open} onClick={() => setOpen(!open)} title={tr('profiles.editHint')}>
            <Icon name={open ? 'chevron-down' : 'sliders-horizontal'} size={14} /> {tr('profiles.edit')}
          </button>
        )}
      </div>
      {naming !== null && (
        <div class="row profile-new">
          <input class="input" autoFocus placeholder={freeName(cfg, s.type, tr('profiles.newName'))} value={naming} onInput={(e) => setNaming((e.target as HTMLInputElement).value)} onKeyDown={(e) => {
            if (e.key === 'Enter') create();
            if (e.key === 'Escape') setNaming(null);
          }} aria-label={tr('profiles.name')} />
          <button type="button" class="btn small" onClick={create}>{tr('profiles.create')}</button>
          <button type="button" class="icon-btn" onClick={() => setNaming(null)} title={tr('common.close')}>
            <Icon name="x" size={14} />
          </button>
        </div>
      )}
      <div class="field-help">{naming !== null ? t('profiles.newHint', { from: current ? list[current]!.name : tr('profiles.default') }) : current ? `${usedBy(usersOf(cfg, s.type, current))}. ${tr('profiles.sharedHint')}` : tr('profiles.pickerHint')}</div>
      {open && naming === null && (
        <div class="profile-options">
          {current ? (
            <>
              <label class="field-label" for={`wpn-${widgetId}`}>{tr('profiles.name')}</label>
              <input id={`wpn-${widgetId}`} class="input" value={list[current]!.name} {...typed((text) => edit((d) => {
                const p = d.sourceProfiles?.[s.type]?.[current];
                if (p) p.name = text;
              }, `pname-${s.type}-${current}`))} />
            </>
          ) : (
            <p class="muted small">{tr('profiles.defaultShared')}</p>
          )}
          <ProfileOptions s={s} id={current ?? null} />
        </div>
      )}
    </div>
  );
}

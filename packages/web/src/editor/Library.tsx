/** The widget library: search, categories and live thumbnails, draggable onto the panel. */
import { useMemo, useState } from 'preact/hooks';
import { api } from '../api.ts';
import { Icon } from '../icons.tsx';
import { loc, tr } from '../i18n.ts';
import { app, config, widgets } from '../store.ts';
import { addWidgetSomewhere, dragging } from './Stage.tsx';

const CAT_ICON: Record<string, string> = {
  agents: 'bot',
  system: 'cpu',
  time: 'clock',
  productivity: 'list-checks',
  dev: 'git-branch',
  info: 'newspaper',
  media: 'image',
  scene: 'sparkles',
  fun: 'party-popper',
};

export function Library() {
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<string>('all');
  const all = [...widgets.value.values()];
  const cats = (app.value?.categories ?? []).filter((c) => all.some((w) => w.category === c.id));
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return all.filter((w) => (cat === 'all' || w.category === cat) && (!needle || `${w.name} ${w.description} ${w.tags.join(' ')} ${w.type} ${w.plugin.name}`.toLowerCase().includes(needle)));
  }, [q, cat, widgets.value]);
  const themeKey = `${config.value?.theme}-${config.value?.locale}`;
  return (
    <aside class="library panel">
      <div class="panel-head">
        <h2>{tr('library.title')}</h2>
        <span class="count">{all.length}</span>
      </div>
      <div class="search">
        <Icon name="search" size={15} />
        <input placeholder={tr('library.search')} value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} aria-label={tr('library.search')} />
        {q && (
          <button class="icon-btn" onClick={() => setQ('')} aria-label="clear">
            <Icon name="x" size={14} />
          </button>
        )}
      </div>
      <div class="chips" role="tablist">
        <button role="tab" class={`chip ${cat === 'all' ? 'on' : ''}`} onClick={() => setCat('all')}>
          {tr('library.all')}
        </button>
        {cats.map((c) => (
          <button role="tab" class={`chip ${cat === c.id ? 'on' : ''}`} onClick={() => setCat(c.id)}>
            <Icon name={CAT_ICON[c.id] ?? 'shapes'} size={13} /> {loc(c.label)}
          </button>
        ))}
      </div>
      <div class="lib-hint">{tr('library.hint')}</div>
      <div class="lib-list">
        {list.map((w) => {
          const pref = w.size.preferred ?? { w: 480, h: 300 };
          const aspect = pref.w / pref.h;
          const tw = 240;
          const th = Math.round(Math.max(60, Math.min(160, tw / aspect)));
          return (
            <div
              class="lib-item"
              draggable
              onDragStart={(e) => {
                dragging.type = w.type;
                e.dataTransfer?.setData('text/plain', w.type);
                if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy';
              }}
              onDragEnd={() => (dragging.type = null)}
              onClick={() => addWidgetSomewhere(w.type)}
              onKeyDown={(e) => e.key === 'Enter' && addWidgetSomewhere(w.type)}
              tabIndex={0}
              role="button"
              title={w.description}
            >
              <div class="lib-thumb" style={{ aspectRatio: `${tw} / ${th}` }}>
                <img loading="lazy" src={api.thumbnailUrl(w.type, Math.min(pref.w, 960), Math.min(pref.h, 480), themeKey)} alt="" draggable={false} />
              </div>
              <div class="lib-meta">
                <div class="lib-name">
                  <Icon name={w.icon ?? 'puzzle'} size={14} /> {w.name}
                </div>
                <div class="lib-desc">{w.description}</div>
                <div class="lib-plugin">{w.plugin.name}</div>
              </div>
            </div>
          );
        })}
        {!list.length && <div class="empty-note">{tr('library.empty')}</div>}
      </div>
    </aside>
  );
}

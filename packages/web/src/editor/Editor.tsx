/** The editor view: library | stage + pages | inspector. */
import { autoPack, compact, rescale, suggestGrid, type Gravity } from '@tessera/core/layout';
import { newPage, type Page, type Screen } from '@tessera/core/model';
import { useEffect, useState } from 'preact/hooks';
import { api } from '../api.ts';
import { Icon } from '../icons.tsx';
import { tr } from '../i18n.ts';
import { canRedo, canUndo, draftPage, draftScreen, edit, go, lastFrame, liveMode, page, pageId, redo, screen, selectedTile, showGrid, status, undo } from '../store.ts';
import { Inspector } from './Inspector.tsx';
import { Library } from './Library.tsx';
import { Stage } from './Stage.tsx';

export function Editor() {
  const s = screen.value;
  if (!s) {
    return (
      <div class="empty-state">
        <div class="empty-art">
          <Icon name="monitor-smartphone" size={40} />
        </div>
        <h2>{tr('stage.noScreen')}</h2>
        <p class="muted">{tr('stage.noScreenHint')}</p>
        <button class="btn primary" onClick={() => go('screens')}>
          <Icon name="plus" size={16} /> {tr('stage.addScreen')}
        </button>
      </div>
    );
  }
  return (
    <div class="editor">
      <Library />
      <main class="center">
        <Toolbar />
        <Stage />
        <PagesBar />
      </main>
      <Inspector />
    </div>
  );
}

function Toolbar() {
  const p = page.value;
  if (!p) return null;
  const s = screen.value!;
  const setPage = (fn: (pg: Page) => void) => edit((d) => {
    const pg = draftPage(d);
    if (pg) fn(pg);
  });
  const density = (delta: number) => setPage((pg) => {
    const target = Math.max(2, Math.round(s.height / pg.grid.rows) - delta * 10);
    const g = suggestGrid(s.width, s.height, target);
    pg.tiles = rescale(pg.tiles, pg.grid, g);
    pg.grid = g;
  });
  return (
    <div class="toolbar">
      <div class="tb-group">
        <button class="icon-btn" disabled={!canUndo.value} onClick={undo} title={`${tr('undo')} (Ctrl+Z)`}>
          <Icon name="undo-2" size={16} />
        </button>
        <button class="icon-btn" disabled={!canRedo.value} onClick={redo} title={`${tr('redo')} (Ctrl+Shift+Z)`}>
          <Icon name="redo-2" size={16} />
        </button>
      </div>
      <div class="tb-group">
        <span class="tb-label hide-md">{tr('stage.gravity')}</span>
        <div class="segmented small" title={tr('stage.gravity')}>
          {(['none', 'up', 'left'] as Gravity[]).map((g) => (
            <button class={p.gravity === g ? 'on' : ''} title={tr(`gravity.${g}`)} onClick={() => setPage((pg) => {
              pg.gravity = g;
              pg.tiles = compact(pg.tiles, g);
            })}>
              <Icon name={g === 'none' ? 'move' : g === 'up' ? 'arrow-up-to-line' : 'arrow-left-to-line'} size={14} />
              <span class="hide-sm hide-md">{tr(`gravity.${g}`)}</span>
            </button>
          ))}
        </div>
      </div>
      <div class="tb-group">
        <span class="tb-label hide-md">{tr('stage.density')}</span>
        <button class="icon-btn" onClick={() => density(-1)} title="−">
          <Icon name="minus" size={14} />
        </button>
        <span class="tb-value">
          {p.grid.cols}×{p.grid.rows}
        </span>
        <button class="icon-btn" onClick={() => density(1)} title="+">
          <Icon name="plus" size={14} />
        </button>
      </div>
      <button class="btn ghost small" onClick={() => setPage((pg) => {
        const r = autoPack(pg.tiles, pg.grid, pg.gravity === 'none' ? 'up' : pg.gravity);
        pg.tiles = r.items;
      })} title={tr('stage.autoArrange')}>
        <Icon name="layout-grid" size={14} /> <span class="hide-sm hide-md">{tr('stage.autoArrange')}</span>
      </button>
      <div class="tb-spacer" />
      <button class={`btn ghost small ${showGrid.value ? 'active' : ''}`} onClick={() => (showGrid.value = !showGrid.value)} aria-pressed={showGrid.value}>
        <Icon name="grid-3x3" size={14} /> <span class="hide-sm hide-md">{tr('stage.grid')}</span>
      </button>
      <button class={`btn small ${liveMode.value ? 'live-on' : 'ghost'}`} onClick={() => {
        liveMode.value = !liveMode.value;
        if (liveMode.value) selectedTile.value = null;
      }} aria-pressed={liveMode.value}>
        <span class={`dot ${liveMode.value ? 'pulse' : ''}`} /> {liveMode.value ? tr('stage.live') : tr('stage.editing')}
      </button>
    </div>
  );
}

function PagesBar() {
  const s = screen.value!;
  const current = page.value;
  const st = status.value?.screens.find((x) => x.id === s.id);
  const onPanel = lastFrame.value[s.id]?.pageId ?? st?.page;
  const pinned = st?.pinned ?? s.pinnedPage ?? null;
  const setScreen = (fn: (sc: typeof s) => void) => edit((d) => {
    const sc = draftScreen(d);
    if (sc) fn(sc);
  });
  return (
    <div class="pages-bar">
      <span class="tb-label">{tr('pages.title')}</span>
      <div class="pages">
        {s.pages.map((p) => (
          <div class={`page-card ${current?.id === p.id ? 'on' : ''} ${p.enabled === false ? 'off' : ''}`} onClick={() => {
            pageId.value = p.id;
            selectedTile.value = null;
          }} role="tab" aria-selected={current?.id === p.id} tabIndex={0}>
            <PageThumb screen={s} pageId={p.id} />
            <div class="page-card-meta">
              {onPanel === p.id && <span class="dot live" title={tr('pages.onPanel')} />}
              <span class="page-name">{p.name}</span>
              <span class="page-count">{p.tiles.length}</span>
              <button class={`icon-btn tiny ${pinned === p.id ? 'pinned' : ''}`} title={pinned === p.id ? tr('pages.unpin') : tr('pages.pin')} onClick={(e) => {
                e.stopPropagation();
                const next = pinned === p.id ? null : p.id;
                setScreen((sc) => {
                  if (next) sc.pinnedPage = next;
                  else delete sc.pinnedPage;
                });
                void api.pin(s.id, next);
              }}>
                <Icon name={pinned === p.id ? 'pin' : 'pin-off'} size={12} />
              </button>
            </div>
          </div>
        ))}
        <button class="icon-btn" title={tr('pages.add')} onClick={() => {
          const np = newPage(`${tr('inspector.page')} ${s.pages.length + 1}`, s.width, s.height);
          setScreen((sc) => sc.pages.push(np));
          pageId.value = np.id;
        }}>
          <Icon name="plus" size={15} />
        </button>
      </div>
      <div class="tb-spacer" />
      {current && (
        <>
          <button class="icon-btn" title={tr('pages.duplicate')} onClick={() => {
            const copy = JSON.parse(JSON.stringify(current)) as Page;
            copy.id = newPage('x', s.width, s.height).id;
            copy.name = `${current.name} (2)`;
            setScreen((sc) => sc.pages.push(copy));
            pageId.value = copy.id;
          }}>
            <Icon name="copy" size={15} />
          </button>
          <button class="icon-btn danger" disabled={s.pages.length < 2} title={tr('pages.delete')} onClick={() => {
            if (!confirm(tr('confirm.deletePage'))) return;
            setScreen((sc) => (sc.pages = sc.pages.filter((p) => p.id !== current.id)));
            pageId.value = null;
          }}>
            <Icon name="trash-2" size={15} />
          </button>
        </>
      )}
      {s.pages.length > 1 && (
        <span class="muted small">
          <Icon name={pinned ? 'pin' : 'repeat'} size={12} /> {pinned ? s.pages.find((p) => p.id === pinned)?.name : tr('pages.rotation')}
        </span>
      )}
    </div>
  );
}

/** A small live picture of a page, refreshed shortly after it changes. */
function PageThumb({ screen: s, pageId: id }: { screen: Screen; pageId: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const key = JSON.stringify([s.width, s.height, s.pages.find((p) => p.id === id)]);
  useEffect(() => {
    let alive = true;
    const t = setTimeout(async () => {
      try {
        const r = await api.preview(s, id);
        if (!alive) return URL.revokeObjectURL(r.url);
        setUrl((old) => {
          if (old) setTimeout(() => URL.revokeObjectURL(old), 1000);
          return r.url;
        });
      } catch {
        /* retried on the next change */
      }
    }, 700);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [key]);
  return (
    <div class="page-thumb" style={{ aspectRatio: `${s.width} / ${s.height}` }}>
      {url && <img src={url} alt="" draggable={false} />}
    </div>
  );
}

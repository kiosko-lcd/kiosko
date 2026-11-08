/**
 * The panel, at scale, with the grid and the tiles on top. The picture is
 * painted by the server (same code as the real panel); the tiles are DOM
 * boxes over it that can be selected, moved and resized.
 */
import { useComputed, useSignal, useSignalEffect } from '@preact/signals';
import { useEffect, useRef, useState } from 'preact/hooks';
import { cellsFor, collisions, fit, inBounds, place, toPx, type GridItem, type Rect } from '@tessera/core/layout';
import { newTile, newWidget, type Page, type Tile } from '@tessera/core/model';
import { api } from '../api.ts';
import { Icon } from '../icons.tsx';
import { tr } from '../i18n.ts';
import { config, draftPage, edit, lastFrame, liveMode, notify, page, redo, screen, selectedTile, selectedWidget, showGrid, undo, widgets } from '../store.ts';

/** Type of the widget being dragged from the library (DnD can't read data during dragover). */
export const dragging = { type: null as string | null };

interface Drag {
  kind: 'move' | 'resize';
  id: string;
  edge: string;
  startX: number;
  startY: number;
  start: Rect;
  moved: boolean;
}

interface Ghost {
  rect: Rect;
  ok: boolean;
  /** Dropping onto this tile stacks the widget there. */
  stackOn: string | null;
}

export function minCellsOf(t: Tile, p: Page, W: number, H: number): { w: number; h: number } {
  let w = 1;
  let h = 1;
  for (const wi of t.widgets) {
    const min = widgets.value.get(wi.type)?.size.min;
    if (!min) continue;
    const c = cellsFor(min, p.grid, W, H);
    w = Math.max(w, Math.min(c.w, p.grid.cols));
    h = Math.max(h, Math.min(c.h, p.grid.rows));
  }
  return { w, h };
}

export function Stage() {
  const scr = screen.value;
  const pg = page.value;
  const wrap = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 900, h: 400 });
  const img = useSignal<string | null>(null);
  const tileInfo = useSignal<Record<string, { shown: string | null; error?: string }>>({});
  const [drag, setDrag] = useState<Drag | null>(null);
  const [preview, setPreview] = useState<Tile[] | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [ghost, setGhost] = useState<Ghost | null>(null);
  const tick = useSignal(0);

  // Fit the panel in the available space.
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Ask the server for a fresh picture when what's on the page changes.
  const key = useComputed(() => JSON.stringify([screen.value, page.value?.id, selectedTile.value, selectedWidget.value, config.value?.theme, config.value?.locale, tick.value]));
  useSignalEffect(() => {
    const k = key.value;
    const s = screen.value;
    const p = page.value;
    if (!s || !p) return;
    const force: Record<string, string> = {};
    if (selectedTile.value && selectedWidget.value) force[selectedTile.value] = selectedWidget.value;
    const t = setTimeout(async () => {
      try {
        const r = await api.preview(s, p.id, force);
        const old = img.value;
        const im = new Image();
        im.onload = () => {
          img.value = r.url;
          if (old) setTimeout(() => URL.revokeObjectURL(old), 1000);
        };
        im.src = r.url;
        tileInfo.value = Object.fromEntries(r.tiles.map((x) => [x.id, x]));
      } catch {
        /* server restarting: the next change retries */
      }
    }, 90);
    void k;
    return () => clearTimeout(t);
  });

  // Live data changes: repaint the preview now and then (clocks, sessions…).
  useEffect(() => {
    const t = setInterval(() => (tick.value = tick.value + 1), 8000);
    return () => clearInterval(t);
  }, []);
  useSignalEffect(() => {
    const f = scr ? lastFrame.value[scr.id] : undefined;
    if (f && !drag) tick.value = Math.floor(f.at / 4000);
  });

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target as HTMLElement)?.isContentEditable) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
        return;
      }
      const id = selectedTile.value;
      if (!id) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        deleteTile(id);
      } else if (e.key === 'Escape') {
        selectedTile.value = null;
      } else if (mod && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        duplicateTile(id);
      } else if (e.key.startsWith('Arrow')) {
        e.preventDefault();
        const p = page.value!;
        const t = p.tiles.find((x) => x.id === id);
        if (!t) return;
        const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key] ?? [0, 0];
        const r = e.shiftKey ? { x: t.x, y: t.y, w: Math.max(1, t.w + d[0]!), h: Math.max(1, t.h + d[1]!) } : { x: t.x + d[0]!, y: t.y + d[1]!, w: t.w, h: t.h };
        const next = place(p.tiles, id, r, p.grid, p.gravity);
        if (next) commitTiles(next);
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  if (!scr || !pg) return null;
  const W = scr.width;
  const H = scr.height;
  const pad = 28;
  const scale = Math.max(0.05, Math.min((box.w - pad * 2) / W, (box.h - pad * 2) / H, 2));
  const sw = Math.round(W * scale);
  const sh = Math.round(H * scale);
  const tiles = preview ?? pg.tiles;
  const live = liveMode.value;
  const frame = lastFrame.value[scr.id];
  const src = live && frame ? api.liveFrameUrl(scr.id, frame.at) : img.value;

  const cellOf = (clientX: number, clientY: number, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const px = ((clientX - r.left) / r.width) * W;
    const py = ((clientY - r.top) / r.height) * H;
    const colW = (W - 2 * pg.grid.padding + pg.grid.gap) / pg.grid.cols;
    const rowH = (H - 2 * pg.grid.padding + pg.grid.gap) / pg.grid.rows;
    return { fx: (px - pg.grid.padding) / colW, fy: (py - pg.grid.padding) / rowH, colW, rowH };
  };

  // ---- Move and resize ----
  const onPointerDown = (e: PointerEvent, t: Tile, edge: string) => {
    if (live || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    selectedTile.value = t.id;
    if (!t.widgets.some((w) => w.id === selectedWidget.value)) selectedWidget.value = t.widgets[0]?.id ?? null;
    if (t.locked && edge === 'move') return;
    setDrag({ kind: edge === 'move' ? 'move' : 'resize', id: t.id, edge, startX: e.clientX, startY: e.clientY, start: { x: t.x, y: t.y, w: t.w, h: t.h }, moved: false });
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!drag) return;
    const el = (e.currentTarget as HTMLElement).closest('.panel-surface') as HTMLElement;
    const r = el.getBoundingClientRect();
    const colW = ((W - 2 * pg.grid.padding + pg.grid.gap) / pg.grid.cols) * (r.width / W);
    const rowH = ((H - 2 * pg.grid.padding + pg.grid.gap) / pg.grid.rows) * (r.height / H);
    const dx = Math.round((e.clientX - drag.startX) / colW);
    const dy = Math.round((e.clientY - drag.startY) / rowH);
    if (!drag.moved && Math.abs(e.clientX - drag.startX) + Math.abs(e.clientY - drag.startY) < 4) return;
    if (!drag.moved) setDrag({ ...drag, moved: true });
    const s = drag.start;
    let rect: Rect = { ...s };
    if (drag.kind === 'move') rect = { ...s, x: s.x + dx, y: s.y + dy };
    else {
      const t = pg.tiles.find((x) => x.id === drag.id)!;
      const min = minCellsOf(t, pg, W, H);
      if (drag.edge.includes('e')) rect.w = Math.max(min.w, s.w + dx);
      if (drag.edge.includes('s')) rect.h = Math.max(min.h, s.h + dy);
      if (drag.edge.includes('w')) {
        const w = Math.max(min.w, s.w - dx);
        rect.x = s.x + s.w - w;
        rect.w = w;
      }
      if (drag.edge.includes('n')) {
        const h = Math.max(min.h, s.h - dy);
        rect.y = s.y + s.h - h;
        rect.h = h;
      }
      if (rect.x < 0) {
        rect.w += rect.x;
        rect.x = 0;
      }
      if (rect.y < 0) {
        rect.h += rect.y;
        rect.y = 0;
      }
    }
    const next = place(pg.tiles, drag.id, fit(rect, pg.grid), pg.grid, pg.gravity);
    if (next) {
      setPreview(next);
      setInvalid(false);
    } else {
      setPreview(pg.tiles.map((t) => (t.id === drag.id ? { ...t, ...fit(rect, pg.grid) } : t)));
      setInvalid(true);
    }
  };

  const onPointerUp = () => {
    if (drag && preview && !invalid && drag.moved) commitTiles(preview);
    setDrag(null);
    setPreview(null);
    setInvalid(false);
  };

  // ---- Drop from the library ----
  const ghostFor = (e: DragEvent): Ghost | null => {
    const type = dragging.type;
    if (!type) return null;
    const el = e.currentTarget as HTMLElement;
    const { fx, fy } = cellOf(e.clientX, e.clientY, el);
    const over = pg.tiles.find((t) => fx >= t.x && fx < t.x + t.w && fy >= t.y && fy < t.y + t.h);
    if (over) return { rect: { x: over.x, y: over.y, w: over.w, h: over.h }, ok: true, stackOn: over.id };
    const info = widgets.value.get(type);
    const pref = cellsFor(info?.size.preferred ?? { w: W / 4, h: H / 2 }, pg.grid, W, H);
    const rect = fit({ x: Math.round(fx - pref.w / 2), y: Math.round(fy - pref.h / 2), w: pref.w, h: pref.h }, pg.grid);
    // Shrink until it fits the free space under the pointer.
    let r = rect;
    while (collisions(pg.tiles, r).length && (r.w > 1 || r.h > 1)) {
      const min = info?.size.min ? cellsFor(info.size.min, pg.grid, W, H) : { w: 1, h: 1 };
      const shrinkW = r.w > Math.max(1, min.w) && r.w >= r.h;
      const nr = shrinkW ? { ...r, w: r.w - 1 } : r.h > Math.max(1, min.h) ? { ...r, h: r.h - 1 } : null;
      if (!nr) break;
      const cx = Math.floor(fx);
      const cy = Math.floor(fy);
      r = fit({ ...nr, x: Math.min(Math.max(nr.x, cx - nr.w + 1), cx), y: Math.min(Math.max(nr.y, cy - nr.h + 1), cy) }, pg.grid);
    }
    return { rect: r, ok: !collisions(pg.tiles, r).length && inBounds(r, pg.grid), stackOn: null };
  };

  const onDragOver = (e: DragEvent) => {
    if (!dragging.type || live) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    const g = ghostFor(e);
    if (JSON.stringify(g) !== JSON.stringify(ghost)) setGhost(g);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    const type = dragging.type;
    const g = ghostFor(e);
    setGhost(null);
    dragging.type = null;
    if (!type || !g) return;
    if (g.stackOn) {
      stackWidget(g.stackOn, type);
      return;
    }
    if (!g.ok) {
      notify(tr('toast.noRoom'), 'error');
      return;
    }
    addTileAt(type, g.rect);
  };

  const showChips = !live;
  return (
    <div class="stage" ref={wrap} onPointerDown={(e) => {
      if ((e.target as HTMLElement).classList.contains('stage')) selectedTile.value = null;
    }}>
      <div class={`bezel ${live ? 'is-live' : ''}`} style={{ width: sw + 24, height: sh + 24 }}>
        <div class="panel-surface" style={{ width: sw, height: sh }} onDragOver={onDragOver} onDragLeave={() => setGhost(null)} onDrop={onDrop} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerDown={(e) => {
          if (e.target === e.currentTarget) selectedTile.value = null;
        }}>
          {src ? <img class="panel-img" src={src} alt="" draggable={false} /> : <div class="panel-loading" />}
          {!live && showGrid.value && <GridLines page={pg} W={W} H={H} />}
          {!live &&
            tiles.map((t) => {
              const r = toPx(t, pg.grid, W, H);
              const sel = selectedTile.value === t.id;
              const info = tileInfo.value[t.id];
              const shown = t.widgets.find((w) => w.id === info?.shown) ?? t.widgets[0];
              const wi = shown ? widgets.value.get(shown.type) : undefined;
              const isDragged = drag?.id === t.id && drag.moved;
              return (
                <div
                  key={t.id}
                  class={`tile ${sel ? 'selected' : ''} ${isDragged ? 'dragging' : ''} ${isDragged && invalid ? 'invalid' : ''} ${ghost?.stackOn === t.id ? 'stack-target' : ''} ${t.locked ? 'locked' : ''}`}
                  style={{ left: `${(r.x / W) * 100}%`, top: `${(r.y / H) * 100}%`, width: `${(r.w / W) * 100}%`, height: `${(r.h / H) * 100}%` }}
                  onPointerDown={(e) => onPointerDown(e as PointerEvent, t, 'move')}
                  tabIndex={0}
                  aria-label={wi?.name ?? shown?.type ?? 'tile'}
                >
                  {showChips && (
                    <div class="tile-chip">
                      <Icon name={wi?.icon ?? (shown ? 'puzzle' : 'square-dashed')} size={12} />
                      <span>{wi?.name ?? shown?.type ?? '—'}</span>
                      {t.widgets.length > 1 && <b class="stack-count">{t.widgets.length}</b>}
                      {t.locked && <Icon name="lock" size={11} />}
                    </div>
                  )}
                  {info?.error && (
                    <div class="tile-error" title={info.error}>
                      <Icon name="triangle-alert" size={14} />
                    </div>
                  )}
                  {!wi && shown && <div class="tile-missing">{tr('inspector.missingPlugin')}</div>}
                  {sel && !t.locked && ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].map((edge) => <div class={`handle h-${edge}`} onPointerDown={(e) => onPointerDown(e as PointerEvent, t, edge)} />)}
                </div>
              );
            })}
          {ghost && (() => {
            const r = toPx(ghost.rect, pg.grid, W, H);
            return <div class={`ghost ${ghost.ok ? '' : 'invalid'} ${ghost.stackOn ? 'stacking' : ''}`} style={{ left: `${(r.x / W) * 100}%`, top: `${(r.y / H) * 100}%`, width: `${(r.w / W) * 100}%`, height: `${(r.h / H) * 100}%` }}>{ghost.stackOn ? <span><Icon name="layers" size={16} /> {tr('library.dropStack')}</span> : null}</div>;
          })()}
          {!live && !pg.tiles.length && !ghost && (
            <div class="stage-empty">
              <Icon name="layout-dashboard" size={28} />
              <span>{tr('stage.empty')}</span>
            </div>
          )}
          {live && frame?.interlude && <div class="live-badge"><Icon name="clapperboard" size={14} /> {tr('stage.interlude')}</div>}
          {live && frame?.sleeping && <div class="live-badge"><Icon name="moon" size={14} /> {tr('stage.sleeping')}</div>}
        </div>
      </div>
      <div class="stage-caption">
        {scr.name} · {W}×{H}
        {scr.rotate ? ` · ↻${scr.rotate}°` : ''} · {pg.grid.cols}×{pg.grid.rows}
      </div>
    </div>
  );
}

function GridLines({ page: p, W, H }: { page: Page; W: number; H: number }) {
  const cells: Rect[] = [];
  for (let y = 0; y < p.grid.rows; y++) for (let x = 0; x < p.grid.cols; x++) cells.push({ x, y, w: 1, h: 1 });
  return (
    <svg class="gridlines" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      {cells.map((c) => {
        const r = toPx(c, p.grid, W, H);
        return <rect x={r.x} y={r.y} width={r.w} height={r.h} rx={Math.min(6, r.w / 6)} />;
      })}
    </svg>
  );
}

// ---------- Mutations used by the stage, the library and the inspector ----------

export function commitTiles(tiles: Tile[]): void {
  edit((d) => {
    const p = draftPage(d);
    if (p) p.tiles = tiles.map((t) => ({ ...t }));
  });
}

export function addTileAt(type: string, rect: Rect): void {
  const info = widgets.value.get(type);
  const w = newWidget(type, {}, info?.chrome === 'bare' ? undefined : info?.name);
  const t = newTile(rect, [w]);
  edit((d) => {
    draftPage(d)?.tiles.push(t);
  });
  selectedTile.value = t.id;
  selectedWidget.value = w.id;
}

/** Adds a widget at the first free spot (library click). */
export function addWidgetSomewhere(type: string): void {
  const s = screen.value;
  const p = page.value;
  if (!s || !p) return;
  const info = widgets.value.get(type);
  const pref = cellsFor(info?.size.preferred ?? { w: s.width / 4, h: s.height / 2 }, p.grid, s.width, s.height);
  for (let shrink = 0; shrink < p.grid.cols + p.grid.rows; shrink++) {
    const w = Math.max(1, pref.w - Math.ceil(shrink / 2));
    const h = Math.max(1, pref.h - Math.floor(shrink / 2));
    const order = p.gravity === 'left' ? 'cols' : 'rows';
    for (const pos of scan(p, w, h, order)) {
      addTileAt(type, { ...pos, w, h });
      return;
    }
  }
  if (selectedTile.value) {
    stackWidget(selectedTile.value, type);
    return;
  }
  notify(tr('toast.noRoom'), 'error');
}

function* scan(p: Page, w: number, h: number, order: 'rows' | 'cols'): Generator<{ x: number; y: number }> {
  const items: GridItem[] = p.tiles;
  const outer = order === 'rows' ? p.grid.rows - h : p.grid.cols - w;
  const inner = order === 'rows' ? p.grid.cols - w : p.grid.rows - h;
  for (let a = 0; a <= outer; a++) {
    for (let b = 0; b <= inner; b++) {
      const pos = order === 'rows' ? { x: b, y: a } : { x: a, y: b };
      if (!collisions(items, { ...pos, w, h }).length) yield pos;
    }
  }
}

export function stackWidget(tileId: string, type: string): void {
  const info = widgets.value.get(type);
  const w = newWidget(type, {}, info?.chrome === 'bare' ? undefined : info?.name);
  edit((d) => {
    const t = draftPage(d)?.tiles.find((x) => x.id === tileId);
    t?.widgets.push(w);
  });
  selectedTile.value = tileId;
  selectedWidget.value = w.id;
  notify(tr('toast.stacked'), 'ok');
}

export function deleteTile(id: string): void {
  edit((d) => {
    const p = draftPage(d);
    if (p) p.tiles = p.tiles.filter((t) => t.id !== id);
  });
  if (selectedTile.value === id) selectedTile.value = null;
}

export function duplicateTile(id: string): void {
  const s = screen.value;
  const p = page.value;
  const t = p?.tiles.find((x) => x.id === id);
  if (!s || !p || !t) return;
  for (const pos of scan(p, t.w, t.h, p.gravity === 'left' ? 'cols' : 'rows')) {
    const copy = newTile({ ...pos, w: t.w, h: t.h }, t.widgets.map((w) => ({ ...JSON.parse(JSON.stringify(w)), id: newWidget(w.type).id })));
    copy.rotateMs = t.rotateMs;
    copy.chrome = t.chrome;
    edit((d) => {
      draftPage(d)?.tiles.push(copy);
    });
    selectedTile.value = copy.id;
    return;
  }
  notify(tr('toast.noRoom'), 'error');
}

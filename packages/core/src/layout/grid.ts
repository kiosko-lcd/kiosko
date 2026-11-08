/**
 * The grid ("mosaic") engine. Pure: no Node, no canvas. The server uses it to
 * paint and the editor to drag, so both agree on every pixel.
 *
 * A page is a fixed grid of `cols × rows` cells over the whole panel. Every
 * item (a *tile*) covers a rectangle of cells. Unlike a web dashboard, the
 * panel doesn't scroll: there is no "below the fold", so moves that would push
 * a tile out of the grid are rejected instead of growing the page.
 *
 * Compaction ("gravity") closes gaps after a move: `up` like a classic
 * masonry, `left` for wide strips like 1920×462, `none` for free placement.
 */

export interface GridSpec {
  cols: number;
  rows: number;
  /** Space between tiles, in panel px. */
  gap: number;
  /** Space around the grid, in panel px. */
  padding: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface GridItem extends Rect {
  id: string;
  /** Pinned tiles are never pushed nor compacted. */
  locked?: boolean;
}

export type Gravity = 'none' | 'up' | 'left';

export interface PxRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * A sensible grid for a resolution: square-ish cells of about `target` px.
 * 1920×462 → 24×6, 480×480 → 6×6, 1280×480 → 16×6, 320×240 → 4×3.
 */
export function suggestGrid(width: number, height: number, target = 80): GridSpec {
  const rows = Math.max(2, Math.round(height / target));
  const cellH = height / rows;
  const cols = Math.max(2, Math.round(width / cellH));
  const short = Math.min(width, height);
  const gap = short >= 400 ? 10 : short >= 240 ? 6 : 4;
  return { cols, rows, gap, padding: gap };
}

/** Pixel rectangle of a cell rectangle, edges snapped to whole pixels. */
export function toPx(r: Rect, grid: GridSpec, width: number, height: number): PxRect {
  const innerW = width - 2 * grid.padding;
  const innerH = height - 2 * grid.padding;
  const colW = (innerW + grid.gap) / grid.cols;
  const rowH = (innerH + grid.gap) / grid.rows;
  const x0 = Math.round(grid.padding + r.x * colW);
  const y0 = Math.round(grid.padding + r.y * rowH);
  const x1 = Math.round(grid.padding + (r.x + r.w) * colW - grid.gap);
  const y1 = Math.round(grid.padding + (r.y + r.h) * rowH - grid.gap);
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
}

/** The cell under a pixel (for drops), clamped to the grid. */
export function fromPx(px: number, py: number, grid: GridSpec, width: number, height: number): { x: number; y: number } {
  const colW = (width - 2 * grid.padding + grid.gap) / grid.cols;
  const rowH = (height - 2 * grid.padding + grid.gap) / grid.rows;
  return {
    x: clamp(Math.floor((px - grid.padding) / colW), 0, grid.cols - 1),
    y: clamp(Math.floor((py - grid.padding) / rowH), 0, grid.rows - 1),
  };
}

/** Cells needed to hold `size` px (rounded up), at least 1×1, at most the grid. */
export function cellsFor(size: { w: number; h: number }, grid: GridSpec, width: number, height: number): { w: number; h: number } {
  const colW = (width - 2 * grid.padding + grid.gap) / grid.cols;
  const rowH = (height - 2 * grid.padding + grid.gap) / grid.rows;
  return {
    w: clamp(Math.ceil((size.w + grid.gap) / colW - 0.05), 1, grid.cols),
    h: clamp(Math.ceil((size.h + grid.gap) / rowH - 0.05), 1, grid.rows),
  };
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

export function inBounds(r: Rect, grid: GridSpec): boolean {
  return r.x >= 0 && r.y >= 0 && r.w >= 1 && r.h >= 1 && r.x + r.w <= grid.cols && r.y + r.h <= grid.rows;
}

/** Clamps a rectangle into the grid, shrinking it if it's bigger than the grid. */
export function fit(r: Rect, grid: GridSpec): Rect {
  const w = clamp(Math.round(r.w), 1, grid.cols);
  const h = clamp(Math.round(r.h), 1, grid.rows);
  return { x: clamp(Math.round(r.x), 0, grid.cols - w), y: clamp(Math.round(r.y), 0, grid.rows - h), w, h };
}

export function collisions<T extends GridItem>(items: readonly T[], r: Rect, except?: string): T[] {
  return items.filter((i) => i.id !== except && overlaps(i, r));
}

/** Occupancy matrix [row][col] → item id or null. */
export function occupancy(items: readonly GridItem[], grid: GridSpec): (string | null)[][] {
  const m: (string | null)[][] = Array.from({ length: grid.rows }, () => Array<string | null>(grid.cols).fill(null));
  for (const it of items) {
    for (let y = Math.max(0, it.y); y < Math.min(grid.rows, it.y + it.h); y++) {
      for (let x = Math.max(0, it.x); x < Math.min(grid.cols, it.x + it.w); x++) m[y]![x] = it.id;
    }
  }
  return m;
}

/**
 * First free spot for a `w×h` tile, scanning in reading order (or column
 * order for `left` gravity, which fills a wide strip column by column).
 */
export function findSpot(items: readonly GridItem[], grid: GridSpec, w: number, h: number, order: 'rows' | 'cols' = 'rows'): { x: number; y: number } | null {
  if (w > grid.cols || h > grid.rows) return null;
  const tryAt = (x: number, y: number) => !collisions(items, { x, y, w, h }).length;
  if (order === 'rows') {
    for (let y = 0; y + h <= grid.rows; y++) for (let x = 0; x + w <= grid.cols; x++) if (tryAt(x, y)) return { x, y };
  } else {
    for (let x = 0; x + w <= grid.cols; x++) for (let y = 0; y + h <= grid.rows; y++) if (tryAt(x, y)) return { x, y };
  }
  return null;
}

/**
 * Slides every tile towards the gravity as far as it goes, in order of
 * distance to the wall so the first ones settle first. Locked tiles stay.
 */
export function compact<T extends GridItem>(items: readonly T[], gravity: Gravity): T[] {
  if (gravity === 'none') return items.map((i) => ({ ...i }));
  const axis = gravity === 'up' ? 'y' : 'x';
  const cross = gravity === 'up' ? 'x' : 'y';
  const sorted = items.map((i) => ({ ...i })).sort((a, b) => a[axis] - b[axis] || a[cross] - b[cross]);
  const placed: T[] = [];
  for (const it of sorted) {
    if (!it.locked) {
      while (it[axis] > 0) {
        const probe = { ...it, [axis]: it[axis] - 1 };
        if (collisions(placed, probe).length || collisions(sorted.filter((s) => s.locked), probe, it.id).length) break;
        it[axis]--;
      }
    }
    placed.push(it);
  }
  // Keep the caller's order (it's the drawing and tab order).
  return items.map((i) => placed.find((p) => p.id === i.id)!);
}

/**
 * Moves (or resizes) a tile to `to`, pushing the ones in the way along the
 * gravity axis (down for `up`, right for `left`, and for `none` whichever
 * fits). Returns the new layout, already compacted, or null if it can't fit
 * without leaving the grid or moving a locked tile.
 */
export function place<T extends GridItem>(items: readonly T[], id: string, to: Rect, grid: GridSpec, gravity: Gravity): T[] | null {
  const target = fit(to, grid);
  const next = items.map((i) => (i.id === id ? { ...i, ...target } : { ...i }));
  const moved = next.find((i) => i.id === id);
  if (!moved) return null;
  const pushAxes: ('x' | 'y')[] = gravity === 'up' ? ['y', 'x'] : gravity === 'left' ? ['x', 'y'] : ['y', 'x'];
  for (const axis of pushAxes) {
    const attempt = next.map((i) => ({ ...i }));
    if (resolve(attempt, id, axis, grid, 0)) {
      return gravity === 'none' ? attempt : keepMovedFirst(compact(attempt, gravity), id, target, grid);
    }
  }
  return null;
}

/** After compaction the moved tile may slide; keep it where the user dropped it if that's still free. */
function keepMovedFirst<T extends GridItem>(items: T[], id: string, target: Rect, grid: GridSpec): T[] {
  const me = items.find((i) => i.id === id)!;
  if (me.x === target.x && me.y === target.y) return items;
  const others = items.filter((i) => i.id !== id);
  if (!collisions(others, target).length && inBounds(target, grid)) return items.map((i) => (i.id === id ? { ...i, ...target } : i));
  return items;
}

function resolve(items: GridItem[], id: string, axis: 'x' | 'y', grid: GridSpec, depth: number): boolean {
  if (depth > items.length * 2) return false;
  const me = items.find((i) => i.id === id)!;
  for (const other of collisions(items, me, id)) {
    if (other.locked) return false;
    const size = axis === 'y' ? 'h' : 'w';
    other[axis] = me[axis] + me[size];
    if (!inBounds(other, grid)) return false;
    if (!resolve(items, other.id, axis, grid, depth + 1)) return false;
  }
  return true;
}

/**
 * Masonry auto-arrange: biggest tiles first, each at the first free spot.
 * Keeps sizes; tiles that don't fit any more are shrunk to what's left, and
 * dropped from the result (returned in `overflow`) if not even 1×1 fits.
 */
export function autoPack<T extends GridItem>(items: readonly T[], grid: GridSpec, gravity: Gravity = 'up'): { items: T[]; overflow: T[] } {
  const order = gravity === 'left' ? 'cols' : 'rows';
  const byArea = items.map((i) => ({ ...i })).sort((a, b) => b.w * b.h - a.w * a.h || b.h - a.h);
  const placed: T[] = [];
  const overflow: T[] = [];
  for (const it of byArea) {
    let spot = findSpot(placed, grid, it.w, it.h, order);
    let { w, h } = it;
    while (!spot && (w > 1 || h > 1)) {
      if (w >= h && w > 1) w--;
      else h--;
      spot = findSpot(placed, grid, w, h, order);
    }
    if (!spot) {
      overflow.push(it);
      continue;
    }
    placed.push({ ...it, ...spot, w, h });
  }
  const result = items.map((i) => placed.find((p) => p.id === i.id)).filter((p): p is T => !!p);
  return { items: result, overflow };
}

/**
 * Re-maps a layout to another grid (a different panel, or the user changed
 * the density) keeping proportions.
 */
export function rescale<T extends GridItem>(items: readonly T[], from: GridSpec, to: GridSpec): T[] {
  const sx = to.cols / from.cols;
  const sy = to.rows / from.rows;
  return items.map((i) => {
    const x = Math.round(i.x * sx);
    const y = Math.round(i.y * sy);
    const w = Math.max(1, Math.round((i.x + i.w) * sx) - x);
    const h = Math.max(1, Math.round((i.y + i.h) * sy) - y);
    return { ...i, ...fit({ x, y, w, h }, to) };
  });
}

/** Free cells as maximal-ish rectangles, for the editor's "drop here" hints. */
export function freeCells(items: readonly GridItem[], grid: GridSpec): { x: number; y: number }[] {
  const occ = occupancy(items, grid);
  const out: { x: number; y: number }[] = [];
  occ.forEach((row, y) => row.forEach((v, x) => v === null && out.push({ x, y })));
  return out;
}

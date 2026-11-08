/**
 * Paints one page of a screen: background, then every tile with its card
 * and the widget whose turn it is. Pure function of its input (plus the
 * widgets' own code), so the panel, the editor preview and the gallery all
 * go through here and can't disagree.
 */
import { createCanvas, loadImage, type Canvas, type Image, type SKRSContext2D } from '@napi-rs/canvas';
import { pixelShift } from '@loksly/lcd-canvas-kit';
import { localize, validate, type Box, type RenderContext, type Theme, type WidgetDefinition } from '@tessera/sdk';
import { toPx, type PxRect } from './layout/grid.ts';
import { nextTurnAt, pickInStack } from './layout/stack.ts';
import { whenMatches, type Config, type Page, type Screen, type Tile, type WidgetInstance } from './config/model.ts';
import { CANVAS, baseContext, kit, type LogFn } from './env.ts';
import { registerFonts } from './fonts.ts';
import type { Registry } from './registry.ts';

export interface ComposeInput {
  cfg: Config;
  screen: Pick<Screen, 'width' | 'height' | 'pixelShift'>;
  page: Page;
  theme: Theme;
  registry: Registry;
  now: number;
  working: boolean;
  /** Data of an instance's own fetch. */
  dataOf: (inst: WidgetInstance) => unknown;
  /** Latest data of shared sources. */
  sourcesOf: (types: readonly string[] | undefined) => Record<string, unknown>;
  /** Painted for the editor, not for the panel. */
  preview?: boolean;
  /** Use each widget's demo data where there's no real data yet. */
  demo?: boolean;
  /** Force which widget a tile shows (editor: the one selected in its stack). */
  forceShown?: Record<string, string>;
  log?: LogFn;
  /** Disable pixel shift (editor, gallery). */
  noShift?: boolean;
}

export interface TileResult {
  id: string;
  rect: PxRect;
  /** Id of the widget instance shown, or null if none is visible. */
  shown: string | null;
  error?: string;
}

export interface ComposeResult {
  canvas: Canvas;
  tiles: TileResult[];
  /** Every widget shown says it's idle (and there's at least one). */
  idle: boolean;
  /** When something will change by itself (clock, rotation): next repaint. */
  nextAt: number;
}

const images = new Map<string, Image | null>();
/** Background images are loaded once, in the background; the first frames go without. */
function backgroundImage(path: string): Image | null {
  if (!images.has(path)) {
    images.set(path, null);
    loadImage(path).then((img) => images.set(path, img)).catch(() => undefined);
  }
  return images.get(path) ?? null;
}

interface Resolved {
  inst: WidgetInstance;
  def: WidgetDefinition<any, any>;
  options: Record<string, unknown>;
  data: unknown;
  sources: Record<string, unknown>;
}

function resolve(input: ComposeInput, inst: WidgetInstance): Resolved | null {
  const def = input.registry.widget(inst.type);
  if (!def) return null;
  const options = def.options ? (validate(def.options, inst.options).value as Record<string, unknown>) : {};
  let data = input.dataOf(inst);
  let sources = input.sourcesOf(def.sources);
  if (input.demo && def.demo) {
    const needData = data === undefined && !!def.fetch;
    const needSources = (def.sources ?? []).some((s) => sources[s] === undefined);
    if (needData || needSources) {
      try {
        const d = def.demo({ options, now: input.now });
        if (needData) data = d.data;
        if (needSources) sources = { ...(d.sources ?? {}), ...Object.fromEntries(Object.entries(sources).filter(([, v]) => v !== undefined)) };
      } catch {
        /* a broken demo shouldn't break the editor */
      }
    }
  }
  return { inst, def, options, data, sources };
}

function stateCtx(r: Resolved, now: number, working: boolean) {
  return { options: r.options, data: r.data, sources: r.sources, now, working };
}

function safe<T>(fn: (() => T) | undefined, fallback: T): T {
  if (!fn) return fallback;
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/** Next time a widget wants to be repainted on its own. */
function redrawAt(def: WidgetDefinition<any, any>, now: number): number {
  const r = def.redraw ?? 'never';
  if (r === 'never') return Infinity;
  const step = r === 'second' ? 1000 : r === 'minute' ? 60_000 : Math.max(250, r.everyMs);
  return (Math.floor(now / step) + 1) * step;
}

export function roundRect(g: SKRSContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.roundRect(x, y, w, h, Math.max(0, Math.min(r, w / 2, h / 2)));
}

/** Card padding and title size scale with the panel: a 320×240 can't afford 16 px margins. */
export function chromeMetrics(theme: Theme, screenH: number, rect: PxRect) {
  const scale = Math.max(0.45, Math.min(1, screenH / 462, rect.h / 180));
  const pad = Math.round(16 * scale);
  const title = Math.round(theme.titleSize * scale);
  return { pad, title, titleBar: Math.round(title * 1.55) };
}

function paintTile(g: SKRSContext2D, input: ComposeInput, tile: Tile, rect: PxRect, out: TileResult, nextAt: { v: number }, idles: boolean[]): void {
  const { theme, now, working } = input;
  const candidates = tile.widgets
    .filter((w) => !w.disabled && whenMatches(w.when, working))
    .map((w) => resolve(input, w))
    .filter((r): r is Resolved => !!r);
  const entries = candidates.map((r) => ({
    id: r.inst.id,
    visible: safe(() => r.def.visible?.(stateCtx(r, now, working)) ?? true, true),
    urgent: safe(() => r.def.urgent?.(stateCtx(r, now, working)) ?? false, false),
  }));
  const forced = input.forceShown?.[tile.id];
  const shownId = forced && candidates.some((c) => c.inst.id === forced) ? forced : pickInStack(entries, now, tile.rotateMs);
  if (entries.filter((e) => e.visible).length > 1 && !forced) nextAt.v = Math.min(nextAt.v, nextTurnAt(now, tile.rotateMs));
  out.shown = shownId;
  const r = candidates.find((c) => c.inst.id === shownId);

  const chrome = tile.chrome === 'auto' ? (r?.def.chrome ?? 'card') : tile.chrome;
  const m = chromeMetrics(theme, input.screen.height, rect);
  if (chrome === 'card') {
    roundRect(g, rect.x, rect.y, rect.w, rect.h, theme.radius);
    g.fillStyle = theme.colors.surface;
    g.fill();
    g.strokeStyle = theme.colors.surfaceEdge;
    g.lineWidth = 1;
    roundRect(g, rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1, theme.radius);
    g.stroke();
  }
  if (!r) {
    // An empty tile is invisible on the panel; in the editor it's a hint.
    if (input.preview && !tile.widgets.length) {
      g.setLineDash([6, 6]);
      g.strokeStyle = theme.colors.inkFaint;
      roundRect(g, rect.x + 1, rect.y + 1, rect.w - 2, rect.h - 2, theme.radius);
      g.stroke();
      g.setLineDash([]);
    }
    return;
  }
  idles.push(safe(() => r.def.idle?.(stateCtx(r, now, working)) ?? false, false));
  nextAt.v = Math.min(nextAt.v, redrawAt(r.def, now));

  const pad = chrome === 'card' ? m.pad : 0;
  let top = rect.y + pad;
  const title = r.inst.title?.trim();
  if (title && chrome === 'card') {
    kit.drawTracked(g, kit.truncate(g, title, rect.w - 2 * pad, { size: m.title, family: theme.fonts.sans }), rect.x + pad, rect.y + pad + m.title * 0.8, { size: m.title, family: theme.fonts.sans, color: theme.colors.inkDim });
    top = rect.y + pad + m.titleBar;
  }
  const box: Box = { x: rect.x + pad, y: top, w: Math.max(1, rect.w - 2 * pad), h: Math.max(1, rect.y + rect.h - pad - top) };
  const [plugin] = r.inst.type.split('/');
  const ctx: RenderContext<any, any> = {
    ...baseContext(input.cfg, plugin!, input.log ?? (() => undefined), now),
    ...stateCtx(r, now, working),
    box,
    theme,
    fonts: theme.fonts,
    kit,
    canvas: CANVAS,
    preview: !!input.preview,
  };
  g.save();
  roundRect(g, rect.x, rect.y, rect.w, rect.h, chrome === 'card' ? theme.radius : 0);
  g.clip();
  try {
    r.def.render(g, ctx);
  } catch (err) {
    out.error = err instanceof Error ? err.message : String(err);
    input.log?.(r.inst.type, `render failed: ${out.error}`);
    const size = Math.max(12, Math.min(20, box.h / 4));
    kit.drawTracked(g, kit.truncate(g, `⚠ ${localize(r.def.name, ctx.locale)}: ${out.error}`, box.w, { size, family: theme.fonts.mono }), box.x, box.y + size * 1.2, { size, family: theme.fonts.mono, color: theme.colors.alert });
  }
  g.restore();
}

/** Paints `page` on a new canvas of the screen size. */
export function composePage(input: ComposeInput): ComposeResult {
  registerFonts();
  const { screen, page, theme, now } = input;
  const canvas = createCanvas(screen.width, screen.height);
  const g = canvas.getContext('2d');
  g.fillStyle = page.background.color || theme.colors.bg;
  g.fillRect(0, 0, screen.width, screen.height);
  if (page.background.image) {
    const img = backgroundImage(page.background.image);
    if (img) {
      const s = Math.max(screen.width / img.width, screen.height / img.height);
      g.drawImage(img, (screen.width - img.width * s) / 2, (screen.height - img.height * s) / 2, img.width * s, img.height * s);
    }
  }
  const shift = input.noShift || input.preview ? { x: 0, y: 0 } : pixelShift(now, screen.pixelShift);
  g.save();
  g.translate(shift.x, shift.y);
  const nextAt = { v: Infinity };
  const idles: boolean[] = [];
  const tiles: TileResult[] = [];
  for (const tile of page.tiles) {
    const rect = toPx(tile, page.grid, screen.width, screen.height);
    const out: TileResult = { id: tile.id, rect, shown: null };
    tiles.push(out);
    paintTile(g, input, tile, rect, out, nextAt, idles);
  }
  g.restore();
  if (screen.pixelShift.enabled && !input.preview) nextAt.v = Math.min(nextAt.v, (Math.floor(now / screen.pixelShift.periodMs) + 1) * screen.pixelShift.periodMs);
  return { canvas, tiles, idle: idles.length > 0 && idles.every(Boolean), nextAt: nextAt.v };
}

/** A canvas rotated for a panel mounted at `rotate` degrees. */
export function rotateCanvas(src: Canvas, rotate: number): Canvas {
  if (!rotate) return src;
  const swap = rotate === 90 || rotate === 270;
  const out = createCanvas(swap ? src.height : src.width, swap ? src.width : src.height);
  const g = out.getContext('2d');
  g.translate(out.width / 2, out.height / 2);
  g.rotate((rotate * Math.PI) / 180);
  g.drawImage(src, -src.width / 2, -src.height / 2);
  return out;
}

/** Renders a single widget alone (gallery thumbnails, plugin tests), with demo data unless given. */
export function composeWidget(o: {
  cfg: Config;
  registry: Registry;
  theme: Theme;
  type: string;
  width: number;
  height: number;
  options?: Record<string, unknown>;
  title?: string;
  data?: unknown;
  sources?: Record<string, unknown>;
  now?: number;
  chrome?: Tile['chrome'];
}): ComposeResult {
  const inst: WidgetInstance = { id: 'w', type: o.type, options: o.options ?? {}, ...(o.title ? { title: o.title } : {}) };
  const page: Page = { id: 'p', name: 'p', grid: { cols: 1, rows: 1, gap: 0, padding: 0 }, gravity: 'none', background: { color: o.theme.colors.bg }, tiles: [{ id: 't', x: 0, y: 0, w: 1, h: 1, widgets: [inst], rotateMs: 0, chrome: o.chrome ?? 'auto' }] };
  return composePage({
    cfg: o.cfg,
    screen: { width: o.width, height: o.height, pixelShift: { enabled: false, amplitude: 0, periodMs: 1 } },
    page,
    theme: o.theme,
    registry: o.registry,
    now: o.now ?? Date.now(),
    working: true,
    dataOf: () => o.data,
    sourcesOf: (types) => Object.fromEntries((types ?? []).map((t) => [t, o.sources?.[t]])),
    preview: true,
    demo: o.data === undefined,
    noShift: true,
  });
}

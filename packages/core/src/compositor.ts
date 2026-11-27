/**
 * Paints one page of a screen: background, then every tile with its card
 * and the widget whose turn it is. Pure function of its input (plus the
 * widgets' own code), so the panel, the editor preview and the gallery all
 * go through here and can't disagree.
 */
import { createCanvas, loadImage, type Canvas, type Image, type SKRSContext2D } from '@napi-rs/canvas';
import { pixelShift } from '@loksly/lcd-canvas-kit';
import { errorMessage, localize, validate, type AnimationFrame, type AnimationPlan, type Box, type Redraw, type RenderContext, type Theme, type WidgetDefinition } from '@kiosko/sdk';
import { toPx, type PxRect } from './layout/grid.ts';
import { nextTurnAt, pickInStack } from './layout/stack.ts';
import { legibleCjkPx, whenMatches, zoomOf, type Config, type Page, type Screen, type Tile, type WidgetInstance } from './config/model.ts';
import { CANVAS, baseContext, kit, resolveLocale, type LogFn } from './env.ts';
import { registerFonts, setFontLocale } from './fonts.ts';
import type { Registry } from './registry.ts';

export interface ComposeInput {
  cfg: Config;
  screen: Pick<Screen, 'width' | 'height' | 'pixelShift'> & Partial<Pick<Screen, 'readingDistance' | 'textScale' | 'diagonalIn'>>;
  page: Page;
  theme: Theme;
  registry: Registry;
  now: number;
  working: boolean;
  /** Data of an instance's own fetch. */
  dataOf: (inst: WidgetInstance) => unknown;
  /** Latest data of shared sources, by type: of the source profile `profile` where it has one (see config/profiles.ts). */
  sourcesOf: (types: readonly string[] | undefined, profile?: string | null) => Record<string, unknown>;
  /** Painted for the editor, not for the panel. */
  preview?: boolean;
  /** Use each widget's demo data where there's no real data yet. */
  demo?: boolean;
  /** Also its demo options (gallery thumbnails only). */
  demoOptions?: boolean;
  /** Force which widget a tile shows (editor: the one selected in its stack). */
  forceShown?: Record<string, string>;
  log?: LogFn;
  /** Disable pixel shift (editor, gallery). */
  noShift?: boolean;
  /**
   * Paint the page already turned for a panel mounted at this angle (90,
   * 180, 270): the canvas comes out the panel's way round, with no second
   * copy to turn it. Default 0.
   */
  rotate?: number;
  /** Reuse tiles whose inputs didn't change (the panel; not previews). */
  cache?: TileCache;
  /**
   * Paint these frames of animations, each in its own tile (see
   * `AnimationFrame`); every other tile as usual. Any number at once: how
   * many the runtime plays together is its decision (`MAX_CONCURRENT`).
   */
  animate?: { tileId: string; instanceId: string; frame: AnimationFrame }[];
  /**
   * A canvas of the frame's size to paint on instead of a new one (the
   * screen runner's, reused from frame to frame: a 1920×462 canvas per frame
   * kept V8's garbage collector busy). It is cleared first. Of another size,
   * it is ignored.
   */
  into?: Canvas;
}

/**
 * A widget on screen that has an `animation` hook: asks it, with the state
 * the page was painted with. The runtime decides when to ask.
 */
export interface Animatable {
  tileId: string;
  instanceId: string;
  type: string;
  def: Pick<WidgetDefinition<any, any>, 'animationGap' | 'animationCooldownMs'>;
  /** What the widget painted with, by reference (replaced, never mutated), to tell when it changed. */
  data: unknown;
  sources: Record<string, unknown>;
  ask: (trigger: 'idle' | 'data', rnd: () => number, prev?: { data: unknown; sources: Record<string, unknown> }) => AnimationPlan | null;
  /** Tells the widget an animation of its has ended (see `WidgetDefinition.animationEnded`). */
  ended: (plan: AnimationPlan, completed: boolean) => void;
}

export interface TileResult {
  id: string;
  rect: PxRect;
  /** Id of the widget instance shown, or null if none is visible. */
  shown: string | null;
  error?: string;
  /** How long the shown widget's `render` took, in ms, when it painted (not when the tile came from the cache). */
  renderMs?: number;
  /**
   * The widget asked for Chinese, Japanese or Korean text this small (panel
   * px) and got it raised to `legibleCjkPx`: its tile may want more room.
   */
  cjkEnlarged?: number;
}

export interface ComposeResult {
  canvas: Canvas;
  tiles: TileResult[];
  /** Every widget shown says it's idle (and there's at least one). */
  idle: boolean;
  /** When something will change by itself (clock, rotation): next repaint. */
  nextAt: number;
  /** The shown widgets that can animate. */
  animatable: Animatable[];
  /**
   * What the frame looks like, told by the tiles it was made of (each
   * painting of a tile in the cache has a number of its own): the same key
   * means the same pixels as the frame that had it, so it need not be
   * encoded or sent again. Null when a tile was painted outside the cache
   * (an animation frame) or there is no cache (previews).
   */
  sameAs: string | null;
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
  let options = def.options ? (validate(def.options, inst.options).value as Record<string, unknown>) : {};
  let data = input.dataOf(inst);
  let sources = input.sourcesOf(def.sources, inst.profile);
  if (input.demo && def.demo) {
    const needData = data === undefined;
    const needSources = (def.sources ?? []).some((s) => sources[s] === undefined);
    if (needData || needSources || input.demoOptions) {
      try {
        const d = def.demo({ options, now: input.now, locale: resolveLocale(input.cfg) });
        if (input.demoOptions && d.options && def.options) options = validate(def.options, { ...d.options, ...inst.options }).value as Record<string, unknown>;
        if (needData) data = d.data;
        if (needSources) sources = { ...(d.sources ?? {}), ...Object.fromEntries(Object.entries(sources).filter(([, v]) => v !== undefined)) };
      } catch {
        /* a broken demo shouldn't break the editor */
      }
    }
  }
  return { inst, def, options, data, sources };
}

function stateCtx(r: Resolved, now: number, working: boolean, cfg: Config) {
  return { options: r.options, data: r.data, sources: r.sources, now, working, workday: cfg.workday, ...(cfg.location ? { location: cfg.location } : {}) };
}

/**
 * The instance's switches over the widget's hooks: `takeOver` (keep the tile
 * while urgent) and `hideWhenEmpty` (skip it in the rotation while `empty`).
 * Each defaults to what the widget declares.
 */
export function tileState(def: WidgetDefinition<any, any>, inst: Pick<WidgetInstance, 'takeOver' | 'hideWhenEmpty'>, state: Parameters<NonNullable<WidgetDefinition['visible']>>[0]): { visible: boolean; urgent: boolean } {
  const takeOver = inst.takeOver ?? def.takeOver ?? true;
  const hideEmpty = inst.hideWhenEmpty ?? def.hideWhenEmpty ?? false;
  const visible = safe(() => def.visible?.(state) ?? true, true) && !(hideEmpty && def.empty && safe(() => def.empty!(state), false));
  const urgent = takeOver && safe(() => def.urgent?.(state) ?? false, false);
  return { visible, urgent };
}

function safe<T>(fn: (() => T) | undefined, fallback: T): T {
  if (!fn) return fallback;
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/** How often a widget wants to be repainted on its own, in ms (0 = only when its data changes). */
function redrawStep(def: WidgetDefinition<any, any>, state: ReturnType<typeof stateCtx>): number {
  const r = (typeof def.redraw === 'function' ? safe(() => (def.redraw as (c: typeof state) => Redraw)(state), 'never' as Redraw) : def.redraw) ?? 'never';
  if (r === 'never') return 0;
  return r === 'second' ? 1000 : r === 'minute' ? 60_000 : Math.max(250, r.everyMs);
}

/** Cuts `text` with an ellipsis to fit `maxW` with the current font (plain fillText, no tracking). */
export function fitText(g: SKRSContext2D, text: string, maxW: number): string {
  if (g.measureText(text).width <= maxW) return text;
  const chars = [...text];
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (g.measureText(`${chars.slice(0, mid).join('').trimEnd()}…`).width <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? `${chars.slice(0, lo).join('').trimEnd()}…` : '…';
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

/**
 * Rendered tiles kept between frames of one screen, so a frame only repaints
 * what changed. `gen` tells one painting of a tile from the next (see
 * `ComposeResult.sameAs`).
 */
export type TileCache = Map<string, { key: string; refs: unknown[]; canvas: Canvas; error?: string; gen?: number }>;

/** Numbers each tile painted into a cache, so a frame's look can be told by its tiles' `gen`. */
let tileGen = 0;

function drawCard(g: SKRSContext2D, rect: PxRect, theme: Theme): void {
  roundRect(g, rect.x, rect.y, rect.w, rect.h, theme.radius);
  g.fillStyle = theme.colors.surface;
  g.fill();
  g.strokeStyle = theme.colors.surfaceEdge;
  g.lineWidth = 1;
  roundRect(g, rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1, theme.radius);
  g.stroke();
}

/**
 * Paints a tile; returns what it painted, for `ComposeResult.sameAs`: the
 * `gen` of the painting in the cache (reused or just made), a string for an
 * empty tile (its card depends only on the theme and the rect, both in the
 * key), or null when painted outside the cache.
 */
function paintTile(g: SKRSContext2D, input: ComposeInput, tile: Tile, rect: PxRect, out: TileResult, nextAt: { v: number }, idles: boolean[], animatable: Animatable[]): number | string | null {
  const { theme, now, working } = input;
  const candidates = tile.widgets
    .filter((w) => !w.disabled && whenMatches(w.when, working))
    .map((w) => resolve(input, w))
    .filter((r): r is Resolved => !!r);
  const entries = candidates.map((r) => ({ id: r.inst.id, ...tileState(r.def, r.inst, stateCtx(r, now, working, input.cfg)) }));
  const forced = input.forceShown?.[tile.id];
  const shownId = forced && candidates.some((c) => c.inst.id === forced) ? forced : pickInStack(entries, now, tile.rotateMs);
  if (entries.filter((e) => e.visible).length > 1 && !forced) nextAt.v = Math.min(nextAt.v, nextTurnAt(now, tile.rotateMs));
  out.shown = shownId;
  const r = candidates.find((c) => c.inst.id === shownId);

  const chrome = tile.chrome === 'auto' ? (r?.def.chrome ?? 'card') : tile.chrome;
  if (!r) {
    if (chrome === 'card') drawCard(g, rect, theme);
    // An empty tile is invisible on the panel; in the editor it's a hint.
    if (input.preview && !tile.widgets.length) {
      g.setLineDash([6, 6]);
      g.strokeStyle = theme.colors.inkFaint;
      roundRect(g, rect.x + 1, rect.y + 1, rect.w - 2, rect.h - 2, theme.radius);
      g.stroke();
      g.setLineDash([]);
    }
    return `empty:${chrome}`;
  }
  const state = stateCtx(r, now, working, input.cfg);
  idles.push(safe(() => r.def.idle?.(state) ?? false, false));
  const step = redrawStep(r.def, state);
  if (step) nextAt.v = Math.min(nextAt.v, (Math.floor(now / step) + 1) * step);
  const animation = r.def.animation;
  if (animation && !input.preview) {
    animatable.push({
      tileId: tile.id,
      instanceId: r.inst.id,
      type: r.inst.type,
      def: r.def,
      data: r.data,
      sources: r.sources,
      ended: (plan, completed) => {
        const [plugin] = r.inst.type.split('/');
        safe(() => r.def.animationEnded?.({ ...baseContext(input.cfg, plugin!, input.log ?? (() => undefined), input.now), options: r.options, plan, completed, data: r.data }), undefined);
      },
      ask: (trigger, rnd, prev) => safe(() => animation({ ...state, box: tileBoxes(theme, input.screen.height, r.inst, rect, chrome, input.screen.textScale).box, trigger, rnd, ...(prev !== undefined ? { prev } : {}) }), null),
    });
  }

  // The tile whose animation is being painted: this frame, never from or into the cache.
  const frame = input.animate?.find((a) => a.tileId === tile.id && a.instanceId === r.inst.id)?.frame;
  const draw = (tg: SKRSContext2D) => drawTileContent(tg, input, r, rect, chrome, out, frame);
  if (frame || !input.cache) {
    draw(g);
    return null;
  }
  // Same widget, options, size, data and sources (by reference: they're
  // replaced, never mutated, when they change) and same redraw slot: reuse.
  const cfg = input.cfg;
  const key = JSON.stringify([r.inst.id, r.inst.type, r.inst.options, r.inst.title ?? '', zoomOf(r.inst), input.screen.textScale ?? 1, legibleCjkPx(input.screen), chrome, rect, theme.id, step ? Math.floor(now / step) : 0, cfg.locale, cfg.timeFormat, cfg.workday, cfg.location ?? null, working]);
  const refs = [r.data, ...(r.def.sources ?? []).map((s) => r.sources[s])];
  const hit = input.cache.get(tile.id);
  if (hit && hit.key === key && hit.refs.length === refs.length && hit.refs.every((x, i) => x === refs[i])) {
    g.drawImage(hit.canvas, rect.x, rect.y);
    if (hit.error) out.error = hit.error;
    return hit.gen ?? null;
  }
  // The tile's old picture is replaced: its canvas is painted again (drawImage
  // copies what it draws, so frames that showed it keep their pixels).
  const canvas = hit && hit.canvas.width === rect.w && hit.canvas.height === rect.h ? hit.canvas : createCanvas(rect.w, rect.h);
  const tg = canvas.getContext('2d');
  if (canvas === hit?.canvas) tg.reset();
  tg.translate(-rect.x, -rect.y);
  draw(tg);
  g.drawImage(canvas, rect.x, rect.y);
  const gen = ++tileGen;
  input.cache.set(tile.id, { key, refs, canvas, gen, ...(out.error ? { error: out.error } : {}) });
  return gen;
}

/**
 * The smallest text a widget can be expected to draw, in px (the floor the
 * widgets' own layouts and tests use), and the height of one line of it.
 */
export const MIN_TEXT_PX = 11;
export const MIN_LINE_PX = Math.ceil(MIN_TEXT_PX * 1.25);

/**
 * Where a widget paints inside its tile: `outer` is the area left by the
 * card's padding and title, and `box` is what the widget sees: the same area
 * `zoom` times smaller when zoomed (it keeps its top-left corner).
 *
 * `title`: whether the card's title is drawn. A title that would leave the
 * widget less than one line of the smallest text (`MIN_LINE_PX`) is dropped,
 * whatever the widget: on a strip (200×36) the widget's own content is worth
 * more than its name. Tiles where both fit are exactly as before.
 */
export function tileBoxes(theme: Theme, screenH: number, inst: WidgetInstance, rect: PxRect, chrome: 'card' | 'bare', textScale = 1): { outer: Box; box: Box; zoom: number; title: boolean } {
  const m = chromeMetrics(theme, screenH, rect);
  const pad = chrome === 'card' ? m.pad : 0;
  const title = !!inst.title?.trim() && chrome === 'card' && rect.h - 2 * pad - m.titleBar >= MIN_LINE_PX;
  const top = rect.y + pad + (title ? m.titleBar : 0);
  const outer: Box = { x: rect.x + pad, y: top, w: Math.max(1, rect.w - 2 * pad), h: Math.max(1, rect.y + rect.h - pad - top) };
  // Zoom: the widget gets a box `zoom` times smaller and is painted `zoom`
  // times bigger, so it fills the same space with bigger (or smaller) type.
  // Its box keeps its top-left corner, so widgets see nothing unusual.
  // The screen's text size multiplies every widget's own zoom.
  const zoom = Math.round(zoomOf(inst) * textScale * 100) / 100;
  const box: Box = zoom === 1 ? outer : { x: outer.x, y: outer.y, w: Math.max(1, outer.w / zoom), h: Math.max(1, outer.h / zoom) };
  return { outer, box, zoom, title };
}

function drawTileContent(g: SKRSContext2D, input: ComposeInput, r: Resolved, rect: PxRect, chrome: 'card' | 'bare', out: TileResult, anim?: AnimationFrame): void {
  const { theme, now, working } = input;
  const m = chromeMetrics(theme, input.screen.height, rect);
  if (chrome === 'card') drawCard(g, rect, theme);
  const pad = chrome === 'card' ? m.pad : 0;
  const { outer, box, zoom, title } = tileBoxes(theme, input.screen.height, r.inst, rect, chrome, input.screen.textScale);
  if (title) {
    g.font = `${m.title}px "${theme.fonts.sans}"`;
    g.fillStyle = theme.colors.inkDim;
    g.textBaseline = 'alphabetic';
    g.fillText(fitText(g, r.inst.title!.trim(), rect.w - 2 * pad), rect.x + pad, rect.y + pad + m.title * 0.8);
  }
  const [plugin] = r.inst.type.split('/');
  const ctx: RenderContext<any, any> = {
    ...baseContext(input.cfg, plugin!, input.log ?? (() => undefined), now),
    ...stateCtx(r, now, working, input.cfg),
    box,
    theme,
    fonts: theme.fonts,
    kit,
    canvas: CANVAS,
    preview: !!input.preview,
    ...(anim ? { anim, frame: anim.i } : {}),
  };
  g.save();
  roundRect(g, rect.x, rect.y, rect.w, rect.h, chrome === 'card' ? theme.radius : 0);
  g.clip();
  if (zoom !== 1) {
    g.translate(outer.x * (1 - zoom), outer.y * (1 - zoom));
    g.scale(zoom, zoom);
  }
  const t0 = performance.now();
  try {
    kit.takeCjkEnlarged();
    r.def.render(g, ctx);
    out.renderMs = performance.now() - t0;
    const small = kit.takeCjkEnlarged();
    if (small !== null) out.cjkEnlarged = small;
  } catch (err) {
    out.error = errorMessage(err, ctx.locale);
    input.log?.(r.inst.type, `render failed: ${out.error}`);
    const size = Math.max(12, Math.min(20, box.h / 4));
    kit.drawTracked(g, kit.truncate(g, `⚠ ${localize(r.def.name, ctx.locale)}: ${out.error}`, box.w, { size, family: theme.fonts.mono }), box.x, box.y + size * 1.2, { size, family: theme.fonts.mono, color: theme.colors.alert });
  }
  g.restore();
}

/** Paints `page` on a new canvas of the screen size. */
export function composePage(input: ComposeInput): ComposeResult {
  registerFonts();
  setFontLocale(resolveLocale(input.cfg));
  // CJK text is never painted smaller than this panel lets it be read from where its readers sit.
  kit.setMinCjkPx(legibleCjkPx(input.screen));
  const { screen, page, theme, now } = input;
  const rotate = ((input.rotate ?? 0) % 360 + 360) % 360;
  const swap = rotate === 90 || rotate === 270;
  const w = swap ? screen.height : screen.width;
  const h = swap ? screen.width : screen.height;
  const canvas = input.into && input.into.width === w && input.into.height === h ? input.into : createCanvas(w, h);
  const g = canvas.getContext('2d');
  // A canvas painted before: blank, with no transform, clip or state left from that frame.
  if (canvas === input.into) g.reset();
  if (rotate) {
    // Everything below draws in the page's own coordinates.
    g.translate(canvas.width / 2, canvas.height / 2);
    g.rotate((rotate * Math.PI) / 180);
    g.translate(-screen.width / 2, -screen.height / 2);
  }
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
  const animatable: Animatable[] = [];
  // The frame's look, by the paintings of its tiles (see `ComposeResult.sameAs`).
  let painted: (number | string)[] | null = input.cache && !input.preview ? [] : null;
  for (const tile of page.tiles) {
    const rect = toPx(tile, page.grid, screen.width, screen.height);
    const out: TileResult = { id: tile.id, rect, shown: null };
    tiles.push(out);
    const look = paintTile(g, input, tile, rect, out, nextAt, idles, animatable);
    if (painted && look === null) painted = null;
    else painted?.push(tile.id, look!);
  }
  if (input.cache) for (const id of input.cache.keys()) if (!page.tiles.some((t) => t.id === id)) input.cache.delete(id);
  g.restore();
  if (screen.pixelShift.enabled && !input.preview) nextAt.v = Math.min(nextAt.v, (Math.floor(now / screen.pixelShift.periodMs) + 1) * screen.pixelShift.periodMs);
  const sameAs = painted && JSON.stringify([canvas.width, canvas.height, rotate, page.id, page.background, !!(page.background.image && images.get(page.background.image)), theme.id, theme.colors.bg, theme.colors.surface, theme.colors.surfaceEdge, theme.radius, shift, painted]);
  return { canvas, tiles, idle: idles.length > 0 && idles.every(Boolean), nextAt: nextAt.v, animatable, sameAs };
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
  /** The instance's zoom (see `WidgetInstance.zoom`). */
  zoom?: number;
}): ComposeResult {
  const inst: WidgetInstance = { id: 'w', type: o.type, options: o.options ?? {}, ...(o.title ? { title: o.title } : {}), ...(o.zoom !== undefined && o.zoom !== 1 ? { zoom: o.zoom } : {}) };
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
    demoOptions: !o.options || !Object.keys(o.options).length,
    noShift: true,
  });
}

/**
 * Helpers for plugin tests (Node only: they paint with @napi-rs/canvas).
 *
 *   import { renderWidget, checkPlugin } from '@kiosko/sdk/testing';
 *
 *   const r = renderWidget(forecast, { size: { w: 600, h: 300 }, locale: 'es' });
 *   assert.deepEqual(r.texts.slice(0, 2), ['13°', 'Parcialmente nublado']);
 *   assert.equal(r.outside, 0);
 *
 *   assert.deepEqual(checkPlugin(plugin), []);   // every widget, several sizes, themes and languages
 *
 * A widget is painted the way Kiosko paints it (same context, same drawing
 * kit), with its `demo` data unless given other, and every text it draws
 * through the kit is collected in order. It is painted with a margin around
 * its box, so what it draws outside (which the panel would clip) is counted.
 */
import { createCanvas, loadImage, type Canvas } from '@napi-rs/canvas';
import * as kit from '@loksly/lcd-canvas-kit';
import { createBaseContext } from './context.ts';
import type { TimeFormat } from './format.ts';
import type { Alert, Box, PluginDefinition, RenderContext, StateContext, WidgetDefinition } from './plugin.ts';
import { validate } from './schema.ts';
import { THEMES, themeById, type Theme } from './theme.ts';
import { DEFAULT_WORKDAY } from './workday.ts';

export interface RenderOptions {
  /** The instance's options (validated against the widget's schema, defaults filled in). Default: the demo's, if any. */
  options?: Record<string, unknown>;
  /** The widget's own data. Default: its demo data. */
  data?: unknown;
  /** Data of its sources, by type. Default: its demo's. */
  sources?: Record<string, unknown>;
  /** The box it paints in. Default: its preferred size, else 480×300. */
  size?: { w: number; h: number };
  locale?: string;
  /** A theme or its id (`midnight`, `paper`…). Default: the first. */
  theme?: string | Theme;
  now?: number;
  timeFormat?: TimeFormat;
  /** Painted for the editor's preview rather than the panel. */
  preview?: boolean;
  /** Use the widget's `demo` for what isn't given. Default true. */
  demo?: boolean;
}

export interface RenderResult {
  /** Every text drawn with `kit.drawTracked`, in order. */
  texts: string[];
  /** The picture: the box with `margin` pixels around it. */
  canvas: Canvas;
  /** Where the box is on `canvas`. */
  box: Box;
  margin: number;
  /** Pixels painted outside the box (the panel would cut them off). */
  outside: number;
  /** How long `render` took. */
  ms: number;
  /** What `render` threw, if it did. */
  error?: string;
  /** The box alone, as PNG. */
  png(): Buffer;
}

const MARGIN = 24;

function resolve(w: WidgetDefinition<any, any>, o: RenderOptions) {
  const now = o.now ?? Date.UTC(2026, 10, 5, 9, 42);
  const locale = o.locale ?? 'en';
  const demoOpts = w.options ? (validate(w.options, {}).value as Record<string, unknown>) : {};
  const demo = o.demo === false ? undefined : w.demo?.({ options: demoOpts as never, now, locale });
  const options = w.options ? (validate(w.options, o.options ?? demo?.options ?? {}).value as Record<string, unknown>) : {};
  const data = 'data' in o ? o.data : demo?.data;
  const sources = o.sources ?? demo?.sources ?? {};
  return { now, locale, options, data, sources };
}

/** Paints a widget alone and says what it drew. Never throws: a failing `render` is reported in `error`. */
export function renderWidget(w: WidgetDefinition<any, any>, o: RenderOptions = {}): RenderResult {
  const { now, locale, options, data, sources } = resolve(w, o);
  const size = o.size ?? w.size?.preferred ?? { w: 480, h: 300 };
  const theme = typeof o.theme === 'object' ? o.theme : themeById(o.theme);
  const texts: string[] = [];
  const spy = { ...kit, drawTracked: (...a: Parameters<typeof kit.drawTracked>) => (texts.push(a[1]), kit.drawTracked(...a)) };
  const canvas = createCanvas(size.w + 2 * MARGIN, size.h + 2 * MARGIN);
  const g = canvas.getContext('2d');
  const box: Box = { x: MARGIN, y: MARGIN, w: size.w, h: size.h };
  const ctx: RenderContext<any, any> = {
    ...createBaseContext({ now, locale, ...(o.timeFormat ? { timeFormat: o.timeFormat } : {}) }),
    options,
    data,
    sources,
    working: true,
    box,
    theme,
    fonts: theme.fonts,
    kit: spy,
    canvas: { createCanvas, loadImage },
    preview: !!o.preview,
  };
  const t0 = performance.now();
  let error: string | undefined;
  try {
    w.render(g, ctx);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  const ms = performance.now() - t0;
  const px = g.getImageData(0, 0, canvas.width, canvas.height).data;
  let outside = 0;
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      if (x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h) continue;
      if (px[(y * canvas.width + x) * 4 + 3]! > 24) outside++;
    }
  }
  return {
    texts,
    canvas,
    box,
    margin: MARGIN,
    outside,
    ms,
    ...(error !== undefined ? { error } : {}),
    png() {
      const out = createCanvas(box.w, box.h);
      out.getContext('2d').drawImage(canvas, -box.x, -box.y);
      return out.toBuffer('image/png');
    },
  };
}

/** Asks a widget's `urgent`, `idle`, `empty` or `visible` with the same inputs `renderWidget` would use. */
export function widgetState(w: WidgetDefinition<any, any>, hook: 'urgent' | 'idle' | 'empty' | 'visible', o: RenderOptions = {}): boolean | undefined {
  const fn = w[hook];
  if (!fn) return undefined;
  const { now, options, data, sources } = resolve(w, o);
  const ctx: StateContext<any, any> = { options, data, sources, now, working: true, workday: DEFAULT_WORKDAY };
  return fn(ctx);
}

/** Asks a widget's `alerts` with the same inputs `renderWidget` would use; `[]` when it has none. */
export function widgetAlerts(w: WidgetDefinition<any, any>, o: RenderOptions = {}): Alert[] {
  if (!w.alerts) return [];
  const { now, options, data, sources } = resolve(w, o);
  return w.alerts({ options, data, sources, now, working: true, workday: DEFAULT_WORKDAY });
}

export interface PluginIssue {
  /** `plugin/widget`. */
  type: string;
  /** `600x300 midnight es`. */
  where: string;
  problem: string;
}

/**
 * Paints every widget of a plugin with its demo data at its minimum and
 * preferred sizes and a wide and a tall one, in every theme and in each
 * language given (by default the ones the plugin declares), and lists what went wrong: a `render` that throws, one
 * that paints nothing, paints outside its box, or takes longer than
 * `slowMs` (Kiosko warns at 50 ms). An empty list is a pass.
 */
export function checkPlugin(p: PluginDefinition, o: { locales?: string[]; themes?: string[]; slowMs?: number; extraSizes?: { w: number; h: number }[] } = {}): PluginIssue[] {
  const issues: PluginIssue[] = [];
  const locales = o.locales ?? (p.languages?.length ? p.languages : ['en', 'es']);
  const themes = o.themes ?? THEMES.map((t) => t.id);
  const slow = o.slowMs ?? 50;
  for (const w of p.widgets ?? []) {
    const type = `${p.id}/${w.id}`;
    const pref = w.size?.preferred ?? { w: 480, h: 300 };
    const min = w.size?.min ?? { w: Math.round(pref.w / 2), h: Math.round(pref.h / 2) };
    const sizes = [min, pref, { w: Math.max(pref.w * 2, 900), h: Math.max(min.h, 120) }, { w: Math.max(min.w, 200), h: Math.max(pref.h * 2, 500) }, ...(o.extraSizes ?? [])];
    for (const size of sizes) {
      for (const theme of themes) {
        for (const locale of locales) {
          const where = `${size.w}x${size.h} ${theme} ${locale}`;
          const r = renderWidget(w, { size, theme, locale });
          if (r.error) issues.push({ type, where, problem: `render threw: ${r.error}` });
          else if (r.outside > 0) issues.push({ type, where, problem: `painted ${r.outside} px outside its box` });
          // The first paint pays for loading fonts and compiling code; on the panel a widget paints
          // again and again. Slow means slow every time: the best of three.
          if (r.ms > slow && !r.error) {
            const ms = Math.min(r.ms, renderWidget(w, { size, theme, locale }).ms, renderWidget(w, { size, theme, locale }).ms);
            if (ms > slow) issues.push({ type, where, problem: `render took ${Math.round(ms)} ms` });
          }
        }
      }
    }
    // Something must show with the demo data, at least at the preferred size.
    const r = renderWidget(w, { size: pref });
    if (!r.error) {
      const px = r.canvas.getContext('2d').getImageData(r.box.x, r.box.y, r.box.w, r.box.h).data;
      let inked = 0;
      for (let i = 3; i < px.length; i += 4) if (px[i]! > 24) inked++;
      if (!inked) issues.push({ type, where: `${pref.w}x${pref.h}`, problem: 'painted nothing with its demo data (add a `demo`)' });
    }
  }
  return issues;
}

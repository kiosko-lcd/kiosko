/**
 * Painting usage: the old right-hand "Consumo" rail (limit windows or spend
 * bars, tokens today by model) and the spend-per-block sparkline. The
 * measurements are the original rail's (356 px wide, ~300 px of body),
 * scaled to the box.
 */
import type { Graphics, Localized, RenderContext } from '@tessera/sdk';
import type { UsageSnapshot } from './ccusage.ts';
import { countdown, money, percent, tokens } from './format.ts';

type Ctx = Pick<RenderContext<unknown, unknown>, 'box' | 'theme' | 'kit' | 'now' | 't' | 'sources'>;

export const USAGE_SOURCE = 'usage/ccusage';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export const TEXT = {
  block: { en: '5 h window', es: 'Ventana 5 h' },
  week: { en: 'Week', es: 'Semana' },
  day: { en: 'Today', es: 'Hoy' },
  month: { en: 'Month', es: 'Mes' },
  resetsIn: { en: 'resets in {t}', es: 'reinicia en {t}' },
  of: { en: 'of {cap}', es: 'de {cap}' },
  tokensToday: { en: 'Tokens today', es: 'Tokens hoy' },
  noData: { en: 'no ccusage data', es: 'sin datos de ccusage' },
  peak: { en: 'peak {v}', es: 'pico {v}' },
  current: { en: 'now {v}', es: 'ahora {v}' },
} satisfies Record<string, Localized>;

const fill = (text: string, vars: Record<string, string>) => text.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? '');

export function usageOf(sources: Record<string, unknown>): UsageSnapshot | undefined {
  const u = sources[USAGE_SOURCE] as UsageSnapshot | undefined;
  return u && typeof u === 'object' && (u.mode === 'max' || u.mode === 'api') ? u : undefined;
}

export interface Thresholds {
  warn: number;
  alert: number;
}

/** Ratios shown by the rail, 0..1. */
export function railRatios(u: UsageSnapshot): number[] {
  return u.mode === 'max' ? (u.windows ?? []).map((w) => w.ratio) : (u.spend ?? []).map((s) => (s.cap > 0 ? s.amount / s.cap : 0));
}

/** Semaphore level of a ratio against the thresholds. */
export function level(ratio: number, t: Thresholds): 'alert' | 'warn' | 'info' {
  return ratio >= t.alert ? 'alert' : ratio >= t.warn ? 'warn' : 'info';
}

function hairline(g: Graphics, x: number, y: number, w: number, color: string): void {
  g.fillStyle = color;
  g.fillRect(x, Math.round(y), w, 1);
}

function quiet(g: Graphics, ctx: Ctx, text: Localized, s: number): void {
  const { box, kit, theme, t } = ctx;
  const o = { size: Math.max(10, Math.round(15 * s)), family: theme.fonts.mono, color: theme.colors.inkFaint };
  kit.drawClipped(g, t(text), box.x, box.y + o.size * 1.2, box.w, o);
}

/** Height a bar takes, with and without its note, at scale 1. */
export const BAR_SLOT = 68;
export const BAR_SLOT_WITH_NOTE = 82;

interface Bar {
  label: string;
  right: string;
  ratio: number;
  note: string | null;
}

/** Label and figure, then the bar, then an optional note. Returns the next y. */
function drawBar(g: Graphics, ctx: Ctx, x: number, y: number, w: number, bar: Bar, color: string, s: number): number {
  const { kit, theme } = ctx;
  const c = theme.colors;
  const right = kit.drawTracked(g, bar.right, x + w, y, { size: Math.round(20 * s), family: theme.fonts.monoBold, color, align: 'right' });
  const labelOpts = { size: Math.round(18 * s), family: theme.fonts.sansBold, tracking: 3 * s, smallCaps: true, color: c.inkDim };
  kit.drawClipped(g, bar.label, x, y, Math.max(0, w - right - 10 * s), labelOpts);
  const barY = Math.round(y + 12 * s);
  const barH = Math.round(16 * s);
  g.fillStyle = c.bg;
  g.fillRect(x, barY, w, barH);
  g.fillStyle = color;
  g.fillRect(x, barY, Math.max(2, Math.round(w * clamp(bar.ratio, 0, 1))), barH);
  g.strokeStyle = c.surfaceEdge;
  g.lineWidth = 1;
  g.strokeRect(x + 0.5, barY + 0.5, w - 1, barH - 1);
  let next = barY + barH + 20 * s;
  if (bar.note) {
    kit.drawClipped(g, bar.note, x, next, w, { size: Math.max(9, Math.round(14 * s)), family: theme.fonts.mono, color: c.inkFaint });
    next += 14 * s;
  }
  return next + 20 * s;
}

function barsOf(ctx: Ctx, u: UsageSnapshot): Bar[] {
  const { t, now } = ctx;
  if (u.mode === 'max') {
    return (u.windows ?? []).map((win) => ({
      label: t(TEXT[win.id]),
      right: percent(win.ratio),
      ratio: win.ratio,
      note: win.resetsAt ? fill(t(TEXT.resetsIn), { t: countdown(win.resetsAt - now) }) : null,
    }));
  }
  return (u.spend ?? []).map((sp) => ({ label: t(TEXT[sp.id]), right: money(sp.amount), ratio: sp.cap > 0 ? sp.amount / sp.cap : 0, note: fill(t(TEXT.of), { cap: money(sp.cap) }) }));
}

/** Today's tokens and the split by model, from `y` down; `rows` model lines. */
function drawTokens(g: Graphics, ctx: Ctx, u: UsageSnapshot, x: number, y: number, w: number, rows: number, s: number): void {
  const { kit, theme, t } = ctx;
  const c = theme.colors;
  const value = tokens(u.tokensToday ?? 0);
  const vw = kit.drawTracked(g, value, x + w, y, { size: Math.round(18 * s), family: theme.fonts.monoBold, color: c.ink, align: 'right' });
  kit.drawClipped(g, t(TEXT.tokensToday), x, y, Math.max(0, w - vw - 8 * s), { size: Math.round(17 * s), family: theme.fonts.sansBold, tracking: 2.6 * s, smallCaps: true, color: c.inkDim });
  let fy = y + 26 * s;
  const o = { size: Math.max(10, Math.round(14 * s)), family: theme.fonts.mono, color: c.inkFaint };
  for (const m of (u.byModel ?? []).slice(0, rows)) {
    const tw = kit.drawTracked(g, tokens(m.tokens), x + w, fy, { ...o, align: 'right' });
    kit.drawClipped(g, m.model, x, fy, Math.max(0, w - tw - 10 * s), o);
    fy += 22 * s;
  }
}

export interface RailOptions extends Thresholds {
  bars: number;
  models: number;
}

/** The usage rail. Two columns when the box is wide enough, one otherwise. */
export function drawRail(g: Graphics, ctx: Ctx, o: RailOptions): void {
  const { box, theme } = ctx;
  const c = theme.colors;
  const s = clamp(Math.min(box.w / 356, box.h / 300), 0.55, 1.6);
  const u = usageOf(ctx.sources);
  const bars = u ? barsOf(ctx, u).slice(0, o.bars) : [];
  if (!u || (u.stale && !bars.length && !u.tokensToday)) {
    quiet(g, ctx, TEXT.noData, s);
    return;
  }
  const colorOf = (r: number) => ({ alert: c.alert, warn: c.warn, info: c.info })[level(r, o)];
  const top = box.y + Math.round(16 * s);
  const models = Math.min(o.models, u.byModel?.length ?? 0);

  if (box.w >= 620 * s) {
    // Wide: bars on the left, tokens on the right, a rule between them.
    const gapW = Math.round(36 * s);
    const leftW = Math.round((box.w - gapW) * 0.6);
    const rx = box.x + leftW + gapW;
    const rw = box.x + box.w - rx;
    let cy = top;
    for (const bar of bars) {
      const room = box.y + box.h - cy;
      if (room < (BAR_SLOT - 20) * s) break;
      cy = drawBar(g, ctx, box.x, cy, leftW, { ...bar, note: room >= (BAR_SLOT_WITH_NOTE - 20) * s ? bar.note : null }, colorOf(bar.ratio), s);
    }
    g.fillStyle = c.surfaceEdge;
    g.fillRect(box.x + leftW + Math.round(gapW / 2), box.y, 1, box.h);
    const rows = Math.max(0, Math.min(models, Math.floor((box.h - 16 * s - 26 * s) / (22 * s)) + 1));
    drawTokens(g, ctx, u, rx, top, rw, rows, s);
    return;
  }

  // Narrow, like the original: bars from the top, tokens anchored at the bottom.
  let rows = models;
  let notes = true;
  let shown = bars.length;
  const footerH = () => (rows > 0 || u.tokensToday !== undefined ? (44 + 22 * rows) * s : 0);
  const barsH = () => (shown ? shown * (notes ? BAR_SLOT_WITH_NOTE : BAR_SLOT) * s - 20 * s : 0);
  // Out of room: models go first, then the notes, then a bar.
  while (top + barsH() + 12 * s > box.y + box.h - footerH()) {
    if (rows > 1) rows--;
    else if (notes && shown) notes = false;
    else if (shown > 1) shown--;
    else if (rows > 0) rows--;
    else break;
  }
  let cy = top;
  for (const bar of bars.slice(0, shown)) cy = drawBar(g, ctx, box.x, cy, box.w, { ...bar, note: notes ? bar.note : null }, colorOf(bar.ratio), s);
  const footerTop = box.y + box.h - footerH();
  if (footerTop >= cy - 20 * s) {
    hairline(g, box.x, footerTop, box.w, c.surfaceEdge);
    drawTokens(g, ctx, u, box.x, footerTop + 26 * s, box.w, rows, s);
  }
}

/** The spend per 5-hour block, as bars; the running block one step brighter. */
export function drawBlocks(g: Graphics, ctx: Ctx): void {
  const { box, kit, theme, t } = ctx;
  const c = theme.colors;
  const s = clamp(Math.min(box.h / 200, box.w / 300), 0.6, 1.5);
  const points = usageOf(ctx.sources)?.blockHistory ?? [];
  if (!points.length) {
    quiet(g, ctx, TEXT.noData, s);
    return;
  }
  const o = { size: Math.max(10, Math.round(14 * s)), family: theme.fonts.mono, color: c.inkFaint };
  const head = box.y + o.size;
  const peak = Math.max(...points.map((p) => p.cost));
  const pw = kit.drawTracked(g, fill(t(TEXT.peak), { v: money(peak) }), box.x + box.w, head, { ...o, align: 'right' });
  const active = points.find((p) => p.active);
  if (active) kit.drawClipped(g, fill(t(TEXT.current), { v: money(active.cost) }), box.x, head, Math.max(0, box.w - pw - 12 * s), { ...o, color: c.inkDim });
  const top = Math.round(head + 12 * s);
  const h = box.y + box.h - top;
  for (const bar of kit.sparkBars(points.map((p) => p.cost), box.w, h, { gap: Math.max(1, Math.round(3 * s)) })) {
    // The running block stands out by one step of ink, not by a state
    // colour: the semaphore is the language of the sessions.
    g.fillStyle = points[bar.index]?.active ? c.inkDim : c.inkFaint;
    g.fillRect(box.x + bar.x, top + bar.y, bar.w, bar.h);
  }
}

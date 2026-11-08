/**
 * Painting the sessions: the tiles with their weight hierarchy, the overflow
 * column and the summary strip. Ported from the original aimonitor
 * dashboard ("tablero"), whose measurements were tuned for a 374 px tall
 * body; here everything scales from that reference to the box it gets.
 */
import { STATE_PRIORITY, claims } from '@loksly/agent-sessions';
import type { Graphics, Localized, RenderContext, ThemeColors } from '@tessera/sdk';
import { clock, countdown, elapsed, shortId } from './format.ts';
import { plan, usedWidth, type Tile } from './select.ts';
import { STATE_LABEL, TEXT, fill } from './texts.ts';
import { sessionsOf, type SessionState, type SessionView, type Weight } from './types.ts';

type Kit = RenderContext<unknown, unknown>['kit'];
type Ctx = Pick<RenderContext<unknown, unknown>, 'box' | 'theme' | 'kit' | 'now' | 't' | 'sources'>;

/** Body height the original layout was measured at. */
export const REF_H = 374;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Theme colour of a state: the semaphore every widget shares. */
export function stateColor(state: SessionState, c: ThemeColors): string {
  switch (state) {
    case 'permission':
      return c.alert;
    case 'waiting':
      return c.warn;
    case 'ready':
      return c.info;
    case 'active':
      return c.ok;
    default:
      return c.inkDim;
  }
}

/** `color` at `a` opacity, for `#RRGGBB` theme colours; anything else as is. */
function alpha(kit: Kit, color: string, a: number): string {
  return /^#[0-9a-f]{6}$/i.test(color) ? kit.css(kit.hex(color), a) : color;
}

interface Inks {
  strong: string;
  mid: string;
  faint: string;
  rule: string;
  accent: string;
}

/** Ink by visual weight. */
function inks(kit: Kit, weight: Weight, state: SessionState, c: ThemeColors): Inks {
  if (weight === 'solid') {
    // A full field of colour with dark text on it.
    return { strong: c.bg, mid: alpha(kit, c.bg, 0.78), faint: alpha(kit, c.bg, 0.55), rule: alpha(kit, c.bg, 0.28), accent: c.bg };
  }
  if (weight === 'marked') return { strong: c.ink, mid: c.inkDim, faint: c.inkFaint, rule: c.surfaceEdge, accent: stateColor(state, c) };
  return { strong: c.inkDim, mid: c.inkFaint, faint: c.inkFaint, rule: c.surfaceEdge, accent: c.inkFaint };
}

function hairline(g: Graphics, x: number, y: number, w: number, color: string): void {
  g.fillStyle = color;
  g.fillRect(x, Math.round(y), w, 1);
}

export interface TileStyle {
  /** Vertical scale against REF_H. */
  s: number;
  /** Tile width the text sizes are designed for (the configured minimum, scaled). */
  designW: number;
  spineWidth: number;
  detailLines: number;
  showGit: boolean;
}

/** One session tile. */
export function drawTile(g: Graphics, ctx: Ctx, tile: Tile, x: number, y: number, w: number, h: number, st: TileStyle): void {
  const { kit, theme, now, t } = ctx;
  const c = theme.colors;
  const f = theme.fonts;
  const { record: r, weight } = tile;
  const color = stateColor(r.state, c);
  const ink = inks(kit, weight, r.state, c);
  const s = st.s;
  // Text shrinks with the tile when it ends up narrower than designed.
  const fs = clamp(Math.min(s, (s * w) / st.designW), 0.4, 2);

  const spine = Math.max(3, Math.round(st.spineWidth * fs));
  if (weight === 'solid') {
    g.fillStyle = color;
    g.fillRect(x, y, w, h);
  } else {
    g.fillStyle = c.surface;
    g.fillRect(x, y, w, h);
    g.strokeStyle = c.surfaceEdge;
    g.lineWidth = 1;
    g.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    if (weight === 'marked') {
      // Full-bleed spine on the left edge.
      g.fillStyle = color;
      g.fillRect(x, y, spine, h);
    }
  }

  const pad = Math.round(18 * fs);
  const padL = weight === 'marked' ? spine + Math.round(15 * fs) : pad;
  const cx = x + padL;
  const cw = Math.max(10, w - padL - pad);
  const meeting = r.startsAt !== undefined;

  // 1. State label + short id (with provider).
  const labelOpts = { size: Math.max(11, Math.round(21 * fs)), family: f.sansBold, tracking: 3.6 * fs, smallCaps: true, color: ink.accent };
  const label = kit.truncate(g, t(meeting ? TEXT.meeting : STATE_LABEL[r.state]), cw, labelOpts);
  const labelW = kit.drawTracked(g, label, cx, y + 32 * s, labelOpts);
  const idOpts = { size: Math.max(10, Math.round(15 * fs)), family: f.mono, color: ink.faint, align: 'right' as const };
  const ids = meeting ? [clock(new Date(r.startsAt!))] : [`${String(r.provider).toUpperCase()} · ${shortId(r.session_id)}`, shortId(r.session_id)];
  const id = ids.find((txt) => kit.measureTracked(g, txt, idOpts) <= cw - labelW - 12 * fs);
  if (id) kit.drawTracked(g, id, x + w - pad, y + 31 * s, idOpts);

  // 2. Thin rule.
  hairline(g, cx, y + 46 * s, cw, ink.rule);

  // 5. The big number, at the bottom: how long it has been like this; for a
  //    meeting, how long until it starts (the same question, backwards).
  const footerBase = y + h - 16 * s;
  const elapsedSize = Math.round(52 * fs);
  const elapsedBase = footerBase - 26 * s;
  const big = !meeting ? elapsed(now - r.since, t(TEXT.now)) : r.startsAt! <= now ? t(TEXT.now) : countdown(r.startsAt! - now);
  const bigOpts = { size: elapsedSize, family: f.monoBold, color: ink.strong, tracking: -1 * fs };
  kit.drawClipped(g, big, cx, elapsedBase, cw, bigOpts);

  // 4. Technical detail, right above the time, over several lines: with one,
  //    an assistant message was cut mid-sentence. Lines grow upwards into the
  //    room the project name leaves, so the counter never moves.
  const detailOpts = { size: Math.max(10, Math.round(17 * fs)), family: f.mono, color: ink.mid };
  const lead = Math.round(detailOpts.size * 1.35);
  const detailBase = elapsedBase - elapsedSize * 0.8 - 14 * s;
  const midTop = y + 54 * s;
  const projMax = Math.round(48 * fs);
  const projMin = Math.max(12, Math.round(26 * fs));
  // In a short box the detail gives up lines before the project name gives up its room.
  let maxLines = Math.max(1, st.detailLines);
  while (maxLines > 1 && detailBase - (maxLines - 1) * lead - 24 * s - midTop < projMin * 0.9) maxLines--;
  const lines = kit.wrapLines(g, r.detail, cw, maxLines, detailOpts);
  lines.forEach((line, i) => kit.drawTracked(g, line, cx, detailBase - (lines.length - 1 - i) * lead, detailOpts));
  const detailTop = detailBase - Math.max(0, lines.length - 1) * lead;

  // 3. Project name: what identifies the console. It shrinks as far as it
  //    must before accepting an ellipsis.
  const midBottom = detailTop - 24 * s;
  const projOpts = { size: projMax, family: f.sansBold, color: ink.strong, tracking: 0.5 * fs };
  projOpts.size = Math.min(kit.fitSize(g, r.project, cw, projOpts, projMin), Math.max(projMin, Math.floor((midBottom - midTop) / 0.8)));
  const projBase = Math.round((midTop + midBottom) / 2 + projOpts.size * 0.36);
  kit.drawClipped(g, r.project, cx, projBase, cw, projOpts);

  // 6. Footer: files waiting for a commit.
  if (st.showGit && r.dirty !== undefined) {
    const txt = r.dirty === 0 ? t(TEXT.gitClean) : fill(t(TEXT.gitDirty), { n: r.dirty });
    kit.drawClipped(g, txt, cx, footerBase, cw, { size: Math.max(10, Math.round(16 * fs)), family: f.mono, color: ink.faint });
  }
}

/** The column that sums up the sessions that didn't get a tile. */
export function drawOverflow(g: Graphics, ctx: Ctx, rest: SessionView[], x: number, y: number, w: number, h: number, s: number): void {
  const { kit, theme, t } = ctx;
  const c = theme.colors;
  const f = theme.fonts;
  g.fillStyle = c.surface;
  g.fillRect(x, y, w, h);
  g.strokeStyle = c.surfaceEdge;
  g.lineWidth = 1;
  g.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);

  const pad = Math.round(16 * s);
  const cx = x + pad;
  const cw = Math.max(10, w - 2 * pad);
  const headOpts = { size: Math.max(11, Math.round(21 * s)), family: f.sansBold, tracking: 3.6 * s, smallCaps: true, color: c.inkDim };
  kit.drawClipped(g, fill(t(TEXT.more), { n: rest.length }), cx, y + 32 * s, cw, headOpts);
  hairline(g, cx, y + 46 * s, cw, c.surfaceEdge);

  const counts = new Map<SessionState, number>();
  for (const r of rest) counts.set(r.state, (counts.get(r.state) ?? 0) + 1);
  const box = Math.max(5, Math.round(9 * s));
  const countOpts = { size: Math.max(10, Math.round(17 * s)), family: f.monoBold, color: c.inkDim, align: 'right' as const };
  const labelOpts = { size: Math.max(10, Math.round(16 * s)), family: f.sansBold, tracking: 2 * s, smallCaps: true, color: c.inkDim };
  let ry = y + 78 * s;
  for (const [state, n] of [...counts].sort((a, b) => b[1] - a[1])) {
    if (ry > y + h - 6 * s) break;
    g.fillStyle = stateColor(state, c);
    g.fillRect(cx, ry - box, box, box);
    const countW = kit.drawTracked(g, String(n), x + w - pad, ry, countOpts);
    const lx = cx + box + Math.round(8 * s);
    kit.drawClipped(g, t(STATE_LABEL[state]), lx, ry, Math.max(0, x + w - pad - countW - 6 * s - lx), labelOpts);
    ry += 28 * s;
  }
}

export interface SessionsOptions {
  tileMin: number;
  tileMax: number;
  gap: number;
  summaryWidth: number;
  detailLines: number;
  spineWidth: number;
  stretch: boolean;
  align: 'left' | 'center' | 'right';
  showGit: boolean;
}

/** A centred, faint line: the widget has nothing to show. */
function drawQuiet(g: Graphics, ctx: Ctx, text: Localized): void {
  const { box, kit, theme, t } = ctx;
  const size = clamp(Math.round(box.h * 0.08), 12, 26);
  const o = { size, family: theme.fonts.sansBold, tracking: size * 0.15, smallCaps: true, color: theme.colors.inkFaint, align: 'center' as const };
  kit.drawTracked(g, kit.truncate(g, t(text), box.w, o), box.x + box.w / 2, box.y + box.h / 2 + size * 0.36, o);
}

/** The whole sessions widget. */
export function drawSessions(g: Graphics, ctx: Ctx, o: SessionsOptions): void {
  const { box } = ctx;
  const sessions = sessionsOf(ctx.sources);
  if (!sessions.length) {
    drawQuiet(g, ctx, TEXT.noSessions);
    return;
  }
  const s = clamp(box.h / REF_H, 0.5, 1.6);
  const gap = Math.max(2, Math.round(o.gap * s));
  const designW = o.tileMin * s;
  const p = plan(sessions, box.w, { min: designW, max: o.stretch ? Infinity : o.tileMax * s, gap, summaryWidth: Math.round(o.summaryWidth * s) });
  const free = box.w - usedWidth(p, gap);
  let x = Math.round(box.x + (o.align === 'center' ? free / 2 : o.align === 'right' ? free : 0));
  const st: TileStyle = { s, designW, spineWidth: o.spineWidth, detailLines: o.detailLines, showGit: o.showGit };
  for (const tile of p.tiles) {
    drawTile(g, ctx, tile, x, box.y, p.tileWidth, box.h, st);
    x += p.tileWidth + gap;
  }
  if (p.overflow.length) drawOverflow(g, ctx, p.overflow, x, box.y, p.summaryWidth, box.h, s);
}

export interface SummaryOptions {
  ram: boolean;
  clock: boolean;
  rule: boolean;
}

interface Part {
  text: string;
  color: string;
  /** Lower goes first when there is no room. */
  keep: number;
}

/**
 * The header line: RAM · N consoles · M waiting for you, and the clock. The
 * most urgent waiting state tints the count, so it reads from the corner of
 * the eye whether anything is up.
 */
export function drawSummaryStrip(g: Graphics, ctx: Ctx, o: SummaryOptions): void {
  const { box, kit, theme, now, t, sources } = ctx;
  const c = theme.colors;
  const f = theme.fonts;
  const sessions = sessionsOf(sources);
  // A strip: it grows with its height, but a tall box must not turn it into a poster.
  const s = clamp(Math.min(box.h / 56, box.w / 900), 0.4, 2);
  const ruleH = o.rule ? 1 : 0;
  const mid = box.y + (box.h - ruleH) / 2;

  let right = box.x + box.w;
  if (o.clock) {
    const cs = Math.max(10, Math.round(30 * s));
    const cw = kit.drawTracked(g, clock(new Date(now)), right, mid + cs * 0.36, { size: cs, family: f.monoBold, color: c.ink, align: 'right' });
    right -= cw + Math.round(24 * s);
  }

  const parts: Part[] = [];
  const mem = (sources['system/vitals'] as { mem?: { used: number; total: number } } | undefined)?.mem;
  if (o.ram && mem && mem.total > 0) {
    parts.push({ text: `RAM: ${Math.round(mem.used / 1024 ** 3)}GB/${Math.round(mem.total / 1024 ** 3)}GB`, color: c.ink, keep: 0 });
  }
  const n = sessions.length;
  parts.push({ text: n === 1 ? t(TEXT.console) : fill(t(TEXT.consoles), { n }), color: c.inkDim, keep: 1 });
  const waiting = sessions.filter(claims);
  const urgent = [...waiting].sort((a, b) => STATE_PRIORITY[b.state] - STATE_PRIORITY[a.state])[0];
  const waitText = waiting.length === 0 ? t(TEXT.nobody) : waiting.length === 1 ? t(TEXT.waitingOne) : fill(t(TEXT.waitingMany), { n: waiting.length });
  parts.push({ text: waitText, color: urgent ? stateColor(urgent.state, c) : c.inkFaint, keep: 2 });

  const dot = ' · ';
  let size = Math.max(10, Math.round(22 * s));
  const label = () => ({ size, family: f.sansBold, tracking: 3.4 * (size / 22), smallCaps: true });
  const width = (ps: Part[]) => ps.reduce((a, p, i) => a + kit.measureTracked(g, p.text, label()) + (i ? kit.measureTracked(g, dot, label()) : 0), 0);
  const room = right - box.x;
  // No room: drop the least important parts first, then shrink.
  while (parts.length > 1 && width(parts) > room) parts.splice(parts.findIndex((p) => p.keep === Math.min(...parts.map((q) => q.keep))), 1);
  while (size > 10 && width(parts) > room) size--;

  let x = box.x;
  const base = mid + size * 0.36;
  parts.forEach((p, i) => {
    if (i) x += kit.drawTracked(g, dot, x, base, { ...label(), color: c.inkFaint });
    x += kit.drawTracked(g, kit.truncate(g, p.text, Math.max(0, right - x), label()), x, base, { ...label(), color: p.color });
  });

  if (o.rule) hairline(g, box.x, box.y + box.h - 1, box.w, c.surfaceEdge);
}

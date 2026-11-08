/**
 * Painting of a news story: the full frame (`drawHeadline`) and the narrow
 * column (`drawColumn`), both from aimonitor's news panel.
 *
 * The text never sits bare on the photo: there's always a gradient veil
 * under it. Without it a white headline over a light sky can't be read, and
 * there's no knowing in advance which photo will come.
 *
 * The original frame was designed for 1920×462; every size here is that one
 * times `k`, the box's scale against it, so it holds at any tile size.
 */
import { iconFor, type Weather } from '@loksly/weather-astro';
import type { Box, Graphics, Image, Localized, RenderContext, Theme } from '@tessera/sdk';
import { contrastPair, type Story } from './cluster.ts';
import { paintDemoPhoto } from './demophoto.ts';
import type { NewsItem } from './feeds.ts';

/** Dark, so the photo leads. Fixed on purpose: it sits on a photo, not on the theme's background. */
export const PALETTE = { BG: '#05070A', INK: '#FFFFFF', INK_DIM: '#B9C6D4', ACCENT: '#FFB020' } as const;

type Kit = RenderContext<unknown, unknown>['kit'];

export interface Painter {
  g: Graphics;
  kit: Kit;
  fonts: Theme['fonts'];
  t: (text: Localized) => string;
  now: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const pad2 = (n: number) => String(n).padStart(2, '0');
const hhmm = (now: number) => {
  const d = new Date(now);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

/** "12 min ago" / "hace 12 min"… Null if the feed had no date or it's in the future. */
export function relativeAge(published: number, now: number): Localized | null {
  if (!published) return null;
  const mins = Math.floor((now - published) / 60000);
  if (mins < 0) return null;
  if (mins < 1) return { en: 'just now', es: 'ahora mismo' };
  if (mins < 60) return { en: `${mins} min ago`, es: `hace ${mins} min` };
  const hours = Math.floor(mins / 60);
  if (hours < 24) return { en: `${hours} h ago`, es: `hace ${hours} h` };
  const days = Math.floor(hours / 24);
  return days === 1 ? { en: 'yesterday', es: 'ayer' } : { en: `${days} days ago`, es: `hace ${days} días` };
}

export function outletsLabel(n: number): Localized {
  return { en: `${n} outlets`, es: `${n} cabeceras` };
}

/**
 * "Cover" crop biased upwards: in a press photo the faces are in the upper
 * third, and centring the crop beheads half the cabinet. `bias` 0.5 centres.
 */
export function coverRect(iw: number, ih: number, w: number, h: number, bias = 0.35): { dx: number; dy: number; dw: number; dh: number } {
  const scale = Math.max(w / iw, h / ih);
  const dw = iw * scale;
  const dh = ih * scale;
  return { dx: (w - dw) / 2, dy: (h - dh) * bias, dw, dh };
}

/** The photo over the whole box: the real one, a demo scene, or a sober gradient, never a hole. */
export function drawPhoto(g: Graphics, photo: Image | null, demo: string | null, b: Box): void {
  if (photo) {
    const r = coverRect(photo.width, photo.height, b.w, b.h);
    g.drawImage(photo, b.x + r.dx, b.y + r.dy, r.dw, r.dh);
    return;
  }
  if (demo) return paintDemoPhoto(g, demo, b);
  const grad = g.createLinearGradient(b.x, b.y, b.x + b.w, b.y + b.h);
  grad.addColorStop(0, '#101A26');
  grad.addColorStop(1, PALETTE.BG);
  g.fillStyle = grad;
  g.fillRect(b.x, b.y, b.w, b.h);
}

function vertical(g: Graphics, b: Box, y0: number, y1: number, stops: [number, number][]): void {
  const grad = g.createLinearGradient(0, y0, 0, y1);
  for (const [o, a] of stops) grad.addColorStop(o, `rgba(5,7,10,${a})`);
  g.fillStyle = grad;
  g.fillRect(b.x, y0, b.w, y1 - y0);
}

/**
 * Three layers: a soft general dimming (so the photo doesn't compete in
 * brightness), a strong left-to-right gradient under the text column, and a
 * darker foot that settles the image.
 */
function sideScrim(g: Graphics, b: Box): void {
  g.fillStyle = 'rgba(5,7,10,0.28)';
  g.fillRect(b.x, b.y, b.w, b.h);
  const side = g.createLinearGradient(b.x, 0, b.x + b.w * 0.78, 0);
  side.addColorStop(0, 'rgba(5,7,10,0.93)');
  side.addColorStop(0.55, 'rgba(5,7,10,0.72)');
  side.addColorStop(1, 'rgba(5,7,10,0)');
  g.fillStyle = side;
  g.fillRect(b.x, b.y, b.w, b.h);
  vertical(g, b, b.y + b.h * 0.62, b.y + b.h, [[0, 0], [1, 0.55]]);
}

/** For narrow boxes, where the text spans the width: light on top (the clock), strong at the bottom. */
function footScrim(g: Graphics, b: Box, topH: number): void {
  g.fillStyle = 'rgba(5,7,10,0.25)';
  g.fillRect(b.x, b.y, b.w, b.h);
  vertical(g, b, b.y, b.y + topH, [[0, 0.7], [1, 0]]);
  vertical(g, b, b.y + b.h * 0.1, b.y + b.h, [[0, 0], [0.3, 0.8], [1, 0.96]]);
}

/**
 * The headline's size: going down until it fits whole in its lines; if not
 * even the smallest fits, the smallest with an ellipsis. A short headline gets
 * the big size, which is what a screen read at a glance wants.
 */
export function fitHeadline(p: Painter, text: string, maxWidth: number, budget: number, sizes: number[], maxLines = 3, lead = 1.15): { size: number; lines: string[]; lead: number } {
  let last = { size: sizes[sizes.length - 1] ?? 20, lines: [] as string[], lead: 0 };
  for (const size of sizes) {
    const l = Math.round(size * lead);
    const n = Math.max(1, Math.min(maxLines, Math.floor(budget / l)));
    const lines = p.kit.wrapLines(p.g, text, maxWidth, n, { size, family: p.fonts.sansBold });
    last = { size, lines, lead: l };
    if (lines.length > 0 && !lines[lines.length - 1]!.endsWith('…')) return last;
  }
  return last;
}

/** The strapline: accent bar, outlet in small caps, then age and consensus as far as they fit. */
function kicker(p: Painter, x: number, y: number, maxW: number, size: number, source: string, extra: string[]): void {
  const { g, kit, fonts } = p;
  g.fillStyle = PALETTE.ACCENT;
  g.fillRect(x, y - size * 0.74, Math.max(2, size * 0.22), size * 0.96);
  const o = { size, family: fonts.sans, color: PALETTE.ACCENT, tracking: size * 0.1, smallCaps: true };
  const x0 = x + size * 0.78;
  const used = kit.drawTracked(g, kit.truncate(g, source, maxW - (x0 - x), o), x0, y, o);
  let cx = x0 + used + size * 0.7;
  for (const part of extra) {
    const text = `· ${part}`;
    const w = kit.measureTracked(g, text, o);
    if (cx + w > x + maxW) break;
    kit.drawTracked(g, text, cx, y, { ...o, color: PALETTE.INK_DIM });
    cx += w + size * 0.5;
  }
}

function extras(p: Painter, item: NewsItem, consensus: number): string[] {
  const age = relativeAge(item.published, p.now);
  return [...(age ? [p.t(age)] : []), ...(consensus > 1 ? [p.t(outletsLabel(consensus))] : [])];
}

/** Service corner, bottom right: temperature with its icon, place with today's range, and the clock. */
function corner(p: Painter, right: number, bottom: number, k: number, weather: Weather | undefined): void {
  const { g, kit, fonts } = p;
  // A soft shadow under the corner: unlike the text column it has no scrim of its own, and the photo's bright side is often there.
  const cx = right - 120 * k, cy = bottom - 60 * k, r = 230 * k;
  const shade = g.createRadialGradient(cx, cy, 0, cx, cy, r);
  shade.addColorStop(0, 'rgba(5,7,10,0.55)');
  shade.addColorStop(1, 'rgba(5,7,10,0)');
  g.fillStyle = shade;
  g.fillRect(cx - r, cy - r, 2 * r, 2 * r);
  const clockY = bottom;
  kit.drawTracked(g, hhmm(p.now), right, clockY, { size: 34 * k, family: fonts.sans, color: 'rgba(255,255,255,0.55)', tracking: 2 * k, align: 'right' });
  if (!weather) return;
  const today = weather.days[0];
  const line = today ? `${weather.place}  ${today.min}° / ${today.max}°` : weather.place;
  const placeY = clockY - 40 * k;
  kit.drawTracked(g, line, right, placeY, { size: 21 * k, family: fonts.sans, color: 'rgba(255,255,255,0.5)', tracking: 1.4 * k, align: 'right' });
  const tempY = placeY - 30 * k;
  const tw = kit.drawTracked(g, `${weather.temp}°`, right, tempY, { size: 46 * k, family: fonts.sansBold, color: 'rgba(255,255,255,0.9)', align: 'right' });
  kit.drawWeatherIcon(g, iconFor(weather.code, weather.night), right - tw - 42 * k, tempY - 16 * k, 52 * k, 'rgba(255,255,255,0.85)');
}

/** Clock and temperature in one low-key line, top right (narrow layouts). */
function topLine(p: Painter, right: number, baseline: number, size: number, weather: Weather | undefined): void {
  const { g, kit, fonts } = p;
  const w = kit.drawTracked(g, hhmm(p.now), right, baseline, { size, family: fonts.mono, color: 'rgba(255,255,255,0.7)', align: 'right' });
  if (weather) kit.drawTracked(g, `${weather.temp}°`, right - w - size * 0.6, baseline, { size, family: fonts.sansBold, color: 'rgba(255,255,255,0.85)', align: 'right' });
}

export interface HeadlineOptions {
  contrast: boolean;
  corner: boolean;
}

/**
 * The full frame: photo full-bleed, scrim, strapline, headline, standfirst
 * and the service corner. On wide boxes the text keeps to a left column and
 * the photo breathes on the right; on narrow ones it spans the width and sits
 * at the bottom.
 */
export function drawHeadline(p: Painter, story: Story, photo: Image | null, demo: string | null, b: Box, weather: Weather | undefined, o: HeadlineOptions): void {
  const { g, kit, fonts } = p;
  g.save();
  g.beginPath();
  g.rect(b.x, b.y, b.w, b.h);
  g.clip();
  g.fillStyle = PALETTE.BG;
  g.fillRect(b.x, b.y, b.w, b.h);
  drawPhoto(g, photo, demo, b);
  const k = clamp(Math.min(b.h / 462, b.w / 760), 0.35, 2);
  const pair = o.contrast && b.w >= 1400 && b.h >= 260 ? contrastPair(story) : null;
  if (pair) {
    drawContrast(p, b, pair, story, k);
    g.restore();
    return;
  }
  const item = story.lead;
  const wide = b.w >= b.h * 2.2;
  const PAD = Math.max(10, 58 * k);
  const cornerW = o.corner && wide && b.w - 2 * PAD >= 1000 * k ? 300 * k : 0;
  const textW = wide ? Math.min(1240 * k, b.w - 2 * PAD - cornerW) : b.w - 2 * PAD;
  const topBand = !wide && o.corner ? 30 * k + PAD * 0.6 : 0;
  if (wide) sideScrim(g, b);
  else footScrim(g, b, Math.max(topBand * 2, 60 * k));

  // Measured whole before painting, then centred (wide) or set at the bottom (narrow).
  const kickerCap = 18 * k, kickerGap = 34 * k;
  const bodySize = 26 * k, bodyLead = 34 * k, bodyGap = 16 * k;
  const inner = b.h - 2 * PAD - topBand;
  const budget = inner - kickerCap - kickerGap - (2 * bodyLead + bodyGap);
  const head = fitHeadline(p, item.title, textW, budget, [56, 51, 46, 42, 38].map((s) => Math.round(s * k)), wide ? 3 : 4);
  const headBottom = kickerCap + kickerGap + head.lines.length * head.lead;
  const room = Math.min(3, Math.floor((inner - headBottom - bodyGap) / bodyLead));
  const body = { size: bodySize, family: fonts.sans, color: PALETTE.INK_DIM, tracking: 0.2 * k };
  const bodyLines = room > 0 && item.summary ? kit.wrapLines(g, item.summary, textW, room, body) : [];
  const groupH = headBottom + (bodyLines.length ? bodyGap + bodyLines.length * bodyLead : 0);
  const top = wide ? b.y + Math.max(PAD, Math.round((b.h - groupH) / 2)) : b.y + Math.max(PAD + topBand, b.h - PAD - groupH);
  const x = b.x + PAD;

  kicker(p, x, top + kickerCap, textW, 23 * k, item.source, extras(p, item, story.consensus));
  const headTop = top + kickerCap + kickerGap;
  head.lines.forEach((line, i) => kit.drawTracked(g, line, x, headTop + head.size + i * head.lead, { size: head.size, family: fonts.sansBold, color: PALETTE.INK }));
  const bodyTop = headTop + head.lines.length * head.lead + bodyGap;
  bodyLines.forEach((line, i) => kit.drawTracked(g, line, x, bodyTop + bodySize + i * bodyLead, body));

  if (cornerW) corner(p, b.x + b.w - PAD, b.y + b.h - PAD + 10 * k, k, weather);
  else if (topBand) topLine(p, b.x + b.w - PAD, b.y + PAD * 0.6 + 26 * k, 28 * k, weather);
  g.restore();
}

/**
 * The same fact, two outlets, side by side: the one layout that uses the
 * panel's proportion instead of fighting it. The photo is dimmed much more,
 * since the text takes the whole width.
 */
function drawContrast(p: Painter, b: Box, pair: [NewsItem, NewsItem], story: Story, k: number): void {
  const { g, kit, fonts } = p;
  g.fillStyle = 'rgba(5,7,10,0.80)';
  g.fillRect(b.x, b.y, b.w, b.h);
  vertical(g, b, b.y, b.y + b.h, [[0, 0.35], [1, 0.75]]);
  const PAD = 58 * k, GUTTER = 64 * k;
  const colW = Math.floor((b.w - PAD * 2 - GUTTER) / 2);
  const kickerCap = 12 * k, kickerGap = 40 * k, sourceGap = 34 * k;
  const budget = b.h - PAD * 2 - kickerCap - kickerGap - sourceGap;
  const cols = pair.map((item) => ({ item, ...fitHeadline(p, item.title, colW, budget, [40, 36, 33, 30, 27].map((s) => Math.round(s * k)), 3, 1.18) }));
  const tallest = Math.max(...cols.map((c) => c.lines.length * c.lead));
  const groupH = kickerCap + kickerGap + sourceGap + tallest;
  const top = b.y + Math.max(PAD, Math.round((b.h - groupH) / 2));
  const kickerY = top + kickerCap;
  const age = relativeAge(story.lead.published, p.now);
  kicker(p, b.x + PAD, kickerY, b.w - 2 * PAD, 23 * k, p.t(outletsLabel(story.consensus)), age ? [p.t(age)] : []);
  // A divider only as tall as the text it separates.
  const ruleX = b.x + PAD + colW + GUTTER / 2;
  const ruleTop = kickerY + kickerGap - 8 * k;
  const ruleH = sourceGap + tallest + 8 * k;
  const rule = g.createLinearGradient(0, ruleTop, 0, ruleTop + ruleH);
  rule.addColorStop(0, 'rgba(255,255,255,0.05)');
  rule.addColorStop(0.5, 'rgba(255,255,255,0.24)');
  rule.addColorStop(1, 'rgba(255,255,255,0.05)');
  g.fillStyle = rule;
  g.fillRect(ruleX, ruleTop, 1, ruleH);
  const colTop = kickerY + kickerGap;
  cols.forEach((col, i) => {
    const x = b.x + PAD + (i === 0 ? 0 : colW + GUTTER);
    const so = { size: 21 * k, family: fonts.sans, color: PALETTE.ACCENT, tracking: 2.2 * k, smallCaps: true };
    kit.drawTracked(g, kit.truncate(g, col.item.source, colW, so), x, colTop, so);
    col.lines.forEach((line, n) => kit.drawTracked(g, line, x, colTop + sourceGap + col.size + n * col.lead, { size: col.size, family: fonts.sansBold, color: PALETTE.INK }));
  });
}

/**
 * The story in a column, for a screen shared with other tiles: the photo
 * full-bleed with rounded corners, the clock and temperature on top, and from
 * the bottom up the standfirst, the headline and the strapline.
 */
export function drawColumn(p: Painter, story: Story, photo: Image | null, demo: string | null, b: Box, radius: number, weather: Weather | undefined, showCorner: boolean): void {
  const { g, kit, fonts } = p;
  const k = clamp(Math.min(b.w / 560, b.h / 430), 0.45, 1.8);
  g.save();
  g.beginPath();
  g.roundRect(b.x, b.y, b.w, b.h, Math.max(0, Math.min(radius, b.w / 2, b.h / 2)));
  g.clip();
  g.fillStyle = PALETTE.BG;
  g.fillRect(b.x, b.y, b.w, b.h);
  drawPhoto(g, photo, demo, b);
  footScrim(g, b, 90 * k);
  g.restore();

  const pad = 16 * k;
  const box: Box = { x: b.x + pad, y: b.y + pad, w: b.w - 2 * pad, h: b.h - 2 * pad };
  const item = story.lead;
  const clockH = showCorner ? 40 * k : 0;
  if (showCorner) topLine(p, box.x + box.w, box.y + 26 * k, 30 * k, weather);

  const bodyOpts = { size: 22 * k, family: fonts.sans, color: PALETTE.INK_DIM };
  const bodyLead = 28 * k;
  const budget = box.h - clockH - 50 * k;
  const sizes = [40, 36, 33, 30, 27].map((s) => Math.round(s * k));
  const head = fitHeadline(p, item.title, box.w, budget - 2 * bodyLead, sizes, 5, 1.14);
  const room = Math.min(3, Math.floor((budget - head.lines.length * head.lead - 10 * k) / bodyLead));
  const body = room > 0 && item.summary ? kit.wrapLines(g, item.summary, box.w, room, bodyOpts) : [];
  let y = box.y + box.h - body.length * bodyLead;
  body.forEach((l, i) => kit.drawTracked(g, l, box.x, y + 18 * k + i * bodyLead, bodyOpts));
  y -= (body.length ? 12 * k : 0) + head.lines.length * head.lead;
  head.lines.forEach((l, i) => kit.drawTracked(g, l, box.x, y + head.size * 0.9 + i * head.lead, { size: head.size, family: fonts.sansBold, color: PALETTE.INK }));
  kicker(p, box.x, y - 18 * k, box.w, 21 * k, item.source, extras(p, item, story.consensus));
}

/** No stories yet: a dark frame that says so, instead of a hole. */
export function drawWaiting(p: Painter, b: Box): void {
  const { g, kit, fonts } = p;
  drawPhoto(g, null, null, b);
  const size = clamp(b.h / 12, 11, 30);
  const text = p.t({ en: 'Waiting for the news…', es: 'Esperando las noticias…' });
  kit.drawTracked(g, kit.truncate(g, text, b.w * 0.9, { size, family: fonts.sans }), b.x + b.w / 2, b.y + b.h / 2 + size * 0.35, { size, family: fonts.sans, color: PALETTE.INK_DIM, align: 'center' });
}

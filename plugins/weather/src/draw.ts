/**
 * Painting of the forecast card, in blocks that the widget arranges to the
 * shape of its tile: what it's like now, the next hours, the next days and the
 * moon. Every size comes from the block it's given, never from the panel, so
 * the same code serves a 300×200 corner and a full 1920×462 strip.
 */
import { iconFor, moonPhase, type DayForecast, type HourForecast, type Weather } from '@loksly/weather-astro';
import type { Box, Graphics, Localized, RenderContext, Theme } from '@tessera/sdk';
import { dayLabel, describeCode, moonHeadline, moonName, staleness } from './labels.ts';

export interface Painter {
  g: Graphics;
  kit: RenderContext<unknown, unknown>['kit'];
  theme: Theme;
  t: (text: Localized) => string;
  locale: string;
  now: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Icon and temperature only, as large as the box allows. */
export function drawTiny(p: Painter, w: Weather, b: Box): void {
  const { g, kit, theme } = p;
  const icon = Math.min(b.h * 0.8, b.w * 0.4);
  const text = `${w.temp}°`;
  const size = kit.fitSize(g, text, b.w - icon - 6, { size: Math.min(b.h * 0.7, 120), family: theme.fonts.sansBold }, 8);
  const tw = kit.measureTracked(g, text, { size, family: theme.fonts.sansBold });
  const x0 = b.x + (b.w - icon - 6 - tw) / 2;
  kit.drawWeatherIcon(g, iconFor(w.code, w.night), x0 + icon / 2, b.y + b.h / 2, icon, theme.colors.ink);
  kit.drawTracked(g, text, x0 + icon + 6, b.y + b.h / 2 + size * 0.36, { size, family: theme.fonts.sansBold, color: theme.colors.ink });
}

/** Now: icon, big temperature, what it's like, the place and today's range. */
export function drawNow(p: Pick<Painter, 'g' | 'kit' | 'theme' | 't' | 'now'>, w: Weather, b: Box): void {
  const { g, kit, theme, t } = p;
  const icon = Math.min(b.h * 0.72, b.w * 0.34, 130);
  const gap = icon * 0.16;
  const tx = b.x + icon + gap;
  const tw = b.w - icon - gap;
  const T = kit.fitSize(g, `${w.temp}°`, tw, { size: clamp(b.h * 0.46, 16, 110), family: theme.fonts.sansBold }, 12);
  const D = clamp(T * 0.27, 10, 28);
  const today = w.days[0];
  const detail = today ? `${w.place} · ${today.min}° / ${today.max}°` : w.place;
  const old = staleness(w, p.now);
  const lines = 2 + (old && b.h > T * 0.8 + D * 4.4 ? 1 : 0);
  const groupH = T * 0.78 + D * 0.5 + lines * D * 1.3;
  const top = b.y + Math.max(0, (b.h - groupH) / 2);
  kit.drawWeatherIcon(g, iconFor(w.code, w.night), b.x + icon / 2, b.y + b.h / 2, icon, theme.colors.ink);
  let y = top + T * 0.78;
  kit.drawTracked(g, `${w.temp}°`, tx, y, { size: T, family: theme.fonts.sansBold, color: theme.colors.ink, tracking: -T * 0.02 });
  y += D * 0.5 + D * 1.15;
  const desc = t(describeCode(w.code));
  kit.drawTracked(g, kit.truncate(g, desc, tw, { size: D, family: theme.fonts.sans }), tx, y, { size: D, family: theme.fonts.sans, color: theme.colors.ink });
  y += D * 1.3;
  const ds = D * 0.86;
  kit.drawTracked(g, kit.truncate(g, detail, tw, { size: ds, family: theme.fonts.sans }), tx, y, { size: ds, family: theme.fonts.sans, color: theme.colors.inkDim });
  if (lines === 3 && old) {
    y += D * 1.3;
    kit.drawTracked(g, kit.truncate(g, t(old), tw, { size: ds, family: theme.fonts.sans }), tx, y, { size: ds, family: theme.fonts.sans, color: theme.colors.warn });
  }
}

/**
 * The next hours: temperature curve on top, rain bars below, sharing the same
 * hour axis, which is the comparison that matters (when it will be warmest,
 * when it may rain). The vertical scale fits the range shown: on a flat day a
 * fixed 0–40 scale would draw a straight line.
 */
export function drawHourly(p: Painter, hours: HourForecast[], b: Box): void {
  const { g, kit, theme, t } = p;
  const k = clamp(b.h / 270, 0.42, 1.3);
  const n = Math.min(hours.length, Math.max(2, Math.floor(b.w / (46 * k))));
  const shown = hours.slice(0, n);
  if (shown.length < 2) return;
  const x0 = b.x, x1 = b.x + b.w, bottom = b.y + b.h;
  const step = (x1 - x0) / shown.length;
  const cx = (i: number) => x0 + step * (i + 0.5);

  const temps = shown.map((h) => h.temp);
  const lo = Math.min(...temps);
  const span = Math.max(1, Math.max(...temps) - lo);
  const lineTop = b.y + 38 * k;
  const lineBottom = b.y + b.h * 0.46;
  const rainBase = bottom - 30 * k;
  const rainMax = Math.max(8, Math.min(62 * k, rainBase - lineBottom - 34 * k));
  const yOf = (v: number) => lineBottom - ((v - lo) / span) * (lineBottom - lineTop);
  const rainColor = theme.colors.info;

  // Rain bars, with a faint baseline.
  g.fillStyle = theme.colors.surfaceEdge;
  g.fillRect(x0, rainBase, x1 - x0, 1);
  const bw = Math.min(34 * k, step * 0.42);
  let wet = false;
  for (const [i, h] of shown.entries()) {
    if (h.rain <= 0) continue;
    wet = true;
    const bh = Math.max(2, (h.rain / 100) * rainMax);
    g.globalAlpha = h.rain >= 50 ? 1 : 0.5;
    g.fillStyle = rainColor;
    g.fillRect(cx(i) - bw / 2, rainBase - bh, bw, bh);
    g.globalAlpha = 1;
    if (h.rain >= 20 && step > 30 * k) kit.drawTracked(g, `${h.rain}%`, cx(i), rainBase - bh - 6 * k, { size: 17 * k, family: theme.fonts.sans, color: rainColor, align: 'center' });
  }
  if (!wet) {
    // Twelve zero bars say nothing; a sentence does.
    const text = t({ en: 'No rain expected', es: 'Sin lluvia prevista' });
    kit.drawTracked(g, kit.truncate(g, text, b.w, { size: 19 * k, family: theme.fonts.sans }), x0, rainBase - 10 * k, { size: 19 * k, family: theme.fonts.sans, color: theme.colors.inkFaint, tracking: 1 });
  }

  // Temperature curve.
  g.strokeStyle = theme.colors.warn;
  g.lineWidth = Math.max(1.5, 2.5 * k);
  g.lineJoin = 'round';
  g.beginPath();
  shown.forEach((h, i) => (i ? g.lineTo(cx(i), yOf(h.temp)) : g.moveTo(cx(i), yOf(h.temp))));
  g.stroke();
  for (const [i, h] of shown.entries()) {
    const x = cx(i), y = yOf(h.temp);
    g.fillStyle = theme.colors.warn;
    g.beginPath();
    g.arc(x, y, Math.max(2, 3.5 * k), 0, Math.PI * 2);
    g.fill();
    // The label goes above its point unless a steep segment would cut through
    // it there (a dip, the foot of a drop) and below is clear.
    const label = { size: 21 * k, family: theme.fonts.sansBold };
    const half = kit.measureTracked(g, `${h.temp}°`, label) / 2;
    const climb = (j: number) => (shown[j] ? ((y - yOf(shown[j]!.temp)) * half) / step : 0);
    const above = Math.max(climb(i - 1), climb(i + 1)) <= 12 * k;
    const below = Math.min(climb(i - 1), climb(i + 1)) >= -6 * k;
    kit.drawTracked(g, `${h.temp}°`, x, above || !below ? y - 12 * k : y + 28 * k, { size: 21 * k, family: theme.fonts.sansBold, color: theme.colors.ink, align: 'center' });
    // Every hour labelled; the ones divisible by three brighter, to find your way.
    const hh = Number.parseInt(h.label.slice(0, 2), 10);
    kit.drawTracked(g, `${h.label.slice(0, 2)}h`, x, bottom, { size: 19 * k, family: theme.fonts.sans, color: hh % 3 === 0 ? theme.colors.inkDim : theme.colors.inkFaint, align: 'center' });
  }
}

/** The next days, as rows (tall boxes) or columns (wide, short boxes). */
export function drawDays(p: Painter, days: DayForecast[], b: Box): void {
  const { g, kit, theme, t, locale } = p;
  if (!days.length) return;
  if (b.w / b.h > 2.4) {
    const n = Math.min(days.length, Math.max(1, Math.floor(b.w / 70)));
    const cw = b.w / n;
    const S = clamp(Math.min(b.h * 0.2, cw * 0.2), 9, 26);
    const icon = Math.min(b.h - S * 2.6, cw * 0.45);
    days.slice(0, n).forEach((d, i) => {
      const x = b.x + cw * (i + 0.5);
      kit.drawTracked(g, kit.truncate(g, dayLabel(d.date, i, locale, t), cw - 4, { size: S, family: theme.fonts.sans }), x, b.y + S, { size: S, family: theme.fonts.sans, color: theme.colors.inkDim, align: 'center' });
      kit.drawWeatherIcon(g, iconFor(d.code), x, b.y + S * 1.3 + icon / 2, icon, theme.colors.ink);
      kit.drawTracked(g, `${d.min}° / ${d.max}°`, x, b.y + b.h - 2, { size: S, family: theme.fonts.sansBold, color: theme.colors.ink, align: 'center' });
    });
    return;
  }
  const n = Math.min(days.length, Math.max(1, Math.floor(b.h / 22)));
  const rowH = Math.min(b.h / n, 90);
  const S = clamp(rowH * 0.34, 9, 28);
  const icon = Math.min(rowH * 0.7, S * 1.8);
  const top = b.y + (b.h - rowH * n) / 2;
  const labelW = Math.min(b.w * 0.34, S * 4);
  const temps = (d: DayForecast) => `${d.min}° / ${d.max}°`;
  const showRain = b.w >= labelW + icon + S * 9;
  days.slice(0, n).forEach((d, i) => {
    const cy = top + rowH * (i + 0.5);
    const base = cy + S * 0.36;
    kit.drawTracked(g, kit.truncate(g, dayLabel(d.date, i, locale, t), labelW, { size: S, family: theme.fonts.sans }), b.x, base, { size: S, family: theme.fonts.sans, color: i === 0 ? theme.colors.ink : theme.colors.inkDim });
    kit.drawWeatherIcon(g, iconFor(d.code), b.x + labelW + icon * 0.7, cy, icon, theme.colors.ink);
    kit.drawTracked(g, temps(d), b.x + b.w, base, { size: S, family: theme.fonts.sansBold, color: theme.colors.ink, align: 'right' });
    if (showRain && d.rain > 0) kit.drawTracked(g, `${d.rain}%`, b.x + labelW + icon * 1.5 + S * 0.4, base, { size: S * 0.85, family: theme.fonts.sans, color: theme.colors.info });
  });
}

/** The moon in its phase, its name and the next milestone. */
export function drawMoon(p: Painter, b: Box): void {
  const { g, kit, theme, t } = p;
  const m = moonPhase(p.now);
  const S = clamp(b.h * 0.06, 10, 22);
  const disc = Math.min(b.w * 0.6, b.h - S * 4.6, 110);
  if (disc < 24) return;
  const cx = b.x + b.w / 2;
  const groupH = disc + S * 4;
  const top = b.y + (b.h - groupH) / 2;
  kit.drawMoonPhase(g, m, cx, top + disc / 2, disc, theme.colors.ink);
  const name = t(moonName(m));
  kit.drawTracked(g, kit.truncate(g, name, b.w, { size: S, family: theme.fonts.sans }), cx, top + disc + S * 1.8, { size: S, family: theme.fonts.sans, color: theme.colors.inkDim, align: 'center' });
  const sub = `${Math.round(m.illumination * 100)}% · ${t(moonHeadline(m))}`;
  const ss = S * 0.85;
  kit.drawTracked(g, kit.truncate(g, sub, b.w, { size: ss, family: theme.fonts.sans }), cx, top + disc + S * 3.4, { size: ss, family: theme.fonts.sans, color: theme.colors.inkFaint, align: 'center' });
}

/** A hairline between blocks, faded at both ends. */
export function rule(p: Pick<Painter, 'g' | 'theme'>, x: number, top: number, bottom: number): void {
  const { g, theme } = p;
  const grad = g.createLinearGradient(0, top, 0, bottom);
  grad.addColorStop(0, 'rgba(128,128,128,0)');
  grad.addColorStop(0.5, theme.colors.surfaceEdge);
  grad.addColorStop(1, 'rgba(128,128,128,0)');
  g.fillStyle = grad;
  g.fillRect(Math.round(x), top, 1, bottom - top);
}

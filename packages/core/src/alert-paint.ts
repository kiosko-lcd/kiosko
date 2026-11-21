/**
 * How an alert looks on a panel: the whole surface, dark, with a frame in
 * the level's colour that flashes for the first seconds and then pulses
 * slowly, and the text still, as big as the panel allows.
 *
 * The flashing follows WCAG 2.3.1 (photosensitive epilepsy): at most one
 * flash a second here (the limit is three), and only the frame flashes,
 * never the whole surface, which keeps a red flash under a sixth of the
 * panel (the "red flash" rule is about area). The text never moves: it must
 * be read from across the room.
 */
import * as kit from '@loksly/lcd-canvas-kit';
import { Path2D, type SKRSContext2D } from '@napi-rs/canvas';
import type { AlertLevel, ThemeFonts } from '@kiosko/sdk';
import type { ShownAlert } from './alerts.ts';

/** How long a new alert flashes before it only pulses. */
export const FLASH_MS = 10_000;
/** One slow pulse, after the flashing. */
export const PULSE_MS = 4_000;
/** The most the frame may cover of the panel: the rest stays still. */
export const MAX_FRAME_AREA = 0.16;

/** The level's colour, the dim one of its frame and a background just tinted with it. */
export const LEVEL_COLORS: Record<AlertLevel, { color: string; bg: string }> = {
  info: { color: '#38bdf8', bg: '#04101a' },
  warn: { color: '#f59e0b', bg: '#160f02' },
  critical: { color: '#ef4444', bg: '#190405' },
};

/**
 * Time between two different alert frames, in ms: half a second (2 fps, a
 * 1 Hz flash), slower if the screen's `maxFps` asks for it.
 */
export function alertStepMs(maxFps: number): number {
  return Math.max(500, Math.ceil(1000 / Math.max(1, maxFps || 1)));
}

/**
 * How bright the frame is (0..1) `elapsed` ms after the alert came up, in
 * steps of `step` ms: on and off for `FLASH_MS` (not for `info`, which only
 * pulses), then a slow pulse. Rounded, so equal steps give equal frames
 * (and an equal frame is not sent again).
 */
export function alertIntensity(level: AlertLevel, elapsed: number, step: number): number {
  const k = Math.floor(Math.max(0, elapsed) / step);
  if (level !== 'info' && elapsed < FLASH_MS) return k % 2 === 0 ? 1 : 0.15;
  const t = ((k * step) % PULSE_MS) / PULSE_MS;
  const depth = level === 'info' ? 0.3 : 0.45;
  return Math.round((1 - depth * (0.5 - 0.5 * Math.cos(2 * Math.PI * t))) * 100) / 100;
}

/** The frame's thickness for a panel: about 5% of its short side, never over `MAX_FRAME_AREA` of it. */
export function frameWidth(w: number, h: number): number {
  const want = Math.max(4, Math.round(Math.min(w, h) * 0.055));
  // 2b(w+h) - 4b² <= A·w·h; the linear term alone is a safe bound.
  const cap = Math.floor((MAX_FRAME_AREA * w * h) / (2 * (w + h)));
  return Math.max(2, Math.min(want, cap));
}

/* Icons: Lucide's (ISC licence), the ones alerts are likely to ask for. Circles as paths. */
const circle = (cx: number, cy: number, r: number) => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;
export const ALERT_ICONS: Record<string, string[]> = {
  'triangle-alert': ['m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3', 'M12 9v4', 'M12 17h.01'],
  'octagon-alert': ['M12 16h.01', 'M12 8v4', 'M15.312 2a2 2 0 0 1 1.414.586l4.688 4.688A2 2 0 0 1 22 8.688v6.624a2 2 0 0 1-.586 1.414l-4.688 4.688a2 2 0 0 1-1.414.586H8.688a2 2 0 0 1-1.414-.586l-4.688-4.688A2 2 0 0 1 2 15.312V8.688a2 2 0 0 1 .586-1.414l4.688-4.688A2 2 0 0 1 8.688 2z'],
  info: [circle(12, 12, 10), 'M12 16v-4', 'M12 8h.01'],
  bell: ['M10.268 21a2 2 0 0 0 3.464 0', 'M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326'],
  'bell-ring': ['M10.268 21a2 2 0 0 0 3.464 0', 'M22 8c0-2.3-.8-4.3-2-6', 'M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326', 'M4 2C2.8 3.7 2 5.7 2 8'],
  flame: ['M12 3q1 4 4 6.5t3 5.5a1 1 0 0 1-14 0 5 5 0 0 1 1-3 1 1 0 0 0 5 0c0-2-1.5-3-1.5-5q0-2 2.5-4'],
  droplet: ['M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z'],
  phone: ['M13.832 16.568a1 1 0 0 0 1.213-.303l.355-.465A2 2 0 0 1 17 15h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2A18 18 0 0 1 2 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3a2 2 0 0 1-.8 1.6l-.468.351a1 1 0 0 0-.292 1.233 14 14 0 0 0 6.392 6.384'],
  'phone-incoming': ['M16 2v6h6', 'm22 2-6 6', 'M13.832 16.568a1 1 0 0 0 1.213-.303l.355-.465A2 2 0 0 1 17 15h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2A18 18 0 0 1 2 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3a2 2 0 0 1-.8 1.6l-.468.351a1 1 0 0 0-.292 1.233 14 14 0 0 0 6.392 6.384'],
  activity: ['M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2'],
  zap: ['M15.914 4a1.5 1.5 0 00-2.474-1.561l-9 9A1.5 1.5 0 005.5 14h4.002a.5.5 0 01.471.666L8.086 20a1.5 1.5 0 002.475 1.56l9-9A1.5 1.5 0 0018.5 10h-3.997a.5.5 0 01-.472-.667z'],
  'cloud-lightning': ['M6 16.326A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 .5 8.973', 'm13 12-3 5h4l-3 5'],
  wind: ['M12.8 19.6A2 2 0 1 0 14 16H2', 'M17.5 8a2.5 2.5 0 1 1 2 4H2', 'M9.8 4.4A2 2 0 1 1 11 8H2'],
  waves: ['M2 12q2.5 2 5 0t5 0 5 0 5 0', 'M2 19q2.5 2 5 0t5 0 5 0 5 0', 'M2 5q2.5 2 5 0t5 0 5 0 5 0'],
  thermometer: ['M14 4v10.54a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0Z'],
  siren: ['M7 18v-6a5 5 0 1 1 10 0v6', 'M5 21a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-1a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2z', 'M21 12h1', 'M18.5 4.5 18 5', 'M2 12h1', 'M12 2v1', 'm4.929 4.929.707.707', 'M12 12v6'],
  'shield-alert': ['M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z', 'M12 8v4', 'M12 16h.01'],
  'door-open': ['M10 21H2', 'M10 3H7a2 2 0 00-2 2v16', 'M14 12h.01', 'M19 21V5a2 2 0 00-1.675-1.974l-6.163-1.013A1 1 0 0010 3v18a1 1 0 001.124.992z', 'M22 21h-3'],
  'git-branch': ['M15 6a9 9 0 0 0-9 9V3', circle(18, 6, 3), circle(6, 18, 3)],
  'circle-x': [circle(12, 12, 10), 'm15 9-6 6', 'm9 9 6 6'],
  bug: ['M12 20v-9', 'M14 7a4 4 0 0 1 4 4v3a6 6 0 0 1-12 0v-3a4 4 0 0 1 4-4z', 'M14.12 3.88 16 2', 'M21 21a4 4 0 0 0-3.81-4', 'M21 5a4 4 0 0 1-3.55 3.97', 'M22 13h-4', 'M3 21a4 4 0 0 1 3.81-4', 'M3 5a4 4 0 0 0 3.55 3.97', 'M6 13H2', 'm8 2 1.88 1.88', 'M9 7.13V6a3 3 0 1 1 6 0v1.13'],
  mail: ['m22 7-8.991 5.727a2 2 0 0 1-2.009 0L2 7', 'M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z'],
};

const paths = new Map<string, Path2D[]>();
function iconPaths(name: string): Path2D[] | null {
  const d = ALERT_ICONS[name];
  if (!d) return null;
  let p = paths.get(name);
  if (!p) paths.set(name, (p = d.map((x) => new Path2D(x))));
  return p;
}

/** The icon an alert gets: its own if the panel can draw it, else one by level. */
export function iconFor(a: { icon?: string; level: AlertLevel }): { path: string } | { glyph: string } {
  const icon = a.icon?.trim();
  if (icon && ALERT_ICONS[icon]) return { path: icon };
  // One or two characters (an emoji, 震): drawn as text.
  if (icon && [...icon].length <= 2 && !/^[a-z-]+$/.test(icon)) return { glyph: icon };
  return { path: a.level === 'info' ? 'info' : a.level === 'critical' ? 'octagon-alert' : 'triangle-alert' };
}

function drawIcon(g: SKRSContext2D, a: { icon?: string; level: AlertLevel }, x: number, y: number, size: number, color: string, family: string): void {
  const which = iconFor(a);
  g.save();
  if ('glyph' in which) {
    kit.drawTracked(g, which.glyph, x + size / 2, y + size * 0.82, { size: Math.round(size * 0.86), family, color, align: 'center' });
  } else {
    g.translate(x, y);
    g.scale(size / 24, size / 24);
    g.strokeStyle = color;
    g.lineWidth = 2;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    for (const p of iconPaths(which.path)!) g.stroke(p);
  }
  g.restore();
}

export interface AlertPaintOptions {
  /** How bright the frame is now, 0..1 (see `alertIntensity`). */
  intensity: number;
  fonts: ThemeFonts;
  /** The smallest text that can be read on this panel, in px (`legibleCjkPx`). */
  minPx: number;
  /** When it came, already written for the user ("14:05"), shown small in a corner. */
  sinceText?: string;
  /** Anti burn-in: the content moves a pixel or two with the screen's pixel shift. */
  shift?: { x: number; y: number };
}

const mixHex = (a: string, b: string, t: number) => kit.css(kit.mix(kit.hex(a), kit.hex(b), kit.clamp(t)));

/** Paints `shown` over the whole of a `w`×`h` surface. */
export function paintAlert(g: SKRSContext2D, w: number, h: number, shown: ShownAlert, o: AlertPaintOptions): void {
  const a = shown.top;
  const { color, bg } = LEVEL_COLORS[a.level];
  g.save();
  g.fillStyle = bg;
  g.fillRect(0, 0, w, h);
  // The frame: the only thing that flashes.
  const b = frameWidth(w, h);
  g.fillStyle = mixHex(bg, color, 0.12 + 0.88 * o.intensity);
  g.fillRect(0, 0, w, b);
  g.fillRect(0, h - b, w, b);
  g.fillRect(0, b, b, h - 2 * b);
  g.fillRect(w - b, b, b, h - 2 * b);

  const shift = o.shift ?? { x: 0, y: 0 };
  const pad = Math.round(Math.min(w, h) * 0.07);
  const box = { x: b + pad + shift.x, y: b + pad + shift.y, w: w - 2 * (b + pad), h: h - 2 * (b + pad) };
  const minPx = Math.max(12, o.minPx);
  const bold = o.fonts.sansBold;
  const regular = o.fonts.sans;

  // "+2": the others, as a counter in the corner.
  const small = Math.max(minPx, Math.round(Math.min(box.h, box.w) * 0.12));
  let counterW = 0;
  if (shown.more > 0) {
    const label = `+${shown.more}`;
    const tw = kit.measureTracked(g, label, { size: small, family: bold });
    const ph = Math.round(small * 1.35);
    counterW = Math.round(tw + small);
    const cx = box.x + box.w - counterW;
    g.fillStyle = color;
    g.beginPath();
    g.roundRect(cx, box.y, counterW, ph, ph / 2);
    g.fill();
    kit.drawTracked(g, label, cx + counterW / 2, box.y + ph * 0.5 + small * 0.36, { size: small, family: bold, color: '#0b0b0b', align: 'center' });
  }
  // Who published it and when, small in the bottom corner: "IGN · 14:05" on
  // one line if it is short, else the source over the time, cut to a fifth
  // of the panel so the title keeps its room.
  let sinceW = 0;
  const sinceSize = Math.max(minPx, Math.round(small * 0.8));
  const cornerFont = { size: sinceSize, family: regular, color: mixHex(bg, '#ffffff', 0.62) };
  const cornerMax = Math.round(box.w * (w / h >= 1.5 ? 0.2 : 0.9));
  let corner = [a.source && o.sinceText ? `${a.source} · ${o.sinceText}` : (a.source ?? o.sinceText)].filter((x): x is string => !!x);
  if (a.source && o.sinceText && kit.measureTracked(g, corner[0]!, cornerFont) > cornerMax) corner = [a.source, o.sinceText];
  corner = corner.map((line) => kit.truncate(g, line, cornerMax, cornerFont));
  corner.forEach((line, i) => {
    const y = box.y + box.h - (corner.length - 1 - i) * Math.round(sinceSize * 1.2);
    sinceW = Math.max(sinceW, kit.drawTracked(g, line, box.x + box.w, y, { ...cornerFont, align: 'right' }));
  });

  const wide = w / h >= 1.5;
  let col: { x: number; y: number; w: number; h: number };
  const iconSize = Math.round(wide ? Math.min(box.h * 0.78, box.w * 0.2) : Math.min(box.w * 0.4, box.h * 0.3));
  if (wide) {
    drawIcon(g, a, box.x, box.y + (box.h - iconSize) / 2, iconSize, color, bold);
    const gap = Math.round(iconSize * 0.3);
    const side = Math.max(counterW, sinceW);
    col = { x: box.x + iconSize + gap, y: box.y, w: box.w - iconSize - gap - (side ? side + gap / 2 : 0), h: box.h };
  } else {
    drawIcon(g, a, box.x + (box.w - iconSize) / 2, box.y, iconSize, color, bold);
    const gap = Math.round(iconSize * 0.15);
    const below = corner.length ? Math.round(sinceSize * (0.1 + 1.2 * corner.length)) : 0;
    col = { x: box.x, y: box.y + iconSize + gap, w: box.w, h: box.h - iconSize - gap - below };
  }
  const align = wide ? 'left' : 'center';
  const ax = wide ? col.x : col.x + col.w / 2;

  // The title as big as it fits on one line; on two if that would make it
  // small. A little smaller when the instruction (`detail`) comes too.
  const hasText = !!a.text;
  const hasDetail = !!a.detail;
  const lower = hasText && hasDetail ? 2 : hasText || hasDetail ? 1 : 0;
  let size = Math.round(col.h * [0.55, 0.4, 0.34][lower]!);
  const floor = Math.max(minPx * 2, Math.round(col.h * 0.2));
  size = kit.fitSize(g, a.title, col.w, { size, family: bold }, floor);
  let titleLines = [a.title];
  if (kit.measureTracked(g, a.title, { size, family: bold }) > col.w) {
    size = Math.max(minPx * 1.5, Math.round(col.h * [0.36, 0.27, 0.24][lower]!));
    titleLines = kit.wrapLines(g, a.title, col.w, 2, { size, family: bold });
  }
  const tLine = size * 1.08;
  // Under it, smaller: the text, then the detail in the level's colour, on
  // as many lines (up to 3 between both) as there is room for. The text
  // comes first; the detail gets what is left (at least a line when the
  // text takes one).
  const textSize = Math.max(minPx, Math.min(Math.round(size * 0.5), Math.round(size * 0.42 + minPx * 0.4)));
  const lineH = textSize * 1.25;
  const gapH = textSize * 0.4;
  const detailGap = hasText && hasDetail ? textSize * 0.25 : 0;
  const room = col.h - titleLines.length * tLine - gapH - detailGap;
  const fits = Math.max(1, Math.min(3, Math.floor(room / lineH)));
  const font = { size: textSize, family: regular };
  const textLines = hasText ? kit.wrapLines(g, a.text, col.w, hasDetail ? Math.max(1, fits - 1) : fits, font) : [];
  const detailLines = hasDetail ? kit.wrapLines(g, a.detail!, col.w, fits - textLines.length, font) : [];
  const lowerLines = textLines.length + detailLines.length;
  const blockH = titleLines.length * tLine + (lowerLines ? gapH + lowerLines * lineH + (textLines.length && detailLines.length ? detailGap : 0) : 0);
  let y = col.y + Math.max(0, (col.h - blockH) / 2);
  for (const line of titleLines) {
    kit.drawTracked(g, line, ax, y + size * 0.86, { size, family: bold, color: '#ffffff', align });
    y += tLine;
  }
  if (lowerLines) y += gapH;
  for (const line of textLines) {
    kit.drawTracked(g, line, ax, y + textSize * 0.95, { ...font, color: '#e4e4e7', align });
    y += lineH;
  }
  if (textLines.length && detailLines.length) y += detailGap;
  const detailColor = mixHex(color, '#ffffff', 0.45);
  for (const line of detailLines) {
    kit.drawTracked(g, line, ax, y + textSize * 0.95, { ...font, color: detailColor, align });
    y += lineH;
  }
  g.restore();
}

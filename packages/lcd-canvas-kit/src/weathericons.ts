/**
 * Weather icons, hand-drawn with canvas paths.
 *
 * Why drawn rather than taken from a font: the system fonts (DejaVu) do not
 * ship reliable weather glyphs (just as they ship no emoji, which is why text
 * drawing avoids them too), and an empty box in the middle of the panel is
 * worse than no icon at all. Drawing them takes a hundred lines and matches
 * the rest of the panel, whose other decorations are drawn as well.
 *
 * Every icon is painted inside a box of side `size` centred on (`cx`, `cy`),
 * so the caller only has to choose the centre.
 */
import { createCanvas, type Canvas, type SKRSContext2D } from '@napi-rs/canvas';
import type { IconKind, Moon } from '@loksly/weather-astro';

/** Cloud body: three lobes and a flat base. */
function cloud(ctx: SKRSContext2D, cx: number, cy: number, s: number): void {
  const r = s * 0.22;
  ctx.beginPath();
  ctx.arc(cx - s * 0.22, cy + s * 0.04, r, Math.PI * 0.5, Math.PI * 1.5);
  ctx.arc(cx - s * 0.06, cy - s * 0.14, r * 1.25, Math.PI, Math.PI * 1.85);
  ctx.arc(cx + s * 0.22, cy + s * 0.02, r * 0.95, Math.PI * 1.4, Math.PI * 0.5);
  ctx.closePath();
  ctx.fill();
}

function sun(ctx: SKRSContext2D, cx: number, cy: number, s: number, rays = true): void {
  const r = s * 0.19;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  if (!rays) return;
  ctx.lineWidth = Math.max(1.5, s * 0.045);
  ctx.lineCap = 'round';
  for (let i = 0; i < 8; i += 1) {
    const a = (i * Math.PI) / 4;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * r * 1.45, cy + Math.sin(a) * r * 1.45);
    ctx.lineTo(cx + Math.cos(a) * r * 1.95, cy + Math.sin(a) * r * 1.95);
    ctx.stroke();
  }
}

/**
 * Crescent moon: a disc with an offset disc subtracted from it.
 *
 * The cut-out is done on a **separate canvas** and then stamped. An earlier
 * version applied `destination-out` directly to the target canvas, and that
 * does not cut the moon: it punches a hole through everything underneath. On
 * the card's gradient it came out as a black disc, and on a photo it would
 * have been a bite taken out of the picture.
 */
function moon(ctx: SKRSContext2D, cx: number, cy: number, s: number): void {
  const r = s * 0.24;
  const pad = 2;
  const side = Math.ceil(r * 2 + pad * 2);
  const off = createCanvas(side, side) as Canvas;
  const o = off.getContext('2d');
  const c = side / 2;

  o.fillStyle = ctx.fillStyle as string;
  o.beginPath();
  o.arc(c, c, r, 0, Math.PI * 2);
  o.fill();

  // Fine here: the canvas is otherwise empty, so only the moon gets cut.
  o.globalCompositeOperation = 'destination-out';
  o.beginPath();
  o.arc(c + r * 0.55, c - r * 0.42, r * 0.92, 0, Math.PI * 2);
  o.fill();

  ctx.drawImage(off, cx - c, cy - c);
}

/** Drops or streaks under the cloud. `len` stretches them: short for drizzle, long for rain. */
function drops(ctx: SKRSContext2D, cx: number, cy: number, s: number, len: number): void {
  ctx.lineWidth = Math.max(1.5, s * 0.05);
  ctx.lineCap = 'round';
  for (const dx of [-0.2, 0, 0.2]) {
    ctx.beginPath();
    ctx.moveTo(cx + s * dx + s * 0.05, cy + s * 0.22);
    ctx.lineTo(cx + s * dx - s * 0.02, cy + s * (0.22 + len));
    ctx.stroke();
  }
}

function snowflakes(ctx: SKRSContext2D, cx: number, cy: number, s: number): void {
  ctx.lineWidth = Math.max(1.2, s * 0.035);
  ctx.lineCap = 'round';
  for (const dx of [-0.2, 0.05]) {
    const x = cx + s * dx;
    const y = cy + s * 0.3;
    for (let i = 0; i < 3; i += 1) {
      const a = (i * Math.PI) / 3;
      ctx.beginPath();
      ctx.moveTo(x - Math.cos(a) * s * 0.07, y - Math.sin(a) * s * 0.07);
      ctx.lineTo(x + Math.cos(a) * s * 0.07, y + Math.sin(a) * s * 0.07);
      ctx.stroke();
    }
  }
}

function bolt(ctx: SKRSContext2D, cx: number, cy: number, s: number): void {
  ctx.beginPath();
  ctx.moveTo(cx + s * 0.06, cy + s * 0.16);
  ctx.lineTo(cx - s * 0.1, cy + s * 0.34);
  ctx.lineTo(cx + s * 0.01, cy + s * 0.34);
  ctx.lineTo(cx - s * 0.06, cy + s * 0.5);
  ctx.lineTo(cx + s * 0.14, cy + s * 0.28);
  ctx.lineTo(cx + s * 0.03, cy + s * 0.28);
  ctx.closePath();
  ctx.fill();
}

function fogLines(ctx: SKRSContext2D, cx: number, cy: number, s: number): void {
  ctx.lineWidth = Math.max(1.5, s * 0.055);
  ctx.lineCap = 'round';
  for (const [i, w] of [0.34, 0.4, 0.28].entries()) {
    const y = cy + s * (0.2 + i * 0.13);
    ctx.beginPath();
    ctx.moveTo(cx - s * w, y);
    ctx.lineTo(cx + s * w, y);
    ctx.stroke();
  }
}

/**
 * Paints the weather icon.
 *
 * `color` is used for both fill and stroke: these are single-ink icons, which
 * is what holds up well over a background photo with a dimming veil on top.
 */
export function drawWeatherIcon(
  ctx: SKRSContext2D,
  kind: IconKind,
  cx: number,
  cy: number,
  size: number,
  color: string,
): void {
  ctx.save();
  ctx.fillStyle = color;
  ctx.strokeStyle = color;

  switch (kind) {
    case 'sun':
      sun(ctx, cx, cy, size);
      break;
    case 'moon':
      moon(ctx, cx, cy, size);
      break;
    case 'sun-cloud':
      sun(ctx, cx - size * 0.16, cy - size * 0.18, size * 0.72);
      cloud(ctx, cx + size * 0.06, cy + size * 0.1, size);
      break;
    case 'moon-cloud':
      moon(ctx, cx - size * 0.16, cy - size * 0.2, size * 0.72);
      cloud(ctx, cx + size * 0.06, cy + size * 0.1, size);
      break;
    case 'cloud':
      cloud(ctx, cx, cy, size);
      break;
    case 'fog':
      cloud(ctx, cx, cy - size * 0.12, size * 0.9);
      fogLines(ctx, cx, cy, size);
      break;
    case 'drizzle':
      cloud(ctx, cx, cy - size * 0.1, size);
      drops(ctx, cx, cy - size * 0.1, size, 0.14);
      break;
    case 'rain':
      cloud(ctx, cx, cy - size * 0.12, size);
      drops(ctx, cx, cy - size * 0.12, size, 0.26);
      break;
    case 'snow':
      cloud(ctx, cx, cy - size * 0.14, size);
      snowflakes(ctx, cx, cy - size * 0.14, size);
      break;
    case 'storm':
      cloud(ctx, cx, cy - size * 0.14, size);
      bolt(ctx, cx, cy - size * 0.14, size);
      break;
  }
  ctx.restore();
}

/**
 * The moon in its actual phase: the lit disc minus the shadowed part.
 *
 * The shadow is bounded by two curves: the **limb** (the half circle on the
 * dark side) and the **terminator**, which seen face-on projects as a half
 * ellipse with horizontal semi-axis `R·(1−2k)`, where `k` is the illuminated
 * fraction. That semi-axis is signed, and that is the whole trick:
 *
 *   - `k < 0.5` → positive: the terminator falls on the lit side and the
 *     shadow goes past the centre, which is what a thin crescent looks like.
 *   - `k > 0.5` → negative: it moves into the dark side and the shadow is left
 *     as a thin sliver, which is a gibbous moon.
 *
 * It is traced as a polygon instead of with `ellipse()` because the sweep
 * direction of the arcs changes with the sign of the semi-axis and ends up as
 * code full of flags; with parametric points the same loop works for all
 * eight phases.
 *
 * The cut-out also goes on a separate canvas, for the same reason as the
 * simple moon: on the target canvas `destination-out` would punch through the
 * background.
 */
export function drawMoonPhase(
  ctx: SKRSContext2D,
  moon: Moon,
  cx: number,
  cy: number,
  size: number,
  color: string,
): void {
  const r = size / 2;
  const pad = 2;
  const side = Math.ceil(size + pad * 2);
  const off = createCanvas(side, side) as Canvas;
  const o = off.getContext('2d');
  const c = side / 2;

  // Full disc, plus a faint ring so that an almost-new moon does not vanish.
  o.fillStyle = color;
  o.beginPath();
  o.arc(c, c, r, 0, Math.PI * 2);
  o.fill();

  const f = 1 - 2 * moon.illumination;
  // In the northern hemisphere a waxing moon is lit from the right.
  const dark = moon.waxing ? -1 : 1;
  const STEPS = 48;

  o.globalCompositeOperation = 'destination-out';
  o.beginPath();
  for (let i = 0; i <= STEPS; i += 1) {
    const u = (i / STEPS) * Math.PI;
    o.lineTo(c + dark * r * Math.sin(u), c - r * Math.cos(u));
  }
  for (let i = STEPS; i >= 0; i -= 1) {
    const u = (i / STEPS) * Math.PI;
    o.lineTo(c - dark * r * f * Math.sin(u), c - r * Math.cos(u));
  }
  o.closePath();
  o.fill();

  ctx.save();
  ctx.drawImage(off, cx - c, cy - c);
  // Ring around the whole disc: without it, a new moon would be an invisible
  // hole, indistinguishable from "nothing was drawn here".
  ctx.strokeStyle = 'rgba(255,255,255,0.22)';
  ctx.lineWidth = Math.max(1, size * 0.02);
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

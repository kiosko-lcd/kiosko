/**
 * The cat-mode room: wall, window with the real sky,
 * shelf, lamp and parquet floor.
 *
 * The background is painted once and cached (see `render.ts`); it only changes when
 * the sky does, so it depends on the rounded hour and on the weather
 * code, never on the exact minute. What does change every minute (the
 * wall clock's hands) is kept apart, in `wallClock`.
 */
import { moonPhase } from '@loksly/weather-astro';
import { drawMoonPhase } from '@loksly/lcd-canvas-kit';
import { HORIZON } from './layout.ts';
import { type X, TAU, clamp, css, ellipse, hex, linear, mix, radial, rng, smooth } from './paint.ts';

export interface Sky {
  /** Local time with decimals, 0..24. */
  hour: number;
  /** WMO weather code (0 = clear). */
  code: number;
  /** Instant, for the moon phase. */
  now: number;
  /** Today's sunrise and sunset (see sun.ts); without them, fixed hours. */
  rise?: number;
  set?: number;
}

/** The ones from before the sun was computed: any September in Murcia. */
const RISE = 7.4;
const SET = 20.2;
const riseOf = (s: Sky) => s.rise ?? RISE;
const setOf = (s: Sky) => s.set ?? SET;

/**
 * Sky by hour: [hour, top, horizon], interpolated between keys. The
 * keys are anchored to sunrise and sunset: dawn starts a bit before
 * the sun rises and night closes a while after it sets, whatever the
 * time of year.
 */
function skyKeys(rise: number, set: number): [number, string, string][] {
  return [
    [0, '#070C22', '#18234A'], [rise - 1.1, '#101838', '#3A3560'], [rise - 0.2, '#3A4E8C', '#F2A070'], [rise + 1.1, '#5D9AD8', '#CDE4F4'],
    [set - 2.4, '#5A96D6', '#D6E8F2'], [set - 1.0, '#4A64A8', '#F7B26A'], [set, '#2A2E66', '#D2685A'], [set + 1.0, '#0E1434', '#2E2A58'],
    [24, '#070C22', '#18234A'],
  ];
}

function skyAt(s: Sky): [string, string] {
  const SKY = skyKeys(riseOf(s), setOf(s));
  const h = s.hour;
  let i = 0;
  while (i < SKY.length - 2 && SKY[i + 1]![0] <= h) i++;
  const [h0, a0, b0] = SKY[i]!, [h1, a1, b1] = SKY[i + 1]!;
  const t = clamp((h - h0) / (h1 - h0));
  return [css(mix(hex(a0), hex(a1), t)), css(mix(hex(b0), hex(b1), t))];
}

/** Daylight: 0 dead of night, 1 full day. */
export function daylight(hour: number, rise = RISE, set = SET): number {
  return clamp(Math.min(smooth(rise - 0.8, rise + 1.2, hour), 1 - smooth(set - 1.0, set + 0.8, hour)));
}

/** Background cache key: the sky changes slowly, in 10-minute steps. */
export function skyKey(s: Sky): string {
  const moon = Math.round(moonPhase(s.now).phase * 16);
  return `${Math.floor(s.hour * 6)}|${s.code}|${moon}|${riseOf(s).toFixed(1)}|${setOf(s).toFixed(1)}`;
}

/** Where the sea horizon sits, as a fraction of the view's height. */
const SEA_AT = 0.52;

/**
 * The sea up to the horizon, with the reflection of the sun or moon and tiny
 * waves; with `pool`, the infinity pool's sheet of water in front.
 */
function sea(c: X, s: Sky, x: number, y: number, w: number, h: number, pool: boolean): void {
  const DL = daylight(s.hour, riseOf(s), setOf(s));
  const hy = y + h * SEA_AT;
  const bad = s.code >= 45;
  const deep = css(mix(hex('#0A1428'), hex(bad ? '#4A6070' : '#1E6FA8'), DL));
  const near = css(mix(hex('#10203A'), hex(bad ? '#5A7888' : '#3FB8C8'), DL));
  c.fillStyle = linear(c, 0, hy, 0, y + h, [[0, deep], [1, near]]);
  c.fillRect(x, hy, w, y + h - hy);
  // Horizon glow and reflection of the heavenly body: little horizontal streaks below it.
  c.fillStyle = `rgba(255,255,255,${0.25 + 0.2 * DL})`;
  c.fillRect(x, hy - 1, w, 2);
  const day = s.hour > riseOf(s) - 0.3 && s.hour < setOf(s) + 0.3;
  const t = day ? (s.hour - riseOf(s)) / (setOf(s) - riseOf(s)) : clamp(((s.hour < 12 ? s.hour + 24 : s.hour) - setOf(s) - 0.8) / (24 - (setOf(s) - riseOf(s)) - 1.6));
  const gx = x + 20 + clamp(t) * (w - 40);
  const r = rng(23);
  if (!bad) {
    for (let i = 0; i < 26; i++) {
      const yy = hy + 4 + r() * (y + h - hy - 6), spread = 8 + (yy - hy) * 0.5;
      c.fillStyle = day ? `rgba(255,236,190,${0.5 + r() * 0.4})` : `rgba(230,236,255,${0.35 + r() * 0.3})`;
      c.fillRect(gx + (r() - 0.5) * spread * 2, yy, 6 + r() * 14, 2);
    }
  }
  // Tiny waves: little white arcs that splash the water.
  c.strokeStyle = `rgba(255,255,255,${0.35 + 0.35 * DL})`;
  c.lineWidth = 1.5;
  for (let i = 0; i < Math.round(w / 12); i++) {
    const yy = hy + 6 + Math.pow(r(), 1.5) * (y + h - hy - 8), sz = 2 + ((yy - hy) / (h * (1 - SEA_AT))) * 7;
    const xx = x + r() * w;
    c.beginPath();
    c.arc(xx, yy + sz, sz, Math.PI * 1.15, Math.PI * 1.85);
    c.stroke();
  }
  if (pool) {
    // Infinity pool: a turquoise sheet in the foreground whose edge
    // blends into the sea; sparkles in the background and a sun lounger on each side.
    const py = y + h * 0.8;
    c.fillStyle = linear(c, 0, py, 0, y + h, [[0, css(mix(hex('#12304A'), hex('#5ED6E0'), DL))], [1, css(mix(hex('#0E2640'), hex('#2AA8C8'), DL))]]);
    c.fillRect(x, py, w, y + h - py);
    c.fillStyle = `rgba(255,255,255,${0.35 + 0.3 * DL})`;
    c.fillRect(x, py, w, 2);
    c.strokeStyle = `rgba(230,255,255,${0.25 + 0.3 * DL})`;
    c.lineWidth = 1.5;
    for (let i = 0; i < Math.round(w / 30); i++) {
      const xx = x + r() * w, yy = py + 6 + r() * (y + h - py - 8);
      c.beginPath();
      c.moveTo(xx, yy);
      c.quadraticCurveTo(xx + 6, yy - 3, xx + 12, yy);
      c.stroke();
    }
    // At night, the pool lit from within.
    if (DL < 0.5) {
      c.fillStyle = `rgba(80,220,255,${0.35 * (1 - DL * 2)})`;
      c.fillRect(x, py + 2, w, y + h - py - 2);
    }
  }
}

/** Window position, shared with the windowsill in `layout.ts`. */
export const WINDOW = { x: 548, y: 28, w: 324, h: 206 };

/**
 * What is seen through the window: the usual city or the sea. With `pool`, in the
 * foreground the edge of an infinity pool that melts into it.
 */
function windowScene(c: X, s: Sky, x: number, y: number, w: number, h: number, view: View = 'ciudad', pool = false): void {
  const DL = daylight(s.hour, riseOf(s), setOf(s));
  const RISE = riseOf(s), SET = setOf(s);
  const code = s.code;
  c.save();
  c.beginPath();
  c.rect(x, y, w, h);
  c.clip();
  const [top, hor] = skyAt(s);
  const bad = code >= 45; // fog, rain, snow, storm: grey sky
  c.fillStyle = linear(c, 0, y, 0, y + h, [[0, top], [1, hor]]);
  c.fillRect(x, y, w, h);
  if (bad) {
    c.fillStyle = `rgba(110,118,130,${0.35 + DL * 0.3})`;
    c.fillRect(x, y, w, h);
  }
  const r = rng(3);
  for (let i = 0; i < 50; i++) {
    const a = (1 - DL) * (bad ? 0.2 : 1) * (0.3 + r() * 0.7);
    c.fillStyle = `rgba(255,255,255,${a})`;
    c.fillRect(x + r() * w, y + r() * h * 0.6, 2, 2);
  }
  // Sun in an arc from sunrise to sunset; at night, the moon in its real phase
  if (s.hour > RISE - 0.3 && s.hour < SET + 0.3) {
    const t = (s.hour - RISE) / (SET - RISE);
    // Over the sea, the sun rises and sets on the horizon.
    const ground = view === 'mar' ? y + h * SEA_AT : y + h * 0.78;
    const sx = x + 20 + t * (w - 40), sy = ground - Math.sin(clamp(t) * Math.PI) * (ground - y) * 0.8;
    const low = 1 - Math.sin(clamp(t) * Math.PI);
    const core = css(mix(hex('#FFF6D8'), hex('#FFB060'), low));
    c.fillStyle = radial(c, sx, sy, 4, 70, [[0, core], [0.25, 'rgba(255,220,150,0.5)'], [1, 'rgba(255,200,120,0)']]);
    ellipse(c, sx, sy, 70, 70);
    c.fill();
    c.fillStyle = core;
    ellipse(c, sx, sy, 18, 18);
    c.fill();
  } else {
    // The moon crosses the window from dusk to dawn for real.
    const hh = s.hour < 12 ? s.hour + 24 : s.hour;
    const dusk = SET + 0.8, dawn = RISE + 24 - 0.8;
    const t = clamp((hh - dusk) / (dawn - dusk));
    const mx = x + 30 + t * (w - 60), my = y + h * 0.6 - Math.sin(t * Math.PI) * h * 0.42;
    c.fillStyle = radial(c, mx, my, 6, 60, [[0, 'rgba(255,248,220,0.35)'], [1, 'rgba(255,248,220,0)']]);
    ellipse(c, mx, my, 60, 60);
    c.fill();
    drawMoonPhase(c, moonPhase(s.now), mx, my, 44, '#FFF6DC');
  }
  // Clouds according to the WMO code
  const nClouds = code === 0 ? 0 : code === 1 ? 1 : code === 2 ? 2 : 4;
  const cloudCol = mix(hex('#3A4260'), hex(bad ? '#B8C0CC' : '#FFFFFF'), 0.25 + DL * 0.75);
  for (let k = 0; k < nClouds; k++) {
    const cx = x + 40 + ((k * 97 + 30) % (w - 60)), cy = y + 30 + (k % 2) * 34;
    for (const [dx, dy, rr] of [[0, 0, 22], [24, -10, 28], [52, 0, 20], [26, 8, 22]] as const) {
      c.fillStyle = radial(c, cx + dx, cy + dy, 2, rr, [[0, css(cloudCol)], [1, css(mix(cloudCol, hex('#8090A8'), 0.35))]], cx + dx - 6, cy + dy - 8);
      ellipse(c, cx + dx, cy + dy, rr, rr * 0.8);
      c.fill();
    }
  }
  if (view === 'mar') sea(c, s, x, y, w, h, pool);
  if (view === 'hielo') iceView(c, DL, x, y, w, h);
  if (view === 'dunas') duneView(c, DL, x, y, w, h);
  if (view === 'bosque') forestView(c, DL, x, y, w, h);
  // City: silhouettes, with lit windows only when it gets dark
  const rb = rng(9);
  const bcol = css(mix(hex('#141B2E'), hex('#7C8CA2'), DL * 0.8));
  for (let i = 0; i < (view === 'ciudad' ? 15 : 0); i++) {
    const bx = x + i * 22, bh = 30 + rb() * 50;
    c.fillStyle = bcol;
    c.fillRect(bx, y + h - bh, 20, bh);
    for (const [ox, oy] of [[5, 8], [12, 18], [5, 28]] as const) {
      if (rb() > 0.45) {
        c.fillStyle = `rgba(255,210,120,${(1 - DL) * 0.85})`;
        c.fillRect(bx + ox, y + h - bh + oy, 3, 3);
      }
    }
  }
  if ((code >= 51 && code < 70) || (code >= 80 && code < 90)) {
    c.strokeStyle = 'rgba(190,210,235,0.7)';
    c.lineWidth = 1.5;
    for (let i = 0; i < 70; i++) {
      const px = x + r() * w, py = y + r() * h;
      c.beginPath();
      c.moveTo(px, py);
      c.lineTo(px - 4, py + 12);
      c.stroke();
    }
  }
  if (code >= 71 && code < 78) {
    c.fillStyle = 'rgba(255,255,255,0.9)';
    for (let i = 0; i < 70; i++) {
      ellipse(c, x + r() * w, y + r() * h, 2.2, 2.2);
      c.fill();
    }
  }
  if (code === 45 || code === 48) {
    c.fillStyle = 'rgba(210,215,222,0.55)';
    c.fillRect(x, y + h * 0.35, w, h * 0.65);
  }
  if (code >= 95) {
    c.fillStyle = 'rgba(30,34,48,0.45)';
    c.fillRect(x, y, w, h);
    c.strokeStyle = '#FFF3A0';
    c.lineWidth = 3;
    c.beginPath();
    c.moveTo(x + w * 0.6, y);
    c.lineTo(x + w * 0.55, y + 50);
    c.lineTo(x + w * 0.62, y + 55);
    c.lineTo(x + w * 0.52, y + 120);
    c.stroke();
  }
  c.restore();
}

/** What is seen in the distance: the city, the sea, or the landscape of the outdoor rooms. */
type View = 'ciudad' | 'mar' | 'hielo' | 'dunas' | 'bosque';

/** A mountain range: random peaks (seeded) over the base `base`. */
function ridge(c: X, x: number, w: number, base: number, rise: number, step: number, seed: number, fill: string | ReturnType<typeof linear>): number[] {
  const r = rng(seed);
  const peaks: number[] = [];
  c.fillStyle = fill;
  c.beginPath();
  c.moveTo(x, base);
  for (let px = x; px <= x + w + step; px += step) {
    const py = base - rise * (0.35 + 0.65 * r());
    peaks.push(py);
    c.lineTo(px, py);
  }
  c.lineTo(x + w + step, base);
  c.closePath();
  c.fill();
  return peaks;
}

/**
 * Antarctica in the distance: austral aurora at night and icy mountains with their
 * side in shadow.
 */
function iceView(c: X, DL: number, x: number, y: number, w: number, h: number): void {
  const night = 1 - DL;
  if (night > 0.3) {
    // Aurora: green curtains rippling across the width, more intense the darker the night.
    const a = (night - 0.3) / 0.7;
    for (let px = x; px < x + w; px += 5) {
      const top = y + h * (0.12 + 0.1 * Math.sin(px * 0.006) + 0.05 * Math.sin(px * 0.021 + 1));
      const len = h * (0.22 + 0.12 * Math.sin(px * 0.013 + 2));
      c.fillStyle = linear(c, 0, top, 0, top + len, [[0, 'rgba(120,255,190,0)'], [0.6, `rgba(90,240,170,${0.32 * a})`], [1, 'rgba(90,240,170,0)']]);
      c.fillRect(px, top, 4, len);
      if (Math.sin(px * 0.05) > 0.7) {
        c.fillStyle = `rgba(200,120,255,${0.12 * a})`;
        c.fillRect(px, top - len * 0.25, 4, len * 0.3);
      }
    }
  }
  const base = y + h;
  const far = css(mix(hex('#1A2236'), hex('#C9D8EA'), DL));
  ridge(c, x, w, base, h * 0.42, 70, 501, far);
  const snow = linear(c, 0, base - h * 0.35, 0, base, [[0, css(mix(hex('#2A3450'), hex('#FFFFFF'), DL))], [1, css(mix(hex('#1E2840'), hex('#B8CCE2'), DL))]]);
  const peaks = ridge(c, x, w, base, h * 0.3, 110, 502, snow);
  // The shadowed side of each peak.
  c.fillStyle = `rgba(60,90,140,${0.18 + 0.12 * DL})`;
  peaks.forEach((py, i) => {
    const px = x + i * 110;
    c.beginPath();
    c.moveTo(px, py);
    c.lineTo(px + 55, base);
    c.lineTo(px + 110, base);
    c.closePath();
    c.fill();
  });
}

/** The desert in the distance: Milky Way at night, a mesa and layered dunes. */
function duneView(c: X, DL: number, x: number, y: number, w: number, h: number): void {
  const night = 1 - DL;
  if (night > 0.3) {
    // No lights for miles: the sky fills with stars and a milky band.
    const r = rng(611);
    const a = (night - 0.3) / 0.7;
    for (let i = 0; i < 260; i++) {
      const px = x + r() * w, py = y + r() * h * 0.75;
      c.fillStyle = `rgba(255,255,255,${a * (0.2 + 0.6 * r())})`;
      c.fillRect(px, py, r() < 0.1 ? 2 : 1, r() < 0.1 ? 2 : 1);
    }
    for (let i = 0; i < 18; i++) {
      const t = i / 17, px = x + t * w, py = y + h * (0.65 - 0.5 * t);
      c.fillStyle = radial(c, px, py, 0, 70, [[0, `rgba(210,210,255,${0.07 * a})`], [1, 'rgba(210,210,255,0)']]);
      c.fillRect(px - 70, py - 70, 140, 140);
    }
  }
  const base = y + h;
  // A mesa on the right, with straight edges.
  c.fillStyle = css(mix(hex('#2A1E24'), hex('#C98A5E'), DL));
  c.beginPath();
  c.moveTo(x + w * 0.66, base);
  c.lineTo(x + w * 0.69, base - h * 0.3);
  c.lineTo(x + w * 0.8, base - h * 0.32);
  c.lineTo(x + w * 0.83, base);
  c.fill();
  const layers: [number, string, string][] = [[0.22, '#2E2230', '#E2B588'], [0.14, '#3A2A2A', '#D99C62'], [0.07, '#4A3428', '#E7AC6C']];
  layers.forEach(([amp, n, d], k) => {
    c.fillStyle = css(mix(hex(n), hex(d), DL));
    c.beginPath();
    c.moveTo(x, base);
    for (let px = x; px <= x + w; px += 12) c.lineTo(px, base - h * amp * (0.6 + 0.4 * Math.sin(px * (0.004 + k * 0.002) + k * 2)));
    c.lineTo(x + w, base);
    c.closePath();
    c.fill();
  });
}

/** The forest in the distance: layered firs, bluer the farther away, and haze. */
function forestView(c: X, DL: number, x: number, y: number, w: number, h: number): void {
  const base = y + h;
  const layers: [number, number, string, string, number][] = [[0.5, 26, '#141C24', '#6E8C86', 701], [0.38, 34, '#10181A', '#3E6A50', 702], [0.26, 44, '#0C1410', '#2A5236', 703]];
  for (const [tall, step, n, d, seed] of layers) {
    const r = rng(seed);
    c.fillStyle = css(mix(hex(n), hex(d), DL));
    for (let px = x - step; px < x + w + step; px += step * (0.6 + 0.5 * r())) {
      const th = h * tall * (0.7 + 0.5 * r()), half = step * 0.55;
      c.beginPath();
      c.moveTo(px, base - th);
      c.lineTo(px + half, base);
      c.lineTo(px - half, base);
      c.closePath();
      c.fill();
    }
    c.fillStyle = `rgba(220,230,235,${0.06 + 0.06 * DL})`;
    c.fillRect(x, base - h * tall * 0.4, w, h * tall * 0.4);
  }
}

/** Where the lamp and the clock hang: proportional to the panel width. */
export const lampX = (W: number) => Math.round(W * 0.615);
export const clockPos = (W: number) => ({ x: Math.round(W * 0.73), y: 84, r: 40 });

// ---------- Room repertoire ----------
/**
 * The rooms cat mode rotates through, one per day. All of them
 * respect the same fixed points, because the gestures count on them: the
 * window (`WINDOW`) and its windowsill, the lamp hung at `lampX` at height 64
 * (the LGTM cat hangs from it), the furniture on the left with the top shelf
 * at 40 (one sleeps there) and the plant next to it. Everything else changes.
 */
export const ROOMS = ['estudio', 'cocina', 'cabana', 'atico', 'oficina', 'japonesa', 'acuario', 'arcade', 'ventanal', 'playa', 'espacio', 'antartida', 'desierto', 'bosque'] as const;
export type RoomName = (typeof ROOMS)[number];

/** Today's room: it changes at midnight and runs through the whole repertoire. */
export function roomFor(now: number): RoomName {
  const d = new Date(now);
  const day = Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000);
  return ROOMS[((day % ROOMS.length) + ROOMS.length) % ROOMS.length]!;
}

/** The one chosen in the config (`scene.room`), or today's if it is "rotate" or does not exist. */
export function resolveRoom(setting: string | undefined, now: number): RoomName {
  return (ROOMS as readonly string[]).includes(setting ?? '') ? (setting as RoomName) : roomFor(now);
}

interface Theme {
  /** Wall: top and bottom, by day; at night it darkens by itself. */
  wall: [string, string];
  frame: string;
  sill: string;
  curtains?: string;
  lamp: 'aplique' | 'colgante' | 'farol' | 'papel' | 'neon';
  floor: 'tarima' | 'baldosa' | 'moqueta' | 'tatami' | 'tablones' | 'oscuro';
  floorColors: [string, string];
}

const THEMES: Record<RoomName, Theme> = {
  estudio: { wall: ['#4A5266', '#5E6478'], frame: '#5E4630', sill: '#7A5A3C', lamp: 'aplique', floor: 'tarima', floorColors: ['#3E2C1E', '#6E4E32'] },
  cocina: { wall: ['#E8DCC4', '#D8C8A8'], frame: '#F4F0E6', sill: '#E4DCCB', curtains: '#D9534F', lamp: 'colgante', floor: 'baldosa', floorColors: ['#2A2A30', '#E8E4DA'] },
  cabana: { wall: ['#6B4A2B', '#7A5634'], frame: '#3E2A18', sill: '#4A3220', curtains: '#8C2F2F', lamp: 'farol', floor: 'tablones', floorColors: ['#4A301C', '#7A5230'] },
  atico: { wall: ['#7D8FA8', '#9AA8BC'], frame: '#E8ECF2', sill: '#DDE3EA', curtains: '#F2D98A', lamp: 'colgante', floor: 'moqueta', floorColors: ['#5A3E5E', '#7A5A7E'] },
  oficina: { wall: ['#B8C0C8', '#C8CED4'], frame: '#3A4250', sill: '#4A5260', lamp: 'colgante', floor: 'moqueta', floorColors: ['#3A4452', '#56606E'] },
  japonesa: { wall: ['#E8DFC8', '#DCD2B8'], frame: '#5A3A22', sill: '#6A4A2E', lamp: 'papel', floor: 'tatami', floorColors: ['#A8A060', '#C8C080'] },
  acuario: { wall: ['#2E5A62', '#3A6E76'], frame: '#E8ECF2', sill: '#D8DEE6', curtains: '#F4F0E6', lamp: 'colgante', floor: 'baldosa', floorColors: ['#3A6E76', '#5A8E96'] },
  arcade: { wall: ['#1E1A2E', '#2A2440'], frame: '#14121E', sill: '#221E30', lamp: 'neon', floor: 'oscuro', floorColors: ['#141220', '#2A2640'] },
  ventanal: { wall: ['#EEF0F2', '#E2E6EA'], frame: '#3A3F48', sill: '#F4F4F2', curtains: '#F8F6F0', lamp: 'colgante', floor: 'baldosa', floorColors: ['#D8D4CC', '#ECE8E0'] },
  espacio: { wall: ['#000000', '#000000'], frame: '#000000', sill: '#000000', lamp: 'aplique', floor: 'moqueta', floorColors: ['#000000', '#000000'] },
  playa: { wall: ['#000000', '#000000'], frame: '#000000', sill: '#000000', lamp: 'farol', floor: 'moqueta', floorColors: ['#E8D2A0', '#F4E4BC'] },
  // Outdoors, like the beach: painted whole in their own function.
  antartida: { wall: ['#000000', '#000000'], frame: '#000000', sill: '#000000', lamp: 'farol', floor: 'moqueta', floorColors: ['#DDE8F2', '#F6FAFE'] },
  desierto: { wall: ['#000000', '#000000'], frame: '#000000', sill: '#000000', lamp: 'farol', floor: 'moqueta', floorColors: ['#D9A066', '#EBC08A'] },
  bosque: { wall: ['#000000', '#000000'], frame: '#000000', sill: '#000000', lamp: 'farol', floor: 'moqueta', floorColors: ['#3E5A2A', '#5E7A3A'] },
};

/** The big window: almost the whole back wall, between the furniture and the clock. */
export const GLASS = { x: 392, y: 18, w: 938, h: 214 };

/** Full background, with nothing that changes minute to minute. */
export function paintRoom(c: X, W: number, H: number, s: Sky, room: RoomName = 'estudio', notOnFriday = '(el viernes no)'): void {
  if (room === 'playa') return paintBeach(c, W, H, s);
  if (room === 'espacio') return paintSpace(c, W, H, s);
  if (room === 'antartida') return paintAntarctica(c, W, H, s);
  if (room === 'desierto') return paintDesert(c, W, H, s);
  if (room === 'bosque') return paintForest(c, W, H, s);
  const T = THEMES[room];
  const DL = daylight(s.hour, riseOf(s), setOf(s));
  const RISE = riseOf(s), SET = setOf(s);
  // At night the wall loses color: it blends with a very dark blue.
  const night = (col: string, k = 0.45) => css(mix(hex(col), hex('#141828'), (1 - DL) * k));
  c.fillStyle = linear(c, 0, 0, 0, HORIZON, [[0, night(T.wall[0])], [1, night(T.wall[1])]]);
  c.fillRect(0, 0, W, HORIZON);
  wallPattern(c, room, W, DL);
  const lx = lampX(W);
  const warm = room === 'arcade' ? '190,90,255' : '255,200,130';
  if (room !== 'ventanal') decor(c, room, W, DL, notOnFriday);

  // Window (or big window): the opening the daylight comes in through.
  const { x: wx, y: wy, w: ww, h: wh } = room === 'ventanal' ? GLASS : WINDOW;
  if (room === 'ventanal') {
    c.fillStyle = T.frame;
    c.fillRect(wx - 6, wy - 6, ww + 12, wh + 12);
    windowScene(c, s, wx, wy, ww, wh, 'mar', true);
    c.fillStyle = T.frame;
    for (let i = 1; i < 4; i++) c.fillRect(wx + (ww * i) / 4 - 3, wy, 6, wh);
    // Low wall under the glass: it serves as the windowsill.
    c.fillStyle = T.sill;
    c.fillRect(wx - 10, 226, ww + 20, 14);
    c.fillStyle = 'rgba(0,0,0,0.12)';
    c.fillRect(wx - 10, 238, ww + 20, 2);
  } else {
  c.fillStyle = T.frame;
  c.fillRect(wx, wy, ww, wh);
  windowScene(c, s, wx + 12, wy + 12, ww - 24, wh - 26);
  c.fillStyle = T.frame;
  c.fillRect(wx + ww / 2 - 4, wy + 12, 8, wh - 26);
  c.fillRect(wx + 12, wy + 98, ww - 24, 8);
  if (room === 'japonesa') {
    // Thin wooden lattice, like an open shoji.
    c.fillStyle = T.frame;
    for (let i = 1; i < 4; i++) c.fillRect(wx + 12 + ((ww - 24) * i) / 4 - 2, wy + 12, 4, wh - 26);
  }
  c.fillStyle = 'rgba(255,255,255,0.06)';
  c.beginPath();
  c.moveTo(wx + 32, wy + 12);
  c.lineTo(wx + 92, wy + 12);
  c.lineTo(wx + 32, wy + 82);
  c.fill();
  c.fillStyle = T.sill;
  c.fillRect(wx - 10, wy + wh - 8, ww + 20, 14);
  }
  if (T.curtains) curtains(c, T.curtains, DL, { x: wx, y: wy, w: ww, h: wh });

  leftFurniture(c, room, DL);

  // Baseboard and floor with perspective
  c.fillStyle = room === 'cocina' || room === 'acuario' ? '#8A9098' : room === 'japonesa' ? '#5A3A22' : '#12161F';
  c.fillRect(0, HORIZON - 12, W, 12);
  floor(c, T, W, H);
  rug(c, room, W, H);
  plant(c, room);
  // Dimness: at night, everything (except the glass) loses light. What lights up
  // by itself (the lamp, the fire, the screens) is painted afterwards, on top.
  if (DL < 1) {
    c.fillStyle = `rgba(10,14,30,${0.42 * (1 - DL)})`;
    c.beginPath();
    c.rect(0, 0, W, H);
    c.rect(wx + 12, wy + 12, ww - 24, wh - 26);
    c.fill('evenodd');
  }
  c.fillStyle = radial(c, lx, 70, 10, 420, [[0, `rgba(${warm},${0.3 * (1 - DL) + 0.05})`], [1, `rgba(${warm},0)`]]);
  c.fillRect(lx - 480, 0, 960, HORIZON);
  c.fillStyle = radial(c, lx, 330, 10, 380, [[0, `rgba(${warm},${0.18 * (1 - DL) + 0.03})`], [1, `rgba(${warm},0)`]]);
  c.fillRect(lx - 480, HORIZON, 960, H - HORIZON);
  lamp(c, T.lamp, lx);
  emissive(c, room, W, DL);
  // Beam of sun coming in through the window, shifting with the hour
  if (DL > 0 && s.hour > RISE && s.hour < SET && s.code < 45) {
    const t = (s.hour - RISE) / (SET - RISE);
    const shift = (0.5 - t) * 700;
    c.fillStyle = `rgba(255,226,160,${0.16 * DL})`;
    c.beginPath();
    c.moveTo(wx + 12, HORIZON);
    c.lineTo(wx + ww - 12, HORIZON);
    c.lineTo(wx + ww - 12 + shift + 160, H);
    c.lineTo(wx + 12 + shift - 60, H);
    c.closePath();
    c.fill();
  }
  // At night, the moon: a cold beam that crosses the parquet with it, as strong
  // as today's phase (full, clearly visible; new, almost nothing). With low
  // clouds, rain or fog it does not come in.
  const moonLit = moonPhase(s.now).illumination * (1 - Math.min(1, DL * 2)) * (s.code >= 45 ? 0 : s.code >= 2 ? 0.5 : 1);
  if (moonLit > 0.03) {
    const hh = s.hour < 12 ? s.hour + 24 : s.hour;
    const dusk = SET + 0.8, dawn = RISE + 24 - 0.8;
    const t = clamp((hh - dusk) / (dawn - dusk));
    const shift = (0.5 - t) * 700;
    c.fillStyle = linear(c, 0, HORIZON, 0, H, [[0, `rgba(175,200,255,${0.17 * moonLit})`], [1, `rgba(175,200,255,${0.06 * moonLit})`]]);
    c.beginPath();
    c.moveTo(wx + 12, HORIZON);
    c.lineTo(wx + ww - 12, HORIZON);
    c.lineTo(wx + ww - 12 + shift + 160, H);
    c.lineTo(wx + 12 + shift - 60, H);
    c.closePath();
    c.fill();
    // A soft glow on the wall, under the windowsill.
    c.fillStyle = radial(c, wx + ww / 2, wy + wh, 10, 220, [[0, `rgba(175,200,255,${0.1 * moonLit})`], [1, 'rgba(175,200,255,0)']]);
    c.fillRect(wx - 220, wy + wh - 40, ww + 440, HORIZON - (wy + wh) + 40);
  }
}

/**
 * The beach: sky and sea across the width, sand instead of floor and tiny waves on
 * the shore. The fixed points are still there in their own way: the palm tree serves as
 * the shelf (one sleeps on its leaves), a boat beached on the shore serves as
 * the windowsill, the lantern hangs from a post and the clock is nailed to another.
 */
function paintBeach(c: X, W: number, H: number, s: Sky): void {
  const DL = daylight(s.hour, riseOf(s), setOf(s));
  windowScene(c, s, 0, 0, W, HORIZON + 8, 'mar');
  // Shore: wet sand and foam with little waves.
  const r = rng(61);
  c.fillStyle = linear(c, 0, HORIZON - 4, 0, H, [[0, css(mix(hex('#3A3428'), hex('#C8B080'), DL))], [0.15, css(mix(hex('#4A4232'), hex('#E8D2A0'), DL))], [1, css(mix(hex('#5A5040'), hex('#F6E8C4'), DL))]]);
  c.fillRect(0, HORIZON - 4, W, H - HORIZON + 4);
  c.strokeStyle = `rgba(255,255,255,${0.5 + 0.4 * DL})`;
  c.lineWidth = 2;
  c.beginPath();
  for (let x = 0; x <= W; x += 18) c.quadraticCurveTo(x + 9, HORIZON - 8 + (r() - 0.5) * 3, x + 18, HORIZON - 4);
  c.stroke();
  for (let i = 0; i < 400; i++) {
    c.fillStyle = r() < 0.5 ? 'rgba(255,255,255,0.12)' : 'rgba(120,90,50,0.12)';
    c.fillRect(r() * W, HORIZON + r() * (H - HORIZON), 2, 2);
  }
  // Loose shells and starfish.
  for (let i = 0; i < 8; i++) {
    const x = 60 + r() * (W - 500), y = HORIZON + 20 + r() * (H - HORIZON - 30);
    c.fillStyle = i % 3 ? '#F4D8C8' : '#E8845A';
    if (i % 3) {
      ellipse(c, x, y, 6, 4);
      c.fill();
    } else {
      c.beginPath();
      for (let k = 0; k < 10; k++) {
        const a = (k / 10) * TAU - Math.PI / 2, rr = k % 2 ? 3 : 8;
        c.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
      }
      c.fill();
    }
  }
  // Boat beached on the shore, where the windowsill falls.
  c.fillStyle = '#2E6A8A';
  c.beginPath();
  c.moveTo(610, 226);
  c.lineTo(810, 226);
  c.quadraticCurveTo(800, 262, 760, 266);
  c.lineTo(650, 266);
  c.quadraticCurveTo(620, 262, 610, 226);
  c.fill();
  c.fillStyle = '#F4F0E6';
  c.fillRect(610, 226, 200, 7);
  c.fillStyle = '#C0392B';
  c.fillRect(640, 244, 140, 5);
  // Palm tree on the left: its leaves reach up to the top "shelf".
  c.strokeStyle = '#8A6A40';
  c.lineWidth = 22;
  c.lineCap = 'round';
  c.beginPath();
  c.moveTo(150, 300);
  c.quadraticCurveTo(210, 180, 185, 62);
  c.stroke();
  c.strokeStyle = 'rgba(60,40,20,0.35)';
  c.lineWidth = 2;
  for (let t = 0.1; t < 1; t += 0.07) {
    const x = (1 - t) * (1 - t) * 150 + 2 * (1 - t) * t * 210 + t * t * 185, y = (1 - t) * (1 - t) * 300 + 2 * (1 - t) * t * 180 + t * t * 62;
    c.beginPath();
    c.moveTo(x - 10, y);
    c.lineTo(x + 10, y + 3);
    c.stroke();
  }
  const leaf = css(mix(hex('#1E3A26'), hex('#3E8A4A'), DL));
  // Fronds: each one comes out of the crown, rises a little and falls arched, with its
  // leaflets hanging downward.
  for (let i = 0; i < 8; i++) {
    const th = -Math.PI + 0.25 + (i / 7) * (Math.PI - 0.5), len = 120 + (i % 3) * 18;
    const p0: [number, number] = [185, 56];
    const p1: [number, number] = [185 + Math.cos(th) * len * 0.55, 56 + Math.sin(th) * len * 0.55];
    const p2: [number, number] = [185 + Math.cos(th) * len, 56 + Math.sin(th) * len * 0.2 + len * 0.4];
    const at = (t: number): [number, number] => [
      (1 - t) * (1 - t) * p0[0] + 2 * (1 - t) * t * p1[0] + t * t * p2[0],
      (1 - t) * (1 - t) * p0[1] + 2 * (1 - t) * t * p1[1] + t * t * p2[1],
    ];
    c.strokeStyle = leaf;
    c.lineCap = 'round';
    for (let t = 0.08; t < 1; t += 0.06) {
      const [x, y] = at(t), [x2, y2] = at(t + 0.02);
      const ang = Math.atan2(y2 - y, x2 - x);
      const l = 26 * (1 - t * 0.7);
      c.lineWidth = 4;
      for (const side of [1, -1]) {
        c.beginPath();
        c.moveTo(x, y);
        c.lineTo(x + Math.cos(ang + side * 1.1) * l * 0.5, y + Math.sin(ang + side * 1.1) * l * 0.5 + l * 0.6);
        c.stroke();
      }
    }
    c.lineWidth = 4;
    c.strokeStyle = css(mix(hex('#1A2A18'), hex('#2E6A3A'), DL));
    c.beginPath();
    c.moveTo(p0[0], p0[1]);
    c.quadraticCurveTo(p1[0], p1[1], p2[0], p2[1]);
    c.stroke();
  }
  c.fillStyle = '#6A4A2A';
  for (const [dx, dy] of [[-10, 64], [8, 66], [0, 74]] as const) {
    ellipse(c, 185 + dx, dy, 9, 9);
    c.fill();
  }
  // Sandcastle where the others have the plant.
  c.fillStyle = css(mix(hex('#5A5040'), hex('#E0C088'), DL));
  c.fillRect(330, 262, 56, 34);
  for (const x of [330, 350, 370]) c.fillRect(x, 254, 12, 10);
  c.fillRect(348, 238, 20, 26);
  c.fillStyle = '#D9534F';
  c.beginPath();
  c.moveTo(358, 238);
  c.lineTo(358, 222);
  c.lineTo(372, 228);
  c.lineTo(358, 232);
  c.fill();
  // Beach umbrella and towel at the back, to the right of the boat.
  c.strokeStyle = '#EDE4CC';
  c.lineWidth = 4;
  c.beginPath();
  c.moveTo(1010, 300);
  c.lineTo(1030, 196);
  c.stroke();
  for (let k = 0; k < 6; k++) {
    c.fillStyle = k % 2 ? '#FFFFFF' : '#E8542A';
    c.beginPath();
    c.moveTo(1030, 190);
    c.arc(1030, 206, 90, Math.PI + (k / 6) * Math.PI, Math.PI + ((k + 1) / 6) * Math.PI);
    c.closePath();
    c.fill();
  }
  c.fillStyle = '#3F7FE0';
  c.beginPath();
  c.moveTo(930, 300);
  c.lineTo(1080, 300);
  c.lineTo(1100, 318);
  c.lineTo(910, 318);
  c.fill();
  c.fillStyle = '#FFFFFF';
  c.fillRect(960, 300, 10, 18);
  c.fillRect(1040, 300, 10, 18);
  // Lantern post (lamp) and clock post.
  const lx = lampX(W);
  c.fillStyle = '#6A4A2A';
  c.fillRect(lx + 60, 30, 10, 280);
  c.fillRect(lx - 4, 30, 74, 8);
  c.fillRect(1398, 120, 8, 190);
  // At night, dimness on the sand (the sky already darkens by itself).
  if (DL < 1) {
    c.fillStyle = `rgba(10,14,30,${0.35 * (1 - DL)})`;
    c.fillRect(0, HORIZON - 4, W, H - HORIZON + 4);
  }
  const warm = '255,200,130';
  c.fillStyle = radial(c, lx, 70, 10, 360, [[0, `rgba(${warm},${0.3 * (1 - DL) + 0.03})`], [1, `rgba(${warm},0)`]]);
  c.fillRect(lx - 480, 0, 960, H);
  lamp(c, 'farol', lx, 36);
}

/**
 * Space: stars, nebulae and the Earth curving below, with the day and
 * night of the real hour. The fixed points, in their own way: an asteroid at the top
 * left (the shelf), a floating rock where the windowsill falls, a
 * satellite where the lamp hangs and a terrarium where the plant goes.
 */
function paintSpace(c: X, W: number, H: number, s: Sky): void {
  const r = rng(101);
  c.fillStyle = linear(c, 0, 0, 0, H, [[0, '#03040C'], [1, '#0A0E24']]);
  c.fillRect(0, 0, W, H);
  // Nebulae: very faint patches of color.
  for (const [x, y, rr, col] of [[520, 120, 380, '140,70,200'], [1250, 90, 320, '40,150,200'], [900, 260, 260, '200,60,120']] as const) {
    c.fillStyle = radial(c, x, y, 10, rr, [[0, `rgba(${col},0.22)`], [1, `rgba(${col},0)`]]);
    c.fillRect(x - rr, y - rr, rr * 2, rr * 2);
  }
  for (let i = 0; i < 420; i++) {
    const x = r() * W, y = r() * H, big = r() < 0.06;
    c.fillStyle = `rgba(${r() < 0.2 ? '200,220,255' : r() < 0.3 ? '255,230,200' : '255,255,255'},${0.3 + r() * 0.7})`;
    ellipse(c, x, y, big ? 1.8 : 0.9, big ? 1.8 : 0.9);
    c.fill();
    if (big && r() < 0.4) {
      c.fillRect(x - 5, y - 0.5, 10, 1);
      c.fillRect(x - 0.5, y - 5, 1, 10);
    }
  }
  // The Moon, in today's phase, at the top.
  drawMoonPhase(c, moonPhase(s.now), 1010, 70, 34, '#F4F0E6');
  // The Earth: a huge arc at the bottom. The day side follows the hour.
  const ex = W * 0.42, ey = H + 1500, er = 1580;
  c.save();
  c.beginPath();
  c.arc(ex, ey, er, 0, TAU);
  c.clip();
  c.fillStyle = linear(c, 0, ey - er, 0, ey - er + 140, [[0, '#2E7FD0'], [1, '#12407A']]);
  c.fillRect(0, ey - er, W, 200);
  for (let i = 0; i < 18; i++) {
    c.fillStyle = r() < 0.5 ? 'rgba(80,150,70,0.9)' : 'rgba(200,180,120,0.8)';
    ellipse(c, r() * W, ey - er + 20 + r() * 100, 60 + r() * 120, 10 + r() * 16, (r() - 0.5) * 0.3);
    c.fill();
  }
  for (let i = 0; i < 24; i++) {
    c.fillStyle = 'rgba(255,255,255,0.75)';
    ellipse(c, r() * W, ey - er + 10 + r() * 110, 40 + r() * 90, 5 + r() * 8, (r() - 0.5) * 0.2);
    c.fill();
  }
  // Terminator: the night part, on one side or the other depending on the hour.
  const DL = daylight(s.hour, riseOf(s), setOf(s));
  const cut = W * (0.15 + 0.7 * ((s.hour % 24) / 24));
  c.fillStyle = linear(c, cut - 200, 0, cut + 200, 0, [[0, 'rgba(2,4,14,0)'], [1, `rgba(2,4,14,${0.55 + 0.3 * (1 - DL)})`]]);
  c.fillRect(cut - 200, ey - er, W, 200);
  // City lights on the night side.
  for (let i = 0; i < 90; i++) {
    const x = cut + 60 + r() * (W - cut), y = ey - er + 30 + r() * 100;
    c.fillStyle = `rgba(255,210,120,${0.4 + r() * 0.5})`;
    c.fillRect(x, y, 2, 2);
  }
  c.restore();
  // Atmosphere: blue halo at the edge.
  c.strokeStyle = 'rgba(120,190,255,0.55)';
  c.lineWidth = 8;
  c.beginPath();
  c.arc(ex, ey, er + 4, Math.PI * 1.2, Math.PI * 1.8);
  c.stroke();
  c.strokeStyle = 'rgba(120,190,255,0.15)';
  c.lineWidth = 30;
  c.beginPath();
  c.arc(ex, ey, er + 20, Math.PI * 1.2, Math.PI * 1.8);
  c.stroke();
  // Asteroid at the top left (the shelf: one sleeps at 40).
  const rock = (x: number, y: number, rx: number, ry: number, seed: number) => {
    const rr = rng(seed);
    c.fillStyle = radial(c, x - rx * 0.3, y - ry * 0.4, 4, rx * 1.2, [[0, '#9A938A'], [1, '#4A4540']]);
    c.beginPath();
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * TAU, k = 0.85 + rr() * 0.25;
      c.lineTo(x + Math.cos(a) * rx * k, y + Math.sin(a) * ry * k);
    }
    c.closePath();
    c.fill();
    for (let i = 0; i < 5; i++) {
      c.fillStyle = 'rgba(40,36,32,0.5)';
      ellipse(c, x + (rr() - 0.5) * rx * 1.2, y + (rr() - 0.3) * ry, 6 + rr() * 10, 4 + rr() * 6);
      c.fill();
    }
  };
  rock(185, 62, 120, 26, 5);
  rock(710, 244, 100, 20, 7);
  // Floating terrarium where the others have the plant.
  c.fillStyle = 'rgba(180,220,255,0.18)';
  ellipse(c, 354, 240, 34, 36);
  c.fill();
  c.strokeStyle = 'rgba(200,230,255,0.6)';
  c.lineWidth = 2;
  c.stroke();
  c.fillStyle = '#6A7280';
  c.fillRect(322, 268, 64, 10);
  c.fillStyle = '#56995E';
  for (let i = 0; i < 6; i++) {
    ellipse(c, 354 + Math.cos(i * 1.1) * 12, 250 - i * 5, 6, 14, -0.8 + i * 0.3);
    c.fill();
  }
  // Satellite where the lamp goes: the LGTM cat grabs onto its body.
  const lx = lampX(W);
  c.fillStyle = '#2A4A8A';
  for (const dx of [-96, 34]) {
    c.fillRect(lx + dx, 54, 62, 22);
    c.strokeStyle = 'rgba(160,200,255,0.5)';
    c.lineWidth = 1;
    for (let k = 1; k < 4; k++) {
      c.beginPath();
      c.moveTo(lx + dx + k * 15.5, 54);
      c.lineTo(lx + dx + k * 15.5, 76);
      c.stroke();
    }
  }
  c.fillStyle = '#C9CED6';
  c.fillRect(lx - 34, 62, 68, 6);
  c.fillStyle = '#D8B84A';
  c.beginPath();
  c.roundRect(lx - 18, 46, 36, 38, 6);
  c.fill();
  c.strokeStyle = '#C9CED6';
  c.lineWidth = 2;
  c.beginPath();
  c.moveTo(lx, 46);
  c.lineTo(lx + 8, 26);
  c.stroke();
  c.fillStyle = '#FF4D4D';
  ellipse(c, lx + 8, 25, 3, 3);
  c.fill();
}

/**
 * Astronaut helmet: a glass bubble around the head, with its
 * reflection and a metal ring at the neck. (x, y): center of the head; `r`
 * bubble radius; no ring for the ones that sleep lying down.
 */
export function spaceHelmet(c: X, x: number, y: number, r: number, collar = true): void {
  c.save();
  c.fillStyle = radial(c, x - r * 0.3, y - r * 0.35, r * 0.1, r, [[0, 'rgba(210,235,255,0.10)'], [0.8, 'rgba(170,210,255,0.14)'], [1, 'rgba(200,230,255,0.35)']]);
  ellipse(c, x, y, r, r);
  c.fill();
  c.strokeStyle = 'rgba(220,240,255,0.75)';
  c.lineWidth = Math.max(1.5, r * 0.04);
  ellipse(c, x, y, r, r);
  c.stroke();
  // Curved window reflection at the top left.
  c.strokeStyle = 'rgba(255,255,255,0.7)';
  c.lineWidth = Math.max(2, r * 0.07);
  c.lineCap = 'round';
  c.beginPath();
  c.arc(x, y, r * 0.78, Math.PI * 1.1, Math.PI * 1.35);
  c.stroke();
  c.lineWidth = Math.max(1.5, r * 0.04);
  c.beginPath();
  c.arc(x, y, r * 0.78, Math.PI * 1.42, Math.PI * 1.48);
  c.stroke();
  if (collar) {
    // Neck ring: a thin ring, not a plate.
    c.strokeStyle = 'rgba(200,210,225,0.85)';
    c.lineWidth = Math.max(2, r * 0.06);
    ellipse(c, x, y + r * 0.93, r * 0.5, r * 0.09);
    c.stroke();
  }
  c.restore();
}

/**
 * A tiny wave that climbs the beach sand and retreats: the `ola`
 * gesture (wave). It is painted over the background and under the cats.
 */
export function beachWave(c: X, W: number, t: number): void {
  const reach = Math.sin(Math.PI * t) * 46;
  if (reach <= 0.5) return;
  const r = rng(77);
  const y0 = HORIZON - 4;
  const edge: [number, number][] = [];
  for (let x = 0; x <= W; x += 24) edge.push([x, y0 + reach * (0.7 + 0.3 * Math.sin(x * 0.013 + 1.7)) + (r() - 0.5) * 4]);
  c.save();
  c.fillStyle = 'rgba(120,200,220,0.45)';
  c.beginPath();
  c.moveTo(0, y0);
  for (const [x, y] of edge) c.lineTo(x, y);
  c.lineTo(W, y0);
  c.closePath();
  c.fill();
  c.strokeStyle = 'rgba(255,255,255,0.85)';
  c.lineWidth = 3;
  c.beginPath();
  edge.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
  c.stroke();
  c.restore();
}

/** Wallpaper, tiles, brick or wood: the wall texture. */
function wallPattern(c: X, room: RoomName, W: number, DL: number): void {
  const r = rng(41);
  c.save();
  if (room === 'cocina') {
    // White and blue tile up to half height.
    const top = 150;
    for (let y = top; y < HORIZON - 12; y += 24) {
      for (let x = 0; x < W; x += 24) {
        c.fillStyle = ((x / 24 + y / 24) | 0) % 5 === 0 ? `rgba(60,110,190,${0.55 + 0.3 * DL})` : `rgba(244,246,250,${0.35 + 0.5 * DL})`;
        c.fillRect(x + 1, y + 1, 22, 22);
      }
    }
    c.fillStyle = 'rgba(60,110,190,0.8)';
    c.fillRect(0, top - 6, W, 5);
  } else if (room === 'cabana') {
    // Horizontal logs with their grain.
    for (let y = 0; y < HORIZON; y += 34) {
      c.fillStyle = 'rgba(0,0,0,0.22)';
      c.fillRect(0, y + 30, W, 4);
      c.fillStyle = 'rgba(255,220,170,0.05)';
      c.fillRect(0, y + 2, W, 8);
      for (let i = 0; i < 6; i++) {
        c.fillStyle = 'rgba(40,24,10,0.35)';
        ellipse(c, r() * W, y + 16, 4 + r() * 5, 3 + r() * 3);
        c.fill();
      }
    }
  } else if (room === 'atico') {
    // Soft vertical stripes and the beams of the attic ceiling.
    for (let x = 0; x < W; x += 36) {
      c.fillStyle = 'rgba(255,255,255,0.06)';
      c.fillRect(x, 0, 14, HORIZON);
    }
    c.fillStyle = '#4A3420';
    c.beginPath();
    c.moveTo(0, 0);
    c.lineTo(W * 0.3, 0);
    c.lineTo(0, 120);
    c.closePath();
    c.fill();
    c.fillStyle = '#5A4028';
    c.fillRect(0, 0, W, 14);
    for (const x of [420, 980, 1500]) c.fillRect(x - 10, 0, 20, 22);
  } else if (room === 'oficina') {
    // Wall panels and a strip of corporate color.
    for (let x = 0; x < W; x += 240) {
      c.fillStyle = 'rgba(0,0,0,0.05)';
      c.fillRect(x, 0, 2, HORIZON);
    }
    c.fillStyle = `rgba(63,127,224,${0.5 + 0.3 * DL})`;
    c.fillRect(0, 200, W, 10);
  } else if (room === 'japonesa') {
    // Paper wall with a wooden lattice.
    c.strokeStyle = 'rgba(90,58,34,0.55)';
    c.lineWidth = 3;
    for (let x = 0; x < W; x += 60) {
      c.beginPath();
      c.moveTo(x, 0);
      c.lineTo(x, HORIZON);
      c.stroke();
    }
    for (let y = 0; y < HORIZON; y += 68) {
      c.beginPath();
      c.moveTo(0, y);
      c.lineTo(W, y);
      c.stroke();
    }
    c.fillStyle = '#5A3A22';
    c.fillRect(0, 0, W, 12);
  } else if (room === 'acuario') {
    // Water reflections on the wall: the aquarium lights it up.
    for (let i = 0; i < 40; i++) {
      c.fillStyle = `rgba(160,230,240,${0.03 + r() * 0.05})`;
      ellipse(c, r() * W, r() * HORIZON, 30 + r() * 60, 6 + r() * 8, r());
      c.fill();
    }
  } else if (room === 'arcade') {
    // Neon strips along the wall.
    for (const [y, col] of [[18, '255,60,200'], [206, '60,220,255']] as const) {
      c.fillStyle = `rgba(${col},0.18)`;
      c.fillRect(0, y - 8, W, 18);
      c.fillStyle = `rgba(${col},0.95)`;
      c.fillRect(0, y, W, 3);
    }
  } else {
    // Studio: paper with small motifs, barely visible.
    for (let y = 20; y < HORIZON - 20; y += 40) {
      for (let x = (y / 40) % 2 ? 20 : 0; x < W; x += 40) {
        c.fillStyle = 'rgba(255,255,255,0.035)';
        ellipse(c, x, y, 3, 3);
        c.fill();
      }
    }
  }
  c.restore();
}

/** The lamp, always hung at (lx, 64): the LGTM cat grabs onto it from there. */
function lamp(c: X, kind: Theme['lamp'], lx: number, top = 0): void {
  if (kind === 'aplique') {
    c.fillStyle = '#F2C27A';
    ellipse(c, lx, 64, 16, 10);
    c.fill();
    c.fillStyle = '#6B4A2B';
    c.fillRect(lx - 4, 40, 8, 18);
    return;
  }
  // The hanging ones: cable from the ceiling.
  c.strokeStyle = '#222';
  c.lineWidth = 2;
  c.beginPath();
  c.moveTo(lx, top);
  c.lineTo(lx, 52);
  c.stroke();
  if (kind === 'colgante') {
    c.fillStyle = '#2A2E38';
    c.beginPath();
    c.moveTo(lx - 30, 72);
    c.lineTo(lx - 10, 50);
    c.lineTo(lx + 10, 50);
    c.lineTo(lx + 30, 72);
    c.closePath();
    c.fill();
    c.fillStyle = '#FFE0A0';
    ellipse(c, lx, 72, 26, 5);
    c.fill();
  } else if (kind === 'farol') {
    c.fillStyle = '#2A2A2A';
    c.fillRect(lx - 16, 50, 32, 6);
    c.fillStyle = '#FFC860';
    c.fillRect(lx - 12, 56, 24, 28);
    c.strokeStyle = '#2A2A2A';
    c.lineWidth = 3;
    c.strokeRect(lx - 12, 56, 24, 28);
    c.beginPath();
    c.moveTo(lx, 56);
    c.lineTo(lx, 84);
    c.stroke();
  } else if (kind === 'papel') {
    c.fillStyle = '#FFF0D0';
    ellipse(c, lx, 72, 26, 22);
    c.fill();
    c.strokeStyle = 'rgba(160,110,60,0.5)';
    c.lineWidth = 1.5;
    for (const dy of [-12, -4, 4, 12]) {
      c.beginPath();
      c.ellipse(lx, 72 + dy, 26 * Math.sqrt(1 - (dy / 22) ** 2), 3, 0, 0, TAU);
      c.stroke();
    }
    c.fillStyle = '#5A3A22';
    c.fillRect(lx - 10, 48, 20, 5);
  } else {
    // Neon: a purple ring.
    c.strokeStyle = 'rgba(200,110,255,0.35)';
    c.lineWidth = 12;
    ellipse(c, lx, 68, 22, 14);
    c.stroke();
    c.strokeStyle = '#E0A8FF';
    c.lineWidth = 4;
    ellipse(c, lx, 68, 22, 14);
    c.stroke();
  }
}

/** Curtains gathered at the sides of the window. */
function curtains(c: X, color: string, DL: number, win: { x: number; y: number; w: number; h: number } = WINDOW): void {
  const { x, y, w, h } = win;
  const col = css(mix(hex(color), hex('#141828'), (1 - DL) * 0.5));
  c.fillStyle = '#3A3A3A';
  c.fillRect(x - 40, y - 12, w + 80, 5);
  for (const [x0, dir] of [[x - 34, 1], [x + w + 34, -1]] as const) {
    c.fillStyle = col;
    c.beginPath();
    c.moveTo(x0, y - 8);
    c.lineTo(x0 + dir * 58, y - 8);
    c.quadraticCurveTo(x0 + dir * 20, y + h * 0.5, x0 + dir * 40, y + h + 4);
    c.lineTo(x0, y + h + 4);
    c.closePath();
    c.fill();
    c.strokeStyle = 'rgba(0,0,0,0.18)';
    c.lineWidth = 2;
    for (const k of [0.3, 0.6]) {
      c.beginPath();
      c.moveTo(x0 + dir * 58 * k, y - 8);
      c.quadraticCurveTo(x0 + dir * 20 * k, y + h * 0.5, x0 + dir * 40 * k, y + h + 4);
      c.stroke();
    }
  }
}

/**
 * The furniture on the left (x 60..310, from 40 to 272): always with a shelf
 * at the very top, at 40, where the shelf cat sleeps.
 */
function leftFurniture(c: X, room: RoomName, DL: number): void {
  const r = rng(3);
  if (room === 'estudio' || room === 'atico') {
    c.fillStyle = room === 'atico' ? '#E8ECF2' : '#4A3420';
    c.fillRect(60, 40, 250, 232);
    c.fillStyle = room === 'atico' ? '#C8D0DA' : '#35251A';
    c.fillRect(70, 48, 230, 216);
    const books = ['#C0504A', '#4DA3FF', '#F2C94C', '#39A87A', '#8E6BD6', '#E8894A', '#D9D2C2'];
    for (const sy of [48, 120, 192]) {
      c.fillStyle = room === 'atico' ? '#E8ECF2' : '#4A3420';
      c.fillRect(70, sy + 66, 230, 6);
      let bx = 76;
      while (bx < 280) {
        const bw = 10 + r() * 14, bh = 40 + r() * 22;
        c.fillStyle = books[Math.floor(r() * books.length)]!;
        c.fillRect(bx, sy + 66 - bh, bw, bh);
        c.fillStyle = 'rgba(0,0,0,0.25)';
        c.fillRect(bx + bw - 3, sy + 66 - bh, 3, bh);
        bx += bw + 2;
      }
    }
    return;
  }
  if (room === 'cocina') {
    // Fridge with magnets and low cabinet with countertop.
    c.fillStyle = '#E4E8EE';
    c.beginPath();
    c.roundRect(60, 40, 110, 232, 8);
    c.fill();
    c.fillStyle = '#B8C0CC';
    c.fillRect(60, 120, 110, 3);
    c.fillRect(150, 70, 5, 30);
    c.fillRect(150, 140, 5, 50);
    for (const [mx, my, col] of [[82, 150, '#F2C94C'], [110, 176, '#D9534F'], [92, 204, '#39A87A']] as const) {
      c.fillStyle = col;
      ellipse(c, mx, my, 7, 7);
      c.fill();
    }
    c.fillStyle = '#F4F0E6';
    c.fillRect(96, 160, 30, 36);
    c.fillStyle = '#8A6A4A';
    c.fillRect(175, 40, 135, 10);
    c.fillStyle = '#A07A50';
    c.fillRect(180, 170, 130, 102);
    c.fillStyle = '#8A6A4A';
    c.fillRect(176, 164, 138, 10);
    for (const x of [192, 252]) {
      c.fillStyle = '#B89060';
      c.fillRect(x, 184, 50, 76);
      c.fillStyle = '#5A4028';
      c.fillRect(x + 22, 212, 6, 18);
    }
    // Jars and a fruit bowl on the countertop.
    for (const [x, col] of [[196, '#E8894A'], [220, '#F2C94C'], [244, '#8E6BD6']] as const) {
      c.fillStyle = 'rgba(230,240,250,0.7)';
      c.fillRect(x, 130, 18, 34);
      c.fillStyle = col;
      c.fillRect(x + 2, 146, 14, 16);
    }
    c.fillStyle = '#E8E4DA';
    ellipse(c, 288, 160, 22, 6);
    c.fill();
    for (const [dx, col] of [[-10, '#D9534F'], [4, '#F2C94C'], [12, '#39A87A']] as const) {
      c.fillStyle = col;
      ellipse(c, 288 + dx, 152, 8, 8);
      c.fill();
    }
    return;
  }
  if (room === 'cabana') {
    // Stone fireplace, with the fire livelier at night.
    c.fillStyle = '#6E6A64';
    c.fillRect(60, 40, 250, 232);
    for (let i = 0; i < 60; i++) {
      c.fillStyle = r() < 0.5 ? '#7E7A72' : '#5E5A54';
      c.beginPath();
      c.roundRect(60 + r() * 230, 40 + r() * 215, 22 + r() * 18, 14 + r() * 8, 4);
      c.fill();
    }
    c.fillStyle = '#4A3220';
    c.fillRect(50, 40, 270, 14);
    c.fillStyle = '#1A1210';
    c.beginPath();
    c.moveTo(110, 272);
    c.lineTo(110, 170);
    c.quadraticCurveTo(185, 120, 260, 170);
    c.lineTo(260, 272);
    c.fill();
    const fire = 0.6 + 0.4 * (1 - DL);
    c.fillStyle = radial(c, 185, 250, 4, 90, [[0, `rgba(255,200,90,${fire})`], [1, 'rgba(255,120,40,0)']]);
    c.fillRect(100, 150, 170, 122);
    flames(c);
    c.fillStyle = '#5A3A22';
    c.fillRect(140, 258, 90, 10);
    return;
  }
  if (room === 'oficina') {
    // Whiteboard with a diagram and post-its, over a filing cabinet.
    c.fillStyle = '#9AA3AE';
    c.fillRect(60, 40, 250, 8);
    c.fillStyle = '#F7F8FA';
    c.fillRect(64, 48, 242, 140);
    c.strokeStyle = '#8A96A6';
    c.lineWidth = 4;
    c.strokeRect(64, 48, 242, 140);
    c.strokeStyle = '#2F80ED';
    c.lineWidth = 2.5;
    for (const [x, y] of [[90, 80], [180, 70], [180, 130], [260, 100]] as const) c.strokeRect(x, y, 40, 24);
    c.beginPath();
    c.moveTo(130, 92);
    c.lineTo(180, 82);
    c.moveTo(130, 92);
    c.lineTo(180, 142);
    c.moveTo(220, 82);
    c.lineTo(260, 112);
    c.stroke();
    c.strokeStyle = '#D9534F';
    c.beginPath();
    c.arc(280, 150, 18, 0, TAU);
    c.stroke();
    for (const [x, y, col] of [[76, 150, '#FFE14D'], [106, 158, '#FF9ECF'], [240, 58, '#FFE14D']] as const) {
      c.fillStyle = col;
      c.fillRect(x, y, 24, 24);
    }
    c.fillStyle = '#6B7380';
    c.fillRect(110, 196, 150, 76);
    for (const y of [204, 228, 252]) {
      c.fillStyle = '#8A93A0';
      c.fillRect(116, y, 138, 20);
      c.fillStyle = '#3A4250';
      c.fillRect(175, y + 8, 20, 4);
    }
    return;
  }
  if (room === 'japonesa') {
    // Tokonoma: alcove with a scroll and a bonsai.
    c.fillStyle = '#5A3A22';
    c.fillRect(60, 40, 250, 232);
    c.fillStyle = '#EDE4CC';
    c.fillRect(72, 52, 226, 190);
    c.fillStyle = '#F4F0E6';
    c.fillRect(150, 62, 70, 150);
    c.fillStyle = '#2A2A2A';
    c.fillRect(146, 60, 78, 6);
    c.fillRect(146, 210, 78, 6);
    c.font = 'bold 34px serif';
    c.textAlign = 'center';
    c.fillText('猫', 185, 120);
    c.fillText('道', 185, 170);
    c.textAlign = 'left';
    c.fillStyle = '#6A4A2E';
    c.fillRect(72, 242, 226, 30);
    c.fillStyle = '#4A2E1A';
    c.fillRect(100, 228, 50, 14);
    c.strokeStyle = '#4A2E1A';
    c.lineWidth = 5;
    c.beginPath();
    c.moveTo(125, 228);
    c.quadraticCurveTo(110, 205, 132, 192);
    c.stroke();
    c.fillStyle = '#3E7A4A';
    for (const [x, y] of [[112, 196], [138, 188], [124, 182]] as const) {
      ellipse(c, x, y, 16, 9);
      c.fill();
    }
    return;
  }
  if (room === 'acuario') {
    // A large aquarium on its stand: colorful fish, bubbles and seaweed.
    c.fillStyle = '#2A2E38';
    c.fillRect(60, 40, 250, 10);
    c.fillStyle = 'rgba(60,160,190,0.85)';
    c.fillRect(64, 50, 242, 150);
    c.fillStyle = 'rgba(200,245,255,0.18)';
    c.fillRect(64, 50, 242, 14);
    c.fillStyle = '#D8C8A0';
    c.fillRect(64, 186, 242, 14);
    for (let i = 0; i < 7; i++) {
      c.strokeStyle = '#3E8A4A';
      c.lineWidth = 5;
      const x = 80 + r() * 210;
      c.beginPath();
      c.moveTo(x, 190);
      c.quadraticCurveTo(x + 14, 150, x - 4, 110 + r() * 30);
      c.stroke();
    }
    for (let i = 0; i < 6; i++) {
      const fx = 90 + r() * 190, fy = 80 + r() * 90, col = ['#FF8A2A', '#FFD34D', '#FF5C8A', '#4DA3FF'][i % 4]!;
      c.fillStyle = col;
      ellipse(c, fx, fy, 12, 7);
      c.fill();
      c.beginPath();
      c.moveTo(fx - 10, fy);
      c.lineTo(fx - 20, fy - 7);
      c.lineTo(fx - 20, fy + 7);
      c.fill();
    }
    for (let i = 0; i < 12; i++) {
      c.strokeStyle = 'rgba(230,250,255,0.6)';
      c.lineWidth = 1.5;
      ellipse(c, 270 + r() * 20, 60 + r() * 120, 3, 3);
      c.stroke();
    }
    c.strokeStyle = '#2A2E38';
    c.lineWidth = 5;
    c.strokeRect(64, 50, 242, 150);
    c.fillStyle = '#3A3F4A';
    c.fillRect(60, 200, 250, 72);
    return;
  }
  if (room === 'ventanal') {
    // Low white shelf, with vases and a couple of art books.
    c.fillStyle = '#F4F4F2';
    c.fillRect(60, 40, 250, 232);
    c.fillStyle = '#E4E4E0';
    for (const y of [40, 116, 192]) c.fillRect(60, y + 70, 250, 6);
    c.fillStyle = 'rgba(0,0,0,0.06)';
    c.fillRect(70, 48, 230, 216);
    for (const [x, y, w, h, col] of [[90, 70, 30, 40, '#C8B8A0'], [150, 84, 22, 26, '#2E5A7A'], [230, 60, 40, 50, '#E8E4DA'], [100, 160, 60, 26, '#3A3F48'], [210, 150, 26, 36, '#D9A070'], [120, 226, 40, 40, '#8AA8B8'], [220, 236, 60, 30, '#C8B8A0']] as const) {
      c.fillStyle = col;
      c.beginPath();
      c.roundRect(x, y + (110 - 110), w, h, Math.min(w, h) / 3);
      c.fill();
    }
    return;
  }
  // Arcade: two arcade machines with the screen on.
  for (const [x, col] of [[64, '#FF3CC8'], [190, '#3CDCFF']] as const) {
    c.fillStyle = '#2A2440';
    c.beginPath();
    c.moveTo(x, 272);
    c.lineTo(x, 40);
    c.lineTo(x + 116, 40);
    c.lineTo(x + 116, 272);
    c.fill();
    c.fillStyle = col;
    c.fillRect(x, 40, 116, 26);
    c.fillStyle = '#10101A';
    c.font = 'bold 15px monospace';
    c.fillText(x === 64 ? 'MIAU-MAN' : 'CAT FIGHT', x + 10, 58);
    c.fillStyle = '#0A0A14';
    c.fillRect(x + 12, 76, 92, 76);
    c.fillStyle = radial(c, x + 58, 114, 4, 60, [[0, `${col}AA`], [1, `${col}10`]]);
    c.fillRect(x + 12, 76, 92, 76);
    c.fillStyle = '#FFE14D';
    ellipse(c, x + 40, 118, 10, 10);
    c.fill();
    c.fillStyle = '#3A3450';
    c.fillRect(x + 6, 160, 104, 30);
    c.fillStyle = '#D7262E';
    ellipse(c, x + 36, 175, 7, 7);
    c.fill();
    c.fillStyle = '#FFD34D';
    ellipse(c, x + 70, 175, 6, 6);
    c.fill();
    ellipse(c, x + 86, 175, 6, 6);
    c.fill();
  }
}

/** What gives its own light, painted on top of the night dimness. */
function emissive(c: X, room: RoomName, W: number, DL: number): void {
  const dark = 1 - DL;
  if (dark <= 0) return;
  c.save();
  if (room === 'cabana') {
    c.globalCompositeOperation = 'lighter';
    c.fillStyle = radial(c, 185, 240, 4, 220, [[0, `rgba(255,150,60,${0.35 * dark})`], [1, 'rgba(255,120,40,0)']]);
    c.fillRect(0, 60, 520, 400);
    c.globalCompositeOperation = 'source-over';
    flames(c);
  } else if (room === 'arcade') {
    c.globalCompositeOperation = 'lighter';
    for (const [x, col] of [[122, '255,60,200'], [248, '60,220,255']] as const) {
      c.fillStyle = radial(c, x, 114, 4, 160, [[0, `rgba(${col},${0.35 * dark})`], [1, `rgba(${col},0)`]]);
      c.fillRect(x - 170, 0, 340, 330);
    }
    for (const [y, col] of [[18, '255,60,200'], [206, '60,220,255']] as const) {
      c.fillStyle = `rgba(${col},${0.5 * dark})`;
      c.fillRect(0, y, W, 3);
    }
  } else if (room === 'acuario') {
    c.globalCompositeOperation = 'lighter';
    c.fillStyle = radial(c, 185, 125, 10, 240, [[0, `rgba(80,200,230,${0.3 * dark})`], [1, 'rgba(80,200,230,0)']]);
    c.fillRect(0, 0, 480, 330);
  } else if (room === 'atico') {
    for (let i = 0; i < 14; i++) {
      const x = 900 + i * 44, y = 40 + Math.sin(i * 0.9) * 10 + 14;
      c.fillStyle = radial(c, x, y, 1, 16, [[0, `rgba(255,230,150,${0.8 * dark})`], [1, 'rgba(255,230,150,0)']]);
      ellipse(c, x, y, 16, 16);
      c.fill();
    }
  }
  c.restore();
}

/** The flames of the cabin's fireplace. */
function flames(c: X): void {
  for (const [dx, h, col] of [[-26, 46, '#E8542A'], [0, 64, '#FF8A2A'], [24, 50, '#E8542A'], [0, 34, '#FFD34D']] as const) {
    c.fillStyle = col;
    c.beginPath();
    c.moveTo(185 + dx - 18, 262);
    c.quadraticCurveTo(185 + dx - 12, 262 - h * 0.6, 185 + dx, 262 - h);
    c.quadraticCurveTo(185 + dx + 12, 262 - h * 0.6, 185 + dx + 18, 262);
    c.fill();
  }
}

/** Pictures and posters on the free stretch of wall, between the window and the clock. */
function decor(c: X, room: RoomName, W: number, DL: number, notOnFriday: string): void {
  const frame = (x: number, y: number, w: number, h: number, border: string) => {
    c.fillStyle = 'rgba(0,0,0,0.3)';
    c.fillRect(x + 4, y + 5, w, h);
    c.fillStyle = border;
    c.fillRect(x, y, w, h);
  };
  const x0 = 930;
  if (room === 'estudio') {
    // Portrait of a very serious cat.
    frame(x0, 60, 120, 150, '#8A6A3A');
    c.fillStyle = '#E8E0CC';
    c.fillRect(x0 + 10, 70, 100, 130);
    c.fillStyle = '#4A5266';
    ellipse(c, x0 + 60, 150, 34, 40);
    c.fill();
    ellipse(c, x0 + 60, 112, 26, 22);
    c.fill();
    for (const s of [-1, 1]) {
      c.beginPath();
      c.moveTo(x0 + 60 + s * 22, 104);
      c.lineTo(x0 + 60 + s * 18, 84);
      c.lineTo(x0 + 60 + s * 6, 96);
      c.fill();
    }
    c.fillStyle = '#FFD34D';
    for (const s of [-1, 1]) {
      ellipse(c, x0 + 60 + s * 10, 110, 4, 5);
      c.fill();
    }
  } else if (room === 'cocina') {
    // Not a kitchen clock: a picture of a fish and a shelf with cups.
    frame(x0, 70, 150, 90, '#F4F0E6');
    c.fillStyle = '#9FD6FF';
    c.fillRect(x0 + 8, 78, 134, 74);
    c.fillStyle = '#FF8A2A';
    ellipse(c, x0 + 72, 115, 40, 16);
    c.fill();
    c.beginPath();
    c.moveTo(x0 + 36, 115);
    c.lineTo(x0 + 18, 100);
    c.lineTo(x0 + 18, 130);
    c.fill();
    c.fillStyle = '#8A6A4A';
    c.fillRect(x0 - 10, 200, 190, 8);
    for (let i = 0; i < 4; i++) {
      c.fillStyle = ['#D9534F', '#4DA3FF', '#F2C94C', '#39A87A'][i]!;
      c.fillRect(x0 + 5 + i * 44, 176, 26, 24);
    }
  } else if (room === 'cabana') {
    // Mountain landscape and a pair of crossed skis.
    frame(x0, 60, 170, 110, '#3E2A18');
    c.fillStyle = '#A8C8E8';
    c.fillRect(x0 + 8, 68, 154, 94);
    c.fillStyle = '#5A6A7A';
    c.beginPath();
    c.moveTo(x0 + 8, 162);
    c.lineTo(x0 + 60, 90);
    c.lineTo(x0 + 100, 140);
    c.lineTo(x0 + 130, 104);
    c.lineTo(x0 + 162, 162);
    c.fill();
    c.fillStyle = '#FFFFFF';
    c.beginPath();
    c.moveTo(x0 + 48, 106);
    c.lineTo(x0 + 60, 90);
    c.lineTo(x0 + 72, 106);
    c.fill();
    c.strokeStyle = '#C0392B';
    c.lineWidth = 6;
    c.beginPath();
    c.moveTo(x0 + 200, 70);
    c.lineTo(x0 + 250, 240);
    c.moveTo(x0 + 250, 70);
    c.lineTo(x0 + 200, 240);
    c.stroke();
  } else if (room === 'atico') {
    // String of light bulbs and a star poster.
    for (let i = 0; i < 14; i++) {
      const x = 900 + i * 44, y = 40 + Math.sin(i * 0.9) * 10 + 14;
      c.fillStyle = `rgba(255,230,150,${0.4 + 0.5 * (1 - DL)})`;
      ellipse(c, x, y, 5, 7);
      c.fill();
    }
    c.strokeStyle = '#3A3A3A';
    c.lineWidth = 1.5;
    c.beginPath();
    for (let i = 0; i < 14; i++) c.lineTo(900 + i * 44, 34 + Math.sin(i * 0.9) * 10 + 14);
    c.stroke();
    frame(x0 + 20, 90, 110, 140, '#2A2E38');
    c.fillStyle = '#141A34';
    c.fillRect(x0 + 26, 96, 98, 128);
    const r = rng(9);
    for (let i = 0; i < 30; i++) {
      c.fillStyle = '#FFF6DC';
      ellipse(c, x0 + 30 + r() * 90, 100 + r() * 120, 1.2, 1.2);
      c.fill();
    }
  } else if (room === 'oficina') {
    // Motivational poster and a screen with charts.
    frame(x0, 60, 130, 160, '#2A2E38');
    c.fillStyle = '#1F4E8C';
    c.fillRect(x0 + 6, 66, 118, 148);
    c.fillStyle = '#FFFFFF';
    c.font = 'bold 26px sans-serif';
    c.textAlign = 'center';
    c.fillText('SHIP', x0 + 65, 120);
    c.fillText('IT', x0 + 65, 152);
    c.font = '12px sans-serif';
    c.fillText(notOnFriday, x0 + 65, 190);
    c.textAlign = 'left';
  } else if (room === 'japonesa') {
    // Open fan on the wall.
    c.save();
    c.translate(x0 + 90, 190);
    for (let i = 0; i < 11; i++) {
      c.fillStyle = i % 2 ? '#D9534F' : '#F4F0E6';
      c.beginPath();
      c.moveTo(0, 0);
      c.arc(0, 0, 110, Math.PI + (i / 11) * Math.PI, Math.PI + ((i + 1) / 11) * Math.PI);
      c.closePath();
      c.fill();
    }
    c.fillStyle = '#5A3A22';
    ellipse(c, 0, 0, 8, 8);
    c.fill();
    c.restore();
  } else if (room === 'acuario') {
    // Porthole with little painted fish and a net.
    c.fillStyle = '#C9A24A';
    ellipse(c, x0 + 80, 130, 64, 64);
    c.fill();
    c.fillStyle = '#1E5A8C';
    ellipse(c, x0 + 80, 130, 52, 52);
    c.fill();
    c.fillStyle = '#FFD34D';
    for (const [dx, dy] of [[-16, -10], [14, 12], [0, 26]] as const) {
      ellipse(c, x0 + 80 + dx, 130 + dy, 9, 5);
      c.fill();
    }
  } else {
    // Arcade: retro poster with a grid and a neon sun.
    frame(x0, 50, 150, 170, '#FF3CC8');
    c.fillStyle = '#1A0A2A';
    c.fillRect(x0 + 5, 55, 140, 160);
    c.fillStyle = linear(c, 0, 90, 0, 150, [[0, '#FFE14D'], [1, '#FF3CC8']]);
    ellipse(c, x0 + 75, 130, 40, 40);
    c.fill();
    c.fillStyle = '#1A0A2A';
    for (let i = 0; i < 5; i++) c.fillRect(x0 + 30, 128 + i * 9, 90, 3);
    c.strokeStyle = '#3CDCFF';
    c.lineWidth = 1.5;
    for (let i = 0; i < 6; i++) {
      c.beginPath();
      c.moveTo(x0 + 5, 175 + i * 7);
      c.lineTo(x0 + 145, 175 + i * 7);
      c.stroke();
    }
  }
}

/** Floor with perspective, by type. */
function floor(c: X, T: Theme, W: number, H: number): void {
  const [far, near] = T.floorColors;
  const vx = W * 0.47, vy = 60;
  const t0 = (HORIZON - vy) / (H - vy);
  const lineX = (i: number, y: number, step: number) => {
    const bx = vx + i * step;
    return vx + (bx - vx) * ((y - vy) / (H - vy));
  };
  const rowY = (k: number, n: number) => HORIZON + (H - HORIZON) * Math.pow(k / n, 1.6);
  if (T.floor === 'baldosa') {
    // Checkerboard with perspective: each square, its trapezoid.
    c.fillStyle = near;
    c.fillRect(0, HORIZON, W, H - HORIZON);
    c.fillStyle = far;
    const n = 9, step = 150;
    for (let k = 0; k < n; k++) {
      const y0 = rowY(k, n), y1 = rowY(k + 1, n);
      for (let i = -30; i < 30; i++) {
        if ((i + k) % 2 === 0) continue;
        c.beginPath();
        c.moveTo(lineX(i, y0, step), y0);
        c.lineTo(lineX(i + 1, y0, step), y0);
        c.lineTo(lineX(i + 1, y1, step), y1);
        c.lineTo(lineX(i, y1, step), y1);
        c.closePath();
        c.fill();
      }
    }
    c.fillStyle = linear(c, 0, HORIZON, 0, H, [[0, 'rgba(0,0,0,0.35)'], [1, 'rgba(0,0,0,0)']]);
    c.fillRect(0, HORIZON, W, H - HORIZON);
    return;
  }
  c.fillStyle = linear(c, 0, HORIZON, 0, H, [[0, far], [1, near]]);
  c.fillRect(0, HORIZON, W, H - HORIZON);
  if (T.floor === 'moqueta') {
    // Carpet: seamless, with some texture.
    const r = rng(17);
    for (let i = 0; i < 900; i++) {
      c.fillStyle = r() < 0.5 ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.05)';
      c.fillRect(r() * W, HORIZON + r() * (H - HORIZON), 3, 2);
    }
    return;
  }
  if (T.floor === 'tatami') {
    // Mats with their dark border.
    c.strokeStyle = 'rgba(40,50,20,0.7)';
    c.lineWidth = 5;
    for (let i = -8; i <= 8; i++) {
      c.beginPath();
      c.moveTo(lineX(i, HORIZON, 360), HORIZON);
      c.lineTo(vx + i * 360, H);
      c.stroke();
    }
    const y = rowY(4, 9);
    c.beginPath();
    c.moveTo(0, y);
    c.lineTo(W, y);
    c.stroke();
    c.strokeStyle = 'rgba(90,100,40,0.18)';
    c.lineWidth = 1;
    for (let k = 1; k < 40; k++) {
      const yy = HORIZON + (H - HORIZON) * Math.pow(k / 40, 1.4);
      c.beginPath();
      c.moveTo(0, yy);
      c.lineTo(W, yy);
      c.stroke();
    }
    return;
  }
  // Parquet, wide planks or dark arcade floor: boards receding to a vanishing point.
  const step = T.floor === 'tablones' ? 180 : 120;
  c.strokeStyle = T.floor === 'oscuro' ? 'rgba(60,220,255,0.12)' : 'rgba(20,12,6,0.45)';
  c.lineWidth = T.floor === 'tablones' ? 3 : 2;
  for (let i = -30; i <= 30; i++) {
    const bx = vx + i * step;
    c.beginPath();
    c.moveTo(vx + (bx - vx) * t0, HORIZON);
    c.lineTo(bx, H);
    c.stroke();
  }
  for (let k = 1; k < 9; k++) {
    const y = rowY(k, 9);
    c.strokeStyle = T.floor === 'oscuro' ? 'rgba(255,60,200,0.1)' : 'rgba(20,12,6,0.25)';
    c.beginPath();
    c.moveTo(0, y);
    c.lineTo(W, y);
    c.stroke();
  }
}

/** Rug in the center, in the rooms that have one. */
function rug(c: X, room: RoomName, W: number, H: number): void {
  const col = room === 'cabana' ? ['#8C2F2F', '#C8A060'] : room === 'arcade' ? ['#3A1A5A', '#FF3CC8'] : room === 'estudio' ? ['#5A2E3A', '#C8A060'] : null;
  if (!col) return;
  c.save();
  c.translate(W * 0.42, H - 60);
  c.scale(1, 0.22);
  c.fillStyle = col[0]!;
  ellipse(c, 0, 0, 520, 300);
  c.fill();
  c.strokeStyle = col[1]!;
  c.lineWidth = 14;
  ellipse(c, 0, 0, 470, 260);
  c.stroke();
  c.restore();
}

/** The plant next to the furniture, different in each room. */
function plant(c: X, room: RoomName): void {
  const pot = room === 'japonesa' ? '#3A2A1A' : room === 'oficina' || room === 'arcade' ? '#E8ECF2' : '#9A5A36';
  c.fillStyle = pot;
  c.beginPath();
  c.moveTo(330, 262);
  c.lineTo(378, 262);
  c.lineTo(372, 300);
  c.lineTo(336, 300);
  c.fill();
  if (room === 'cocina' || room === 'arcade') {
    // Cactus with arms.
    c.fillStyle = '#4A8A4A';
    c.beginPath();
    c.roundRect(344, 180, 20, 84, 10);
    c.fill();
    c.beginPath();
    c.roundRect(330, 206, 14, 34, 7);
    c.fill();
    c.beginPath();
    c.roundRect(364, 196, 14, 30, 7);
    c.fill();
    if (room === 'cocina') {
      c.fillStyle = '#FF5C8A';
      ellipse(c, 354, 178, 7, 5);
      c.fill();
    }
    return;
  }
  if (room === 'oficina') {
    // Sansevieria: tall, straight leaves.
    for (let i = 0; i < 7; i++) {
      c.fillStyle = i % 2 ? '#3E7A4A' : '#6EA86A';
      c.beginPath();
      c.moveTo(338 + i * 5, 262);
      c.quadraticCurveTo(334 + i * 6, 210, 342 + i * 4, 170 + (i % 3) * 14);
      c.lineTo(348 + i * 5, 262);
      c.fill();
    }
    return;
  }
  if (room === 'japonesa') {
    // Bamboo.
    for (const [x, h] of [[344, 120], [356, 150], [366, 104]] as const) {
      c.fillStyle = '#7AA84A';
      c.fillRect(x, 262 - h, 6, h);
      c.fillStyle = '#5A8A3A';
      for (let y = 262 - h + 20; y < 262; y += 26) c.fillRect(x - 1, y, 8, 3);
      c.fillStyle = '#6EA86A';
      ellipse(c, x + 14, 262 - h + 10, 14, 4, -0.4);
      c.fill();
    }
    return;
  }
  if (room === 'acuario' || room === 'atico') {
    // Monstera: large leaves with cuts.
    for (let i = 0; i < 6; i++) {
      const a = -2.4 + i * 0.36, x = 354 + Math.cos(a) * 36, y = 236 + Math.sin(a) * 40;
      c.fillStyle = i % 2 ? '#2E6A3A' : '#3E8A4A';
      ellipse(c, x, y, 24, 16, a);
      c.fill();
      c.strokeStyle = 'rgba(0,0,0,0.25)';
      c.lineWidth = 2;
      c.beginPath();
      c.moveTo(354, 250);
      c.lineTo(x, y);
      c.stroke();
    }
    return;
  }
  for (let i = 0; i < 9; i++) {
    c.fillStyle = room === 'cabana' ? (i % 2 ? '#2E5A3A' : '#3E6A4A') : i % 2 ? '#3E7A4A' : '#56995E';
    ellipse(c, 354 + Math.cos(i * 0.7) * 22, 238 - i * 6, 10, 26, -0.9 + i * 0.22);
    c.fill();
  }
}

/** Cat-shaped wall clock: ears, whiskers and the pendulum tail. */
export function wallClock(c: X, cx: number, cy: number, r: number, d: Date): void {
  const hh = d.getHours() % 12, mm = d.getMinutes();
  c.save();
  c.translate(cx, cy + r * 0.9);
  c.rotate(0.22);
  c.strokeStyle = '#1A1C24';
  c.lineWidth = r * 0.22;
  c.lineCap = 'round';
  c.beginPath();
  c.moveTo(0, 0);
  c.quadraticCurveTo(r * 0.25, r * 0.7, 0, r * 1.3);
  c.stroke();
  c.restore();
  c.fillStyle = 'rgba(0,0,0,0.35)';
  ellipse(c, cx + 6, cy + 8, r * 1.05, r * 1.05);
  c.fill();
  for (const s of [-1, 1]) {
    c.fillStyle = '#1A1C24';
    c.beginPath();
    c.moveTo(cx + s * r * 0.95, cy - r * 0.35);
    c.lineTo(cx + s * r * 0.75, cy - r * 1.35);
    c.lineTo(cx + s * r * 0.2, cy - r * 0.9);
    c.fill();
  }
  c.fillStyle = '#1A1C24';
  ellipse(c, cx, cy, r * 1.08, r * 1.08);
  c.fill();
  c.fillStyle = radial(c, cx - r * 0.3, cy - r * 0.3, 2, r, [[0, '#FFFFFF'], [1, '#E6E1D6']]);
  ellipse(c, cx, cy, r * 0.9, r * 0.9);
  c.fill();
  c.strokeStyle = '#2A2C34';
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * TAU, l = i % 3 === 0 ? 0.18 : 0.09;
    c.lineWidth = i % 3 === 0 ? 3 : 1.5;
    c.beginPath();
    c.moveTo(cx + Math.sin(a) * r * 0.82, cy - Math.cos(a) * r * 0.82);
    c.lineTo(cx + Math.sin(a) * r * (0.82 - l), cy - Math.cos(a) * r * (0.82 - l));
    c.stroke();
  }
  const hand = (a: number, len: number, wd: number) => {
    c.strokeStyle = '#1A1C24';
    c.lineWidth = wd;
    c.lineCap = 'round';
    c.beginPath();
    c.moveTo(cx, cy);
    c.lineTo(cx + Math.sin(a) * len, cy - Math.cos(a) * len);
    c.stroke();
  };
  hand(((hh + mm / 60) / 12) * TAU, r * 0.48, 5);
  hand((mm / 60) * TAU, r * 0.7, 3.5);
  c.fillStyle = '#C62A22';
  ellipse(c, cx, cy, 4, 4);
  c.fill();
  c.strokeStyle = '#1A1C24';
  c.lineWidth = 1.5;
  for (const s of [-1, 1]) {
    for (const dd of [-6, 6]) {
      c.beginPath();
      c.moveTo(cx + s * r * 1.05, cy + r * 0.3 + dd);
      c.lineTo(cx + s * r * 1.5, cy + r * 0.25 + dd * 1.6);
      c.stroke();
    }
  }
}

// ---------- Outdoors: Antarctica, desert and forest ----------

/**
 * What the outdoor rooms (like the beach) have in common: the lantern
 * post, which hangs where the others have the lamp; the clock post; the
 * dimness of the floor at night and the lantern's halo.
 */
function outdoorPosts(c: X, W: number, H: number, DL: number, post: string, clockOnTree = false): void {
  const lx = lampX(W);
  c.fillStyle = post;
  c.fillRect(lx + 60, 30, 10, 280);
  c.fillRect(lx - 4, 30, 74, 8);
  if (!clockOnTree) c.fillRect(1398, 120, 8, 190);
  if (DL < 1) {
    c.fillStyle = `rgba(10,14,30,${0.35 * (1 - DL)})`;
    c.fillRect(0, HORIZON - 4, W, H - HORIZON + 4);
  }
  const warm = '255,200,130';
  c.fillStyle = radial(c, lx, 70, 10, 360, [[0, `rgba(${warm},${0.3 * (1 - DL) + 0.03})`], [1, `rgba(${warm},0)`]]);
  c.fillRect(lx - 480, 0, 960, H);
  lamp(c, 'farol', lx, 36);
}

/**
 * Antarctica: ice up to the horizon, snowy mountains and, at night, the
 * austral aurora. Fixed points: a tall ice block on the left (the
 * shelf, where one sleeps), an ice floe where the windowsill falls, a
 * snowman where the plant goes, an orange base hut and penguins in the distance.
 */
function paintAntarctica(c: X, W: number, H: number, s: Sky): void {
  const DL = daylight(s.hour, riseOf(s), setOf(s));
  windowScene(c, s, 0, 0, W, HORIZON + 8, 'hielo');
  c.fillStyle = linear(c, 0, HORIZON - 4, 0, H, [[0, css(mix(hex('#2A3448'), hex('#D6E4F0'), DL))], [1, css(mix(hex('#3A4660'), hex('#F6FAFE'), DL))]]);
  c.fillRect(0, HORIZON - 4, W, H - HORIZON + 4);
  // Sastrugi (the ridges the wind leaves in snow) and sparkles.
  const r = rng(83);
  c.strokeStyle = `rgba(120,150,190,${0.18 + 0.12 * DL})`;
  c.lineWidth = 2;
  for (let i = 0; i < 70; i++) {
    const x = r() * W, y = HORIZON + 6 + r() * (H - HORIZON - 6), l = 30 + r() * 60;
    c.beginPath();
    c.moveTo(x, y);
    c.quadraticCurveTo(x + l / 2, y - 4, x + l, y);
    c.stroke();
  }
  for (let i = 0; i < 120; i++) {
    c.fillStyle = `rgba(255,255,255,${0.3 + 0.6 * DL * r()})`;
    c.fillRect(r() * W, HORIZON + r() * (H - HORIZON), 2, 2);
  }
  const ice = (a: string, b: string) => linear(c, 0, 40, 0, 300, [[0, css(mix(hex('#3A4A66'), hex(a), DL))], [1, css(mix(hex('#2A3650'), hex(b), DL))]]);
  // Tall ice block: one sleeps on its snowy top.
  c.fillStyle = ice('#CFE6F6', '#8DB6D8');
  c.beginPath();
  c.moveTo(118, 300);
  c.lineTo(128, 62);
  c.lineTo(250, 58);
  c.lineTo(262, 300);
  c.closePath();
  c.fill();
  c.fillStyle = `rgba(255,255,255,${0.2 + 0.2 * DL})`;
  c.fillRect(150, 70, 8, 220);
  c.fillRect(200, 80, 5, 200);
  c.fillStyle = css(mix(hex('#5A6A86'), hex('#FFFFFF'), DL));
  c.beginPath();
  c.moveTo(120, 64);
  c.quadraticCurveTo(185, 34, 252, 60);
  c.lineTo(252, 66);
  c.lineTo(120, 70);
  c.fill();
  // Ice floe where the windowsill falls.
  c.fillStyle = ice('#E2F0FA', '#9CC2E0');
  c.beginPath();
  c.moveTo(600, 266);
  c.lineTo(612, 226);
  c.lineTo(808, 224);
  c.lineTo(822, 266);
  c.closePath();
  c.fill();
  c.fillStyle = css(mix(hex('#6A7A96'), hex('#FFFFFF'), DL));
  c.fillRect(612, 222, 196, 6);
  // Snowman where the plant goes, with scarf and carrot nose.
  const snow = css(mix(hex('#8A98B0'), hex('#FFFFFF'), DL));
  for (const [cy, rr] of [[280, 22], [248, 16], [222, 12]] as const) {
    c.fillStyle = snow;
    ellipse(c, 358, cy, rr, rr);
    c.fill();
  }
  c.fillStyle = '#1A1A22';
  for (const dx of [-4, 4]) {
    ellipse(c, 358 + dx, 219, 1.8, 1.8);
    c.fill();
  }
  c.fillStyle = '#E8762A';
  c.beginPath();
  c.moveTo(358, 222);
  c.lineTo(372, 225);
  c.lineTo(358, 226);
  c.fill();
  c.fillStyle = '#C0392B';
  c.fillRect(346, 232, 24, 5);
  c.fillRect(364, 232, 5, 14);
  c.strokeStyle = '#5A3A22';
  c.lineWidth = 2;
  for (const k of [-1, 1]) {
    c.beginPath();
    c.moveTo(358 + k * 14, 246);
    c.lineTo(358 + k * 32, 234);
    c.stroke();
  }
  // Orange base hut, with its antenna, and penguins in the distance.
  c.fillStyle = css(mix(hex('#5A2A12'), hex('#E86A1E'), DL));
  c.fillRect(440, 246, 90, 32);
  c.fillStyle = css(mix(hex('#3A3A44'), hex('#E8ECF2'), DL));
  c.fillRect(436, 240, 98, 8);
  c.fillStyle = `rgba(255,220,140,${0.25 + 0.65 * (1 - DL)})`;
  c.fillRect(456, 254, 14, 10);
  c.fillRect(494, 254, 14, 10);
  c.strokeStyle = '#3A3F48';
  c.lineWidth = 2;
  c.beginPath();
  c.moveTo(520, 240);
  c.lineTo(520, 206);
  c.stroke();
  for (let i = 0; i < 7; i++) smallPenguin(c, 900 + i * 26 + (i % 2) * 6, 272 + (i % 3) * 3, 0.45 + (i % 3) * 0.05, DL);
  outdoorPosts(c, W, H, DL, '#5A6878');
}

/** A standing penguin, looking sideways; (x, y) are the feet. */
function smallPenguin(c: X, x: number, y: number, k: number, DL = 1, step = 0): void {
  c.save();
  c.translate(x, y);
  c.scale(k, k);
  c.fillStyle = '#F2A23A';
  c.fillRect(-12 + step * 4, -4, 10, 4);
  c.fillRect(2 - step * 4, -4, 10, 4);
  c.fillStyle = '#16181E';
  ellipse(c, 0, -34, 20, 32);
  c.fill();
  c.fillStyle = css(mix(hex('#8A90A0'), hex('#FFFFFF'), DL));
  ellipse(c, 4, -30, 13, 25);
  c.fill();
  c.fillStyle = '#16181E';
  ellipse(c, 0, -68, 14, 14);
  c.fill();
  c.fillStyle = '#FFFFFF';
  ellipse(c, 5, -70, 3, 3);
  c.fill();
  c.fillStyle = '#F2A23A';
  c.beginPath();
  c.moveTo(12, -68);
  c.lineTo(24, -65);
  c.lineTo(12, -63);
  c.fill();
  c.restore();
}

/**
 * The desert: dunes up to the horizon, a mesa and, at night, more
 * stars than anywhere. Fixed points: a rock chimney on the
 * left (the shelf), a sandstone slab where the windowsill falls, a flowering
 * cactus where the plant goes and a saguaro at the back.
 */
function paintDesert(c: X, W: number, H: number, s: Sky): void {
  const DL = daylight(s.hour, riseOf(s), setOf(s));
  windowScene(c, s, 0, 0, W, HORIZON + 8, 'dunas');
  c.fillStyle = linear(c, 0, HORIZON - 4, 0, H, [[0, css(mix(hex('#3A2A28'), hex('#E2AA6E'), DL))], [1, css(mix(hex('#4A3630'), hex('#F2C892'), DL))]]);
  c.fillRect(0, HORIZON - 4, W, H - HORIZON + 4);
  // Sand ripples and pebbles.
  const r = rng(97);
  c.strokeStyle = `rgba(150,90,40,${0.15 + 0.15 * DL})`;
  c.lineWidth = 2;
  for (let i = 0; i < 60; i++) {
    const x = r() * W, y = HORIZON + 8 + r() * (H - HORIZON - 8), l = 40 + r() * 80;
    c.beginPath();
    c.moveTo(x, y);
    c.bezierCurveTo(x + l * 0.3, y - 5, x + l * 0.6, y + 5, x + l, y);
    c.stroke();
  }
  for (let i = 0; i < 40; i++) {
    c.fillStyle = `rgba(110,70,40,${0.3 + 0.3 * r()})`;
    ellipse(c, r() * W, HORIZON + 10 + r() * (H - HORIZON - 10), 3 + r() * 3, 2 + r() * 2);
    c.fill();
  }
  const rock = (a: string) => css(mix(hex('#3A2422'), hex(a), DL));
  // Layered rock chimney, with its flat hat: one sleeps there.
  const bands = ['#B8693E', '#C97E4C', '#A85A36', '#C27648'];
  for (let i = 0; i < 8; i++) {
    const y0 = 66 + i * 30, half = 52 - Math.sin(i * 0.9) * 10;
    c.fillStyle = rock(bands[i % bands.length]!);
    c.fillRect(185 - half, y0, half * 2, 31);
  }
  c.fillStyle = rock('#8E4A2C');
  c.beginPath();
  c.moveTo(112, 70);
  c.lineTo(122, 56);
  c.lineTo(250, 54);
  c.lineTo(260, 70);
  c.closePath();
  c.fill();
  // Sandstone slab where the windowsill falls.
  c.fillStyle = rock('#C9784A');
  c.beginPath();
  c.moveTo(598, 266);
  c.lineTo(610, 228);
  c.lineTo(810, 226);
  c.lineTo(824, 266);
  c.closePath();
  c.fill();
  c.fillStyle = rock('#E09A64');
  c.fillRect(610, 224, 200, 6);
  // Saguaro at the back, with its arms.
  const cactus = css(mix(hex('#1E3A26'), hex('#4E8A4A'), DL));
  c.fillStyle = cactus;
  c.beginPath();
  c.roundRect(482, 150, 22, 140, 11);
  c.roundRect(456, 190, 14, 50, 7);
  c.roundRect(456, 232, 34, 12, 6);
  c.roundRect(516, 176, 14, 46, 7);
  c.roundRect(496, 214, 34, 12, 6);
  c.fill();
  // Round cactus with a flower where the plant goes.
  c.fillStyle = cactus;
  ellipse(c, 358, 276, 24, 22);
  c.fill();
  c.strokeStyle = `rgba(20,40,20,0.35)`;
  c.lineWidth = 2;
  for (const dx of [-12, 0, 12]) {
    c.beginPath();
    c.moveTo(358 + dx, 256);
    c.quadraticCurveTo(358 + dx * 1.3, 276, 358 + dx, 296);
    c.stroke();
  }
  c.fillStyle = '#E8549A';
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * TAU;
    ellipse(c, 358 + Math.cos(a) * 6, 252 + Math.sin(a) * 4, 5, 3.5, a);
    c.fill();
  }
  c.fillStyle = '#F2C21B';
  ellipse(c, 358, 252, 3, 3);
  c.fill();
  outdoorPosts(c, W, H, DL, '#7A5634');
}

/**
 * The forest: layered firs fading into the haze, grass and leaf litter
 * and, at night, fireflies. Fixed points: a big oak branch on the
 * left (the shelf), a fallen log where the windowsill falls, mushrooms where
 * the plant goes and another tree where the clock is nailed.
 */
function paintForest(c: X, W: number, H: number, s: Sky): void {
  const DL = daylight(s.hour, riseOf(s), setOf(s));
  windowScene(c, s, 0, 0, W, HORIZON + 8, 'bosque');
  c.fillStyle = linear(c, 0, HORIZON - 4, 0, H, [[0, css(mix(hex('#1A2A1A'), hex('#4E6E32'), DL))], [1, css(mix(hex('#22301E'), hex('#6E8A42'), DL))]]);
  c.fillRect(0, HORIZON - 4, W, H - HORIZON + 4);
  // Blades of grass and fallen leaves.
  const r = rng(131);
  for (let i = 0; i < 260; i++) {
    const x = r() * W, y = HORIZON + r() * (H - HORIZON);
    if (r() < 0.7) {
      c.strokeStyle = `rgba(${r() < 0.5 ? '120,170,70' : '60,100,40'},${0.35 + 0.35 * DL})`;
      c.lineWidth = 1.5;
      c.beginPath();
      c.moveTo(x, y);
      c.lineTo(x + (r() - 0.5) * 4, y - 6 - r() * 6);
      c.stroke();
    } else {
      c.fillStyle = `rgba(${['200,110,40', '220,170,60', '150,60,30'][Math.floor(r() * 3)]},${0.4 + 0.4 * DL})`;
      ellipse(c, x, y, 4, 2.5, r() * TAU);
      c.fill();
    }
  }
  const bark = css(mix(hex('#1E1612'), hex('#5E432C'), DL));
  const leaf = (k: number) => css(mix(hex('#0E1A10'), hex(['#2E5A2E', '#3E6E36', '#264E28'][k % 3]!), DL));
  // The oak: trunk on the left and a thick branch where one sleeps.
  c.fillStyle = bark;
  c.beginPath();
  c.moveTo(60, 300);
  c.lineTo(78, 0);
  c.lineTo(124, 0);
  c.lineTo(132, 300);
  c.closePath();
  c.fill();
  c.beginPath();
  c.moveTo(110, 58);
  c.quadraticCurveTo(180, 52, 262, 60);
  c.lineTo(262, 72);
  c.quadraticCurveTo(180, 66, 116, 84);
  c.closePath();
  c.fill();
  for (let i = 0; i < 9; i++) {
    c.fillStyle = leaf(i);
    ellipse(c, 40 + i * 34, 4 + (i % 3) * 10, 46, 30);
    c.fill();
  }
  // Fallen log where the windowsill falls, with its rings and moss.
  c.fillStyle = bark;
  c.beginPath();
  c.roundRect(604, 228, 212, 38, 18);
  c.fill();
  c.fillStyle = css(mix(hex('#3A2A1E'), hex('#C8A070'), DL));
  ellipse(c, 812, 247, 14, 18);
  c.fill();
  c.strokeStyle = css(mix(hex('#2A1E14'), hex('#8E6A44'), DL));
  c.lineWidth = 1.5;
  for (const rr of [5, 9, 13]) {
    ellipse(c, 812, 247, rr * 0.8, rr);
    c.stroke();
  }
  c.fillStyle = leaf(1);
  for (let i = 0; i < 10; i++) {
    ellipse(c, 620 + i * 18, 228, 10, 5);
    c.fill();
  }
  // Red mushrooms with spots where the plant goes.
  for (const [mx, top, rr] of [[346, 262, 16], [372, 272, 11], [360, 282, 8]] as const) {
    c.fillStyle = css(mix(hex('#4A443A'), hex('#F2ECDC'), DL));
    c.fillRect(mx - 4, top, 8, 296 - top);
    c.fillStyle = css(mix(hex('#4A1410'), hex('#D83A2E'), DL));
    c.beginPath();
    c.ellipse(mx, top, rr, rr * 0.7, 0, Math.PI, TAU);
    c.fill();
    c.fillStyle = '#FFFFFF';
    for (const d of [-0.5, 0, 0.45]) {
      ellipse(c, mx + d * rr, top - rr * 0.35, 2, 2);
      c.fill();
    }
  }
  // The clock tree, on the right.
  c.fillStyle = bark;
  c.beginPath();
  c.moveTo(1380, 300);
  c.lineTo(1388, 0);
  c.lineTo(1418, 0);
  c.lineTo(1428, 300);
  c.closePath();
  c.fill();
  outdoorPosts(c, W, H, DL, '#5E432C', true);
  // At night, fireflies.
  if (DL < 0.4) {
    const a = (0.4 - DL) / 0.4;
    const f = rng(137);
    for (let i = 0; i < 28; i++) {
      const x = f() * (W - 400), y = 120 + f() * (H - 160);
      c.fillStyle = radial(c, x, y, 0, 9, [[0, `rgba(230,255,120,${0.9 * a})`], [1, 'rgba(230,255,120,0)']]);
      c.fillRect(x - 9, y - 9, 18, 18);
    }
  }
}

// Gestures specific to each outdoor place: they pass through the background, behind
// the cats, and leave no trace (the first and last frame are not painted).

/** Antarctica: a penguin walks across waddling like a duck and ends up sliding on its belly. */
export function penguinCrossing(c: X, W: number, t: number): void {
  const y = HORIZON + 34, x0 = W * 0.78, x1 = W * 0.22;
  const walk = 0.6;
  if (t < walk) {
    const u = t / walk;
    const x = x0 + (x1 - x0) * 0.55 * u;
    const step = Math.round(u * 24) % 2;
    c.save();
    c.translate(x, y);
    c.rotate((step ? 1 : -1) * 0.12);
    c.scale(-1, 1);
    smallPenguin(c, 0, 0, 0.9, 1, step);
    c.restore();
    return;
  }
  // On its belly, faster, with trails in the snow.
  const u = (t - walk) / (1 - walk);
  const x = x0 + (x1 - x0) * (0.55 + 0.45 * u);
  c.save();
  c.strokeStyle = 'rgba(255,255,255,0.8)';
  c.lineWidth = 2;
  for (const dy of [-6, 0, 6]) {
    c.beginPath();
    c.moveTo(x + 30, y - 12 + dy);
    c.lineTo(x + 90, y - 12 + dy);
    c.stroke();
  }
  c.translate(x, y - 12);
  c.rotate(-Math.PI / 2);
  c.scale(1, -1);
  smallPenguin(c, 0, 26, 0.9, 1, 0);
  c.restore();
}

/** Desert: a tumbleweed bounces across. */
export function tumbleweed(c: X, W: number, t: number): void {
  const x = W * 0.12 + (W * 0.66) * t;
  const ground = HORIZON + 46;
  const hop = Math.abs(Math.sin(t * Math.PI * 5)) * 26;
  const y = ground - 22 - hop;
  c.save();
  c.fillStyle = `rgba(80,50,30,${0.25 - hop / 200})`;
  ellipse(c, x, ground, 24 - hop / 4, 5);
  c.fill();
  c.translate(x, y);
  c.rotate(t * 22);
  const r = rng(907);
  c.strokeStyle = '#8A6A3A';
  c.lineWidth = 1.6;
  for (let i = 0; i < 26; i++) {
    const a = r() * TAU, rr = 10 + r() * 12;
    c.beginPath();
    c.arc(r() * 6 - 3, r() * 6 - 3, rr, a, a + 1.5 + r() * 2);
    c.stroke();
  }
  c.restore();
}

/** Forest: a squirrel crosses in leaps, stops with an acorn and carries on. */
export function squirrelRun(c: X, W: number, t: number): void {
  const ground = HORIZON + 40;
  const stop = t > 0.42 && t < 0.62;
  const u = t < 0.42 ? t / 0.42 * 0.5 : stop ? 0.5 : 0.5 + (t - 0.62) / 0.38 * 0.5;
  const x = W * 0.2 + W * 0.56 * u;
  const hop = stop ? 0 : Math.abs(Math.sin(t * Math.PI * 9)) * 16;
  c.save();
  c.translate(x, ground - hop);
  // Huge S-shaped tail, body, head and ear.
  c.fillStyle = '#B8642A';
  c.beginPath();
  c.moveTo(-10, -10);
  c.bezierCurveTo(-36, -14, -40, -44, -22, -50);
  c.bezierCurveTo(-8, -54, -14, -36, -24, -34);
  c.bezierCurveTo(-30, -26, -16, -18, -6, -14);
  c.fill();
  ellipse(c, 0, -12, 13, 10);
  c.fill();
  ellipse(c, 12, -22, 8, 7);
  c.fill();
  c.beginPath();
  c.moveTo(10, -28);
  c.lineTo(13, -36);
  c.lineTo(16, -28);
  c.fill();
  c.fillStyle = '#F2D8B0';
  ellipse(c, 4, -9, 6, 5);
  c.fill();
  c.fillStyle = '#16181E';
  ellipse(c, 15, -24, 1.6, 1.6);
  c.fill();
  if (stop) {
    // The acorn, between the paws.
    c.fillStyle = '#8A5A2A';
    ellipse(c, 16, -14, 4, 5);
    c.fill();
    c.fillStyle = '#5A3A1A';
    c.fillRect(12, -20, 8, 3);
  }
  c.restore();
}

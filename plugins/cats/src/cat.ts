/**
 * The cats of cat mode: coats, poses and the pair scenes.
 *
 * Local coordinates: the origin is on the floor, at the center of the cat, and
 * the Y axis grows downward as in canvas. A sitting cat is about 310
 * units tall; whoever places it scales according to depth.
 *
 * Nothing painted here carries text or depends on the time: these are
 * pure drawings of their arguments, which is why `render.ts` can cache them.
 */
import {
  type Coat, type X, TAU, bezierPts, clamp, creamRamp, css, ellipse, eye, fur, furryShape, hashString, hex, linear, mix,
  radial, ramp, rng, smooth, sphereLight, tailAlong,
} from './paint.ts';
import type { Provider } from './types.ts';

const r5 = (a: string, b: string, c: string, d: string, e: string) => ({ deep: hex(a), dark: hex(b), mid: hex(c), light: hex(d), top: hex(e) });
const CREAM = { dark: hex('#E3C49A'), mid: hex('#FBEBD3'), light: hex('#FFFFFF') };
const EYE_GREEN: Coat['eye'] = [[0, '#F4FFB0'], [0.35, '#B6E65A'], [0.75, '#5FA82C'], [0.92, '#2F6A1A'], [1, '#1A3A0E']];
const EYE_AMBER: Coat['eye'] = [[0, '#FFF3B0'], [0.35, '#F2C94C'], [0.75, '#C7881E'], [0.92, '#7A4E0E'], [1, '#3E2606']];
const EYE_BLUE: Coat['eye'] = [[0, '#E6F7FF'], [0.35, '#8FD3FF'], [0.75, '#3C8FD9'], [0.92, '#1F5A9E'], [1, '#10305A']];

/** Available coats. Each session gets a fixed one, derived from its id. */
export const COATS: Record<string, Coat> = {
  canela: { fur: r5('#8A3E0E', '#C0621E', '#EE9440', '#FFC27C', '#FFE0B0'), stripe: hex('#A2480F'), stripeK: 0.85, cream: CREAM, eye: EYE_GREEN },
  humo: {
    fur: r5('#2E333B', '#555C66', '#8A929C', '#BCC3CB', '#E2E6EA'), stripe: hex('#353A42'), stripeK: 0.85,
    cream: { dark: hex('#C9CED4'), mid: hex('#EDF0F2'), light: hex('#FFFFFF') }, eye: EYE_AMBER,
  },
  carbon: {
    fur: r5('#0C0E14', '#181B24', '#262B37', '#3E4760', '#63708E'), stripe: hex('#0C0E14'), stripeK: 0.15,
    cream: { dark: hex('#1E222C'), mid: hex('#2A2F3C'), light: hex('#3A4154') }, eye: EYE_AMBER,
  },
  nata: { fur: r5('#B09070', '#D2B690', '#EBD8BA', '#FFF0DA', '#FFFFFF'), stripe: hex('#C49E72'), stripeK: 0.45, cream: CREAM, eye: EYE_BLUE },
  tofe: { fur: r5('#3A2412', '#6B4526', '#9C6E42', '#C99A68', '#E8C49A'), stripe: hex('#2A170A'), stripeK: 0.9, cream: CREAM, eye: EYE_GREEN },
};
export const COAT_NAMES = Object.keys(COATS);

/** Stable coat for a session: the same cat for its whole life. */
export function coatFor(sessionId: string): string {
  return COAT_NAMES[hashString(sessionId) % COAT_NAMES.length]!;
}

/**
 * The collar tells the provider: orange for Claude, blue for Gemini and purple
 * for the GitLab Runner cat (see src/runner.ts).
 */
export function collarFor(provider: Provider): string {
  if (provider === 'gitlab-runner') return '#7B5CD6';
  return provider === 'gemini' ? '#3F7FE0' : '#D9663A';
}

export type Mood = 'open' | 'wide' | 'happy' | 'angry';

/**
 * State of a gesture, everything at zero at rest. Each value is quantized before
 * getting here (see `anim.ts`): every combination is a different cat that has
 * to be painted in full, and this way they fit in the cache.
 */
export interface Pose {
  /** Eyelid: 0 open, 1 closed. */
  lid?: number;
  /** Tail flick: -1..1, rotating the tail about its root. */
  swing?: number;
  /** Yawn: 0..1, mouth open and eyes half-closed. */
  yawn?: number;
  /** Right ear that shakes: 0..1. */
  ear?: number;
}

/** Rotates a tail's control points around its base. */
function swingTail(pts: [number, number][], swing: number): [number, number][] {
  if (!swing) return pts;
  const [bx, by] = pts[0]!;
  const a = swing * 0.45;
  const ca = Math.cos(a), sa = Math.sin(a);
  return pts.map(([x, y], i) => {
    if (i === 0) return [x, y];
    const dx = x - bx, dy = y - by;
    return [bx + dx * ca - dy * sa, by + dx * sa + dy * ca];
  });
}

/** Eyelid lowering over an open eye, with fur and the lash line. */
function eyelid(c: X, coat: Coat, ex: number, ey: number, rx: number, ry: number, lid: number): void {
  if (lid <= 0) return;
  const R = ry + 3.5;
  const closed = lid >= 1;
  // Fully closed, the eyelid covers the whole eye but the line sits a bit
  // below the center, which is where real eyelids meet.
  const cover = closed ? ey + R : ey - R + 2 * R * lid;
  const lash = closed ? ey + R * 0.3 : cover;
  const socket = (cc: X) => ellipse(cc, ex, ey, rx + 3.5, R);
  c.save();
  socket(c);
  c.clip();
  c.fillStyle = linear(c, 0, ey - R, 0, cover, [[0, css(coat.fur.light)], [1, css(coat.fur.mid)]]);
  c.fillRect(ex - rx - 5, ey - R - 2, rx * 2 + 10, cover - (ey - R) + 2);
  c.restore();
  // Short fur over the eyelid: without it, a flat disc is seen covering the eye.
  fur(c, coat, (cc) => {
    cc.beginPath();
    cc.rect(ex - rx - 5, ey - R - 2, rx * 2 + 10, cover - (ey - R) + 2);
    cc.clip();
    socket(cc);
  }, [ex - rx - 4, ey - R, ex + rx + 4, cover], 260, {
    seed: Math.round(ex * 3 + lid * 10), light: (_x, y) => 0.62 - (y - (ey - R)) / (4 * R), dir: () => Math.PI / 2, len: [4, 7], width: 1.2,
  });
  c.strokeStyle = '#2A1206';
  c.lineWidth = closed ? 4 : 3.5;
  c.lineCap = 'round';
  c.beginPath();
  const w = Math.sqrt(Math.max(0, 1 - ((lash - ey) / R) ** 2)) * (rx + 3);
  c.moveTo(ex - w, lash - (closed ? 3 : 0));
  c.quadraticCurveTo(ex, lash + (closed ? 6 : 4), ex + w, lash - (closed ? 3 : 0));
  c.stroke();
}

// ---------- Shared silhouettes ----------
const angDist = (a: number, b: number) => Math.abs(((a - b + Math.PI * 3) % TAU) - Math.PI);
/** Furry cheeks; `puff` bristles the whole head (angry). */
const headFluff = (puff: number) => (a: number) => {
  const d = Math.min(angDist(a, 0.35), angDist(a, Math.PI - 0.35));
  return Math.max(puff * (0.6 + 0.4 * Math.abs(Math.cos(a * 7))), d < 0.55 ? 0.09 * (1 - d / 0.55) : 0);
};
const headShape = (puff = 0) => (c: X) => furryShape(c, 0, -196, 96, 70, 2.3, headFluff(puff), 11);
const body = (c: X) => {
  c.beginPath();
  c.moveTo(-46, -2);
  c.bezierCurveTo(-92, -6, -88, -116, -40, -142);
  c.lineTo(40, -142);
  c.bezierCurveTo(88, -116, 92, -6, 46, -2);
  c.closePath();
};
const ear = (c: X, s: number) => {
  c.beginPath();
  c.moveTo(s * 86, -218);
  c.bezierCurveTo(s * 88, -260, s * 80, -296, s * 66, -310);
  c.bezierCurveTo(s * 52, -300, s * 34, -280, s * 20, -258);
  c.closePath();
};
const innerEar = (c: X, s: number) => {
  c.beginPath();
  c.moveTo(s * 74, -230);
  c.bezierCurveTo(s * 76, -262, s * 72, -284, s * 64, -294);
  c.bezierCurveTo(s * 54, -284, s * 44, -270, s * 34, -254);
  c.closePath();
};

function contactShadow(c: X, rx: number): void {
  c.fillStyle = radial(c, 0, 0, 0, rx, [[0, 'rgba(0,0,0,0.5)'], [1, 'rgba(0,0,0,0)']]);
  ellipse(c, 0, 0, rx, 16);
  c.fill();
}

function furryEars(c: X, coat: Coat, angry: boolean, inner: boolean, twitch = 0): void {
  for (const s of [-1, 1]) {
    c.save();
    if (twitch && s > 0) {
      c.translate(50, -236);
      c.rotate(-0.32 * twitch);
      c.translate(-50, 236);
    }
    // Angry: ears flat, pointing back
    if (angry) {
      c.translate(s * 50, -236);
      c.rotate(s * 0.85);
      c.scale(1, 0.8);
      c.translate(-s * 50, 236);
    }
    ear(c, s);
    c.fillStyle = css(coat.fur.dark);
    c.fill();
    fur(c, coat, (cc) => ear(cc, s), [s > 0 ? 15 : -92, -315, s > 0 ? 92 : -15, -212], 650, {
      seed: 60 + s, light: (x, y) => 0.35 + (-(y + 260) / 90) * 0.2 - (s * (x - s * 60)) / 200, dir: () => -Math.PI / 2 - s * 0.35, len: [5, 9],
    });
    if (inner) {
      innerEar(c, s);
      c.fillStyle = linear(c, s * 64, -294, s * 52, -236, [[0, '#B8465E'], [0.6, '#F29AAE'], [1, '#FFC6D2']]);
      c.fill();
      const r = rng(70 + s);
      c.strokeStyle = 'rgba(255,248,236,0.6)';
      c.lineCap = 'round';
      for (let i = 0; i < 16; i++) {
        const bx = s * (40 + r() * 28), by = -236 - r() * 16;
        c.lineWidth = 1 + r();
        c.beginPath();
        c.moveTo(bx, by);
        c.quadraticCurveTo(bx + s * (r() * 8), by - 16, bx + s * (4 + r() * 10), by - 26 - r() * 18);
        c.stroke();
      }
    }
    c.restore();
  }
}

function furryBody(c: X, coat: Coat, seed: number, back: boolean): void {
  body(c);
  c.fillStyle = radial(c, -14, -100, 10, 130, [[0, css(coat.fur.light)], [0.5, css(coat.fur.mid)], [1, css(coat.fur.dark)]]);
  c.fill();
  fur(c, coat, body, [-95, -150, 95, 0], back ? 2600 : 3200, {
    seed, light: sphereLight(-4, -70, 90, 90), dir: (x) => Math.PI / 2 + x * 0.006,
    stripe: back
      ? (x, y) => Math.max(1 - smooth(3, 8, Math.abs(x)), smooth(0.5, 0.85, Math.sin(y * 0.1 + Math.abs(x) * 0.04)))
      : (x, y) => (Math.abs(x) > 38 ? smooth(0.55, 0.85, Math.sin(y * 0.11 + Math.abs(x) * 0.05)) : 0),
    cream: back ? undefined : (x, y) => 1 - smooth(0.75, 1.05, Math.hypot(x / 38, (y + 62) / 60)),
  });
  c.save();
  body(c);
  c.clip();
  c.fillStyle = radial(c, 0, -140, 0, 80, [[0, 'rgba(80,25,0,0.6)'], [1, 'rgba(80,25,0,0)']]);
  ellipse(c, 0, -140, 90, 34);
  c.fill();
  c.restore();
}

// ---------- Poses ----------

/** Sitting front-on, looking at you. */
export function frontCat(c: X, coat: Coat, o: { mood?: Mood; collar?: string; shadow?: boolean; pose?: Pose; dilate?: boolean } = {}): void {
  const g = o.pose ?? {};
  const mood = o.mood ?? 'open';
  const angry = mood === 'angry';
  const head = headShape(angry ? 0.13 : 0);
  if (o.shadow !== false) {
    contactShadow(c, 120);
    c.fillStyle = 'rgba(0,0,0,0.55)';
    ellipse(c, 0, -1, 62, 5);
    c.fill();
  }
  tailAlong(c, coat, bezierPts(swingTail([[42, -16], [116, -20], [134, -84], [100, -136]], g.swing ?? 0)), 5, angry ? 1.9 : 1);
  furryBody(c, coat, 2, false);

  // Front paws with toes
  for (const s of [-1, 1]) {
    const paw = (cc: X) => furryShape(cc, s * 23, -11, 21, 13, 2.2, (a) => (Math.sin(a) < -0.3 ? 0.05 : 0), 30 + s);
    paw(c);
    c.fillStyle = css(coat.cream.mid);
    c.fill();
    fur(c, coat, paw, [s * 23 - 24, -26, s * 23 + 24, 3], 260, {
      seed: 40 + s, light: sphereLight(s * 23, -14, 22, 14), dir: () => Math.PI / 2, len: [4, 7], width: 1.2, cream: () => 1,
    });
    c.strokeStyle = 'rgba(150,100,60,0.6)';
    c.lineWidth = 1.6;
    for (const d of [-7, 0, 7]) {
      c.beginPath();
      c.moveTo(s * 23 + d, -1);
      c.lineTo(s * 23 + d * 1.1, -9);
      c.stroke();
    }
  }

  furryEars(c, coat, angry, true, g.ear ?? 0);

  head(c);
  c.fillStyle = radial(c, -10, -206, 10, 120, [[0, css(coat.fur.light)], [0.55, css(coat.fur.mid)], [1, css(coat.fur.dark)]], -36, -240);
  c.fill();
  fur(c, coat, head, [-115, -275, 115, -115], 5200, {
    seed: 9, light: sphereLight(-6, -198, 100, 80),
    // The face fur starts at the nose and fans outward
    dir: (x, y) => Math.atan2(y + 158, x),
    stripe: (x, y) => {
      let v = 0;
      // Forehead stripes in an "M"
      for (const sx of [-20, 0, 20]) v = Math.max(v, (1 - smooth(3, 7, Math.abs(x - sx * (1 + (y + 262) / 200)))) * (1 - smooth(-238, -222, y)));
      if (Math.abs(x) > 64) v = Math.max(v, smooth(0.5, 0.9, Math.sin((y + 196) * 0.3 - 0.5)) * smooth(64, 80, Math.abs(x)));
      return v;
    },
    cream: (x, y) => {
      const m = 1 - smooth(0.7, 1.05, Math.min(Math.hypot((x + 16) / 24, (y + 150) / 19), Math.hypot((x - 16) / 24, (y + 150) / 19)));
      const chin = 1 - smooth(0.7, 1.1, Math.hypot(x / 20, (y + 134) / 10));
      return Math.max(m, chin);
    },
  });
  c.save();
  head(c);
  c.clip();
  c.strokeStyle = linear(c, 0, -266, 100, -170, [[0, 'rgba(255,236,200,0)'], [0.55, 'rgba(255,236,200,0.35)'], [1, 'rgba(255,236,200,0)']]);
  c.lineWidth = 7;
  head(c);
  c.stroke();
  c.restore();

  // Eyes
  if (mood === 'happy') {
    c.strokeStyle = '#3A1A08';
    c.lineWidth = 4.5;
    c.lineCap = 'round';
    for (const s of [-1, 1]) {
      c.beginPath();
      c.moveTo(s * 38 - 17, -192);
      c.quadraticCurveTo(s * 38, -210, s * 38 + 17, -192);
      c.stroke();
    }
    c.fillStyle = 'rgba(255,120,140,0.35)';
    ellipse(c, -62, -172, 14, 8);
    c.fill();
    ellipse(c, 62, -172, 14, 8);
    c.fill();
  } else {
    const wide = mood === 'wide';
    // In the small hours, in the dim light, the pupil almost eats the iris.
    const pupil = o.dilate && !angry ? 21 : wide ? 15 : angry ? 3.5 : 9;
    for (const s of [-1, 1]) eye(c, coat.eye, s * 38, -198, wide ? 28 : 26, wide ? 32 : 29, pupil);
    const lid = Math.max(g.lid ?? 0, (g.yawn ?? 0) * 0.8);
    if (!angry && lid > 0) for (const s of [-1, 1]) eyelid(c, coat, s * 38, -198, wide ? 28 : 26, wide ? 32 : 29, lid);
    if (angry) {
      for (const s of [-1, 1]) {
        // Eyelid lowered diagonally: the frown
        c.fillStyle = css(coat.fur.dark);
        c.beginPath();
        c.moveTo(s * 4, -236);
        c.lineTo(s * 70, -236);
        c.lineTo(s * 70, -214);
        c.lineTo(s * 8, -196);
        c.closePath();
        c.fill();
        c.strokeStyle = '#2A1206';
        c.lineWidth = 3.5;
        c.beginPath();
        c.moveTo(s * 8, -196);
        c.lineTo(s * 68, -214);
        c.stroke();
      }
    }
  }

  // Whisker pads, nose and mouth
  c.fillStyle = 'rgba(120,70,40,0.55)';
  for (const s of [-1, 1]) {
    for (const [dx, dy] of [[14, -154], [20, -150], [26, -154], [18, -145], [24, -142]] as const) {
      ellipse(c, s * dx, dy, 1.3, 1.3);
      c.fill();
    }
  }
  c.beginPath();
  c.moveTo(-11, -168);
  c.bezierCurveTo(-4, -172, 4, -172, 11, -168);
  c.bezierCurveTo(10, -160, 4, -155, 0, -154);
  c.bezierCurveTo(-4, -155, -10, -160, -11, -168);
  c.fillStyle = radial(c, -3, -166, 1, 14, [[0, '#FFC9D4'], [0.6, '#EE7F96'], [1, '#B8465E']]);
  c.fill();
  c.strokeStyle = '#7A2A38';
  c.lineWidth = 1.5;
  c.stroke();
  c.fillStyle = 'rgba(255,255,255,0.7)';
  ellipse(c, -4, -167, 3, 1.5);
  c.fill();
  c.strokeStyle = '#5A2410';
  c.lineWidth = 2.2;
  c.lineCap = 'round';
  if (angry) {
    // Hiss: mouth open with fangs
    c.fillStyle = '#4A0E14';
    ellipse(c, 0, -138, 17, 12);
    c.fill();
    c.fillStyle = '#E0607A';
    ellipse(c, 0, -132, 9, 5);
    c.fill();
    c.fillStyle = '#FFFFFF';
    for (const s of [-1, 1]) {
      c.beginPath();
      c.moveTo(s * 12, -148);
      c.lineTo(s * 7, -148);
      c.lineTo(s * 9.5, -137);
      c.fill();
    }
    c.beginPath();
    c.moveTo(0, -154);
    c.lineTo(0, -150);
    c.stroke();
  } else if ((g.yawn ?? 0) > 0) {
    // Yawn: the mouth opens downward, with tongue and fangs
    const y = g.yawn!;
    const my = -140 + 5 * y, rx = 9 + 11 * y, ry = 3 + 15 * y;
    c.fillStyle = '#4A0E14';
    ellipse(c, 0, my, rx, ry);
    c.fill();
    c.fillStyle = '#E0607A';
    ellipse(c, 0, my + ry * 0.5, rx * 0.65, ry * 0.45);
    c.fill();
    c.fillStyle = '#FFFFFF';
    for (const s of [-1, 1]) {
      c.beginPath();
      c.moveTo(s * rx * 0.75, my - ry * 0.55);
      c.lineTo(s * rx * 0.45, my - ry * 0.55);
      c.lineTo(s * rx * 0.6, my - ry * 0.55 + 4 + 5 * y);
      c.fill();
    }
    c.beginPath();
    c.moveTo(0, -154);
    c.lineTo(0, my - ry);
    c.stroke();
  } else {
    const k = mood === 'happy' ? 1.35 : 1;
    c.beginPath();
    c.moveTo(0, -154);
    c.lineTo(0, -147);
    c.bezierCurveTo(-4 * k, -140 - (k - 1) * 8, -12 * k, -140, -16 * k, -146);
    c.moveTo(0, -147);
    c.bezierCurveTo(4 * k, -140 - (k - 1) * 8, 12 * k, -140, 16 * k, -146);
    c.stroke();
  }
  whiskers(c, 36, -150);

  // Collar half hidden in the chest fur
  c.strokeStyle = o.collar ?? '#C8303F';
  c.lineWidth = 9;
  c.beginPath();
  c.moveTo(-48, -136);
  c.quadraticCurveTo(0, -116, 48, -136);
  c.stroke();
  c.strokeStyle = 'rgba(255,255,255,0.25)';
  c.lineWidth = 2;
  c.beginPath();
  c.moveTo(-46, -139);
  c.quadraticCurveTo(0, -120, 46, -139);
  c.stroke();
  const rc = rng(90);
  const cr = creamRamp(coat);
  for (let i = 0; i < 60; i++) {
    const x = (rc() - 0.5) * 70, y = -126 + (x / 48) ** 2 * -10 + 2;
    c.strokeStyle = css(ramp(0.55 + rc() * 0.3, cr), 0.85);
    c.lineWidth = 1.4;
    c.beginPath();
    c.moveTo(x, y);
    c.lineTo(x + (rc() - 0.5) * 4, y + 7 + rc() * 8);
    c.stroke();
  }
  c.fillStyle = radial(c, -3, -117, 1, 12, [[0, '#FFF6B0'], [0.55, '#F5C534'], [1, '#9A6C08']]);
  ellipse(c, 0, -114, 10.5, 10.5);
  c.fill();
  c.strokeStyle = '#7A5406';
  c.lineWidth = 1.2;
  c.stroke();
}

function whiskers(c: X, x0Abs: number, y: number): void {
  for (const s of [-1, 1]) {
    for (const [dy, ey, len] of [[-3, -12, 108], [3, 2, 118], [9, 16, 104]] as const) {
      const x0 = s * x0Abs, y0 = y + dy, x1 = s * (30 + len), y1 = y + ey;
      const mx = (x0 + x1) / 2, my = Math.min(y0, y1) - 8;
      for (const [w, a, t] of [[2.4, 0.9, 0.5], [1.4, 0.75, 0.8], [0.7, 0.5, 1]] as const) {
        c.strokeStyle = `rgba(255,255,255,${a})`;
        c.lineWidth = w;
        c.beginPath();
        c.moveTo(x0, y0);
        c.quadraticCurveTo(x0 + (mx - x0) * t * 1.2, y0 + (my - y0) * t * 1.2, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t);
        c.stroke();
      }
    }
  }
}

export function laptop(c: X, halfW: number): void {
  c.fillStyle = radial(c, 0, -150, 10, halfW + 30, [[0, 'rgba(120,190,255,0.45)'], [1, 'rgba(120,190,255,0)']]);
  ellipse(c, 0, -150, halfW + 30, 125);
  c.fill();
  c.fillStyle = '#9AA3AE';
  c.beginPath();
  c.roundRect(-halfW, -252, halfW * 2, 172, 10);
  c.fill();
  c.fillStyle = '#C9D0D8';
  c.fillRect(-halfW + 9, -246, halfW * 2 - 18, 4);
  c.fillStyle = '#6B7380';
  c.fillRect(-halfW - 25, -80, halfW * 2 + 50, 12);
  c.fillStyle = '#E0663A';
  ellipse(c, halfW * 0.78, -222, 12, 12);
  c.fill();
  c.fillStyle = '#FFD08A';
  ellipse(c, halfW * 0.78, -222, 5, 5);
  c.fill();
}

/** From behind, facing the laptop. The screen outlines it in blue. */
export function backCat(c: X, coat: Coat, seed: number, o: { laptop?: boolean; tail?: boolean; pose?: Pose } = {}): void {
  const g = o.pose ?? {};
  contactShadow(c, 125);
  if (o.laptop !== false) laptop(c, 165);
  if (o.tail !== false) tailAlong(c, coat, bezierPts(swingTail([[40, -10], [130, -4], [150, -44], [112, -62]], (g.swing ?? 0) * 0.7)), seed + 1);
  furryBody(c, coat, seed + 2, true);
  furryEars(c, coat, false, false, g.ear ?? 0);
  const head = headShape(0);
  head(c);
  c.fillStyle = radial(c, -10, -206, 10, 120, [[0, css(coat.fur.light)], [0.55, css(coat.fur.mid)], [1, css(coat.fur.dark)]], -36, -240);
  c.fill();
  fur(c, coat, head, [-115, -275, 115, -115], 3800, {
    seed: seed + 9, light: sphereLight(-6, -198, 100, 80), dir: (x) => Math.PI / 2 + x * 0.005,
    stripe: (x, y) => {
      let v = 0;
      for (const sx of [-26, 0, 26]) v = Math.max(v, (1 - smooth(4, 9, Math.abs(x - sx))) * (1 - smooth(-200, -170, y)));
      return v;
    },
  });
  // Screen light only on the outer contour: the whole head and ears,
  // the body below the chin. Otherwise the line between
  // head and body stands out and the cat looks made of glass.
  c.save();
  c.globalCompositeOperation = 'source-atop';
  // Thin and faint: at 8 px and 50 % it looked like a glass cat. The light only
  // has to hint at the screen in front of it.
  c.strokeStyle = 'rgba(160,215,255,0.3)';
  c.lineWidth = 4;
  head(c);
  c.stroke();
  for (const s of [-1, 1]) {
    ear(c, s);
    c.stroke();
  }
  c.beginPath();
  c.rect(-200, -126, 400, 130);
  c.clip();
  body(c);
  c.stroke();
  c.restore();
}

/** Curled up and asleep. */
export function sleepCat(c: X, coat: Coat, seed: number, o: { cushion?: boolean } = {}): void {
  if (o.cushion !== false) {
    c.fillStyle = radial(c, 0, 0, 0, 150, [[0, 'rgba(0,0,0,0.5)'], [1, 'rgba(0,0,0,0)']]);
    ellipse(c, 0, 0, 160, 18);
    c.fill();
    c.fillStyle = radial(c, -20, -30, 10, 170, [[0, '#D8605A'], [1, '#8E2F2C']]);
    ellipse(c, 0, -18, 165, 30);
    c.fill();
    c.strokeStyle = '#F2C94C';
    c.lineWidth = 3;
    c.setLineDash([6, 6]);
    ellipse(c, 0, -18, 150, 24);
    c.stroke();
    c.setLineDash([]);
  }
  const bd = (cc: X) => furryShape(cc, 12, -60, 112, 46, 2, (a) => (Math.sin(a) < -0.2 ? 0.04 : 0), seed);
  bd(c);
  c.fillStyle = css(coat.fur.mid);
  c.fill();
  fur(c, coat, bd, [-110, -112, 130, -10], 3600, {
    seed: seed + 1, light: sphereLight(0, -70, 120, 55), dir: (x, y) => Math.atan2(y + 60, x - 12) + Math.PI / 2,
    stripe: (x) => smooth(0.55, 0.85, Math.sin(x * 0.085)),
  });
  tailAlong(c, coat, bezierPts([[118, -44], [124, -2], [10, 0], [-44, -12]]), seed + 2);
  for (const [x0, y0, x1, y1, x2, y2] of [[-110, -76, -122, -126, -82, -92], [-66, -92, -52, -136, -34, -84]] as const) {
    const e = (cc: X) => {
      cc.beginPath();
      cc.moveTo(x0, y0);
      cc.quadraticCurveTo(x1 + 4, y1 + 6, x1, y1);
      cc.quadraticCurveTo(x1 + 10, y1 + 8, x2, y2);
      cc.closePath();
    };
    e(c);
    c.fillStyle = css(coat.fur.dark);
    c.fill();
    fur(c, coat, e, [-130, -140, -30, -76], 300, { seed: seed + 3, light: () => 0.45, dir: () => -Math.PI / 2, len: [4, 7] });
  }
  const hd = (cc: X) => furryShape(cc, -72, -56, 52, 41, 2.2, (a) => (Math.cos(a) < -0.5 ? 0.06 : 0), seed + 4);
  hd(c);
  c.fillStyle = css(coat.fur.mid);
  c.fill();
  fur(c, coat, hd, [-130, -100, -15, -12], 1800, {
    seed: seed + 5, light: sphereLight(-80, -66, 55, 45), dir: (x, y) => Math.atan2(y + 44, x + 84),
    stripe: (x, y) => (1 - smooth(3, 6, Math.abs(((x + 200) % 16) - 8))) * (1 - smooth(-84, -74, y)),
    cream: (x, y) => 1 - smooth(0.7, 1.05, Math.hypot((x + 86) / 26, (y + 36) / 15)),
  });
  c.strokeStyle = '#3A1A08';
  c.lineWidth = 3.2;
  c.lineCap = 'round';
  for (const ex of [-96, -58]) {
    c.beginPath();
    c.moveTo(ex - 11, -60);
    c.quadraticCurveTo(ex, -52, ex + 11, -60);
    c.stroke();
  }
  c.fillStyle = '#E0708A';
  ellipse(c, -80, -44, 5.5, 3.8);
  c.fill();
  c.strokeStyle = 'rgba(255,255,255,0.75)';
  c.lineWidth = 1.2;
  for (const d of [-4, 4]) {
    c.beginPath();
    c.moveTo(-100, -40 + d);
    c.lineTo(-150, -44 + d * 2);
    c.stroke();
  }
  c.strokeStyle = 'rgba(200,230,255,0.9)';
  c.lineWidth = 2.5;
  ellipse(c, -106, -40, 13, 13);
  c.stroke();
  c.fillStyle = 'rgba(200,230,255,0.2)';
  c.fill();
  c.fillStyle = '#FFFFFF';
  ellipse(c, -111, -45, 3.5, 3.5);
  c.fill();
}

// ---------- Boxes ----------
export function boxFront(c: X, x: number, y: number, w: number, h: number, label?: string, font?: string): void {
  c.fillStyle = linear(c, x, y, x + w, y + h, [[0, '#D8A966'], [1, '#A87838']]);
  c.fillRect(x, y, w, h);
  c.fillStyle = 'rgba(0,0,0,0.14)';
  c.fillRect(x + w * 0.78, y, w * 0.22, h);
  c.fillStyle = 'rgba(255,255,255,0.12)';
  c.fillRect(x, y, w, 4);
  const r = rng(Math.round(x * 13 + w));
  c.strokeStyle = 'rgba(120,70,20,0.18)';
  c.lineWidth = 1;
  for (let i = 0; i < 40; i++) {
    const yy = y + r() * h;
    c.beginPath();
    c.moveTo(x + r() * w, yy);
    c.lineTo(x + r() * w, yy + (r() - 0.5) * 3);
    c.stroke();
  }
  if (label && font) {
    c.fillStyle = 'rgba(110,50,15,0.75)';
    c.font = font;
    c.fillText(label, x + w * 0.12, y + h * 0.62);
  }
  c.fillStyle = 'rgba(0,0,0,0.35)';
  ellipse(c, x + w / 2, y + h + 2, w * 0.55, 8);
  c.fill();
}

/** Ready: asleep inside an open box. "If it fits, it sleeps." */
export function boxSleeper(c: X, coat: Coat, seed: number, font: string, label = 'FRÁGIL'): void {
  c.fillStyle = '#7A5428';
  c.beginPath();
  c.moveTo(-150, -130);
  c.lineTo(-120, -168);
  c.lineTo(120, -168);
  c.lineTo(150, -130);
  c.fill();
  c.save();
  // Peeks out just above the rim: the back and the head, not the paws.
  c.translate(6, -96);
  c.scale(0.86, 0.86);
  sleepCat(c, coat, seed, { cushion: false });
  c.restore();
  boxFront(c, -150, -130, 300, 130, label, font);
  c.fillStyle = '#C79656';
  c.beginPath();
  c.moveTo(-150, -130);
  c.lineTo(-196, -168);
  c.lineTo(-184, -118);
  c.closePath();
  c.fill();
  c.beginPath();
  c.moveTo(150, -130);
  c.lineTo(196, -168);
  c.lineTo(184, -118);
  c.closePath();
  c.fill();
}

/**
 * Halloween or Tuesday the 13th: in the box, instead of the sleeping cat, a ghost in a
 * sheet peeking over the rim. `rise` 0..1 lifts it a bit more (the "boo!").
 */
export function boxGhost(c: X, font: string, rise = 0, sway = 0, label = 'FRÁGIL'): void {
  c.fillStyle = '#7A5428';
  c.beginPath();
  c.moveTo(-150, -130);
  c.lineTo(-120, -168);
  c.lineTo(120, -168);
  c.lineTo(150, -130);
  c.fill();
  c.save();
  c.translate(sway * 14, -rise * 70);
  c.rotate(sway * 0.06);
  // The sheet: dome of the head, ears showing underneath, and the flare.
  const sheet = (cc: X) => {
    cc.beginPath();
    cc.moveTo(-104, -60);
    cc.bezierCurveTo(-110, -150, -92, -214, -58, -228);
    cc.lineTo(-44, -262);
    cc.lineTo(-22, -236);
    cc.bezierCurveTo(-8, -240, 8, -240, 22, -236);
    cc.lineTo(44, -262);
    cc.lineTo(58, -228);
    cc.bezierCurveTo(92, -214, 110, -150, 104, -60);
    cc.closePath();
  };
  sheet(c);
  c.fillStyle = linear(c, -100, -250, 100, -60, [[0, '#FFFFFF'], [0.6, '#E8ECF4'], [1, '#B8C0D0']]);
  c.fill();
  c.save();
  sheet(c);
  c.clip();
  c.strokeStyle = 'rgba(120,130,160,0.35)';
  c.lineWidth = 3;
  for (const x of [-60, -20, 30, 70]) {
    c.beginPath();
    c.moveTo(x, -170);
    c.quadraticCurveTo(x + 8, -120, x - 4, -60);
    c.stroke();
  }
  c.restore();
  // Eye holes, with the glow of the cat underneath.
  for (const s of [-1, 1]) {
    c.fillStyle = '#141018';
    ellipse(c, s * 34, -180, 17, 21);
    c.fill();
    c.fillStyle = 'rgba(190,230,120,0.9)';
    ellipse(c, s * 34 + 3, -178, 6, 11);
    c.fill();
  }
  c.fillStyle = '#141018';
  ellipse(c, 0, -136, 12, 9 + rise * 7);
  c.fill();
  c.restore();
  boxFront(c, -150, -130, 300, 130, label, font);
  c.fillStyle = '#C79656';
  for (const s of [-1, 1]) {
    c.beginPath();
    c.moveTo(s * 150, -130);
    c.lineTo(s * 196, -168);
    c.lineTo(s * 184, -118);
    c.closePath();
    c.fill();
  }
}

/** Alive or dead? Closed box with two eyes glowing through the handle. */
export function schrodinger(c: X, font: string, lid = 0): void {
  c.fillStyle = '#9A6E38';
  c.beginPath();
  c.moveTo(-110, -150);
  c.lineTo(-80, -176);
  c.lineTo(130, -176);
  c.lineTo(110, -150);
  c.fill();
  c.fillStyle = '#8A5E2C';
  c.beginPath();
  c.moveTo(110, -150);
  c.lineTo(130, -176);
  c.lineTo(130, -24);
  c.lineTo(110, 0);
  c.fill();
  boxFront(c, -110, -150, 220, 150);
  c.fillStyle = 'rgba(210,190,140,0.8)';
  c.fillRect(-12, -150, 24, 150);
  c.fillStyle = '#1A1008';
  c.beginPath();
  c.roundRect(-44, -110, 88, 26, 13);
  c.fill();
  for (const ex of [-18, 18]) {
    // The handle's eyes blink too: is anyone in there?
    const open = 1 - Math.min(1, lid);
    c.fillStyle = radial(c, ex, -97, 1, 12, [[0, '#FFF6B0'], [0.5, '#F2C94C'], [1, 'rgba(242,201,76,0)']]);
    ellipse(c, ex, -97, 12, 1 + 8 * open);
    c.fill();
    c.fillStyle = '#1A1008';
    ellipse(c, ex, -97, 2, 0.5 + 5.5 * open);
    c.fill();
  }
  c.fillStyle = 'rgba(40,20,5,0.85)';
  c.font = font;
  c.fillText('?', 34, -24);
}

// ---------- Fireman ----------
function extinguisher(c: X, font: string): void {
  c.fillStyle = 'rgba(0,0,0,0.4)';
  ellipse(c, -150, 0, 34, 7);
  c.fill();
  c.fillStyle = linear(c, -178, 0, -122, 0, [[0, '#FF6A5E'], [0.45, '#D8261E'], [1, '#8A1410']]);
  c.beginPath();
  c.roundRect(-178, -150, 56, 150, 22);
  c.fill();
  c.fillStyle = '#F2F2F2';
  c.fillRect(-172, -100, 44, 40);
  c.fillStyle = '#C62A22';
  c.font = font;
  c.fillText('CO2', -165, -74);
  c.fillStyle = '#2A2A2A';
  c.fillRect(-160, -172, 20, 24);
  c.fillRect(-168, -178, 40, 8);
  c.strokeStyle = '#1C1C1C';
  c.lineWidth = 7;
  c.lineCap = 'round';
  c.beginPath();
  c.moveTo(-138, -172);
  c.bezierCurveTo(-60, -240, 80, -40, 120, -80);
  c.stroke();
  c.fillStyle = '#2A2A2A';
  c.save();
  c.translate(120, -80);
  c.rotate(-0.5);
  c.fillRect(0, -8, 44, 16);
  c.restore();
}

function helmet(c: X): void {
  c.fillStyle = linear(c, 0, -300, 0, -236, [[0, '#FF5A4E'], [1, '#B81E16']]);
  c.beginPath();
  c.ellipse(0, -246, 70, 52, 0, Math.PI, TAU);
  c.fill();
  c.fillStyle = '#9A1610';
  ellipse(c, 0, -244, 96, 16);
  c.fill();
  c.fillStyle = '#FF7A6E';
  c.fillRect(-6, -296, 12, 50);
  c.fillStyle = radial(c, 0, -262, 2, 18, [[0, '#FFF6B0'], [1, '#C79A1E']]);
  ellipse(c, 0, -266, 16, 18);
  c.fill();
  c.fillStyle = 'rgba(255,255,255,0.35)';
  ellipse(c, -32, -276, 14, 7, -0.5);
  c.fill();
}

/** The house cat, with helmet and extinguisher. The nozzle sits at (164, -100). */
export function fireman(c: X, coat: Coat, font: string, pose: Pose = {}): void {
  extinguisher(c, font);
  frontCat(c, coat, { mood: 'wide', collar: '#C8303F', pose });
  helmet(c);
}
export const NOZZLE: [number, number] = [164, -100];

// ---------- Pairs ----------
function heartPath(c: X, x: number, y: number, s: number): void {
  c.beginPath();
  for (let i = 0; i <= 60; i++) {
    const t = (i / 60) * TAU;
    const hx = 16 * Math.sin(t) ** 3, hy = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
    if (i) c.lineTo(x + hx * s, y - hy * s);
    else c.moveTo(x + hx * s, y - hy * s);
  }
}

/** They collaborate: same laptop and the tails forming a heart on the floor. */
export function pairHeart(c: X, a: Coat, b: Coat): void {
  laptop(c, 250);
  const D = 98;
  c.save();
  c.translate(-D, 0);
  backCat(c, a, 11, { laptop: false, tail: false });
  c.restore();
  c.save();
  c.translate(D, 0);
  backCat(c, b, 23, { laptop: false, tail: false });
  c.restore();
  // Heart flattened by the floor's perspective: each tail is half a shape
  const hp = (t: number): [number, number] => {
    const hx = 16 * Math.sin(t) ** 3, hy = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
    return [hx * 7.5, -hy * 7.5 * 0.42 + 12];
  };
  ([[a, -1], [b, 1]] as const).forEach(([coat, sgn], k) => {
    const pts: [number, number][] = [[sgn * (D - 40), -14]];
    for (let i = 0; i <= 30; i++) {
      const [x, y] = hp(0.35 + (i / 30) * (Math.PI - 0.35));
      pts.push([sgn * x, y]);
    }
    tailAlong(c, coat, pts, 40 + k);
  });
  c.fillStyle = '#FF6B8A';
  heartPath(c, 0, -300, 1.6);
  c.fill();
}

function furryArm(c: X, coat: Coat, path: (c: X) => void, box: [number, number, number, number], dir: number, seed: number): void {
  path(c);
  c.fillStyle = css(coat.fur.mid);
  c.fill();
  fur(c, coat, path, box, 480, { seed, light: () => 0.62, dir: () => dir, stripe: (x) => smooth(0.6, 0.9, Math.sin(x * 0.15)) * 0.8 });
}

function pawTip(c: X, coat: Coat, x: number, y: number): void {
  c.fillStyle = radial(c, x, y, 2, 16, [[0, '#FFFFFF'], [1, css(coat.cream.dark)]]);
  ellipse(c, x, y, 15, 12.5);
  c.fill();
}

/** One waits for the other: kneads her back while she works. */
export function knead(c: X, worker: Coat, kneader: Coat, collar: string, pose: Pose = {}): void {
  backCat(c, worker, 31, { pose: { ear: pose.ear } });
  c.save();
  c.translate(190, 0);
  frontCat(c, kneader, { mood: 'happy', collar, pose: { swing: pose.swing } });
  for (const [py, lift] of [[-150, -10], [-104, 6]] as const) {
    const arm = (cc: X) => {
      cc.beginPath();
      cc.moveTo(-40, py + 22);
      cc.bezierCurveTo(-80, py + 10, -110, py + lift, -140, py + lift);
      cc.lineTo(-140, py + lift + 22);
      cc.bezierCurveTo(-110, py + lift + 22, -80, py + 34, -40, py + 44);
      cc.closePath();
    };
    furryArm(c, kneader, arm, [-150, py - 20, -30, py + 50], Math.PI, 90 + py);
    pawTip(c, kneader, -146, py + lift + 11);
    c.strokeStyle = 'rgba(255,255,255,0.8)';
    c.lineWidth = 3;
    c.lineCap = 'round';
    c.beginPath();
    c.arc(-164, py + lift + 11, 16, Math.PI * 0.7, Math.PI * 1.3);
    c.stroke();
  }
  c.restore();
}

/** They step on each other: each pulls at its half of the same sheet. */
export function hiss(c: X, a: Coat, b: Coat, collars: [string, string]): void {
  c.save();
  c.translate(0, -104);
  for (const [sgn, rot] of [[-1, -0.08], [1, 0.1]] as const) {
    c.save();
    c.rotate(rot);
    c.translate(sgn * 6, 0);
    c.fillStyle = '#F6F2E8';
    c.beginPath();
    c.moveTo(0, -52);
    c.lineTo(sgn * 50, -52);
    c.lineTo(sgn * 50, 52);
    c.lineTo(0, 52);
    for (let k = 0; k < 8; k++) c.lineTo(sgn * (k % 2 ? 6 : 0), 52 - (k + 1) * 13);
    c.closePath();
    c.fill();
    c.fillStyle = '#9AA3AE';
    for (let k = 0; k < 6; k++) c.fillRect(sgn > 0 ? 10 : -44, -38 + k * 13, 30 - (k % 3) * 6, 3);
    c.restore();
  }
  c.restore();
  ([[-150, a, 1, collars[0]], [150, b, -1, collars[1]]] as const).forEach(([x, coat, sgn, collar]) => {
    c.save();
    c.translate(x, 0);
    frontCat(c, coat, { mood: 'angry', collar });
    const arm = (cc: X) => {
      cc.beginPath();
      cc.moveTo(sgn * 30, -100);
      cc.bezierCurveTo(sgn * 70, -110, sgn * 100, -116, sgn * 118, -112);
      cc.lineTo(sgn * 118, -90);
      cc.bezierCurveTo(sgn * 100, -92, sgn * 70, -78, sgn * 30, -74);
      cc.closePath();
    };
    furryArm(c, coat, arm, [sgn > 0 ? 20 : -130, -125, sgn > 0 ? 130 : -20, -65], sgn > 0 ? 0 : Math.PI, 70 + x);
    pawTip(c, coat, sgn * 124, -101);
    c.restore();
  });
  // Spark between the heads
  c.fillStyle = '#FFE14D';
  c.beginPath();
  const pts = [[0, -300], [14, -262], [40, -272], [20, -240], [44, -214], [8, -226], [0, -196], [-8, -226], [-44, -214], [-20, -240], [-40, -272], [-14, -262]];
  pts.forEach(([x, y], i) => (i ? c.lineTo(x!, y!) : c.moveTo(x!, y!)));
  c.closePath();
  c.fill();
}

/** Horizontal extent of each pose, in local units, for the layout. */
export const EXTENT: Record<string, [number, number]> = {
  cartel: [-135, 440],
  sentado: [-135, 150],
  portatil: [-195, 195],
  dormido: [-170, 170],
  caja: [-200, 200],
  schrodinger: [-120, 135],
  corazon: [-285, 285],
  amasa: [-195, 345],
  bufido: [-300, 300],
};

/** How far each pose rises above the floor, in local units, for plates and speech bubbles. */
export const HEIGHT: Record<string, number> = {
  cartel: 340, sentado: 312, portatil: 312, dormido: 140, caja: 200, schrodinger: 180, corazon: 330, amasa: 312, bufido: 312,
};


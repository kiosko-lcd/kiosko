/**
 * The laser-sword duel: two cats in profile, standing, in a fencing
 * guard. It shows up in two places in cat mode:
 *
 *   - short (~6 s), when two sessions step on an uncommitted file: they
 *     clash and go back to bristling;
 *   - long (~22 s), as a quarter-hour nod, with a winner.
 *
 * The cat is articulated: real cat hind legs (thigh, knee pointing
 * forward, hock pointing back and a long foot on the floor), torso with
 * chest and belly, sword arm with shoulder and elbow, the other arm back
 * for balance, neck, head in profile and the counterweight tail. The
 * joints are solved with two-bone inverse kinematics.
 *
 * The clashes are not hand-programmed: every frame it checks whether the two blades
 * cross, and where they cross sparks and lightning fly. The choreography only
 * has to make them cross.
 *
 * The swords are an original design (amber and violet, brass hilt): the
 * fun of the duel, without copying anyone else's.
 */
import { type Coat, type X, clamp, css, ellipse, eye, fur, furryShape, linear, radial, rng, sphereLight, tailAlong, bezierPts } from './paint.ts';

// ---------- Geometry ----------
type P = [number, number];
const add = (a: P, b: P): P => [a[0] + b[0], a[1] + b[1]];
const rot = (v: P, a: number): P => [v[0] * Math.cos(a) - v[1] * Math.sin(a), v[0] * Math.sin(a) + v[1] * Math.cos(a)];
const dist = (a: P, b: P) => Math.hypot(b[0] - a[0], b[1] - a[1]);

/**
 * Elbow or knee between two points, with two bones of fixed length. `bend`
 * says which way it bends (+1 or -1). If the target is too far away,
 * it stretches out fully in its direction.
 */
export function ik(root: P, target: P, l1: number, l2: number, bend: 1 | -1): P {
  const d = Math.min(dist(root, target), l1 + l2 - 0.01);
  const a = Math.atan2(target[1] - root[1], target[0] - root[0]);
  const cos = clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1);
  const b = a + bend * Math.acos(cos);
  return [root[0] + Math.cos(b) * l1, root[1] + Math.sin(b) * l1];
}

/** Capsule silhouette between two circles of different radius: a bone with flesh. */
function capsule(c: X, a: P, ra: number, b: P, rb: number): void {
  const d = Math.max(0.001, dist(a, b));
  const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
  const phi = Math.acos(clamp((ra - rb) / d, -1, 1));
  c.beginPath();
  c.arc(a[0], a[1], ra, ang + phi, ang - phi + Math.PI * 2);
  c.arc(b[0], b[1], rb, ang - phi, ang + phi);
  c.closePath();
}

// ---------- Posture ----------
export interface Stance {
  /** Forward lean of the torso, rad. */
  lean: number;
  /** 0..1: knees bent, hip lower. */
  crouch: number;
  /** Forward and back foot, in x relative to the center. */
  front: number;
  back: number;
  /** Jump height (the feet tuck in). */
  jump: number;
  /** Direction and reach of the sword arm relative to the shoulder (rad, 0 = forward, + up) and 0..1. */
  armDir: number;
  armReach: number;
  /** Blade angle, absolute (0 = forward, + up). */
  blade: number;
  /** Free arm, raised behind: 0 low, 1 high. */
  offArm: number;
  /** Hiss, 0..1. */
  mouth: number;
}

export const GUARD: Stance = { lean: 0.12, crouch: 0.35, front: 42, back: -38, jump: 0, armDir: 0.15, armReach: 0.75, blade: 0.85, offArm: 0.7, mouth: 0.4 };

/** Where the hilt ends up and where the blade points, in the cat's coordinates. */
export interface Hilt { hand: P; blade: number }

const THIGH = 70, SHIN = 64, FOOT = 46, UPPER = 54, FORE = 50;

function shade(coat: Coat, k: number): Coat {
  // The far-side limbs, a bit in shadow.
  const d = (c: [number, number, number]): [number, number, number] => [c[0] * k, c[1] * k, c[2] * k];
  return { ...coat, fur: { deep: d(coat.fur.deep), dark: d(coat.fur.dark), mid: d(coat.fur.mid), light: d(coat.fur.light), top: d(coat.fur.top) } };
}

function limb(c: X, coat: Coat, a: P, ra: number, b: P, rb: number, seed: number, light = 0.55): void {
  const shape = (cc: X) => capsule(cc, a, ra, b, rb);
  shape(c);
  c.fillStyle = css(coat.fur.mid);
  c.fill();
  const x0 = Math.min(a[0], b[0]) - ra, x1 = Math.max(a[0], b[0]) + ra, y0 = Math.min(a[1], b[1]) - ra, y1 = Math.max(a[1], b[1]) + ra;
  const dir = Math.atan2(b[1] - a[1], b[0] - a[0]);
  fur(c, coat, shape, [x0, y0, x1, y1], Math.round(((x1 - x0) * (y1 - y0)) / 22), {
    seed, light: (x) => clamp(light + ((x - (x0 + x1) / 2) / (x1 - x0 + 1)) * -0.25), dir: () => dir, len: [5, 9], width: 1.4,
    stripe: (x, y) => (Math.sin((x * Math.cos(dir) + y * Math.sin(dir)) * 0.16) > 0.55 ? 0.8 : 0),
  });
}

function paw(c: X, coat: Coat, at: P, rx: number, ry: number, ang = 0): void {
  c.fillStyle = radial(c, at[0] - rx * 0.3, at[1] - ry * 0.3, 1, rx * 1.2, [[0, css(coat.cream.light)], [1, css(coat.cream.dark)]]);
  ellipse(c, at[0], at[1], rx, ry, ang);
  c.fill();
  c.strokeStyle = 'rgba(120,80,50,0.5)';
  c.lineWidth = 1.4;
  for (const k of [-0.35, 0.05, 0.45]) {
    const p = add(at, rot([rx * 0.55, ry * k], ang));
    const q = add(at, rot([rx * 0.98, ry * k * 0.8], ang));
    c.beginPath();
    c.moveTo(p[0], p[1]);
    c.lineTo(q[0], q[1]);
    c.stroke();
  }
}

/** A hind leg: thigh, knee forward, hock back and a long foot on the floor. */
function hindLeg(c: X, coat: Coat, hip: P, foot: number, lift: number, seed: number, near: boolean): void {
  const toe: P = [foot + FOOT * 0.55, -lift];
  const heel: P = [foot - FOOT * 0.45, -12 - lift * 0.8];
  const knee = ik(hip, heel, THIGH, SHIN, 1);
  const cc = near ? coat : shade(coat, 0.72);
  // The thigh is the big mass of the standing cat: wider at the top.
  limb(c, cc, hip, 36, knee, 17, seed, near ? 0.6 : 0.4);
  limb(c, cc, knee, 15, heel, 10, seed + 1, near ? 0.55 : 0.35);
  limb(c, cc, heel, 10, toe, 12, seed + 2, near ? 0.5 : 0.3);
  paw(c, cc, [toe[0] + 3, toe[1] - 7], 18, 9);
}

/** Paints the cat and returns where its hilt is. Origin: floor, between the feet. */
export function profileCat(c: X, coat: Coat, st: Stance, seed: number, collar: string): Hilt {
  const hipH = 150 - st.crouch * 38;
  const hip: P = [0, -hipH - st.jump];
  const chest = add(hip, rot([0, -112], st.lean));
  const shoulder = add(chest, rot([16, 10], st.lean));
  const neck = add(chest, rot([14, -38], st.lean));
  const headC = add(chest, rot([34, -70], st.lean * 0.6));
  const lift = st.jump > 0 ? Math.min(40, st.jump * 0.5) : 0;

  // Free arm, behind and up: the fencing counterweight (far side).
  const far = shade(coat, 0.7);
  const offShoulder = add(chest, rot([-6, 4], st.lean));
  const offElbow = add(offShoulder, rot([-UPPER, 0], -0.5 - st.offArm * 0.6));
  const offHand = add(offElbow, rot([-FORE * 0.9, 0], -1.4 - st.offArm * 0.5));
  limb(c, far, offShoulder, 15, offElbow, 11, seed + 10, 0.35);
  limb(c, far, offElbow, 11, offHand, 9, seed + 11, 0.3);
  paw(c, far, offHand, 11, 9, -1.2);
  // Far hind leg
  hindLeg(c, coat, add(hip, [-8, 0]), st.back, lift, seed + 20, false);

  // Tail: starts at the rump and acts as a counterweight, high and bristling.
  const rump = add(hip, rot([-40, 8], st.lean));
  tailAlong(c, coat, bezierPts([rump, add(rump, [-70, 20]), add(rump, [-120, -60]), add(rump, [-95, -150])]), seed + 30, 1.35);

  // Torso: chest up, belly down; the light side, the front one.
  const torso = (cc: X) => capsule(cc, hip, 46, chest, 44);
  torso(c);
  c.fillStyle = radial(c, chest[0] + 10, chest[1], 10, 150, [[0, css(coat.fur.light)], [0.5, css(coat.fur.mid)], [1, css(coat.fur.dark)]]);
  c.fill();
  const tb: [number, number, number, number] = [Math.min(hip[0], chest[0]) - 50, chest[1] - 50, Math.max(hip[0], chest[0]) + 50, hip[1] + 50];
  const up = Math.atan2(chest[1] - hip[1], chest[0] - hip[0]);
  fur(c, coat, torso, tb, 1700, {
    seed: seed + 40, light: sphereLight((hip[0] + chest[0]) / 2 + 12, (hip[1] + chest[1]) / 2, 55, 90), dir: () => up + Math.PI,
    stripe: (x, y) => {
      // Stripes that wrap around the body, on the back (rear side) and not on the chest.
      const along = (x - hip[0]) * Math.cos(up) + (y - hip[1]) * Math.sin(up);
      const across = -(x - hip[0]) * Math.sin(up) + (y - hip[1]) * Math.cos(up);
      return across < 8 ? (Math.sin(along * 0.12) > 0.5 ? 0.9 : 0) : 0;
    },
    cream: (x, y) => {
      const across = -(x - hip[0]) * Math.sin(up) + (y - hip[1]) * Math.cos(up);
      return clamp((across - 12) / 26);
    },
  });

  // Near hind leg, in front of the torso.
  hindLeg(c, coat, add(hip, [10, 6]), st.front, lift, seed + 50, true);

  // Neck and head in profile
  limb(c, coat, chest, 30, neck, 26, seed + 60, 0.6);
  for (const [ox, oy, k] of [[-30, -32, 0.72], [-4, -40, 1]] as const) {
    // Ears somewhat back: it is tense. The far one, in shadow.
    const cc = k < 1 ? far : coat;
    const b1 = add(headC, [ox - 16, oy + 18]), tip = add(headC, [ox - 22, oy - 34]), b2 = add(headC, [ox + 18, oy + 12]);
    c.beginPath();
    c.moveTo(b1[0], b1[1]);
    c.quadraticCurveTo(tip[0] - 4, tip[1] + 14, tip[0], tip[1]);
    c.quadraticCurveTo(tip[0] + 16, tip[1] + 10, b2[0], b2[1]);
    c.closePath();
    c.fillStyle = css(cc.fur.dark);
    c.fill();
    if (k === 1) {
      c.fillStyle = 'rgba(240,150,170,0.75)';
      const i1 = add(headC, [ox - 10, oy + 12]), it = add(headC, [ox - 18, oy - 22]), i2 = add(headC, [ox + 10, oy + 8]);
      c.beginPath();
      c.moveTo(i1[0], i1[1]);
      c.quadraticCurveTo(it[0], it[1] + 10, it[0], it[1]);
      c.quadraticCurveTo(it[0] + 10, it[1] + 8, i2[0], i2[1]);
      c.closePath();
      c.fill();
    }
  }
  const head = (cc: X) => furryShape(cc, headC[0], headC[1], 50, 43, 2.2, (a) => (Math.cos(a) < -0.2 ? 0.1 : 0.02), seed + 70);
  head(c);
  c.fillStyle = radial(c, headC[0], headC[1] - 10, 8, 70, [[0, css(coat.fur.light)], [0.55, css(coat.fur.mid)], [1, css(coat.fur.dark)]]);
  c.fill();
  fur(c, coat, head, [headC[0] - 60, headC[1] - 55, headC[0] + 60, headC[1] + 50], 1300, {
    seed: seed + 71, light: sphereLight(headC[0] + 8, headC[1] - 8, 52, 45),
    dir: (x, y) => Math.atan2(y - headC[1] - 10, x - headC[0] - 50) + Math.PI,
    stripe: (x, y) => (x < headC[0] + 5 && y < headC[1] - 12 ? (Math.sin((x - headC[0]) * 0.38) > 0.45 ? 0.85 : 0) : 0),
    cream: (x, y) => 1 - clamp((Math.hypot((x - headC[0] - 30) / 30, (y - headC[1] - 22) / 18) - 0.7) / 0.35),
  });
  // Muzzle, nose, chin and mouth
  const muzzle = add(headC, [40, 12]);
  c.fillStyle = css(coat.cream.mid);
  ellipse(c, muzzle[0], muzzle[1], 24, 17, 0.1);
  c.fill();
  c.fillStyle = radial(c, muzzle[0] + 20, muzzle[1] - 12, 1, 8, [[0, '#FFC9D4'], [1, '#D86A84']]);
  ellipse(c, muzzle[0] + 21, muzzle[1] - 10, 7, 5.5, 0.3);
  c.fill();
  if (st.mouth > 0) {
    c.fillStyle = '#4A0E14';
    ellipse(c, muzzle[0] + 8, muzzle[1] + 10, 12 * st.mouth + 4, 7 * st.mouth + 2, 0.2);
    c.fill();
    c.fillStyle = '#FFFFFF';
    c.beginPath();
    c.moveTo(muzzle[0] + 14, muzzle[1] + 4);
    c.lineTo(muzzle[0] + 19, muzzle[1] + 4);
    c.lineTo(muzzle[0] + 16, muzzle[1] + 13);
    c.fill();
  }
  // Almond eye and frown: focused
  const eyeC = add(headC, [18, -8]);
  eye(c, coat.eye, eyeC[0], eyeC[1], 13, 14, 3);
  c.fillStyle = css(coat.fur.dark);
  c.beginPath();
  c.moveTo(eyeC[0] - 16, eyeC[1] - 16);
  c.lineTo(eyeC[0] + 18, eyeC[1] - 10);
  c.lineTo(eyeC[0] + 16, eyeC[1] - 2);
  c.lineTo(eyeC[0] - 15, eyeC[1] - 6);
  c.closePath();
  c.fill();
  c.strokeStyle = 'rgba(255,255,255,0.85)';
  c.lineWidth = 1.4;
  for (const d of [-5, 2, 9]) {
    c.beginPath();
    c.moveTo(muzzle[0] + 6, muzzle[1] + d * 0.6);
    c.quadraticCurveTo(muzzle[0] + 50, muzzle[1] - 4 + d, muzzle[0] + 92, muzzle[1] + 6 + d * 1.7);
    c.stroke();
  }
  // Collar
  c.strokeStyle = collar;
  c.lineWidth = 7;
  c.beginPath();
  const n1 = add(neck, rot([-24, 8], st.lean)), n2 = add(neck, rot([24, 14], st.lean));
  c.moveTo(n1[0], n1[1]);
  c.quadraticCurveTo((n1[0] + n2[0]) / 2, (n1[1] + n2[1]) / 2 + 10, n2[0], n2[1]);
  c.stroke();

  // Sword arm, the near one: shoulder, elbow and paw with the hilt.
  const reach = 40 + st.armReach * (UPPER + FORE - 44);
  const hand = add(shoulder, [Math.cos(-st.armDir) * reach, Math.sin(-st.armDir) * reach]);
  const elbow = ik(shoulder, hand, UPPER, FORE, 1);
  limb(c, coat, shoulder, 17, elbow, 12, seed + 80, 0.62);
  limb(c, coat, elbow, 12, hand, 10, seed + 81, 0.6);
  return { hand, blade: st.blade };
}

/** The paw that closes around the hilt, on top of it. */
export function gripPaw(c: X, coat: Coat, hand: P, blade: number): void {
  paw(c, coat, hand, 13, 11, -blade);
}

// ---------- Swords, sparks and lightning ----------
export type Blade = [number, number, number, number];

export function saber(c: X, hand: P, ang: number, len: number, color: string, trail: number | null): Blade {
  const dx = Math.cos(-ang), dy = Math.sin(-ang);
  c.save();
  c.translate(hand[0], hand[1]);
  c.rotate(-ang);
  c.fillStyle = linear(c, 0, -7, 0, 7, [[0, '#F0E2B6'], [0.5, '#B08A3E'], [1, '#5A4418']]);
  c.fillRect(-34, -7, 52, 14);
  c.fillStyle = '#2A2014';
  for (let k = 0; k < 5; k++) c.fillRect(-28 + k * 8, -7, 3, 14);
  c.fillStyle = '#E8D9A8';
  c.fillRect(16, -10, 7, 20);
  c.restore();
  const b0: P = [hand[0] + dx * 24, hand[1] + dy * 24];
  const b1: P = [b0[0] + dx * len, b0[1] + dy * len];
  if (len > 1) {
    c.save();
    c.globalCompositeOperation = 'lighter';
    c.lineCap = 'round';
    if (trail !== null && Math.abs(trail - ang) > 0.05) {
      c.fillStyle = `${color}26`;
      c.beginPath();
      c.moveTo(b0[0], b0[1]);
      c.lineTo(b1[0], b1[1]);
      c.lineTo(b0[0] + Math.cos(-trail) * len, b0[1] + Math.sin(-trail) * len);
      c.closePath();
      c.fill();
    }
    for (const [w, a] of [[34, '14'], [18, '50'], [9, 'CC']] as const) {
      c.strokeStyle = `${color}${a}`;
      c.lineWidth = w;
      c.beginPath();
      c.moveTo(b0[0], b0[1]);
      c.lineTo(b1[0], b1[1]);
      c.stroke();
    }
    c.strokeStyle = '#FFFFFF';
    c.lineWidth = 3.8;
    c.beginPath();
    c.moveTo(b0[0], b0[1]);
    c.lineTo(b1[0], b1[1]);
    c.stroke();
    c.restore();
  }
  return [b0[0], b0[1], b1[0], b1[1]];
}

/** Where two blades cross, or null if they do not touch. */
export function crossing(a: Blade, b: Blade): P | null {
  const [x1, y1, x2, y2] = a, [x3, y3, x4, y4] = b;
  const d = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (Math.abs(d) < 1e-6) return null;
  const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / d;
  const u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / d;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? [x1 + t * (x2 - x1), y1 + t * (y2 - y1)] : null;
}

export function sparks(c: X, at: P, power: number, seed: number): void {
  const r = rng(seed);
  c.save();
  c.globalCompositeOperation = 'lighter';
  c.fillStyle = radial(c, at[0], at[1], 0, 80 * power, [[0, 'rgba(255,252,230,0.95)'], [0.3, 'rgba(255,210,140,0.45)'], [1, 'rgba(255,160,80,0)']]);
  ellipse(c, at[0], at[1], 80 * power, 80 * power);
  c.fill();
  c.lineCap = 'round';
  for (let i = 0; i < 22; i++) {
    const a = r() * Math.PI * 2, l = (22 + r() * 55) * power;
    c.strokeStyle = r() > 0.5 ? 'rgba(255,244,190,0.95)' : 'rgba(255,180,95,0.9)';
    c.lineWidth = 1.5 + r() * 2.5;
    c.beginPath();
    c.moveTo(at[0] + Math.cos(a) * 8, at[1] + Math.sin(a) * 8);
    c.lineTo(at[0] + Math.cos(a) * l, at[1] + Math.sin(a) * l);
    c.stroke();
  }
  c.restore();
}

/** A broken lightning bolt with branches, from `from` toward `ang`, with an electric halo. */
function bolt(c: X, from: P, ang: number, len: number, r: () => number, depth = 0): void {
  const pts: P[] = [from];
  const steps = 7;
  let p = from;
  for (let i = 1; i <= steps; i++) {
    const a = ang + (r() - 0.5) * 1.1;
    p = [p[0] + Math.cos(a) * (len / steps), p[1] + Math.sin(a) * (len / steps)];
    pts.push(p);
    if (depth < 1 && r() < 0.28) bolt(c, p, ang + (r() - 0.5) * 2, len * 0.45, r, depth + 1);
  }
  for (const [w, col] of [[9, 'rgba(150,190,255,0.22)'], [4, 'rgba(190,220,255,0.7)'], [1.6, 'rgba(255,255,255,0.95)']] as const) {
    c.strokeStyle = col;
    c.lineWidth = w * (depth ? 0.6 : 1);
    c.beginPath();
    pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
    c.stroke();
  }
}

/** Lightning leaving the clash. With `along`, they also crackle along the blades (block). */
export function lightning(c: X, at: P, power: number, seed: number, along?: [Blade, Blade]): void {
  const r = rng(seed * 7 + 1);
  c.save();
  c.globalCompositeOperation = 'lighter';
  c.lineCap = 'round';
  c.lineJoin = 'round';
  const n = 2 + Math.round(power * 2);
  for (let i = 0; i < n; i++) bolt(c, at, r() * Math.PI * 2, (60 + r() * 90) * power, r);
  if (along) {
    for (const b of along) {
      for (let k = 0; k < 3; k++) {
        const u = 0.25 + r() * 0.7;
        const p: P = [b[0] + (b[2] - b[0]) * u, b[1] + (b[3] - b[1]) * u];
        bolt(c, p, Math.atan2(b[3] - b[1], b[2] - b[0]) + (r() > 0.5 ? 1.6 : -1.6), 30 + r() * 30, r, 1);
      }
    }
  }
  c.restore();
}

// ---------- Choreography ----------
/** A moment of the fight: each one's posture, where it is and whether it lights up. */
export interface Beat {
  /** Seconds since the start. */
  t: number;
  /** Position of each cat relative to the center of the duel, and its posture. */
  a: { x: number; st: Stance };
  b: { x: number; st: Stance };
  /** 0..1: blades lit. */
  on: number;
  /** Full-screen flash on this hit (0..1). */
  flash?: number;
  /** Block: the blades push against each other and electricity runs along them. */
  lock?: boolean;
  /** End of the nod: who wins and the loser, disarmed. */
  winner?: 'a' | 'b';
}

const S = (o: Partial<Stance> = {}): Stance => ({ ...GUARD, ...o });
const B = (t: number, ax: number, a: Partial<Stance>, bx: number, b: Partial<Stance>, extra: Partial<Beat> = {}): Beat =>
  ({ t, a: { x: ax, st: S(a) }, b: { x: bx, st: S(b) }, on: 1, ...extra });

/** The duel's hits, reusable. Each one leaves the blades crossing. */
function exchange(t: number): Beat[] {
  return [
    // Thrust by A, B downward
    B(t, -150, { lean: 0.45, armDir: -0.05, armReach: 1, blade: 0.1, front: 70 }, 150, { lean: 0.05, armDir: 0.05, blade: 0.35 }),
    B(t + 0.35, -130, { lean: 0.4, armDir: 0.05, armReach: 1, blade: 0.18, front: 70 }, 150, { lean: 0.1, armDir: 0.0, blade: -0.35 }),
    // High slash by B, A upward
    B(t + 0.8, -160, { lean: 0.1, armDir: 0.9, armReach: 0.9, blade: 1.25 }, 130, { lean: 0.35, armDir: 1.1, armReach: 1, blade: 1.9, front: 60 }),
    B(t + 1.1, -160, { lean: 0.05, armDir: 0.95, armReach: 0.95, blade: 1.45 }, 120, { lean: 0.4, armDir: 0.7, armReach: 1, blade: 0.95, front: 60 }),
  ];
}

function rally(t: number, n: number): Beat[] {
  // Quick hits alternating high and low: many clashes in a row.
  const out: Beat[] = [];
  for (let i = 0; i < n; i++) {
    const hi = i % 2 === 0;
    out.push(B(t + i * 0.32, -140 + (i % 3) * 8, { lean: 0.3, armDir: hi ? 0.6 : 0.15, armReach: 1, blade: hi ? 0.95 : 0.3 },
      140 - (i % 2) * 10, { lean: 0.3, armDir: hi ? 0.55 : 0.2, armReach: 1, blade: hi ? 1.0 : 0.25 }));
  }
  return out;
}

function lock(t: number, dur: number): Beat[] {
  // Block: the blades push each other almost vertical and crackle.
  return [
    B(t, -110, { lean: 0.5, armDir: 0.5, armReach: 0.8, blade: 1.2, crouch: 0.6, front: 60 }, 110, { lean: 0.5, armDir: 0.5, armReach: 0.8, blade: 1.2, crouch: 0.6, front: 60 }, { lock: true }),
    B(t + dur * 0.5, -95, { lean: 0.55, armDir: 0.45, armReach: 0.7, blade: 1.25, crouch: 0.7, front: 64, mouth: 1 }, 118, { lean: 0.45, armDir: 0.5, armReach: 0.75, blade: 1.2, crouch: 0.6, front: 58, mouth: 1 }, { lock: true }),
    B(t + dur, -115, { lean: 0.45, armDir: 0.5, armReach: 0.8, blade: 1.18, crouch: 0.6 }, 100, { lean: 0.55, armDir: 0.45, armReach: 0.75, blade: 1.25, crouch: 0.7 }, { lock: true, flash: 0.5 }),
  ];
}

function leap(t: number): Beat[] {
  return [
    B(t, -170, { crouch: 0.9, lean: 0.2 }, 170, { crouch: 0.9, lean: 0.2 }),
    B(t + 0.3, -120, { jump: 90, lean: 0.25, armDir: 0.9, blade: 1.3, crouch: 0.4 }, 120, { jump: 95, lean: 0.25, armDir: 0.9, blade: 1.3, crouch: 0.4 }),
    B(t + 0.55, -95, { jump: 120, lean: 0.35, armDir: 0.5, armReach: 1, blade: 0.8 }, 95, { jump: 118, lean: 0.35, armDir: 0.5, armReach: 1, blade: 0.8 }, { flash: 1 }),
    B(t + 0.95, -175, { crouch: 0.8 }, 175, { crouch: 0.8 }),
  ];
}

const ignite = (t: number): Beat[] => [
  { ...B(t, -190, {}, 190, {}), on: 0 },
  B(t + 0.5, -180, {}, 180, {}),
];

/** Short duel, for the "they step on each other" conflict: about six seconds, no winner. */
export function shortDuel(): Beat[] {
  return [
    ...ignite(0),
    ...exchange(0.8),
    ...rally(2.2, 5),
    ...lock(3.9, 1.1),
    ...leap(5.2),
    { ...B(6.5, -190, {}, 190, {}), on: 1 },
  ];
}

/** Long duel, for the nod: more hits, block, jump and a winner who disarms the other. */
export function longDuel(winner: 'a' | 'b'): Beat[] {
  const w = winner === 'a';
  const beats: Beat[] = [
    ...ignite(1.2),
    ...exchange(2.2),
    ...rally(3.6, 7),
    ...leap(6.0),
    ...exchange(7.4),
    ...lock(8.8, 1.8),
    ...rally(10.9, 9),
    ...leap(13.9),
    ...exchange(15.2),
    ...rally(16.6, 5),
  ];
  // Disarm: the winner strikes hard from below upward and the other's blade goes out.
  const W0 = { lean: 0.5, armDir: 0.2, armReach: 1, blade: 0.2, front: 72 }, W1 = { lean: 0.2, armDir: 1.2, armReach: 1, blade: 1.6 };
  const L0 = { lean: 0.2, armDir: 0.2, blade: 0.4 }, L1 = { lean: -0.2, armDir: -0.6, armReach: 0.5, blade: -0.9, crouch: 0.8, mouth: 0.1 };
  beats.push(
    B(18.4, w ? -140 : -150, w ? W0 : L0, w ? 150 : 140, w ? L0 : W0),
    B(18.8, w ? -130 : -170, w ? W1 : L1, w ? 170 : 130, w ? L1 : W1, { flash: 1 }),
    { ...B(20.0, w ? -120 : -180, w ? W1 : L1, w ? 180 : 120, w ? L1 : W1), winner },
    { ...B(22.0, w ? -120 : -180, w ? { ...W1, blade: 1.55, offArm: 1 } : L1, w ? 180 : 120, w ? L1 : { ...W1, blade: 1.55, offArm: 1 }), winner },
  );
  return beats;
}

export const duration = (beats: Beat[]) => beats[beats.length - 1]!.t;

const ez = (u: number) => (u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2);
function mixStance(a: Stance, b: Stance, u: number): Stance {
  const o = {} as Stance;
  for (const k of Object.keys(a) as (keyof Stance)[]) o[k] = a[k] + (b[k] - a[k]) * u;
  return o;
}

/** The `time` instant of the choreography: postures interpolated between hits. */
export function beatAt(beats: Beat[], time: number): Beat & { prevBlades: [number, number] } {
  let i = 0;
  while (i < beats.length - 2 && beats[i + 1]!.t <= time) i++;
  const p = beats[i]!, n = beats[i + 1]!;
  const u = ez(clamp((time - p.t) / Math.max(1e-6, n.t - p.t)));
  const near = Math.abs(time - n.t) < 0.07 ? n : Math.abs(time - p.t) < 0.07 ? p : null;
  return {
    t: time,
    a: { x: p.a.x + (n.a.x - p.a.x) * u, st: mixStance(p.a.st, n.a.st, u) },
    b: { x: p.b.x + (n.b.x - p.b.x) * u, st: mixStance(p.b.st, n.b.st, u) },
    on: p.on + (n.on - p.on) * u,
    flash: near?.flash,
    lock: p.lock && n.lock,
    winner: n.winner ?? p.winner,
    prevBlades: [p.a.st.blade, p.b.st.blade],
  };
}

// ---------- Painting a moment ----------
export interface DuelCast {
  coats: [Coat, Coat];
  collars: [string, string];
  colors?: [string, string];
}

/**
 * Paints the duel at instant `time` around (cx, floorY) at scale `s`.
 * Returns the intensity of the screen flash due (0..1): the caller
 * decides whether to whiten the whole frame.
 */
/**
 * Separation between the two, over the choreography's x. The swords measure
 * ~190 and the arm ~100: closer together, they pile on top of each other and the blades
 * hide behind the heads; this way they cross in the gap in the middle.
 */
export const SPREAD = 1.55;

export function drawDuel(c: X, beats: Beat[], time: number, cx: number, floorY: number, s: number, cast: DuelCast, seed = 1): number {
  const bt = beatAt(beats, time);
  const prev = time > 0.12 ? beatAt(beats, time - 0.12) : null;
  const colors = cast.colors ?? ['#FFB23D', '#B86BFF'];
  const blades: Blade[] = [];
  const len = 190 * clamp(bt.on);
  for (const [k, side] of [[0, 1], [1, -1]] as const) {
    const who = k === 0 ? bt.a : bt.b;
    const loser = bt.winner && bt.winner !== (k === 0 ? 'a' : 'b');
    c.save();
    c.translate(cx + who.x * SPREAD * s, floorY);
    c.scale(s * side, s);
    // Shadow, which shrinks when jumping
    c.fillStyle = `rgba(0,0,0,${clamp(0.4 - who.st.jump / 500)})`;
    ellipse(c, 0, 0, 120 - who.st.jump * 0.3, 14);
    c.fill();
    const hilt = profileCat(c, cast.coats[k], who.st, seed + k * 97, cast.collars[k]);
    // The sword, in the cat's coordinates; its absolute angle, mirrored for B.
    const trail = prev ? (k === 0 ? prev.a.st.blade : prev.b.st.blade) : null;
    const bl = saber(c, hilt.hand, hilt.blade, loser ? 0 : len, colors[k]!, trail);
    gripPaw(c, cast.coats[k], hilt.hand, hilt.blade);
    c.restore();
    // To scene coordinates, to look for the crossing
    const toScene = (x: number, y: number): P => [cx + who.x * SPREAD * s + x * s * side, floorY + y * s];
    const [x0, y0] = toScene(bl[0], bl[1]), [x1, y1] = toScene(bl[2], bl[3]);
    blades.push([x0, y0, x1, y1]);
  }
  let flash = bt.flash ?? 0;
  const x = len > 20 ? crossing(blades[0]!, blades[1]!) : null;
  if (x) {
    const fast = prev ? Math.abs(bt.a.st.blade - prev.a.st.blade) + Math.abs(bt.b.st.blade - prev.b.st.blade) : 0;
    const power = clamp(0.6 + fast * 1.2 + (bt.lock ? 0.3 : 0), 0.5, 1.4) * s * 1.4;
    sparks(c, x, power, Math.round(time * 100) + seed);
    lightning(c, x, power, Math.round(time * 100) + seed, bt.lock ? [blades[0]!, blades[1]!] : undefined);
    flash = Math.max(flash, bt.lock ? 0.15 : 0);
  }
  return flash;
}

/**
 * On all fours at full speed, in profile facing right: the
 * mad dash in the small hours. `stretch` 1 is the stretched gallop (front
 * and hind legs spread out, in the air); 0, tucked (legs underneath).
 * Pupils fully dilated and ears pinned back. Origin: floor, under the back.
 */
export function runningCat(c: X, coat: Coat, seed: number, collar: string, stretch: number): void {
  const s = clamp(stretch);
  const air = 18 + s * 22;
  const hip: P = [-70, -118 - air], chest: P = [62, -132 - air];
  const neck = add(chest, [26, -34]);
  const headC = add(chest, [72, -56]);
  const far = shade(coat, 0.7);
  // Legs: stretched out diagonally or tucked under the body.
  const leg = (cc: Coat, root: P, toe: P, near: boolean, k: number) => {
    const knee = ik(root, toe, 62, 58, near ? 1 : -1);
    limb(c, cc, root, near ? 24 : 20, knee, 13, seed + k, near ? 0.6 : 0.35);
    limb(c, cc, knee, 12, toe, 9, seed + k + 1, near ? 0.55 : 0.3);
    paw(c, cc, toe, 14, 8, 0);
  };
  const frontToe = (dx: number): P => [chest[0] + 40 + s * 70 + dx, -12 - s * 20];
  const backToe = (dx: number): P => [hip[0] - 20 - s * 90 + dx, -10 - s * 26];
  const gathered = (x: number, dx: number): P => [x + dx, -8];
  leg(far, add(chest, [-10, 20]), s > 0.5 ? frontToe(-26) : gathered(chest[0] - 40, 20), false, 10);
  leg(far, add(hip, [-6, 16]), s > 0.5 ? backToe(24) : gathered(hip[0] + 60, -10), false, 20);
  // Tail straight back, bristling from the speed.
  const rump = add(hip, [-34, -4]);
  tailAlong(c, coat, bezierPts([rump, add(rump, [-60, -10]), add(rump, [-120, -30]), add(rump, [-170, -24])]), seed + 30, 1.25);
  // Elongated body: the gallop stretches the back.
  const torso = (cc: X) => capsule(cc, hip, 50, chest, 46);
  torso(c);
  c.fillStyle = radial(c, chest[0], chest[1] - 20, 10, 170, [[0, css(coat.fur.light)], [0.5, css(coat.fur.mid)], [1, css(coat.fur.dark)]]);
  c.fill();
  fur(c, coat, torso, [hip[0] - 55, chest[1] - 55, chest[0] + 55, hip[1] + 55], 1800, {
    seed: seed + 40, light: sphereLight(0, -150 - air, 90, 60), dir: () => Math.PI,
    stripe: (x, y) => (y < -125 - air ? (Math.sin(x * 0.11) > 0.5 ? 0.9 : 0) : 0),
    cream: (_x, y) => clamp((y - (-112 - air)) / 26),
  });
  leg(coat, add(hip, [8, 20]), s > 0.5 ? backToe(0) : gathered(hip[0] + 90, 0), true, 50);
  leg(coat, add(chest, [6, 22]), s > 0.5 ? frontToe(0) : gathered(chest[0] - 60, 0), true, 60);
  // Neck, ears pinned back and head stretched forward.
  limb(c, coat, chest, 32, neck, 28, seed + 65, 0.6);
  for (const [ox, k] of [[-40, 0.72], [-18, 1]] as const) {
    const cc = k < 1 ? far : coat;
    const b1 = add(headC, [ox - 6, -28]), tip = add(headC, [ox - 48, -40]), b2 = add(headC, [ox + 22, -34]);
    c.beginPath();
    c.moveTo(b1[0], b1[1]);
    c.quadraticCurveTo(tip[0] + 10, tip[1] - 6, tip[0], tip[1]);
    c.quadraticCurveTo(tip[0] + 24, tip[1] + 14, b2[0], b2[1]);
    c.closePath();
    c.fillStyle = css(cc.fur.dark);
    c.fill();
  }
  const head = (cc: X) => furryShape(cc, headC[0], headC[1], 50, 42, 2.2, (a) => (Math.cos(a) < -0.2 ? 0.12 : 0.02), seed + 70);
  head(c);
  c.fillStyle = radial(c, headC[0], headC[1] - 10, 8, 70, [[0, css(coat.fur.light)], [0.55, css(coat.fur.mid)], [1, css(coat.fur.dark)]]);
  c.fill();
  fur(c, coat, head, [headC[0] - 60, headC[1] - 55, headC[0] + 60, headC[1] + 50], 1300, {
    seed: seed + 71, light: sphereLight(headC[0] + 8, headC[1] - 8, 52, 45),
    dir: (x, y) => Math.atan2(y - headC[1] - 10, x - headC[0] - 50) + Math.PI,
    stripe: (x, y) => (x < headC[0] + 5 && y < headC[1] - 12 ? (Math.sin((x - headC[0]) * 0.38) > 0.45 ? 0.85 : 0) : 0),
    cream: (x, y) => 1 - clamp((Math.hypot((x - headC[0] - 30) / 30, (y - headC[1] - 22) / 18) - 0.7) / 0.35),
  });
  const muzzle = add(headC, [40, 12]);
  c.fillStyle = css(coat.cream.mid);
  ellipse(c, muzzle[0], muzzle[1], 24, 17, 0.1);
  c.fill();
  c.fillStyle = radial(c, muzzle[0] + 20, muzzle[1] - 12, 1, 8, [[0, '#FFC9D4'], [1, '#D86A84']]);
  ellipse(c, muzzle[0] + 21, muzzle[1] - 10, 7, 5.5, 0.3);
  c.fill();
  // Eye like a saucer: in the small hours, the pupil eats the iris.
  const eyeC = add(headC, [16, -8]);
  eye(c, coat.eye, eyeC[0], eyeC[1], 17, 19, 15);
  c.strokeStyle = 'rgba(255,255,255,0.85)';
  c.lineWidth = 1.4;
  for (const d of [-5, 2, 9]) {
    // Whiskers swept back by the wind.
    c.beginPath();
    c.moveTo(muzzle[0] + 4, muzzle[1] + d * 0.6);
    c.quadraticCurveTo(muzzle[0] - 30, muzzle[1] - 2 + d, muzzle[0] - 70, muzzle[1] + 4 + d * 1.6);
    c.stroke();
  }
  c.strokeStyle = collar;
  c.lineWidth = 7;
  c.beginPath();
  const n1 = add(neck, [-26, 2]), n2 = add(neck, [22, 20]);
  c.moveTo(n1[0], n1[1]);
  c.quadraticCurveTo((n1[0] + n2[0]) / 2 - 6, (n1[1] + n2[1]) / 2 + 12, n2[0], n2[1]);
  c.stroke();
}

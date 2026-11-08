/**
 * The cats room, at rest: every agent session is a cat, and how close it sits
 * says how much it needs you (see layout.ts). Ported from aimonitor's
 * `scene/render.ts` without the gestures, the walking between spots and the
 * card column (in Tessera that column is just other tiles beside the scene).
 *
 * Fur is tens of thousands of strokes: a detailed cat costs ~100 ms. So cats
 * and the room are cached already painted, and each frame only composes them
 * and writes what changes: tags, sign boards and the wall clock.
 *
 * Everything is designed at 462 units high (`DESIGN_H`) and scaled to the
 * canvas; the width in design units follows the canvas aspect.
 */
import type { Canvas } from '@tessera/sdk';
import type { SunTimes, Weather } from '@loksly/weather-astro';
import { createCanvas } from './canvas.ts';
import { COATS, EXTENT, type Pose, backCat, boxGhost, boxSleeper, collarFor, frontCat, hiss, knead, pairHeart, schrodinger, sleepCat } from './cat.ts';
import { COND, MONO, MONO_BOLD } from './fonts.ts';
import { type Actor, DESIGN_H, MARGIN, RIGHT_ZONE, type ColumnSide, type LayoutConfig, type SceneLayout, SILL, floorAt, heightOf, layoutScene, placeTags, tagText } from './layout.ts';
import { ABANDONED_MS, nightOwl, partyTime, spookyDay } from './moments.ts';
import { type X, ellipse, hashString, linear, radial } from './paint.ts';
import { cobweb, deskDuck, devilHorns, meetingDoor, partyHat, tie } from './props.ts';
import { type RoomName, type Sky, WINDOW, clockPos, daylight, lampX, paintRoom, resolveRoom, skyKey, spaceHelmet, wallClock } from './room.ts';
import type { SessionView } from './types.ts';
import { type Words, countdown } from './words.ts';

/** aimonitor's art direction: the room keeps it whatever the panel theme. */
export const BG = '#090C10';
export const STATE_COLOR: Record<SessionView['state'], string> = {
  permission: '#F5453D',
  waiting: '#FFB020',
  ready: '#4DA3FF',
  active: '#2E8A82',
  idle: '#2E8A82',
};

export interface SceneOptions {
  /** `rotate` (a different room every day) or a room name (see `ROOMS`). */
  room: string;
  /** Strip kept free of cats, as the old card column did; `none` uses the whole floor. */
  column: 'none' | ColumnSide | 'alternar';
  swapSidesMs: number;
  /** An active session silent for half of this is drawn as Schrödinger's box. */
  zombieMs: number;
}

export interface SceneInput {
  sessions: SessionView[];
  now: number;
  /** Size of the canvas to paint, in pixels. */
  width: number;
  height: number;
  options: SceneOptions;
  words: Words;
  /** Latest weather reading; null = clear sky following the clock. */
  weather?: Weather | null;
  /** Today's sunrise and sunset; without them, fixed hours. */
  sun?: SunTimes | null;
  /** Nobody in front of the panel: the cats that wait for you doze. */
  away?: boolean;
}

/** Design width of the card column, when one is kept free. */
export const COLUMN_W = RIGHT_ZONE;

/** Where the desk duck sits, relative to the cat at the laptop. */
const DUCK_AT = { x: 178, y: -80, s: 0.6 };

// ---------- Cache ----------
/** Tiny LRU: a Map keeps insertion order. */
class Lru<V> {
  private map = new Map<string, V>();
  private readonly max: number;
  /** Times the value had to be made: the cache misses. */
  misses = 0;
  constructor(max: number) {
    this.max = max;
  }
  get(key: string, make: () => V): V {
    const hit = this.map.get(key);
    if (hit !== undefined) {
      this.map.delete(key);
      this.map.set(key, hit);
      return hit;
    }
    this.misses++;
    const v = make();
    this.map.set(key, v);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
    return v;
  }
  get size() {
    return this.map.size;
  }
}

interface Sprite {
  canvas: Canvas;
  ox: number;
  oy: number;
}

const sprites = new Lru<Sprite>(32);
const rooms = new Lru<Canvas>(4);
const vignettes = new Lru<Canvas>(4);

/** For tests and diagnostics: cats and rooms painted from scratch. */
export function cacheStats(): { sprites: number; rooms: number; paints: number; roomPaints: number } {
  return { sprites: sprites.size, rooms: rooms.size, paints: sprites.misses, roomPaints: rooms.misses };
}

function vignette(w: number, h: number): Canvas {
  return vignettes.get(`${w}x${h}`, () => {
    const v = createCanvas(w, h);
    const c = v.getContext('2d');
    c.translate(w / 2, h / 2);
    c.scale(1, h / w);
    c.fillStyle = radial(c, 0, 0, w * 0.32, w * 0.62, [[0, 'rgba(0,0,0,0)'], [1, 'rgba(0,0,0,0.38)']]);
    c.fillRect(-w, -w, 2 * w, 2 * w);
    return v;
  });
}

const TOP = 400; // the highest a pose rises above the floor, with margin
const BOTTOM = 90; // how low it goes: shadows and the tails' heart
const PAD = 45;

const seedOf = (r: SessionView) => hashString(r.session_id) & 0xffff;

/**
 * Copies to a clean canvas, to cache pixels only.
 *
 * @napi-rs/canvas doesn't rasterise while drawing: it records every call and
 * replays it when encoding or copying. A freshly painted canvas keeps the
 * whole recording of the fur alive (~260 bytes per call, 900 MB for 30
 * canvases of 100,000 strokes). Copying it with `drawImage` and keeping the
 * copy drops it.
 */
function flatten(src: Canvas, blurPx = 0): Canvas {
  const out = createCanvas(src.width, src.height);
  const o = out.getContext('2d');
  if (blurPx > 0) o.filter = `blur(${blurPx}px)`;
  o.drawImage(src, 0, 0);
  return out;
}

/**
 * Room light on a cat. Three levels and two sides, so the cache is renewed
 * only a couple of times a day and not whenever someone moves.
 */
export interface Light {
  /** 0 night (the lamp rules), 1 dusk, 2 day (the window rules). */
  level: 0 | 1 | 2;
  /** Which side of the cat the light comes from: -1 left, 1 right. */
  side: -1 | 1;
}

export function lightLevel(sky: Sky): Light['level'] {
  const dl = daylight(sky.hour, sky.rise, sky.set);
  return dl > 0.66 ? 2 : dl > 0.2 ? 1 : 0;
}

/** Where the light comes from: the lamp at night, the window by day. */
const lightX = (level: Light['level'], W: number) => (level === 0 ? lampX(W) : WINDOW.x + WINDOW.w / 2);

/** Tints the painted cat with the room's light (only where there is cat). */
function grade(o: X, w: number, h: number, light: Light): void {
  o.save();
  o.setTransform(1, 0, 0, 1, 0, 0);
  o.globalCompositeOperation = 'source-atop';
  const [amb, key] = light.level === 0
    ? ['rgba(16,20,44,0.20)', 'rgba(255,176,104,0.26)']
    : light.level === 1
      ? ['rgba(60,30,40,0.08)', 'rgba(255,150,90,0.18)']
      : ['rgba(200,220,255,0.04)', 'rgba(225,238,255,0.16)'];
  o.fillStyle = amb;
  o.fillRect(0, 0, w, h);
  // The side facing the light, brighter and in its colour.
  o.fillStyle = linear(o, light.side > 0 ? w : 0, 0, light.side > 0 ? w * 0.35 : w * 0.65, 0, [[0, key], [1, key.replace(/[\d.]+\)$/, '0)')]]);
  o.fillRect(0, 0, w, h);
  o.restore();
}

/** Depth of field: only the background, and just a little (panel pixels). */
const blurFor = (a: Actor) => (a.sill ? 0 : a.z < 0.6 ? 0 : Math.round((a.z - 0.55) * 4) / 2);
const coat = (name: string) => COATS[name] ?? COATS.canela!;

/**
 * Paints one pose. `flavor` is what changes with the hour or the day and lasts
 * hours (wide pupils after midnight, the Halloween ghost): it goes into the
 * cache key.
 */
function paintPose(c: X, a: Actor, pose: Pose, flavor: string, words: Words): void {
  const [r0, r1] = a.records;
  const c0 = coat(a.coats[0]!);
  const c1 = coat(a.coats[1] ?? a.coats[0]!);
  const box = `bold 26px ${MONO_BOLD}`;
  switch (a.pose) {
    case 'cartel': frontCat(c, c0, { mood: 'wide', collar: collarFor(r0!.provider), pose, dilate: flavor.includes('n') }); break;
    case 'sentado': frontCat(c, c0, { mood: 'open', collar: collarFor(r0!.provider), pose, dilate: flavor.includes('n') }); break;
    case 'portatil': backCat(c, c0, seedOf(r0!), { pose, laptop: true }); break;
    case 'dormido': sleepCat(c, c0, seedOf(r0!)); break;
    case 'caja':
      if (flavor.includes('f')) boxGhost(c, box, 0, 0, words.fragile);
      else boxSleeper(c, c0, seedOf(r0!), box, words.fragile);
      break;
    case 'schrodinger': schrodinger(c, `bold 64px ${MONO_BOLD}`, pose.lid ?? 0); break;
    case 'corazon': pairHeart(c, c0, c1); break;
    case 'amasa': knead(c, c0, c1, collarFor(r1!.provider), pose); break;
    case 'bufido': hiss(c, c0, c1, [collarFor(r0!.provider), collarFor(r1!.provider)]); break;
  }
}

/** The cat already painted at its scale and with its haze, ready to compose. */
function sprite(a: Actor, k: number, pose: Pose, light: Light, flavor: string, words: Words): Sprite {
  const fog = a.sill ? 0.2 : Math.round(a.z * 20) / 20 * 0.38;
  const s = a.scale * k;
  const blur = blurFor(a);
  const key = [a.pose, a.coats.join(','), a.records.map((r) => `${r.provider}:${seedOf(r)}`).join(','), s.toFixed(3), fog.toFixed(3), `${light.level}${light.side}`, blur, flavor, words.fragile, JSON.stringify(pose)].join('|');
  return sprites.get(key, () => {
    const [L, R] = EXTENT[a.pose]!;
    const w = Math.ceil((R - L + PAD * 2) * s), h = Math.ceil((TOP + BOTTOM) * s);
    const canvas = createCanvas(Math.max(1, w), Math.max(1, h));
    const o = canvas.getContext('2d');
    const ox = (PAD - L) * s, oy = TOP * s;
    o.translate(ox, oy);
    o.scale(s, s);
    paintPose(o, a, pose, flavor, words);
    grade(o, w, h, light);
    if (fog > 0) {
      // Aerial perspective: what is far melts into the room.
      o.setTransform(1, 0, 0, 1, 0, 0);
      o.globalCompositeOperation = 'source-atop';
      o.fillStyle = `rgba(42,49,68,${fog})`;
      o.fillRect(0, 0, w, h);
    }
    return { canvas: flatten(canvas, blur), ox, oy };
  });
}

// ---------- Live text and boards ----------
function text(c: X, t: string, x: number, y: number, font: string, color: string, align: 'left' | 'center' | 'right' = 'left'): number {
  c.font = font;
  c.fillStyle = color;
  c.textAlign = align;
  c.fillText(t, x, y);
  const w = c.measureText(t).width;
  c.textAlign = 'left';
  return w;
}

/** Trims with an ellipsis until it fits. */
function fit(c: X, t: string, font: string, max: number): string {
  c.font = font;
  if (c.measureText(t).width <= max) return t;
  let s = t;
  while (s.length > 1 && c.measureText(`${s}…`).width > max) s = s.slice(0, -1);
  return `${s}…`;
}

function toneColor(a: Actor): string {
  if (a.pose === 'bufido') return STATE_COLOR.permission;
  if (a.tone === 'zombi') return '#8A96A6';
  if (a.tone === 'active' || a.tone === 'idle') return '#4FC3B8';
  return STATE_COLOR[a.tone];
}

/** Width a tag asks for with all its text, and the height of its row. */
function tagSize(c: X, name: string, time: string, size: number): { w: number; h: number } {
  c.font = `bold ${size}px ${MONO_BOLD}`;
  const t1 = c.measureText(name).width;
  c.font = `${size}px ${MONO}`;
  const t2 = c.measureText(time).width;
  return { w: size * 1.6 + t1 + size * 0.6 + t2 + size * 0.8, h: size * 1.6 };
}

/**
 * Text of a tag for a given width. Whole if it fits; otherwise the time is
 * trimmed first (down to a minimum) and then the name.
 */
export function fitTagText(c: X, name: string, time: string, size: number, maxW: number): { name: string; time: string } {
  const bold = `bold ${size}px ${MONO_BOLD}`, reg = `${size}px ${MONO}`;
  const inner = maxW - size * 3;
  c.font = bold;
  const n0 = c.measureText(name).width;
  c.font = reg;
  const t0 = c.measureText(time).width;
  if (n0 + t0 <= inner + 0.5) return { name, time };
  const tt = fit(c, time, reg, Math.max(size * 3, inner - n0));
  c.font = reg;
  const t2 = c.measureText(tt).width;
  return { name: fit(c, name, bold, Math.max(size * 2, inner - t2)), time: tt };
}

function tag(c: X, x: number, y: number, name: string, time: string, col: string, size: number, alpha: number, maxW: number): void {
  c.save();
  c.globalAlpha = alpha;
  const bold = `bold ${size}px ${MONO_BOLD}`, reg = `${size}px ${MONO}`;
  const { name: n, time: tt } = fitTagText(c, name, time, size, maxW);
  c.font = reg;
  const t2 = c.measureText(tt).width;
  c.font = bold;
  const t1 = c.measureText(n).width;
  const w = size * 1.6 + t1 + size * 0.6 + t2 + size * 0.8, h = size * 1.6;
  c.fillStyle = 'rgba(9,12,18,0.8)';
  c.beginPath();
  c.roundRect(x - w / 2, y, w, h, h / 2);
  c.fill();
  c.fillStyle = col;
  ellipse(c, x - w / 2 + size * 0.85, y + h / 2, size * 0.32, size * 0.32);
  c.fill();
  text(c, n, x - w / 2 + size * 1.5, y + size * 1.15, bold, '#E6EDF5');
  text(c, tt, x - w / 2 + size * 1.5 + t1 + size * 0.6, y + size * 1.15, reg, '#9AA7B6');
  c.restore();
}

function bubble(c: X, x: number, y: number, t: string, size: number): void {
  const font = `bold ${size}px ${MONO_BOLD}`;
  c.font = font;
  const w = c.measureText(t).width + size * 1.2, h = size * 1.7;
  c.fillStyle = 'rgba(255,255,255,0.95)';
  c.beginPath();
  c.roundRect(x, y, w, h, h / 2);
  c.fill();
  c.beginPath();
  c.moveTo(x + w * 0.25, y + h - 2);
  c.lineTo(x + w * 0.18, y + h + size * 0.6);
  c.lineTo(x + w * 0.38, y + h - 2);
  c.fill();
  text(c, t, x + size * 0.6, y + size * 1.22, font, '#1E2230');
}

function outlined(c: X, t: string, x: number, y: number, size: number, color: string): void {
  c.font = `bold ${size}px ${MONO_BOLD}`;
  c.lineWidth = Math.max(2, size / 7);
  c.strokeStyle = 'rgba(10,12,18,0.85)';
  c.strokeText(t, x, y);
  c.fillStyle = color;
  c.fillText(t, x, y);
}

/** Wooden sign board planted next to the cat that asks for permission. Cat-local coordinates. */
function signBoard(c: X, r: SessionView, now: number, words: Words): void {
  const x = 150, y = -330, w = 276, h = 204;
  c.fillStyle = '#5E3F22';
  c.fillRect(x + w / 2 - 7, y + h - 4, 14, -y - h + 4);
  c.fillStyle = 'rgba(0,0,0,0.4)';
  c.beginPath();
  c.roundRect(x + 6, y + 8, w, h, 10);
  c.fill();
  c.fillStyle = linear(c, x, y, x, y + h, [[0, '#B9864E'], [1, '#8C5E30']]);
  c.beginPath();
  c.roundRect(x, y, w, h, 10);
  c.fill();
  c.fillStyle = linear(c, x, y, x, y + h, [[0, '#FFF8EA'], [1, '#EFE2C6']]);
  c.beginPath();
  c.roundRect(x + 10, y + 10, w - 20, h - 20, 6);
  c.fill();
  c.fillStyle = '#6B6B6B';
  ellipse(c, x + 20, y + 20, 3, 3);
  c.fill();
  ellipse(c, x + w - 20, y + 20, 3, 3);
  c.fill();
  const inner = w - 36;
  const lines: [string, number, string, string][] = [
    [words.mayI, 44, `bold 44px ${MONO_BOLD}`, '#C62A22'],
    [r.project, 30, `bold 30px ${COND}`, '#2A1A10'],
    [r.detail || words.asksPermission, 19, `19px ${MONO}`, '#5A4A3A'],
    [words.elapsed(now - r.since), 34, `bold 34px ${MONO_BOLD}`, '#2A1A10'],
  ];
  let yy = y + 20;
  for (const [t, size, font, col] of lines) {
    yy += size * 1.12;
    text(c, fit(c, t, font, inner), x + w / 2, yy, font, col, 'center');
  }
}

const MEETING_SOON_MS = 10 * 60_000;

/** The meeting door, on the wall between the plant and the window. */
const DOOR_X = 460;

/**
 * Heads of each pose, in cat units: where a hat goes (`top`) and, for the
 * ones facing you, where the tie hangs (`chest`).
 */
function heads(a: Actor): { dx: number; top: number; chest?: number }[] {
  switch (a.pose) {
    case 'sentado': case 'cartel': return [{ dx: 0, top: -258, chest: -122 }];
    case 'portatil': return [{ dx: 0, top: -258 }];
    case 'corazon': return [{ dx: -98, top: -258 }, { dx: 98, top: -258 }];
    case 'amasa': return [{ dx: 0, top: -258 }, { dx: 190, top: -258, chest: -122 }];
    case 'bufido': return [{ dx: -150, top: -258, chest: -122 }, { dx: 150, top: -258, chest: -122 }];
    default: return [];
  }
}

const HAT_COLORS = ['#FF5C8A', '#4DA3FF', '#FFD34D', '#39D98A', '#C58BFF'];

type TagSpot = { name: string; time: string; size: number; y: number; x: number; w: number; h: number };

function computeTags(ctx: X, L: SceneLayout, now: number, words: Words): Map<Actor, TagSpot> {
  const wants = L.actors
    .filter((a) => a.pose !== 'cartel')
    .sort((a, b) => a.z - b.z)
    .map((a) => {
      const { name, time } = tagText(a, now, words);
      const size = Math.max(14, Math.round(20 * (1 - a.z * 0.3)));
      const below = a.pose === 'corazon' ? 64 * a.scale : 4;
      const y = a.sill ? a.floorY + 6 : Math.min(DESIGN_H - size * 1.7, a.floorY + below);
      const { w, h } = tagSize(ctx, name, time, size);
      return { a, name, time, size, box: { x: a.x, y, h, w, minW: Math.min(w, size * 6) } };
    });
  const spots = placeTags(wants.map((t) => t.box), L.zone.lo + MARGIN, L.zone.hi - MARGIN);
  const out = new Map<Actor, TagSpot>();
  wants.forEach((t, i) => out.set(t.a, { name: t.name, time: t.time, size: t.size, y: t.box.y, h: t.box.h, x: spots[i]!.x, w: spots[i]!.w }));
  return out;
}

/** Layout settings from the widget options. */
export function layoutConfig(o: SceneOptions): LayoutConfig {
  return { zombieMs: o.zombieMs, side: o.column === 'none' ? 'derecha' : o.column, swapSidesMs: o.swapSidesMs };
}

/** Design width of the strip kept free of cats. */
export const columnWidth = (o: SceneOptions) => (o.column === 'none' ? 0 : COLUMN_W);

/**
 * The room was drawn for aimonitor's 1920×462 panel: the window, the
 * picture and the shelf sit at fixed spots, while the lamp and the wall clock
 * hang at a fraction of the width. Below this width they would collide with
 * the window, so a narrower tile shows a crop of a room this wide.
 */
export const MIN_ROOM_W = 1800;

export interface RoomView {
  /** Pixels per design unit. */
  k: number;
  /** Visible width, in design units. */
  W: number;
  /** Width of the painted room, in design units (≥ W). */
  RW: number;
  /** Where the visible part starts in the room, in design units. */
  x0: number;
}

export function roomView(width: number, height: number): RoomView {
  const k = height / DESIGN_H;
  const W = width / k;
  const RW = Math.max(W, MIN_ROOM_W);
  if (RW <= W) return { k, W, RW, x0: 0 };
  // A crop keeps the wall clock whole (it tells the time) and the window sill
  // (a cat sleeps there); what goes first is the shelf on the left.
  const clockRight = clockPos(RW).x + 70;
  const x0 = Math.max(0, Math.min(clockRight - W, RW - W, SILL.x - 80));
  return { k, W, RW, x0 };
}

/** The cast of the scene, without painting (tests, the duel). */
export function sceneLayout(input: Pick<SceneInput, 'sessions' | 'now' | 'width' | 'height' | 'options'>): SceneLayout {
  const v = roomView(input.width, input.height);
  return layoutScene(input.sessions, input.now, layoutConfig(input.options), v.W, columnWidth(input.options), v.x0);
}

/** Where the tags land, for the tests: rectangles in design units. */
export function sceneTagRects(input: SceneInput): { x0: number; x1: number; y0: number; y1: number; name: string; fits: boolean }[] {
  const L = sceneLayout(input);
  const ctx = createCanvas(1, 1).getContext('2d');
  return [...computeTags(ctx, L, input.now, input.words).values()].map((t) => ({
    x0: t.x - t.w / 2, x1: t.x + t.w / 2, y0: t.y, y1: t.y + t.h, name: t.name,
    fits: tagSize(ctx, t.name, t.time, t.size).w <= t.w + 0.5,
  }));
}

/** The sky outside the window right now. */
export function skyOf(now: number, weather: Weather | null | undefined, sun: SunTimes | null | undefined): Sky {
  const d = new Date(now);
  return { hour: d.getHours() + d.getMinutes() / 60, code: weather?.code ?? 0, now, rise: sun?.rise, set: sun?.set };
}

/** The whole room painted for a `v` view, cached while the sky doesn't change. */
export function roomCanvas(v: RoomView, height: number, sky: Sky, room: RoomName, words: Words): Canvas {
  const width = Math.ceil(v.RW * v.k);
  return rooms.get(`${width}x${height}|${room}|${skyKey(sky)}|${words.notOnFriday}`, () => {
    const rc = createCanvas(width, height);
    const r = rc.getContext('2d');
    r.scale(v.k, v.k);
    paintRoom(r, v.RW, DESIGN_H, sky, room, words.notOnFriday);
    return flatten(rc);
  });
}

/** Paints the room of view `v` on `ctx`, cropped to the visible part. */
export function drawRoom(ctx: X, v: RoomView, height: number, sky: Sky, room: RoomName, words: Words): void {
  ctx.drawImage(roomCanvas(v, height, sky, room, words), Math.round(-v.x0 * v.k), 0);
}

// ---------- Frame ----------
export function renderScene(input: SceneInput): Canvas {
  const { width, height, now, words, options } = input;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, width, height);

  const v = roomView(width, height);
  const { k, RW } = v;
  // Design units → canvas pixels, and the same for x alone (sprites are drawn unscaled).
  const toDesign = () => ctx.setTransform(k, 0, 0, k, -v.x0 * k, 0);
  const px = (x: number) => (x - v.x0) * k;

  const d = new Date(now);
  const weather = input.weather ?? null;
  const sky = skyOf(now, weather, input.sun);
  const theme = resolveRoom(options.room, now);
  const inSpace = theme === 'espacio';
  drawRoom(ctx, v, height, sky, theme, words);

  toDesign();
  const cp = clockPos(RW);
  wallClock(ctx, cp.x, cp.y, cp.r, d);
  if (weather) {
    // The temperature outside, stuck on the window frame.
    ctx.fillStyle = 'rgba(8,11,17,0.75)';
    ctx.beginPath();
    ctx.roundRect(796, 46, 64, 24, 6);
    ctx.fill();
    text(ctx, `${Math.round(weather.temp)}°`, 828, 64, `bold 17px ${MONO_BOLD}`, '#FFD08A', 'center');
  }
  const L = layoutScene(input.sessions, now, layoutConfig(options), v.W, columnWidth(options), v.x0);
  const party = partyTime(now);
  const spooky = spookyDay(now);
  const flavor = `${nightOwl(now) ? 'n' : ''}${spooky ? 'f' : ''}`;
  const soon = L.meetings.filter((m) => m.startsAt !== undefined && m.startsAt - now <= MEETING_SOON_MS).sort((x, y) => x.startsAt! - y.startsAt!);
  const meetingSoon = soon.length > 0;
  if (meetingSoon) {
    const left = soon[0]!.startsAt! - now;
    meetingDoor(ctx, DOOR_X, 110, 272, words.meeting, left <= 0 ? words.now : words.inTime(countdown(left)));
  }

  // Tags are placed before painting anything, nearest first, so they don't overlap (see placeTags).
  const tagInfo = computeTags(ctx, L, now, words);
  const level = lightLevel(sky);
  const lx = lightX(level, RW);

  // Cats, back to front, with their tag on the floor and their texts on top.
  for (const a of L.actors) {
    const vs = a.scale, vx = a.x;
    // In space they float: each at its own height and a little tilted.
    const seedA = seedOf(a.records[0]!);
    const lift = inSpace && !a.sill ? (40 + (seedA % 60)) * vs : 0;
    const tilt = inSpace && !a.sill ? ((seedA >> 3) % 11 - 5) * 0.012 : 0;
    const vy = a.floorY - lift;
    const side: Light['side'] = lx >= a.x ? 1 : -1;
    // Shadow on the floor, stretched away from the light.
    if (!a.sill && !inSpace) {
      toDesign();
      ctx.save();
      ctx.translate(vx - side * 60 * vs, vy + 3);
      ctx.scale(1, 0.12);
      ctx.fillStyle = radial(ctx, 0, 0, 0, 160 * vs, [[0, `rgba(0,0,0,${level === 0 ? 0.3 : 0.2})`], [1, 'rgba(0,0,0,0)']]);
      ellipse(ctx, 0, 0, 170 * vs, 170 * vs);
      ctx.fill();
      ctx.restore();
    }
    const lead = a.records[0]!;
    const abandoned = a.pose === 'portatil' && lead.lastCommit !== undefined && now - lead.lastCommit >= ABANDONED_MS;
    // With nobody in front, the ones waiting for you doze with their eyes
    // closed, without changing pose: they still say they wait.
    const dozing = input.away === true && (a.pose === 'sentado' || a.pose === 'cartel');
    const sp = sprite(a, k, dozing ? { lid: 1 } : {}, { level, side }, flavor, words);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (tilt) {
      ctx.save();
      ctx.translate(px(vx), vy * k);
      ctx.rotate(tilt);
      ctx.drawImage(sp.canvas, -sp.ox, -sp.oy);
      ctx.restore();
    } else {
      ctx.drawImage(sp.canvas, Math.round(px(vx) - sp.ox), Math.round(vy * k - sp.oy));
    }
    toDesign();
    const sc = vs;
    if (a.pose === 'cartel') {
      ctx.save();
      ctx.translate(vx, vy);
      ctx.scale(sc, sc);
      signBoard(ctx, lead, now, words);
      ctx.restore();
    } else {
      const t = tagInfo.get(a)!;
      tag(ctx, t.x, t.y + (vy - a.floorY), t.name, t.time, toneColor(a), t.size, 1 - a.z * 0.25, t.w);
    }
    if (inSpace) {
      // Bubble helmet, turned with the cat.
      ctx.save();
      ctx.translate(vx, vy);
      ctx.rotate(tilt);
      ctx.scale(sc, sc);
      for (const h of heads(a)) spaceHelmet(ctx, h.dx, -200, 132);
      if (a.pose === 'dormido') spaceHelmet(ctx, -100, -48, 62, false);
      if (a.pose === 'caja') spaceHelmet(ctx, -80, -140, 56, false);
      ctx.restore();
    }
    if (abandoned) cobweb(ctx, vx, vy, sc);
    const top = vy - heightOf(a);
    if (a.pose === 'sentado') bubble(ctx, vx + 70 * sc, top - 40 * sc, words.goOn, Math.round(26 * sc + 6));
    if (a.pose === 'caja' && !spooky) {
      outlined(ctx, 'Z', vx - 150 * sc, top - 20 * sc, Math.round(40 * sc), '#CFE0FF');
      outlined(ctx, 'z', vx - 112 * sc, top + 12 * sc, Math.round(30 * sc), '#CFE0FF');
    }
    if (dozing) {
      for (const h of heads(a)) {
        outlined(ctx, 'z', vx + (h.dx + 70) * sc, vy + (h.top + 10) * sc, Math.round(22 * sc + 6), '#CFE0FF');
        outlined(ctx, 'z', vx + (h.dx + 95) * sc, vy + (h.top - 20) * sc, Math.round(16 * sc + 5), '#CFE0FF');
      }
    }
    if (a.pose === 'amasa') outlined(ctx, 'prrr', vx + 250 * sc, top - 10 * sc, Math.round(28 * sc + 4), '#FFFFFF');
    // Ties with a meeting coming; party hats on Friday afternoon.
    for (const [i, h] of heads(a).entries()) {
      if (meetingSoon && h.chest !== undefined) tie(ctx, vx + h.dx * sc, vy + h.chest * sc, sc);
      if (spooky) devilHorns(ctx, vx + h.dx * sc, vy + h.top * sc, sc);
      else if (party) partyHat(ctx, vx + h.dx * sc, vy + h.top * sc, sc, HAT_COLORS[(i + lead.session_id.length) % HAT_COLORS.length]!, i % 2 ? 0.15 : -0.15);
    }
    // The rubber duck that stayed as a mascot, next to the laptop.
    if (a.pose === 'portatil' && lead.duck) deskDuck(ctx, vx + DUCK_AT.x * sc, vy + DUCK_AT.y * sc, sc * DUCK_AT.s);
    if (a.pose === 'bufido') {
      outlined(ctx, words.hiss, vx - 330 * sc, vy - 300 * sc, Math.round(34 * sc + 4), '#FFFFFF');
      outlined(ctx, words.hiss, vx + 200 * sc, vy - 300 * sc, Math.round(34 * sc + 4), '#FFFFFF');
    }
  }
  if (L.overflow.length) {
    tag(ctx, L.floor.right - 50, floorAt(0.7) + 4, `+${L.overflow.length}`, words.more, '#8A96A6', 16, 0.9, 110);
  }

  // Vignette: slightly darker corners keep the eye on the scene.
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(vignette(width, height), 0, 0);
  return canvas;
}

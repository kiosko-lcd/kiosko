/**
 * The quarter-hour duel: two sessions of the room fight with lightsabers over
 * a darkened room. The one with fewer uncommitted files wins (on a tie, the
 * one that has been like that for less time); a lone session fights "the bug".
 */
import type { CanvasApi, Graphics, Image, InterludePlayer } from '@tessera/sdk';
import type { SunTimes, Weather } from '@loksly/weather-astro';
import { COATS, COAT_NAMES, collarFor } from './cat.ts';
import { COND, MONO_BOLD } from './fonts.ts';
import { type Beat, drawDuel, duration, longDuel } from './duel.ts';
import { DESIGN_H, layoutScene } from './layout.ts';
import { resolveRoom } from './room.ts';
import { drawRoom, roomView, skyOf } from './scene.ts';
import type { SessionView } from './types.ts';
import type { Words } from './words.ts';

/**
 * Frames per second. A frame costs 100-250 ms to paint and rasterise (two
 * furry cats in a new stance every time), too slow to draw live, so the whole
 * duel is painted beforehand (see `prerenderDuel`) and played back.
 */
export const DUEL_FPS = 8;

export interface DuelPlan {
  beats: Beat[];
  /** The two contenders: project name, coat and collar. */
  names: [string, string];
  coats: [string, string];
  collars: [string, string];
  winner: 'a' | 'b';
  /** Why it wins, for the closing title. */
  reason: string;
}

/**
 * Who fights: the first two sessions of the scene (from different projects
 * when possible). With a single one, against the bug; with none, no duel.
 */
export function planDuel(sessions: SessionView[], now: number, words: Words): DuelPlan | null {
  const L = layoutScene(sessions, now, { zombieMs: 15 * 60_000, side: 'derecha', swapSidesMs: 0 }, 1920, 0);
  const recs = L.actors.flatMap((a) => a.records.map((r, i) => ({ r, coat: a.coats[i] ?? a.coats[0]! })));
  if (!recs.length) return null;
  const A = recs[0]!;
  const Bp = recs.find((x) => x.r.project !== A.r.project) ?? recs[1];
  const bug = { r: { project: words.theBug, provider: 'claude', dirty: 99, since: 0 }, coat: A.coat === 'carbon' ? 'humo' : 'carbon' };
  const B = Bp ?? bug;
  const da = A.r.dirty ?? 0, db = B.r.dirty ?? 0;
  const winner: 'a' | 'b' = da !== db ? (da < db ? 'a' : 'b') : A.r.since >= B.r.since ? 'a' : 'b';
  const w = winner === 'a' ? A : B;
  const reason = !Bp ? words.bugHadNoChance : da !== db ? words.uncommittedFiles(w.r.dirty ?? 0) : words.onPoints;
  // Two cats with the same coat read as one cat twice: the second one changes.
  const coatB = B.coat === A.coat ? COAT_NAMES[(COAT_NAMES.indexOf(B.coat) + 1) % COAT_NAMES.length]! : B.coat;
  return {
    beats: longDuel(winner),
    names: [A.r.project, B.r.project],
    coats: [A.coat, coatB],
    collars: [collarFor(A.r.provider), collarFor(B.r.provider)],
    winner,
    reason,
  };
}

export interface DuelInput {
  plan: DuelPlan;
  width: number;
  height: number;
  now: number;
  /** `rotate` or a room name. */
  room: string;
  words: Words;
  weather: Weather | null;
  sun: SunTimes | null;
}

const coat = (name: string) => COATS[name] ?? COATS.canela!;

/** Paints the duel at `time` seconds on a canvas of `width`×`height`. */
export function drawDuelFrame(g: Graphics, o: DuelInput, time: number): void {
  const { plan, width, height, words } = o;
  const v = roomView(width, height);
  const { k, W } = v;
  g.setTransform(1, 0, 0, 1, 0, 0);
  drawRoom(g, v, height, skyOf(o.now, o.weather, o.sun), resolveRoom(o.room, o.now), words);
  g.fillStyle = 'rgba(8,10,20,0.42)';
  g.fillRect(0, 0, width, height);
  g.setTransform(k, 0, 0, k, 0, 0);
  const flash = drawDuel(g, plan.beats, time, W * 0.45, 446, 0.8, { coats: [coat(plan.coats[0]), coat(plan.coats[1])], collars: plan.collars }, 7);
  if (flash > 0) {
    g.fillStyle = `rgba(235,240,255,${flash * 0.4})`;
    g.fillRect(0, 0, W, DESIGN_H);
  }
  // Titles: who fights at the start, who won at the end.
  const title = (big: string, small: string, alpha: number) => {
    g.save();
    g.globalAlpha = alpha;
    g.textAlign = 'center';
    g.font = `bold 46px ${COND}`;
    g.lineWidth = 6;
    g.strokeStyle = 'rgba(10,12,18,0.9)';
    g.strokeText(big, W * 0.45, 90);
    g.fillStyle = '#FFE9B0';
    g.fillText(big, W * 0.45, 90);
    g.font = `bold 26px ${MONO_BOLD}`;
    g.lineWidth = 5;
    g.strokeText(small, W * 0.45, 130);
    g.fillStyle = '#E6EDF5';
    g.fillText(small, W * 0.45, 130);
    g.restore();
  };
  const T = duration(plan.beats);
  if (time < 2.4) title(words.duelTitle, words.versus(plan.names[0], plan.names[1]), Math.min(1, (2.4 - time) / 0.6));
  if (time > 19.6) title(words.wins(plan.names[plan.winner === 'a' ? 0 : 1]), plan.reason, Math.min(1, (time - 19.6) / 0.5, (T + 0.3 - time) / 0.5));
  g.setTransform(1, 0, 0, 1, 0, 0);
}

export const duelFrames = (plan: DuelPlan) => Math.round((duration(plan.beats) + 0.3) * DUEL_FPS) + 1;

/** Plays the duel painting each frame on the spot (tests, previews: too slow for a panel). */
export function duelPlayer(o: DuelInput): InterludePlayer {
  return { frames: duelFrames(o.plan), draw: (g, i) => drawDuelFrame(g, o, i / DUEL_FPS) };
}

/** Frames being encoded at once: the encoder runs on libuv's pool (4 threads by default). */
const IN_FLIGHT = 4;
/** Frames decoded ahead of the one playing. */
const AHEAD = 6;

/**
 * Paints the whole duel ahead and plays it back from JPEG frames.
 *
 * Painting a frame records the strokes on the main thread (~100 ms) and
 * rasterising + encoding it happens in `encode`, off the main thread; with a
 * few frames in flight the duel is ready in about frames × 100 ms, yielding
 * between frames so the rest of the app keeps running. 180 JPEG frames are
 * ~20 MB, against ~600 MB as raw canvases.
 *
 * Playback must be synchronous but decoding a JPEG isn't (an `Image` whose
 * `src` is set to a buffer draws black until it has decoded), so `draw`
 * keeps the next few frames decoding ahead with `loadImage` while the
 * runtime waits for the next frame's slot.
 */
export async function prerenderDuel(o: DuelInput, canvas: CanvasApi, signal?: { aborted: boolean }, quality = 88): Promise<InterludePlayer | null> {
  const count = duelFrames(o.plan);
  const out: Buffer[] = new Array(count);
  const pending = new Set<Promise<void>>();
  for (let i = 0; i < count; i++) {
    await new Promise((r) => setImmediate(r));
    if (signal?.aborted) return null;
    const c = canvas.createCanvas(o.width, o.height);
    const g = c.getContext('2d');
    drawDuelFrame(g, o, i / DUEL_FPS);
    const job: Promise<void> = c.encode('jpeg', quality).then((buf) => {
      out[i] = buf;
      pending.delete(job);
    });
    pending.add(job);
    if (pending.size >= IN_FLIGHT) await Promise.race(pending);
  }
  await Promise.all(pending);
  const decoded = new Map<number, Image>();
  const loading = new Set<number>();
  const want = (j: number) => {
    if (j >= count || decoded.has(j) || loading.has(j)) return;
    loading.add(j);
    canvas.loadImage(out[j]!).then(
      (img) => decoded.set(j, img),
      () => undefined,
    ).finally(() => loading.delete(j));
  };
  for (let j = 0; j < AHEAD; j++) if (j < count) decoded.set(j, await canvas.loadImage(out[j]!));
  let last: Image | null = null;
  return {
    frames: count,
    draw: (g, i) => {
      for (let j = i + 1; j <= i + AHEAD; j++) want(j);
      for (const k of decoded.keys()) if (k < i) decoded.delete(k);
      // A frame still decoding repeats the previous one instead of flashing black.
      const img = decoded.get(i) ?? last;
      if (img) g.drawImage(img, 0, 0, o.width, o.height);
      last = img;
    },
  };
}

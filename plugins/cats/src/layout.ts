/**
 * Cast of the cat-mode scene: which cat does what, at what depth
 * and in which spot on the floor. Pure function with no drawing: everything that decides the
 * meaning of the scene lives here and is tested in `layout.test.ts`.
 *
 * The underlying rule is the same as the board's: **whatever calls for you goes
 * in front**. Depth replaces the visual weight of the tiles.
 *
 *   `permiso`   → foreground, with a sign (the one that has waited longest, in front)
 *   `bufido`    → two sessions stepping on one file: almost foreground
 *   `espera`    → close, sitting and looking at you; the longer it waits, the closer it gets
 *   `listo`     → mid-distance, asleep in its box; as time passes, further back
 *   `activa`    → in the back, facing away at the laptop; the longer it has been, the further back
 *   `inactiva`  → the first sleeps on the windowsill; the rest, at the very back
 *
 * Coordinates in design units: 462 tall, with the width following from the
 * panel's proportions. Whoever paints scales to the real size.
 */
import { basename } from 'node:path';
import { claims } from '@loksly/agent-sessions';
import type { SessionView, SessionState } from './types.ts';
import type { Words } from './words.ts';
import { COAT_NAMES, EXTENT, HEIGHT, coatFor } from './cat.ts';

/** What the layout needs from the widget options (the old global config). */
export interface LayoutConfig {
  /** An `active` session silent for half of this looks dead (Schrödinger's box). */
  zombieMs: number;
  /** Side of the strip kept free of cats, if any (see `columnSide`). */
  side: ColumnSide | 'alternar';
  swapSidesMs: number;
}

export const DESIGN_H = 462;
export const HORIZON = 272;
const FLOOR_FRONT = 452;
const FLOOR_BACK = HORIZON + 8;
/** Reserved column: usage card on top, CPU tower below. */
export const RIGHT_ZONE = 370;
/**
 * The column when there is an hours section: wide enough to read its five
 * figures and a short name in 52 px type. It stays wide the whole time,
 * even when it shows usage, so the cats do not come and go.
 */
export const WIDE_ZONE = 690;

/**
 * Side of the column. It switches from one side to the other every `swapMs`, so
 * the cards, which are the stillest thing in the scene, do not get burned
 * into the panel. It is derived from the time and not from state, so the daemon,
 * the previews and the tests always see the same thing for the same instant. With a
 * fixed side, or with `swapMs` at 0 (on the right), it does not move.
 */
export type ColumnSide = 'derecha' | 'izquierda';
export function columnSide(now: number, setting: { side: ColumnSide | 'alternar'; swapSidesMs: number }): ColumnSide {
  if (setting.side !== 'alternar') return setting.side;
  if (!(setting.swapSidesMs > 0)) return 'derecha';
  return Math.floor(now / setting.swapSidesMs) % 2 === 0 ? 'derecha' : 'izquierda';
}

/**
 * What the column leaves free, edge to edge and without margins: `x` is where
 * the column starts, and `lo`–`hi` is the stretch of floor for the cats.
 */
export function columnZone(designW: number, side: ColumnSide, colW = RIGHT_ZONE): { side: ColumnSide; w: number; x: number; lo: number; hi: number } {
  return side === 'derecha'
    ? { side, w: colW, x: designW - colW, lo: 0, hi: designW - colW }
    : { side, w: colW, x: MARGIN, lo: colW, hi: designW };
}
export const MARGIN = 14;
const GAP = 14;
const OVERFLOW_W = 110;

export const scaleAt = (z: number) => 1 - z * 0.72;
export const floorAt = (z: number) => FLOOR_FRONT - z * (FLOOR_FRONT - FLOOR_BACK);

export type Pose = 'cartel' | 'sentado' | 'portatil' | 'dormido' | 'caja' | 'schrodinger' | 'corazon' | 'amasa' | 'bufido';

export interface Actor {
  pose: Pose;
  /** One session, or two in the pairs (in the kneading ones: [works, kneads]). */
  records: SessionView[];
  /** Coat of each session, in the same order. */
  coats: string[];
  z: number;
  scale: number;
  /** Cat origin (center, on the floor), in design units. */
  x: number;
  floorY: number;
  /** State that gives the plate its color. */
  tone: SessionState | 'zombi';
  /** File in dispute, only in `bufido`. */
  file?: string;
  /** Sleeps on the window sill, off the floor. */
  sill?: boolean;
}

export interface SceneLayout {
  actors: Actor[];
  /** What does not fit; summarized in a "+N" plate. */
  overflow: SessionView[];
  /** Meetings are not cats: they go to the card on the right. */
  meetings: SessionView[];
  /** Stretch of floor that was distributed. */
  floor: { left: number; right: number };
  /** Where the column of cards goes and what it leaves free (see `columnZone`). */
  zone: { side: ColumnSide; w: number; x: number; lo: number; hi: number };
  /** Real sessions (without meetings) and how many call for you. */
  total: number;
  waiting: number;
}

/** How much each pose matters when not everything fits: dropped from the bottom up. */
const RANK: Record<Pose, number> = {
  cartel: 100, bufido: 90, sentado: 80, amasa: 70, caja: 60, corazon: 40, portatil: 30, schrodinger: 20, dormido: 10,
};

/**
 * Places to sleep off the floor: the windowsill and, if something blocks it, the top
 * of the shelf. Shared with the room drawing.
 */
export const SILL = { x: 710, y: 226, scale: 0.38 };
export const SHELF_TOP = { x: 185, y: 40, scale: 0.3 };

/** Have both sessions touched a file that is still uncommitted? Returns which one. */
export function sharedDirtyFile(a: SessionView, b: SessionView): string | undefined {
  if (!a.files?.length || !b.files?.length) return undefined;
  const dirty = [...(a.dirtyFiles ?? []), ...(b.dirtyFiles ?? [])];
  if (!dirty.length) return undefined;
  const mine = new Set(a.files);
  for (const f of b.files) {
    if (!mine.has(f)) continue;
    // `git status` gives paths relative to the repo root and the hook stores them
    // absolute: it is enough for one to end with the other.
    if (dirty.some((d) => f === d || f.endsWith(`/${d}`))) return f;
  }
  return undefined;
}

const since = (r: SessionView, now: number) => Math.max(0, now - r.since);
const ramp01 = (ms: number, span: number) => Math.max(0, Math.min(1, ms / span));
const MIN = 60_000;

/** An active session that has been quiet for a while: is it still alive? */
function looksDead(r: SessionView, now: number, cfg: LayoutConfig): boolean {
  return r.state === 'active' && now - r.updated > cfg.zombieMs / 2;
}

function soloPose(r: SessionView, now: number, cfg: LayoutConfig): Pose {
  switch (r.state) {
    case 'permission': return 'cartel';
    case 'waiting': return 'sentado';
    case 'ready': return 'caja';
    case 'idle': return 'dormido';
    default: return looksDead(r, now, cfg) ? 'schrodinger' : 'portatil';
  }
}

function depth(pose: Pose, lead: SessionView, now: number): number {
  const t = since(lead, now);
  switch (pose) {
    case 'cartel': return 0;
    case 'bufido': return 0.2;
    case 'sentado': return 0.32 - ramp01(t, 15 * MIN) * 0.1;
    case 'amasa': return 0.46;
    case 'caja': return 0.45 + ramp01(t, 20 * MIN) * 0.12;
    case 'schrodinger': return 0.62;
    case 'portatil': return 0.7 + ramp01(t, 10 * MIN) * 0.2;
    case 'corazon': return 0.6 + ramp01(t, 10 * MIN) * 0.15;
    case 'dormido': return 0.95;
  }
}

/**
 * Depth advances in steps, not continuously. Each step is a
 * different cat size and therefore a cat that has to be painted in full
 * (fur included); if z changed every millisecond, every hook event would
 * repaint all the cats that are approaching or moving away. With steps of
 * 0.05 the motion can still be read and the cache hits.
 */
export const Z_STEP = 0.05;
const snap = (z: number) => Math.round(z / Z_STEP) * Z_STEP;

function makeActor(pose: Pose, records: SessionView[], now: number, tone: Actor['tone'], file?: string): Actor {
  const lead = records[0]!;
  const z = snap(depth(pose, lead, now));
  const coats = records.map((r) => coatFor(r.session_id));
  // A pair with the same coat reads as one repeated cat: the second changes.
  if (coats.length === 2 && coats[0] === coats[1]) coats[1] = COAT_NAMES[(COAT_NAMES.indexOf(coats[1]!) + 1) % COAT_NAMES.length]!;
  return { pose, records, coats, z, scale: scaleAt(z), x: 0, floorY: floorAt(z), tone, file };
}

const width = (a: Actor) => (EXTENT[a.pose]![1] - EXTENT[a.pose]![0]) * a.scale;

/** Most urgent first; on a tie, the one that has been in that state longest. */
function byUrgency(a: Actor, b: Actor): number {
  return RANK[b.pose] - RANK[a.pose] || a.records[0]!.since - b.records[0]!.since;
}

/**
 * `designW` is the visible width of the floor, in design units, starting at
 * `x0` (a narrow tile shows a crop of a wider room, see `roomView` in
 * scene.ts).
 */
export function layoutScene(sessions: SessionView[], now: number, cfg: LayoutConfig, designW: number, colW = RIGHT_ZONE, x0 = 0): SceneLayout {
  const meetings = sessions.filter((r) => r.startsAt !== undefined);
  const real = sessions.filter((r) => r.startsAt === undefined);
  const actors: Actor[] = [];
  const used = new Set<string>();

  // Pairs: sessions in the same repo (or, outside git, in the same `cwd`).
  // Never by project name: two different repos can have the same name.
  const groups = new Map<string, SessionView[]>();
  for (const r of real) {
    const where = r.repo ?? r.cwd;
    if (!where || r.state === 'permission') continue; // urgent ones go alone, in front
    groups.set(where, [...(groups.get(where) ?? []), r]);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const free = () => group.filter((r) => !used.has(r.session_id));
    // 1. They step on each other: they touched the same file and it is still uncommitted.
    outer: for (const a of free()) {
      for (const b of free()) {
        if (a === b) continue;
        const f = sharedDirtyFile(a, b);
        if (f) {
          actors.push(makeActor('bufido', [a, b], now, 'permission', f));
          used.add(a.session_id);
          used.add(b.session_id);
          break outer;
        }
      }
    }
    // 2. One waits for the other: the one waiting kneads the one working.
    const worker = free().find((r) => r.state === 'active' && !looksDead(r, now, cfg));
    const idle = free().find((r) => r.state === 'waiting' || r.state === 'ready');
    if (worker && idle) {
      actors.push(makeActor('amasa', [worker, idle], now, idle.state));
      used.add(worker.session_id);
      used.add(idle.session_id);
    }
    // 3. They collaborate: two working on the same thing.
    const busy = free().filter((r) => r.state === 'active' && !looksDead(r, now, cfg));
    if (busy.length >= 2) {
      actors.push(makeActor('corazon', [busy[0]!, busy[1]!], now, 'active'));
      used.add(busy[0]!.session_id);
      used.add(busy[1]!.session_id);
    }
  }

  // The rest, each on its own.
  let sillTaken = false;
  for (const r of real) {
    if (used.has(r.session_id)) continue;
    const pose = soloPose(r, now, cfg);
    const a = makeActor(pose, [r], now, pose === 'schrodinger' ? 'zombi' : r.state);
    if (pose === 'dormido' && !sillTaken) {
      sillTaken = true;
      Object.assign(a, { sill: true, x: SILL.x, floorY: SILL.y, scale: SILL.scale, z: 1 });
    }
    actors.push(a);
  }

  // Several signs: the one that has waited longest, at the very front.
  actors
    .filter((a) => a.pose === 'cartel')
    .sort((a, b) => a.records[0]!.since - b.records[0]!.since)
    .forEach((a, i) => {
      a.z = snap(Math.min(0.5, i * 0.15));
      a.scale = scaleAt(a.z);
      a.floorY = floorAt(a.z);
    });

  // Floor distribution: from front (left) to back (right), without overlaps.
  const z0 = columnZone(designW, columnSide(now, cfg), colW);
  const zone = { ...z0, x: z0.x + x0, lo: z0.lo + x0, hi: z0.hi + x0 };
  const left = zone.lo + MARGIN;
  const right = zone.hi - MARGIN;
  const floor = actors.filter((a) => !a.sill).sort(byUrgency);
  const overflow: SessionView[] = [];
  const fits = (list: Actor[], reserve: number) =>
    list.reduce((s, a) => s + width(a), 0) + GAP * Math.max(0, list.length - 1) <= right - left - reserve;
  while (floor.length > 1 && !fits(floor, overflow.length ? OVERFLOW_W : 0)) {
    overflow.push(...floor.pop()!.records);
  }
  if (floor.length === 1 && !fits(floor, 0)) {
    // A single pose wider than the floor (tiny panel): it shrinks.
    const a = floor[0]!;
    a.scale *= (right - left) / width(a);
  }
  floor.sort((a, b) => a.z - b.z || byUrgency(a, b));
  const total = floor.reduce((s, a) => s + width(a), 0);
  const room = right - left - (overflow.length ? OVERFLOW_W : 0);
  const gap = floor.length > 1 ? Math.min(90, Math.max(GAP, (room - total) / (floor.length - 1))) : 0;
  const span = total + gap * Math.max(0, floor.length - 1);
  let cursor = left + Math.max(0, (room - span) / 2);
  for (const a of floor) {
    a.x = cursor - EXTENT[a.pose]![0] * a.scale;
    cursor += width(a) + gap;
  }

  // The sleeper up top moves to another spot if a floor cat blocks it.
  const covers = (a: Actor, spot: { x: number; y: number }) => {
    const [L, R] = EXTENT[a.pose]!;
    return a.x + L * a.scale < spot.x + 70 && a.x + R * a.scale > spot.x - 70 && a.floorY - HEIGHT[a.pose]! * a.scale < spot.y;
  };
  // With the column on the left, the shelf up top ends up under the card: it stays on the window.
  for (const a of actors.filter((x) => x.sill)) {
    if (zone.side === 'izquierda' && colW > 0) continue;
    // Nor when the shelf is out of the visible crop.
    if (SHELF_TOP.x - 80 < zone.lo) continue;
    if (!floor.some((f) => covers(f, SILL)) || floor.some((f) => covers(f, SHELF_TOP))) continue;
    Object.assign(a, { x: SHELF_TOP.x, floorY: SHELF_TOP.y, scale: SHELF_TOP.scale });
  }

  const placed = [...floor, ...actors.filter((a) => a.sill)];
  const shown = new Set(placed.flatMap((a) => a.records.map((r) => r.session_id)));
  return {
    // Back to front: that is how they are painted, and the near ones cover the far ones.
    actors: placed.sort((a, b) => b.z - a.z),
    overflow: real.filter((r) => !shown.has(r.session_id)),
    meetings,
    floor: { left, right },
    zone,
    total: real.length,
    waiting: real.filter(claims).length,
  };
}

/** Text of each cat's floor plate. */
export function tagText(a: Actor, now: number, words: Words): { name: string; time: string } {
  const lead = a.records[0]!;
  const elapsed = words.elapsed;
  switch (a.pose) {
    case 'bufido':
      return { name: `⚠ ${basename(a.file ?? '')}`, time: `${lead.project} · ${words.uncommitted}` };
    case 'corazon':
    case 'amasa':
      if (a.pose === 'amasa') {
        const idle = a.records[1]!;
        return { name: `${lead.project} ×2`, time: `${idle.state === 'ready' ? words.ready : words.waiting} ${elapsed(now - idle.since)}` };
      }
      return { name: `${lead.project} ×2`, time: elapsed(now - lead.since) };
    case 'schrodinger':
      return { name: lead.project, time: `¿${elapsed(now - lead.updated)}?` };
    default:
      return { name: lead.project, time: elapsed(now - lead.since) };
  }
}

/** Height of the pose, to place speech bubbles above it. */
export const heightOf = (a: Actor) => HEIGHT[a.pose]! * a.scale;

// ---------- Plates ----------
/** A plate to be placed: desired center, row and natural text width. */
export interface TagBox {
  x: number;
  y: number;
  h: number;
  /** Width the full text asks for. */
  w: number;
  /** Below this it does not shrink (the text is clipped with an ellipsis). */
  minW: number;
}

const TAG_GAP = 8;

/**
 * Distributes the plates so they do not overlap. They come in priority order (the first,
 * that of the closest cat) and each stays in its place if it fits; if it collides
 * with another in its row, it moves aside toward the nearest side, and only if
 * it does not fit that way either, it narrows. This way a long plate at the back is no longer
 * cut off by being limited to the width of a small cat.
 */
export function placeTags(tags: TagBox[], left: number, right: number): { x: number; w: number }[] {
  const placed: { x0: number; x1: number; y0: number; y1: number }[] = [];
  const hits = (x0: number, x1: number, y0: number, y1: number) =>
    placed.filter((p) => x0 < p.x1 + TAG_GAP && x1 > p.x0 - TAG_GAP && y0 < p.y1 && y1 > p.y0);
  return tags.map((t) => {
    const y0 = t.y, y1 = t.y + t.h;
    for (let w = Math.min(t.w, right - left); ; w = Math.max(t.minW, w * 0.85)) {
      const within = (x: number) => Math.min(right - w / 2, Math.max(left + w / 2, x));
      // Candidates: where it wanted to be and just to each side of what is in the way.
      const cands = [within(t.x)];
      for (const p of hits(within(t.x) - w / 2, within(t.x) + w / 2, y0, y1)) {
        cands.push(within(p.x1 + TAG_GAP + w / 2), within(p.x0 - TAG_GAP - w / 2));
      }
      const free = cands
        .filter((x) => hits(x - w / 2, x + w / 2, y0, y1).length === 0)
        .sort((a, b) => Math.abs(a - t.x) - Math.abs(b - t.x));
      if (free.length || w <= t.minW) {
        const x = free[0] ?? within(t.x);
        placed.push({ x0: x - w / 2, x1: x + w / 2, y0, y1 });
        return { x, w };
      }
    }
  });
}

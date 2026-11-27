/**
 * Which widget a tile shows now. Pure, shared by the panel and the editor.
 *
 * A tile holds a *stack* of one or more widgets. Visible ones take turns
 * every `rotateMs` against the wall clock (so two panels with the same
 * rotation change together, and a restart doesn't reset the turn). An
 * urgent widget skips the queue and keeps the tile while it lasts.
 *
 * A visible widget that has nothing to show (`live: false`: empty, no data
 * yet, its source failing) passes its turn to the others; if none of them
 * has anything either, the first visible one is shown, so the tile is never
 * blank because of it (see `compositor.ts`, `tileState`).
 */

export interface StackEntry {
  id: string;
  /** Takes part in the rotation at all (`visible`, and not hidden because it's empty and the user said so). */
  visible: boolean;
  urgent: boolean;
  /** Has something to show. Missing: true. */
  live?: boolean;
}

/**
 * What a tile showed last, kept between frames by the panel (`TurnMemos`) so
 * that a stack whose members come and go doesn't flicker: see `pickTurn`.
 */
export interface TurnMemo {
  id: string;
  /** Since when it has been shown. */
  since: number;
  /** The wall-clock turn (`floor(now / rotateMs)`) it was picked or kept in. */
  turn: number;
  /** It had the tile because it was urgent. */
  urgent?: boolean;
  /** It was shown from the tile's first frame because none had anything yet (still loading): it gives way at once. */
  boot?: boolean;
}

/** The panel's `TurnMemo`s, by tile id. */
export type TurnMemos = Map<string, TurnMemo>;

/** The widgets in the rotation: those with something to show, else only the first visible one. */
function poolOf(entries: readonly StackEntry[]): { visible: StackEntry[]; live: StackEntry[]; pool: StackEntry[] } {
  const visible = entries.filter((e) => e.visible);
  const live = visible.filter((e) => e.live !== false);
  return { visible, live, pool: live.length ? live : visible.slice(0, 1) };
}

/** The first of `list` after `id` in stack order, going round. */
function nextAfter(entries: readonly StackEntry[], list: readonly StackEntry[], id: string): StackEntry {
  const at = entries.findIndex((e) => e.id === id);
  return list.find((e) => entries.indexOf(e) > at) ?? list[0]!;
}

/** What the tile shows with no memory of the last frame: the wall clock's turn among the pool. */
function stateless(pool: readonly StackEntry[], now: number, rotateMs: number): StackEntry {
  if (pool.length === 1 || rotateMs <= 0) return pool[0]!;
  return pool[Math.floor(now / Math.max(1000, rotateMs)) % pool.length]!;
}

export function pickInStack(entries: readonly StackEntry[], now: number, rotateMs: number): string | null {
  return pickTurn(entries, now, rotateMs).id;
}

/**
 * Which widget a tile shows now, given what it showed last (`prev`), and
 * what to remember for the next frame. Without `prev` (the first frame, the
 * editor) it is the wall clock's turn, as `pickInStack`.
 *
 * With it, so nothing flickers when widgets become empty or come back:
 * - Turns still end on the wall clock's beat (every `rotateMs`); at the end
 *   of one the next widget with something to show after the current one
 *   comes, in stack order (after a long gap, the wall clock's own turn).
 * - A widget that loses what it had to show mid-turn (or the first one,
 *   shown while none had anything) gives the tile up as soon as another has
 *   something, but not before it has been on for half a turn.
 * - Whatever comes keeps the tile at least half a turn too: one that came
 *   late in a turn stays for the next one as well.
 * - A widget that comes back mid-turn waits for the next turn.
 * - An urgent one takes the tile at once, and gives it back at once.
 *
 * `wakeAt`: when the pick may change by itself (to schedule a repaint).
 */
export function pickTurn(entries: readonly StackEntry[], now: number, rotateMs: number, prev?: TurnMemo): { id: string | null; memo: TurnMemo | null; wakeAt: number } {
  const p = Math.max(1000, rotateMs);
  const turn = Math.floor(now / p);
  const { visible, live, pool } = poolOf(entries);
  const beat = visible.length > 1 && rotateMs > 0 ? nextTurnAt(now, rotateMs) : Infinity;
  const keep = (e: StackEntry, extra: Partial<TurnMemo> = {}) => ({ id: e.id, since: prev?.id === e.id ? prev.since : now, turn, ...extra });
  const urgent = entries.find((e) => e.visible && e.urgent);
  if (urgent) return { id: urgent.id, memo: keep(urgent, { urgent: true }), wakeAt: beat };
  if (!pool.length) return { id: null, memo: null, wakeAt: beat };
  const cur = prev && visible.find((e) => e.id === prev.id);
  if (!prev || !cur || prev.urgent || rotateMs <= 0) {
    // No memory, or what it showed is no longer there (or no longer urgent): the wall clock's turn.
    const e = stateless(pool, now, rotateMs);
    return { id: e.id, memo: { ...keep(e), ...(!prev && !live.length ? { boot: true } : {}) }, wakeAt: beat };
  }
  if (prev.boot && live.length) {
    // The first run: the first widget's "loading" gives way to whichever has something as soon as it does.
    const e = stateless(live, now, rotateMs);
    return { id: e.id, memo: keep(e), wakeAt: beat };
  }
  const hold = p / 2;
  const held = now - prev.since;
  if (held < hold) {
    // Too soon to change: it keeps the tile, through this turn if one began.
    const memo = { ...prev, turn };
    const leaving = !live.includes(cur) && live.length > 0;
    return { id: cur.id, memo, wakeAt: Math.min(beat, leaving ? prev.since + hold : Infinity) };
  }
  if (turn !== prev.turn) {
    const e = turn - prev.turn > 1 ? stateless(pool, now, rotateMs) : pool.includes(cur) && pool.length === 1 ? cur : nextAfter(entries, pool, cur.id);
    return { id: e.id, memo: keep(e), wakeAt: beat };
  }
  if (!live.includes(cur) && live.length) {
    const e = nextAfter(entries, live, cur.id);
    return { id: e.id, memo: keep(e), wakeAt: beat };
  }
  return { id: cur.id, memo: prev, wakeAt: beat };
}

/** When the stack will change by itself next (for scheduling the next repaint). */
export function nextTurnAt(now: number, rotateMs: number): number {
  const p = Math.max(1000, rotateMs);
  return (Math.floor(now / p) + 1) * p;
}

/**
 * Which page of a screen is on: a pinned one, or the enabled pages taking
 * turns, each for its own `durationMs`, against the wall clock.
 */
export function pickPage<P extends { id: string; durationMs?: number; enabled?: boolean }>(pages: readonly P[], now: number, pinned?: string | null): P | null {
  const on = pages.filter((p) => p.enabled !== false);
  if (!on.length) return null;
  if (pinned) {
    const p = on.find((x) => x.id === pinned);
    if (p) return p;
  }
  if (on.length === 1) return on[0]!;
  const lens = on.map((p) => Math.max(10_000, p.durationMs ?? 10 * 60_000));
  const cycle = lens.reduce((a, b) => a + b, 0);
  let t = now % cycle;
  for (let i = 0; i < on.length; i++) {
    if (t < lens[i]!) return on[i]!;
    t -= lens[i]!;
  }
  return on[0]!;
}

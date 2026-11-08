/**
 * Which widget a tile shows now. Pure, shared by the panel and the editor.
 *
 * A tile holds a *stack* of one or more widgets. Visible ones take turns
 * every `rotateMs` against the wall clock (so two panels with the same
 * rotation change together, and a restart doesn't reset the turn). An
 * urgent widget skips the queue and keeps the tile while it lasts.
 */

export interface StackEntry {
  id: string;
  visible: boolean;
  urgent: boolean;
}

export function pickInStack(entries: readonly StackEntry[], now: number, rotateMs: number): string | null {
  const urgent = entries.find((e) => e.visible && e.urgent);
  if (urgent) return urgent.id;
  const shown = entries.filter((e) => e.visible);
  if (!shown.length) return null;
  if (shown.length === 1 || rotateMs <= 0) return shown[0]!.id;
  const turn = Math.floor(now / Math.max(1000, rotateMs));
  return shown[turn % shown.length]!.id;
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

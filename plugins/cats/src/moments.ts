/**
 * Moments of the calendar and the clock that dress the cats up, and the
 * thresholds the resting scene uses. From aimonitor's `anim.ts`, without the
 * gestures.
 */

/** No commits on its branch for this long: the branch is abandoned (cobwebs). */
export const ABANDONED_MS = 30 * 24 * 60 * 60_000;

/** From 00:00 to 06:00: if someone is still working, the cat's pupils go wide. */
export function nightOwl(now: number): boolean {
  return new Date(now).getHours() < 6;
}

/** Halloween (31 October) or Tuesday the 13th: ghosts and horns. */
export function spookyDay(now: number): boolean {
  const d = new Date(now);
  return (d.getMonth() === 9 && d.getDate() === 31) || (d.getDay() === 2 && d.getDate() === 13);
}

/** Friday from 16:00: party hats. */
export function partyTime(now: number): boolean {
  const d = new Date(now);
  return d.getDay() === 5 && d.getHours() >= 16;
}

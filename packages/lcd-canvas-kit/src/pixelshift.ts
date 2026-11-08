/**
 * Pixel shift against image retention: moves the whole layout by a pixel or
 * two, on a slow cycle, so that nothing sits on exactly the same pixels for
 * hours. Invisible from a metre away.
 */

export interface PixelShift {
  enabled: boolean;
  /** Largest offset, in px. */
  amplitude: number;
  /** How long each step of the cycle lasts, in ms. */
  periodMs: number;
}

export interface Shift {
  x: number;
  y: number;
}

/** A slow cycle of positions, so that a pixel that is off is never off for good. */
const CYCLE = [
  [0, 0],
  [1, 0],
  [1, 0.5],
  [1, 1],
  [0.5, 1],
  [0, 1],
] as const;

/** The offset to apply at `now`. */
export function pixelShift(now: number, o: PixelShift): Shift {
  if (!o.enabled) return { x: 0, y: 0 };
  const step = CYCLE[Math.floor(now / o.periodMs) % CYCLE.length]!;
  return { x: Math.round(step[0] * o.amplitude), y: Math.round(step[1] * o.amplitude) };
}

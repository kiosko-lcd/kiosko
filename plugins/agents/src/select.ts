/**
 * Which sessions get a tile, how wide, and with which visual weight. Pure, so
 * it is tested without drawing anything.
 */
import { claims, order } from '@loksly/agent-sessions';
import type { SessionView, Weight } from './types.ts';

export interface Tile {
  record: SessionView;
  weight: Weight;
}

/**
 * Hands out the three visual weights. The rule the whole design rests on:
 * **at most one solid tile**, the most urgent of those claiming you. If
 * several lit up at once, none would win.
 */
export function assignWeights(ordered: SessionView[]): Tile[] {
  // A claiming meeting takes the solid weight ahead of any console: the
  // permission prompt waits for you, the meeting doesn't. One that only
  // informs (quiet, still far) steals nothing.
  const claiming = ordered.filter(claims);
  const winner = claiming.find((r) => r.startsAt !== undefined) ?? claiming[0];
  return ordered.map((record) => {
    if (!claims(record)) return { record, weight: 'quiet' as Weight };
    return { record, weight: record === winner ? ('solid' as Weight) : ('marked' as Weight) };
  });
}

export interface PlanOptions {
  /** Narrowest tile; below it, sessions go to the overflow column. */
  min: number;
  /** Widest tile: a single session doesn't stretch across the panel. `Infinity` to fill. */
  max: number;
  gap: number;
  /** Width of the overflow summary column, when needed. */
  summaryWidth: number;
}

export interface Plan {
  tiles: Tile[];
  /** Sessions that don't fit and are summarised in the last column. */
  overflow: SessionView[];
  tileWidth: number;
  summaryWidth: number;
}

/**
 * How many tiles fit in `available` px within the min/max widths, and what
 * is left for the overflow column. One tile is always shown, even narrower
 * than `min`: the most urgent session must be visible.
 */
export function plan(records: SessionView[], available: number, o: PlanOptions): Plan {
  const { min, max, gap, summaryWidth } = o;
  const all = assignWeights(order(records));
  const fits = (n: number, reserve: number) => (available - reserve - (n - 1) * gap) / n >= min;

  let visible = all.length;
  let reserve = 0;
  while (visible > 1 && !fits(visible, reserve)) {
    visible--;
    reserve = summaryWidth + gap; // as soon as one is left out, it must be summarised
  }
  if (visible < all.length && reserve === 0) reserve = summaryWidth + gap;

  // With overflow there is no room to spare, so the width cap doesn't apply:
  // capped tiles would leave a dead gap next to the summary column.
  const cap = visible < all.length ? Infinity : max;
  const tileWidth = Math.max(0, Math.min(cap, Math.floor((available - reserve - (visible - 1) * gap) / Math.max(1, visible))));
  return {
    tiles: all.slice(0, visible),
    overflow: all.slice(visible).map((t) => t.record),
    tileWidth,
    summaryWidth: visible < all.length ? summaryWidth : 0,
  };
}

/** Width the plan takes, tiles plus overflow column. */
export function usedWidth(p: Plan, gap: number): number {
  const tiles = p.tiles.length * p.tileWidth + Math.max(0, p.tiles.length - 1) * gap;
  return tiles + (p.summaryWidth ? (p.tiles.length ? gap : 0) + p.summaryWidth : 0);
}

/**
 * Width left over to the right of the tiles. With overflow the summary takes
 * it, so both can never be drawn on top of each other.
 */
export function spareWidth(p: Plan, available: number, gap: number): number {
  const used = p.tiles.length * p.tileWidth + Math.max(0, p.tiles.length - 1) * gap;
  return available - used - (p.summaryWidth ? p.summaryWidth + gap : 0);
}

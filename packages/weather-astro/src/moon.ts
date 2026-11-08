/**
 * Moon phase, computed locally.
 *
 * Deterministic arithmetic: elapsed time since a known new moon, modulo the
 * mean synodic month. It ignores orbital perturbations, so it can be a few
 * hours off real ephemerides; plenty for "waning quarter, full in eleven days".
 * Checked against Open-Meteo on 2026-09-04: 0.751 here, 0.753 there.
 */

/** Mean synodic month: new moon to new moon, in days. */
export const SYNODIC = 29.530588853;

/** Reference new moon: 2000-01-06 18:14 UTC, the usual epoch for this calculation. */
const REFERENCE_NEW_MOON = Date.UTC(2000, 0, 6, 18, 14, 0);

/** The eight usual phase names, in order from new moon. */
export const PHASE_NAMES = [
  'new',
  'waxing-crescent',
  'first-quarter',
  'waxing-gibbous',
  'full',
  'waning-gibbous',
  'last-quarter',
  'waning-crescent',
] as const;
export type PhaseName = (typeof PHASE_NAMES)[number];

export interface Moon {
  /** 0 = new moon, 0.5 = full, almost 1 = new again. */
  phase: number;
  /** Lit fraction of the disc, 0 to 1. */
  illumination: number;
  /** Growing? Before full it waxes, after full it wanes. */
  waxing: boolean;
  /** Nearest of the eight named phases (so "full" covers the day before and after). */
  name: PhaseName;
  /** Days to the next full moon (0 if today). */
  daysToFull: number;
  /** Days to the next new moon. */
  daysToNew: number;
}

/** Days elapsed since the reference new moon. */
function daysSinceReference(at: number): number {
  return (at - REFERENCE_NEW_MOON) / 86_400_000;
}

/** The moon at an instant. */
export function moonPhase(at: number | Date = Date.now()): Moon {
  const ms = at instanceof Date ? at.getTime() : at;
  // JS's % keeps the sign, so dates before 2000 are normalised by adding a cycle.
  const phase = (((daysSinceReference(ms) % SYNODIC) + SYNODIC) % SYNODIC) / SYNODIC;

  const illumination = (1 - Math.cos(2 * Math.PI * phase)) / 2;
  const waxing = phase < 0.5;

  // Nearest eighth, wrapping round: 0.97 is "new", not "waning crescent".
  const name: PhaseName = PHASE_NAMES[Math.round(phase * 8) % 8] ?? 'new';

  const toFull = phase <= 0.5 ? 0.5 - phase : 1.5 - phase;
  const toNew = phase === 0 ? 0 : 1 - phase;

  return {
    phase,
    illumination,
    waxing,
    name,
    daysToFull: Math.round(toFull * SYNODIC),
    daysToNew: Math.round(toNew * SYNODIC),
  };
}


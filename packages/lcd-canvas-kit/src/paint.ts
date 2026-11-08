/**
 * Painting primitives: colour arithmetic, a seeded random generator, a stable
 * string hash, gradients and ellipses. Everything is deterministic: the same
 * inputs give the same drawing byte for byte, which is what makes caching
 * rendered sprites and reproducible previews possible.
 */
import type { SKRSContext2D } from '@napi-rs/canvas';

/** The 2D context type of @napi-rs/canvas. */
export type X = SKRSContext2D;
export type RGB = [number, number, number];
export const TAU = Math.PI * 2;

/** `#RRGGBB` → RGB. */
export const hex = (h: string): RGB => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as RGB;
/** Linear mix of two colours, `t` from 0 (a) to 1 (b). */
export const mix = (a: RGB, b: RGB, t: number): RGB => [0, 1, 2].map((i) => a[i]! + (b[i]! - a[i]!) * t) as RGB;
/** RGB (and alpha) → CSS `rgba(…)`. */
export const css = (c: RGB, a = 1) => `rgba(${c.map(Math.round).join(',')},${a})`;
export const clamp = (v: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
/** Smoothstep between two edges. */
export const smooth = (e0: number, e1: number, v: number) => {
  const t = clamp((v - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

/** mulberry32: small, fast and seeded. */
export function rng(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable string hash (FNV-1a), to derive colours and seeds from ids. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Starts a path with an ellipse (degenerate radii are clamped). */
export function ellipse(c: X, x: number, y: number, rx: number, ry: number, rot = 0): void {
  c.beginPath();
  c.ellipse(x, y, Math.max(0.01, rx), Math.max(0.01, ry), rot, 0, TAU);
}

/** Radial gradient from colour stops. */
export function radial(c: X, x: number, y: number, r0: number, r1: number, stops: [number, string][], fx = x, fy = y) {
  const g = c.createRadialGradient(fx, fy, r0, x, y, r1);
  for (const [o, col] of stops) g.addColorStop(o, col);
  return g;
}

/** Linear gradient from colour stops. */
export function linear(c: X, x0: number, y0: number, x1: number, y1: number, stops: [number, string][]) {
  const g = c.createLinearGradient(x0, y0, x1, y1);
  for (const [o, col] of stops) g.addColorStop(o, col);
  return g;
}

/** Cubic Bézier curve sampled as a polyline. */
export function bezierPts(p: [number, number][], steps = 40): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps, u = 1 - t;
    out.push([0, 1].map((k) => u * u * u * p[0]![k]! + 3 * u * u * t * p[1]![k]! + 3 * u * t * t * p[2]![k]! + t * t * t * p[3]![k]!) as [number, number]);
  }
  return out;
}


/**
 * Text drawing for small, high-contrast panels: tracked (letter-spaced) text,
 * small caps, truncation with an ellipsis, fitting to a width and word-wrapped
 * paragraphs with a hard line limit.
 */
import { GlobalFonts, type SKRSContext2D } from '@napi-rs/canvas';

let defaultFamily = 'sans-serif';

/** Family used when `TextOpts.family` is not given. */
export function setDefaultFamily(family: string): void {
  defaultFamily = family;
}

/**
 * Registers font files under your own family names. Register by absolute path
 * and refer to those names: fontconfig may report families as composites
 * ("DejaVu Sans,DejaVu Sans Condensed"). Returns the paths that failed.
 */
export function registerFontFiles(fonts: Record<string, string>): string[] {
  return Object.entries(fonts).filter(([family, path]) => !GlobalFonts.registerFromPath(path, family)).map(([, path]) => path);
}

export interface TextOpts {
  size: number;
  family?: string;
  color?: string;
  /** Extra spacing between characters, in px. */
  tracking?: number;
  /** Small caps: everything upper-case, with originally lower-case letters drawn smaller. */
  smallCaps?: boolean;
  align?: 'left' | 'right' | 'center';
  /** Height of the small caps relative to a capital letter. */
  capRatio?: number;
}

interface Glyph {
  ch: string;
  size: number;
  width: number;
}

function glyphs(ctx: SKRSContext2D, text: string, o: TextOpts): Glyph[] {
  const family = o.family ?? defaultFamily;
  const small = o.smallCaps === true;
  const capSize = o.size * (o.capRatio ?? 0.76);
  const out: Glyph[] = [];
  for (const ch of text) {
    // In small caps, a lower-case letter is drawn upper-case at a smaller size.
    const isLower = small && ch !== ch.toUpperCase() && ch === ch.toLowerCase();
    const size = isLower ? capSize : o.size;
    const draw = small ? ch.toUpperCase() : ch;
    ctx.font = `${size}px "${family}"`;
    out.push({ ch: draw, size, width: ctx.measureText(draw).width });
  }
  return out;
}

function advance(gs: Glyph[], tracking: number): number {
  if (!gs.length) return 0;
  // Tracking goes between characters, not after the last one.
  return gs.reduce((a, g) => a + g.width, 0) + tracking * (gs.length - 1);
}

/** Width the text would take with this tracking, without drawing it. */
export function measureTracked(ctx: SKRSContext2D, text: string, o: TextOpts): number {
  return advance(glyphs(ctx, text, o), o.tracking ?? 0);
}

/**
 * Draws character by character to apply tracking and small caps, which the
 * canvas API does not offer. `y` is the baseline. Returns the width.
 */
export function drawTracked(ctx: SKRSContext2D, text: string, x: number, y: number, o: TextOpts): number {
  const family = o.family ?? defaultFamily;
  const tracking = o.tracking ?? 0;
  const gs = glyphs(ctx, text, o);
  const total = advance(gs, tracking);
  let cursor = o.align === 'right' ? x - total : o.align === 'center' ? x - total / 2 : x;
  if (o.color) ctx.fillStyle = o.color;
  ctx.textBaseline = 'alphabetic';
  for (const g of gs) {
    ctx.font = `${g.size}px "${family}"`;
    ctx.fillText(g.ch, cursor, y);
    cursor += g.width + tracking;
  }
  return total;
}

/**
 * Truncates with an ellipsis until the text fits in `maxWidth`.
 *
 * The search is binary rather than character by character: measuring is
 * expensive (it walks glyph by glyph to apply tracking), so the naive loop is
 * quadratic. With 240-character details that cost hundreds of milliseconds
 * per frame.
 */
export function truncate(ctx: SKRSContext2D, text: string, maxWidth: number, o: TextOpts): string {
  if (measureTracked(ctx, text, o) <= maxWidth) return text;
  const chars = [...text];
  const candidate = (n: number) => `${chars.slice(0, n).join('').trimEnd()}…`;
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measureTracked(ctx, candidate(mid), o) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? candidate(lo) : '…';
}

/**
 * Largest size at which the whole text fits, never going below `minSize`.
 * Useful for labels that identify something (e.g. a project name): shrinking
 * them is better than cutting them.
 */
export function fitSize(ctx: SKRSContext2D, text: string, maxWidth: number, o: TextOpts, minSize: number): number {
  let size = o.size;
  while (size > minSize && measureTracked(ctx, text, { ...o, size }) > maxWidth) size -= 1;
  return size;
}

/** Draws the text truncated to the available width. */
export function drawClipped(
  ctx: SKRSContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  o: TextOpts,
): number {
  return drawTracked(ctx, truncate(ctx, text, maxWidth, o), x, y, o);
}

/**
 * Longest prefix of `text` that fits in `maxWidth`, backing off to the last
 * space so words are not split. If a single word does not fit, it cuts hard:
 * splitting a long path is better than leaving the line empty.
 *
 * The search is binary because measuring is expensive: `measureTracked` walks
 * character by character to apply tracking.
 */
function fitPrefix(ctx: SKRSContext2D, text: string, maxWidth: number, o: TextOpts): number {
  if (measureTracked(ctx, text, o) <= maxWidth) return text.length;
  let lo = 1;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measureTracked(ctx, text.slice(0, mid), o) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  const space = text.lastIndexOf(' ', lo);
  return space > 0 ? space : lo;
}

/**
 * Splits the text into at most `maxLines` lines that fit in `maxWidth`.
 * The last one is truncated with an ellipsis if text is left over, so it never
 * overflows.
 */
export function wrapLines(
  ctx: SKRSContext2D,
  text: string,
  maxWidth: number,
  maxLines: number,
  o: TextOpts,
): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean || maxLines < 1 || maxWidth <= 0) return [];

  const lines: string[] = [];
  let rest = clean;
  while (rest && lines.length < maxLines) {
    if (lines.length === maxLines - 1) {
      lines.push(truncate(ctx, rest, maxWidth, o));
      break;
    }
    const cut = fitPrefix(ctx, rest, maxWidth, o);
    lines.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  return lines;
}

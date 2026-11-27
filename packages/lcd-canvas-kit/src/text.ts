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
  // A family may now draw with another file: measure it again.
  clearTextCache();
  return Object.entries(fonts).filter(([family, path]) => !GlobalFonts.registerFromPath(path, family)).map(([, path]) => path);
}

/**
 * Widths of single characters, by font. Measuring goes character by
 * character (for tracking and small caps), and `measureText` with a font
 * set before every character made wrapping a long paragraph cost hundreds
 * of milliseconds (a news summary of 7 000 characters: 343 ms for three
 * lines). A character's width only depends on its font and size.
 */
const widths = new Map<string, Map<string, number>>();
/** Fonts kept (sizes × families); past it the cache starts again. */
const MAX_FONTS = 400;

function widthOf(ctx: SKRSContext2D, font: string, ch: string): number {
  let byChar = widths.get(font);
  if (!byChar) {
    if (widths.size >= MAX_FONTS) {
      widths.clear();
      measured = 0;
    }
    byChar = new Map();
    widths.set(font, byChar);
  }
  let w = byChar.get(ch);
  if (w === undefined) {
    if (ctx.font !== font) ctx.font = font;
    w = ctx.measureText(ch).width;
    byChar.set(ch, w);
    measured++;
  }
  return w;
}

/** Forgets the measured widths (tests, or fonts replaced under the same name). */
export function clearTextCache(): void {
  widths.clear();
  measured = 0;
}

/** Widths measured (not added) since the cache started again. */
let measured = 0;

/**
 * The widths measured so far, by font and character: to carry them to
 * another thread or to the next start (Kiosko keeps them in its RAM cache),
 * where `addTextWidths` takes them. They are only good for the same fonts.
 */
export function textWidths(): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const [font, byChar] of widths) out[font] = Object.fromEntries(byChar);
  return out;
}

/** Takes widths measured elsewhere (see `textWidths`); what is measured here already stays. Returns how many were new. */
export function addTextWidths(from: Record<string, Record<string, number>>): number {
  let added = 0;
  for (const [font, chars] of Object.entries(from)) {
    if (!chars || typeof chars !== 'object') continue;
    let byChar = widths.get(font);
    if (!byChar) {
      if (widths.size >= MAX_FONTS) break;
      byChar = new Map();
      widths.set(font, byChar);
    }
    for (const [ch, w] of Object.entries(chars)) {
      if (typeof w !== 'number' || !Number.isFinite(w) || byChar.has(ch)) continue;
      byChar.set(ch, w);
      added++;
    }
  }
  return added;
}

/** How many widths were measured here (not added) since the cache started again: what is new to keep. */
export function textWidthsMeasured(): number {
  return measured;
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

const CJK = /[\u1100-\u11ff\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/;
/** Whether the text has Chinese, Japanese or Korean in it. */
export function hasCjk(text: string): boolean {
  return CJK.test(text);
}
/** No letter-spacing in a text with CJK: it would split it into single characters. */
function trackingOf(text: string, o: TextOpts): number {
  return o.tracking && hasCjk(text) ? 0 : (o.tracking ?? 0);
}

interface Glyph {
  ch: string;
  size: number;
  width: number;
}

/**
 * The smallest Chinese, Japanese or Korean text that can be read on the
 * panel being painted, in its own pixels (0: no minimum). Kiosko sets it per
 * screen from the panel's pixel size and how far its readers sit; the kit
 * paints a CJK character asked smaller at this size instead (Latin is left
 * alone: a dense hanzi turns into a blot first).
 */
let minCjkPx = 0;
/** The smallest CJK size asked for since `takeCjkEnlarged`, in panel pixels, when it was raised. */
let enlarged = Infinity;

export function setMinCjkPx(px: number): void {
  if (px !== minCjkPx) widths.clear();
  minCjkPx = Math.max(0, px);
}

/** The smallest CJK size a widget asked for and got raised since the last call (null: none), and starts again. */
export function takeCjkEnlarged(): number | null {
  const v = enlarged;
  enlarged = Infinity;
  return Number.isFinite(v) ? Math.round(v) : null;
}

/** How much the context scales what it draws (a widget's zoom, the panel's turn). */
function scaleOf(ctx: SKRSContext2D): number {
  const t = (ctx as { getTransform?: () => { a: number; b: number } }).getTransform?.();
  return t ? Math.hypot(t.a, t.b) || 1 : 1;
}

function glyphs(ctx: SKRSContext2D, text: string, o: TextOpts): Glyph[] {
  const family = o.family ?? defaultFamily;
  // Han, kana and hangul have no capitals, and spaced out they read as separate words.
  const cjk = hasCjk(text);
  const small = o.smallCaps === true && !cjk;
  const capSize = o.size * (o.capRatio ?? 0.76);
  const out: Glyph[] = [];
  const font = `${o.size}px "${family}"`;
  const capFont = `${capSize}px "${family}"`;
  // CJK characters asked smaller than can be read on this panel are drawn at the minimum.
  let cjkSize = o.size;
  if (cjk && minCjkPx > 0) {
    const scale = scaleOf(ctx);
    if (o.size * scale < minCjkPx - 0.5) {
      cjkSize = minCjkPx / scale;
      enlarged = Math.min(enlarged, o.size * scale);
    }
  }
  const cjkFont = `${cjkSize}px "${family}"`;
  for (const ch of text) {
    if (cjkSize !== o.size && CJK.test(ch)) {
      out.push({ ch, size: cjkSize, width: widthOf(ctx, cjkFont, ch) });
      continue;
    }
    // In small caps, a lower-case letter is drawn upper-case at a smaller size.
    const isLower = small && ch !== ch.toUpperCase() && ch === ch.toLowerCase();
    const size = isLower ? capSize : o.size;
    const draw = small ? ch.toUpperCase() : ch;
    out.push({ ch: draw, size, width: widthOf(ctx, isLower ? capFont : font, draw) });
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
  return advance(glyphs(ctx, text, o), trackingOf(text, o));
}

/**
 * Draws character by character to apply tracking and small caps, which the
 * canvas API does not offer. `y` is the baseline. Returns the width.
 */
export function drawTracked(ctx: SKRSContext2D, text: string, x: number, y: number, o: TextOpts): number {
  const family = o.family ?? defaultFamily;
  const tracking = trackingOf(text, o);
  const gs = glyphs(ctx, text, o);
  const total = advance(gs, tracking);
  let cursor = o.align === 'right' ? x - total : o.align === 'center' ? x - total / 2 : x;
  if (o.color) ctx.fillStyle = o.color;
  ctx.textBaseline = 'alphabetic';
  let size = -1;
  for (const g of gs) {
    if (g.size !== size) {
      ctx.font = `${g.size}px "${family}"`;
      size = g.size;
    }
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

/** Characters a line must not start with (Chinese and Japanese line breaking, "kinsoku"). */
const NO_START = new Set([...'、。，．：；？！）」』】》〉〕｝〗〙〛’”…‥ー々ゝゞヽヾぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ,.;:?!)]}%']);
/** Characters a line must not end with. */
const NO_END = new Set([...'（「『【《〈〔｛〖〘〚‘“([{$']);
const isSpace = (c: string) => /\s/.test(c);

/**
 * Longest prefix of `text` that fits in `maxWidth`, as a string length.
 * It breaks after a space, or between two characters when either is
 * Chinese, Japanese or Korean (they have no spaces), never before a
 * closing mark (，。」) nor after an opening one (「（). In Latin text it
 * backs off to the last space however far; in text with CJK only if that
 * keeps most of the line ("AI 模型在…" doesn't leave "AI" alone). If no
 * break fits, it cuts hard: splitting a long path is better than an empty
 * line.
 *
 * The search is binary because measuring is expensive: `measureTracked` walks
 * character by character to apply tracking. It counts characters, not
 * UTF-16 units, so it never splits one.
 */
function fitPrefix(ctx: SKRSContext2D, text: string, maxWidth: number, o: TextOpts): number {
  if (measureTracked(ctx, text, o) <= maxWidth) return text.length;
  const chars = [...text];
  let lo = 1;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measureTracked(ctx, chars.slice(0, mid).join(''), o) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  const cjk = hasCjk(text);
  const fits = (i: number) => !NO_START.has(chars[i]!) && !NO_END.has(chars[i - 1]!);
  let cut = 0;
  for (let i = lo; i >= 1; i--) {
    const before = chars[i - 1]!;
    const after = chars[i]!;
    if ((isSpace(before) || isSpace(after) || CJK.test(before) || CJK.test(after)) && fits(i)) {
      cut = i;
      break;
    }
  }
  if (!cut || (cjk && cut < lo * 0.6)) {
    // Hard cut, still not starting the next line with a closing mark.
    cut = lo;
    while (cut > 1 && !fits(cut)) cut--;
  }
  return chars.slice(0, cut).join('').length;
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

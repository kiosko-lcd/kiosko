/**
 * Browser stand-in for packages/core/src/fonts.ts (the demo build swaps the
 * module). Same exports; the four DejaVu files the panel draws with are
 * copied next to the demo (assets/fonts/, see demo/build.mjs) and loaded
 * as FontFaces from there. Keep the list in step with core/src/fonts.ts.
 */
import { GlobalFonts } from '@napi-rs/canvas';
import { FONT_FAMILIES, hanScript } from '@kiosko/sdk';
import { CJK_FAMILIES, FontFallback, hookFont } from '../../../core/src/font-fallback.ts';

export const FONT_FILES: [family: string, file: string][] = [
  [FONT_FAMILIES.sans, 'DejaVuSansCondensed.ttf'],
  [FONT_FAMILIES.sansBold, 'DejaVuSansCondensed-Bold.ttf'],
  [FONT_FAMILIES.mono, 'DejaVuSansMono.ttf'],
  [FONT_FAMILIES.monoBold, 'DejaVuSansMono-Bold.ttf'],
];

let done = false;

/** No font files on disk in a browser. */
export function fontFile(_family: keyof typeof FONT_FAMILIES): string | null {
  return null;
}

/** Starts loading the panel families once (the renderer awaits them before painting). */
export function registerFonts(extra: { family: string; path: string }[] = []): void {
  if (done && !extra.length) return;
  for (const [family, file] of FONT_FILES) GlobalFonts.registerFromPath(new URL(`fonts/${file}`, import.meta.url).href, family);
  for (const f of extra) GlobalFonts.registerFromPath(f.path, f.family);
  done = true;
}

const fallback = new FontFallback();
let hooked = false;

/**
 * The browser looks for a missing character in the system's fonts by
 * itself, but picks the region by the page's language: Japanese or
 * Simplified shapes for a Taiwanese reader. So, as on the panel, the
 * regional families go behind every font. All the candidates for that
 * writing: the browser skips the ones this machine lacks, and cannot be
 * asked which it has.
 */
export function setFontLocale(locale: string): void {
  if (!hooked) {
    hooked = true;
    for (const name of ['OffscreenCanvasRenderingContext2D', 'CanvasRenderingContext2D']) {
      const proto = (globalThis as unknown as Record<string, { prototype?: object } | undefined>)[name]?.prototype;
      if (proto) hookFont(proto, (f) => fallback.apply(f));
    }
  }
  fallback.setFamilies(browserFamilies(locale));
}

/**
 * Only the reader's own writing: the browser's own fallback already covers
 * the rest, and every family named costs a lookup (WebKit painted the first
 * thumbnails seconds later with all five lists).
 */
function browserFamilies(locale: string): string[] {
  const script = hanScript(locale);
  return script ? [...new Set([...CJK_FAMILIES[script]])] : [];
}

export function withFallback(font: string): string {
  return fallback.apply(font);
}

export function hasFontFamily(_family: string): boolean {
  return false;
}

export function cjkFonts(locale: string): { script: ReturnType<typeof hanScript>; families: string[]; fromUser: string[] } {
  return { script: hanScript(locale), families: browserFamilies(locale), fromUser: [] };
}

export function userFontsDir(): string {
  return '';
}

export function cjkFontHint(): string {
  return '';
}

export function cjkFontStatus(_locale: string): { ok: boolean; line: string } {
  return { ok: true, line: 'the browser picks the CJK font' };
}

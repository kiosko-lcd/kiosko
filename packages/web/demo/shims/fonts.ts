/**
 * Browser stand-in for packages/core/src/fonts.ts (the demo build swaps the
 * module). Same exports; the four DejaVu files the panel draws with are
 * copied next to the demo (assets/fonts/, see demo/build.mjs) and loaded
 * as FontFaces from there. Keep the list in step with core/src/fonts.ts.
 */
import { GlobalFonts } from '@napi-rs/canvas';
import { FONT_FAMILIES } from '@kiosko/sdk';

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

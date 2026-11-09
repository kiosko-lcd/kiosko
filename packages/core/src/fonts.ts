/**
 * The panel's fonts travel with the package (DejaVu, from `dejavu-fonts-ttf`)
 * so a frame looks the same on Linux, macOS and Windows: no dependency on
 * what the OS has installed. Users can add more families from Settings.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { GlobalFonts } from '@napi-rs/canvas';
import { FONT_FAMILIES } from '@kiosko/sdk';

const require = createRequire(import.meta.url);
let done = false;

function ttfDir(): string | null {
  try {
    return join(dirname(require.resolve('dejavu-fonts-ttf/package.json')), 'ttf');
  } catch {
    return null;
  }
}

const FILES: [family: string, file: string, systemFallback: string][] = [
  [FONT_FAMILIES.sans, 'DejaVuSansCondensed.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSansCondensed.ttf'],
  [FONT_FAMILIES.sansBold, 'DejaVuSansCondensed-Bold.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSansCondensed-Bold.ttf'],
  [FONT_FAMILIES.mono, 'DejaVuSansMono.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf'],
  [FONT_FAMILIES.monoBold, 'DejaVuSansMono-Bold.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf'],
];

/** Absolute path of a bundled TTF (for plugins that need the file, e.g. aliases). */
export function fontFile(family: keyof typeof FONT_FAMILIES): string | null {
  const entry = FILES.find(([f]) => f === FONT_FAMILIES[family]);
  if (!entry) return null;
  const dir = ttfDir();
  const p = dir ? join(dir, entry[1]) : entry[2];
  return existsSync(p) ? p : existsSync(entry[2]) ? entry[2] : null;
}

/** Registers the panel families once. Safe to call on every frame. */
export function registerFonts(extra: { family: string; path: string }[] = []): void {
  if (done && !extra.length) return;
  const dir = ttfDir();
  for (const [family, file, fallback] of FILES) {
    const p = dir && existsSync(join(dir, file)) ? join(dir, file) : fallback;
    if (existsSync(p)) GlobalFonts.registerFromPath(p, family);
  }
  for (const f of extra) if (existsSync(f.path)) GlobalFonts.registerFromPath(f.path, f.family);
  done = true;
}

/**
 * The kit's measured text widths, kept between Kiosko's threads and starts.
 *
 * A character's width is asked of the canvas the first time each font
 * (family and size) draws it, and each `measureText` costs some 47 µs: a
 * first paint of a text-heavy widget measured hundreds of characters (news
 * column, a text, vitals, "on this day", air quality: 30–100 ms, most of it
 * that). Every screen thread starts with none, and so did every start of
 * Kiosko, and every thread started again for a panel that came back.
 *
 * Kept in Kiosko's RAM cache (`paths.cache('kiosko')`), one file per set of
 * fonts: what each thread measures is merged into it now and then while it
 * keeps measuring new ones, and read when a thread first sets its fonts.
 * Only good for exactly the same fonts: the file's name is a fingerprint of
 * the families behind every font and of the fonts registered, and a few of
 * its widths are measured again before it is trusted (a font file replaced
 * under the same name): one that differs and the file is ignored.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as kit from '@loksly/lcd-canvas-kit';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';

/** New widths are merged into the file at most this often. */
export const SAVE_EVERY_MS = 20_000;
/** Widths measured again from a file before it is trusted. */
const CHECKS = 8;

let dir: string | null = null;
let file: string | null = null;
/** The families of the last `textWidthsFor`, and the dir it looked in. */
let lastFamilies: readonly string[] | null = null;
let lastKey: string | null = null;
let savedCount = 0;
let savedAt = 0;
let saving: Promise<void> | null = null;

/** Where to keep them (null: nowhere, the default: tests and tools don't write). */
export function keepTextWidths(to: string | null): void {
  dir = to;
  file = null;
  lastKey = null;
  if (lastFamilies) textWidthsFor(lastFamilies);
}

type Widths = Record<string, Record<string, number>>;

/** Same as the kit measures, with the families behind it: each entry measured again. */
function sample(w: Widths): [font: string, ch: string, width: number][] {
  const all: [string, string, number][] = [];
  for (const [font, chars] of Object.entries(w)) for (const [ch, width] of Object.entries(chars ?? {})) all.push([font, ch, width]);
  if (all.length <= CHECKS) return all;
  const step = all.length / CHECKS;
  return Array.from({ length: CHECKS }, (_, i) => all[Math.floor(i * step)]!);
}

function trusted(w: Widths): boolean {
  const g = createCanvas(1, 1).getContext('2d');
  for (const [font, ch, width] of sample(w)) {
    g.font = font;
    if (g.measureText(ch).width !== width) return false;
  }
  return true;
}

function read(path: string): Widths | null {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { widths?: Widths };
    return raw && typeof raw.widths === 'object' && raw.widths ? raw.widths : null;
  } catch {
    return null;
  }
}

/**
 * The fonts were set (see fonts.ts `setFontLocale`; the kit's widths were
 * forgotten if they changed): takes the widths kept for this set, if any.
 * `families`: those behind every font, in order.
 */
export function textWidthsFor(families: readonly string[]): void {
  lastFamilies = families;
  // Called on every frame: only the first time, and when the families change, is there work.
  const key = `${dir}\0${families.join('\0')}`;
  if (!dir || key === lastKey) return;
  lastKey = key;
  const fonts = GlobalFonts.families.map((f) => `${f.family}:${JSON.stringify(f.styles)}`).sort();
  const name = `text-widths-${createHash('sha256').update(JSON.stringify([families, fonts])).digest('hex').slice(0, 20)}.json`;
  const path = join(dir, name);
  if (path === file) return;
  file = path;
  savedAt = Date.now();
  const w = read(path);
  if (w && trusted(w)) kit.addTextWidths(w);
  // What the file had is not news: only what is measured from now on is.
  savedCount = kit.textWidthsMeasured();
}

/** Merges what was measured here into the file, when there is something new and the last time was a while ago. */
export function maybeSaveTextWidths(now = Date.now()): Promise<void> | null {
  if (!dir || !file || saving) return null;
  const count = kit.textWidthsMeasured();
  if (count <= savedCount || now - savedAt < SAVE_EVERY_MS) return null;
  const path = file;
  savedAt = now;
  savedCount = count;
  const mine = kit.textWidths();
  saving = (async () => {
    try {
      mkdirSync(dir!, { recursive: true, mode: 0o700 });
      // Another thread's, or the last start's, stay.
      let theirs: Widths = {};
      try {
        theirs = (JSON.parse(await readFile(path, 'utf8')) as { widths?: Widths }).widths ?? {};
      } catch {
        /* none yet */
      }
      for (const [font, chars] of Object.entries(mine)) theirs[font] = { ...theirs[font], ...chars };
      const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      await writeFile(tmp, JSON.stringify({ widths: theirs }), { mode: 0o600 });
      await rename(tmp, path);
    } catch {
      /* a cache: next time */
    } finally {
      saving = null;
    }
  })();
  return saving;
}

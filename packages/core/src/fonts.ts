/**
 * The panel's fonts travel with the package (DejaVu, from `dejavu-fonts-ttf`)
 * so a frame looks the same on Linux, macOS and Windows: no dependency on
 * what the OS has installed.
 *
 * DejaVu has no Chinese, Japanese or Korean characters, and the canvas
 * library does not look for a missing character in other fonts: it draws an
 * empty box. So Kiosko adds a CJK family behind every font the panel uses
 * (see `withFallback`), picked for the user's language because the same
 * character is drawn differently in Taiwan, Hong Kong, mainland China, Japan
 * and Korea. It takes the one the system has (Microsoft JhengHei/YaHei on
 * Windows, PingFang on macOS, Noto Sans CJK on Linux) or one the user drops
 * into `<home>/fonts/`.
 */
import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createCanvas, GlobalFonts, type Canvas } from '@napi-rs/canvas';
import * as kit from '@loksly/lcd-canvas-kit';
import { FONT_FAMILIES, hanScript, type HanScript } from '@kiosko/sdk';
import { FontFallback, OTHER_SCRIPTS, cjkFamiliesFor, hookFont } from './font-fallback.ts';
import { paths } from './paths.ts';

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
  if (!done) {
    const dir = ttfDir();
    for (const [family, file, fallback] of FILES) {
      const p = dir && existsSync(join(dir, file)) ? join(dir, file) : fallback;
      if (existsSync(p)) GlobalFonts.registerFromPath(p, family);
    }
    installFallbackHook();
  }
  for (const f of extra) if (existsSync(f.path)) GlobalFonts.registerFromPath(f.path, f.family);
  done = true;
}

// ---------------------------------------------------------------------------
// Chinese, Japanese and Korean (the shared part is in font-fallback.ts)

/** A character every CJK font has and DejaVu does not. */
const PROBE = '體';
const missingPixels = new Map<string, string>();
const available = new Map<string, boolean>();
let probeCanvas: Canvas | null = null;

function pixelsOf(font: string, probe = PROBE): string {
  probeCanvas ??= createCanvas(40, 40);
  const g = probeCanvas.getContext('2d');
  g.clearRect(0, 0, 40, 40);
  // Straight to the native setter: the probe must see the font alone.
  if (nativeFont?.set) nativeFont.set.call(g, font);
  else g.font = font;
  g.fillStyle = '#000';
  g.textBaseline = 'top';
  g.fillText(probe, 4, 4);
  return Buffer.from(g.getImageData(0, 0, 40, 40).data.buffer).toString('base64');
}

/**
 * Whether the system (or a registered file) has `family`. `GlobalFonts.has`
 * only knows registered fonts, so draw a character with it and compare with
 * a family that cannot exist: a missing family draws the same empty box.
 */
export function hasFontFamily(family: string, probe = PROBE): boolean {
  const key = `${family}\u0000${probe}`;
  let yes = available.get(key);
  if (yes === undefined) {
    let missing = missingPixels.get(probe);
    if (missing === undefined) missingPixels.set(probe, (missing = pixelsOf('28px "Kiosko Missing Font"', probe)));
    yes = pixelsOf(`28px "${family.replace(/"/g, '')}"`, probe) !== missing;
    available.set(key, yes);
  }
  return yes;
}

/** Families of the fonts in `<home>/fonts/`, registered under their own names. */
let userFamilies: string[] | null = null;
function loadUserFonts(): string[] {
  if (userFamilies) return userFamilies;
  userFamilies = [];
  const dir = join(paths.home, 'fonts');
  if (!existsSync(dir)) return userFamilies;
  const before = new Set(GlobalFonts.families.map((f) => f.family));
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => /\.(otf|ttf|ttc|woff2?)$/i.test(f));
  } catch {
    return userFamilies;
  }
  for (const f of files.sort()) GlobalFonts.registerFromPath(join(dir, f));
  userFamilies = GlobalFonts.families.map((f) => f.family).filter((f) => !before.has(f));
  return userFamilies;
}

export interface CjkFonts {
  /** The writing the locale asks for (null: not a CJK language; everything is still covered). */
  script: HanScript | null;
  /** Families appended behind every panel font, in order. Empty: Chinese would draw as boxes. */
  families: string[];
  /** Which of them came from `<home>/fonts/`. */
  fromUser: string[];
}

const chosen = new Map<string, CjkFonts>();

/** The CJK families for `locale`: the user's fonts first, then one system family per writing. */
export function cjkFonts(locale: string): CjkFonts {
  const script = hanScript(locale);
  const key = script ?? '-';
  let out = chosen.get(key);
  if (!out) {
    const fromUser = loadUserFonts().filter((f) => hasFontFamily(f));
    const families = cjkFamiliesFor(locale, hasFontFamily, fromUser);
    out = { script, families, fromUser };
    chosen.set(key, out);
  }
  return out;
}

/** Folder for the user's own fonts (an `.otf` per region works best: a `.ttc` only brings its first face). */
export function userFontsDir(): string {
  return join(paths.home, 'fonts');
}

const fallback = new FontFallback();

/**
 * Picks the CJK fonts for this language. Called by the compositor on every
 * frame; only does work when the language changes.
 */
export function setFontLocale(locale: string): void {
  // A character's width depends on which font draws it.
  if (fallback.setFamilies([...new Set([...cjkFonts(locale).families, ...otherScriptFonts().map((f) => f.family)])])) kit.clearTextCache();
}

let others: { script: string; family: string }[] | null = null;
/** For each writing besides Latin, Greek, Cyrillic and CJK, the first family this machine has for it. */
export function otherScriptFonts(): { script: string; family: string }[] {
  if (!others) {
    registerFonts();
    others = [];
    for (const o of OTHER_SCRIPTS) {
      const family = o.families.find((f) => hasFontFamily(f, o.probe));
      if (family) others.push({ script: o.script, family });
    }
  }
  return others;
}

/**
 * Whether the panel can draw the writing of `locale` (Thai, Hindi,
 * Arabic…), or what to install. Null for Latin, Greek, Cyrillic and CJK
 * (CJK has cjkFontStatus).
 */
export function scriptFontStatus(locale: string): { ok: boolean; line: string } | null {
  let script: string | undefined;
  try {
    script = new Intl.Locale(locale.replace(/_/g, '-').replace(/[.@].*$/, '')).maximize().script;
  } catch {
    return null;
  }
  const wanted = OTHER_SCRIPTS.find((o) => o.script === script);
  if (!wanted) return null;
  const found = otherScriptFonts().find((f) => f.script === script);
  if (found) return { ok: true, line: `${script} text drawn with ${found.family}` };
  return { ok: false, line: `no font for ${script} text: it would show as empty boxes; install ${wanted.families[0]} (Debian/Ubuntu: fonts-noto-core), or put an .otf in ${userFontsDir()}` };
}

/** `font` with the CJK families behind it (and bold for Kiosko's bold families). */
export function withFallback(font: string): string {
  return fallback.apply(font);
}

let nativeFont: PropertyDescriptor | null = null;

/** Every 2D context, plugins' included, gets the CJK families behind the font it sets. */
function installFallbackHook(): void {
  if (nativeFont) return;
  nativeFont = hookFont(Object.getPrototypeOf(createCanvas(1, 1).getContext('2d')) as object, withFallback);
}

/** What to tell the user when there is no CJK font: how to get one on this system. */
export function cjkFontHint(): string {
  const install =
    process.platform === 'win32'
      ? 'Microsoft JhengHei and YaHei come with Windows: if they are missing, add the Chinese supplemental fonts in Settings › Apps › Optional features'
      : process.platform === 'darwin'
        ? 'macOS ships PingFang; reinstall it from Font Book'
        : 'install Noto Sans CJK (Debian/Ubuntu: fonts-noto-cjk, Fedora: google-noto-sans-cjk-fonts, Arch: noto-fonts-cjk)';
  return `${install}, or put an .otf such as Noto Sans TC or SC in ${userFontsDir()}`;
}

/**
 * One line about the CJK fonts for `kiosko doctor` and the start-up log:
 * which family draws Chinese, Japanese and Korean, or that they would come
 * out as empty boxes and how to fix it.
 */
export function cjkFontStatus(locale: string): { ok: boolean; line: string } {
  registerFonts();
  const { script, families, fromUser } = cjkFonts(locale);
  if (!families.length) return { ok: false, line: `no Chinese/Japanese/Korean font: those characters would show as empty boxes; ${cjkFontHint()}` };
  const first = families[0]!;
  const more = families.length > 1 ? ` (+${families.length - 1} for other scripts)` : '';
  return { ok: true, line: `CJK text drawn with ${first}${fromUser.includes(first) ? ' (yours)' : ''}${script ? ` for ${script}` : ''}${more}` };
}

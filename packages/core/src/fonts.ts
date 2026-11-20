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
    // The kit's own default ('sans-serif') does not draw everywhere.
    kit.setDefaultFamily(FONT_FAMILIES.sans);
    installFallbackHook();
  }
  for (const f of extra) if (existsSync(f.path)) GlobalFonts.registerFromPath(f.path, f.family);
  done = true;
}

// ---------------------------------------------------------------------------
// Chinese, Japanese and Korean

/**
 * System families to try, best first, for each way of writing Han. Region
 * specific names on purpose: a generic one (or a `.ttc` registered by path,
 * which only brings its first face) would draw Japanese shapes for Chinese.
 */
const CJK_FAMILIES: Record<HanScript, string[]> = {
  Hant: ['Noto Sans CJK TC', 'Noto Sans TC', 'Source Han Sans TC', 'Source Han Sans TW', 'Microsoft JhengHei', 'PingFang TC', 'Heiti TC'],
  'Hant-HK': ['Noto Sans CJK HK', 'Noto Sans HK', 'Source Han Sans HK', 'Microsoft JhengHei', 'PingFang HK', 'Noto Sans CJK TC', 'Noto Sans TC', 'PingFang TC'],
  Hans: ['Noto Sans CJK SC', 'Noto Sans SC', 'Source Han Sans SC', 'Source Han Sans CN', 'Microsoft YaHei', 'PingFang SC', 'Heiti SC'],
  Jpan: ['Noto Sans CJK JP', 'Noto Sans JP', 'Source Han Sans JP', 'Source Han Sans', 'Yu Gothic', 'Meiryo', 'Hiragino Sans', 'Hiragino Kaku Gothic ProN'],
  Kore: ['Noto Sans CJK KR', 'Noto Sans KR', 'Source Han Sans KR', 'Source Han Sans K', 'Malgun Gothic', 'Apple SD Gothic Neo'],
};

/** Which writings to cover, in order: the user's own first, then the rest so nothing is left as a box. */
function scriptOrder(own: HanScript | null): HanScript[] {
  const rest: HanScript[] = ['Hans', 'Hant', 'Jpan', 'Kore'];
  if (!own) return rest;
  const first: HanScript[] = own === 'Hant-HK' ? ['Hant-HK', 'Hant'] : [own];
  return [...first, ...rest.filter((s) => !first.includes(s))];
}

/** A character every CJK font has and DejaVu does not. */
const PROBE = '體';
const available = new Map<string, boolean>();
let probeCanvas: Canvas | null = null;
let missingPixels: string | null = null;

function pixelsOf(font: string): string {
  probeCanvas ??= createCanvas(40, 40);
  const g = probeCanvas.getContext('2d');
  g.clearRect(0, 0, 40, 40);
  // Straight to the native setter: the probe must see the font alone.
  if (nativeFont?.set) nativeFont.set.call(g, font);
  else g.font = font;
  g.fillStyle = '#000';
  g.textBaseline = 'top';
  g.fillText(PROBE, 4, 4);
  return Buffer.from(g.getImageData(0, 0, 40, 40).data.buffer).toString('base64');
}

/**
 * Whether the system (or a registered file) has `family`. `GlobalFonts.has`
 * only knows registered fonts, so draw a character with it and compare with
 * a family that cannot exist: a missing family draws the same empty box.
 */
export function hasFontFamily(family: string): boolean {
  let yes = available.get(family);
  if (yes === undefined) {
    missingPixels ??= pixelsOf('28px "Kiosko Missing Font"');
    yes = pixelsOf(`28px "${family.replace(/"/g, '')}"`) !== missingPixels;
    available.set(family, yes);
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
    const families = [...fromUser];
    for (const s of scriptOrder(script)) {
      const found = CJK_FAMILIES[s].find((f) => !families.includes(f) && hasFontFamily(f));
      if (found) families.push(found);
    }
    out = { script, families: [...new Set(families)], fromUser };
    chosen.set(key, out);
  }
  return out;
}

/** Folder for the user's own fonts (an `.otf` per region works best: a `.ttc` only brings its first face). */
export function userFontsDir(): string {
  return join(paths.home, 'fonts');
}

let fallbackTail = '';
const memo = new Map<string, string>();
const BOLD_FAMILIES = [FONT_FAMILIES.sansBold, FONT_FAMILIES.monoBold];

/**
 * Picks the CJK fonts for this language. Called by the compositor on every
 * frame; only does work when the language changes.
 */
export function setFontLocale(locale: string): void {
  const tail = cjkFonts(locale).families.map((f) => `, "${f}"`).join('');
  if (tail !== fallbackTail) {
    fallbackTail = tail;
    memo.clear();
    // A character's width depends on which font draws it.
    kit.clearTextCache();
  }
}

/**
 * `font` with the CJK families behind it. Kiosko's bold families are DejaVu
 * Bold files under their own name, so the string asks for no weight and the
 * CJK font would come out regular: ask for bold too, which the DejaVu Bold
 * file already is.
 */
export function withFallback(font: string): string {
  if (!fallbackTail) return font;
  let out = memo.get(font);
  if (out === undefined) {
    out = font;
    if (!font.endsWith(fallbackTail)) {
      out = font + fallbackTail;
      const size = /\d*\.?\d+(px|pt|em|rem)\b/.exec(font);
      const before = size ? font.slice(0, size.index) : '';
      const after = size ? font.slice(size.index) : font;
      if (BOLD_FAMILIES.some((f) => after.includes(f)) && !/\b(bold|bolder|[1-9]00)\b/.test(before)) out = `bold ${out}`;
    }
    if (memo.size > 2000) memo.clear();
    memo.set(font, out);
  }
  return out;
}

let nativeFont: PropertyDescriptor | undefined;
const SET = Symbol('kiosko.fontSet');
const GOT = Symbol('kiosko.fontGot');

/**
 * Every 2D context, plugins' included, gets the CJK families behind the font
 * it sets. Reading `font` back gives what was set, so code that compares
 * before setting (the kit does, to save work) keeps working.
 */
function installFallbackHook(): void {
  if (nativeFont) return;
  const proto = Object.getPrototypeOf(createCanvas(1, 1).getContext('2d')) as object;
  const desc = Object.getOwnPropertyDescriptor(proto, 'font');
  if (!desc?.set || !desc.get || !desc.configurable) return;
  nativeFont = desc;
  const { get, set } = desc;
  Object.defineProperty(proto, 'font', {
    configurable: true,
    enumerable: desc.enumerable ?? false,
    get(this: Record<symbol, string>) {
      const now = get.call(this) as string;
      return now === this[GOT] ? this[SET]! : now;
    },
    set(this: Record<symbol, string>, value: string) {
      set.call(this, withFallback(String(value)));
      this[SET] = String(value);
      this[GOT] = get.call(this) as string;
    },
  });
}

/** What to tell the user when there is no CJK font: how to get one on this system. */
export function cjkFontHint(): string {
  const install =
    process.platform === 'win32'
      ? 'add the Chinese supplemental fonts in Settings › Apps › Optional features'
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

/**
 * The CJK font behind every panel font: which families to try for each way
 * of writing Han, and the hook that appends them to whatever a 2D context
 * is given as `font`. No Node imports: the browser demo uses it too (see
 * fonts.ts and web/demo/shims/fonts.ts).
 */
import { FONT_FAMILIES, hanScript, type HanScript } from '@kiosko/sdk';

/**
 * Families to try, best first, for each way of writing Han. Region-specific
 * names on purpose: the same character is drawn differently in Taiwan, Hong
 * Kong, mainland China, Japan and Korea, and a generic name (or a `.ttc`
 * registered by path, which only brings its first face) gives Japanese
 * shapes to Chinese text.
 */
export const CJK_FAMILIES: Record<HanScript, string[]> = {
  Hant: ['Noto Sans CJK TC', 'Noto Sans TC', 'Source Han Sans TC', 'Source Han Sans TW', 'Microsoft JhengHei', 'PingFang TC', 'Heiti TC'],
  'Hant-HK': ['Noto Sans CJK HK', 'Noto Sans HK', 'Source Han Sans HK', 'Microsoft JhengHei', 'PingFang HK', 'Noto Sans CJK TC', 'Noto Sans TC', 'PingFang TC'],
  Hans: ['Noto Sans CJK SC', 'Noto Sans SC', 'Source Han Sans SC', 'Source Han Sans CN', 'Microsoft YaHei', 'PingFang SC', 'Heiti SC'],
  Jpan: ['Noto Sans CJK JP', 'Noto Sans JP', 'Source Han Sans JP', 'Source Han Sans', 'Yu Gothic', 'Meiryo', 'Hiragino Sans', 'Hiragino Kaku Gothic ProN'],
  Kore: ['Noto Sans CJK KR', 'Noto Sans KR', 'Source Han Sans KR', 'Source Han Sans K', 'Malgun Gothic', 'Apple SD Gothic Neo'],
};

/** Which writings to cover, in order: the user's own first, then the rest so nothing is left as a box. */
export function scriptOrder(own: HanScript | null): HanScript[] {
  const rest: HanScript[] = ['Hans', 'Hant', 'Jpan', 'Kore'];
  if (!own) return rest;
  const first: HanScript[] = own === 'Hant-HK' ? ['Hant-HK', 'Hant'] : [own];
  return [...first, ...rest.filter((s) => !first.includes(s))];
}

/**
 * The families for `locale`: `own` first (fonts the user added), then for
 * each writing the first candidate this machine has.
 */
export function cjkFamiliesFor(locale: string, available: (family: string) => boolean, own: string[] = []): string[] {
  const out = [...own];
  for (const s of scriptOrder(hanScript(locale))) {
    const found = CJK_FAMILIES[s].find((f) => !out.includes(f) && available(f));
    if (found) out.push(found);
  }
  return [...new Set(out)];
}

const BOLD_FAMILIES = [FONT_FAMILIES.sansBold, FONT_FAMILIES.monoBold];

/** Turns a canvas `font` into the same font with the CJK families behind it. */
export class FontFallback {
  private tail = '';
  private readonly memo = new Map<string, string>();

  /** Sets the families; true if they changed (callers then forget measured widths). */
  setFamilies(families: string[]): boolean {
    const tail = families.map((f) => `, "${f.replace(/"/g, '')}"`).join('');
    if (tail === this.tail) return false;
    this.tail = tail;
    this.memo.clear();
    return true;
  }

  /**
   * `font` with the families behind it. Kiosko's bold families are DejaVu
   * Bold files under their own name, so the string asks for no weight and
   * the CJK font would come out regular: ask for bold too, which the DejaVu
   * Bold face already is.
   */
  apply(font: string): string {
    if (!this.tail) return font;
    let out = this.memo.get(font);
    if (out === undefined) {
      out = font;
      if (!font.endsWith(this.tail)) {
        out = font + this.tail;
        const size = /\d*\.?\d+(px|pt|em|rem)\b/.exec(font);
        const before = size ? font.slice(0, size.index) : '';
        const after = size ? font.slice(size.index) : font;
        if (BOLD_FAMILIES.some((f) => after.includes(f)) && !/\b(bold|bolder|[1-9]00)\b/.test(before)) out = `bold ${out}`;
      }
      if (this.memo.size > 2000) this.memo.clear();
      this.memo.set(font, out);
    }
    return out;
  }
}

const SET = Symbol('kiosko.fontSet');
const GOT = Symbol('kiosko.fontGot');

/**
 * Makes every context of `proto`'s kind (plugins' included) pass its `font`
 * through `apply`. Reading `font` back gives what was set, so code that
 * compares before setting (the kit does, to save work) keeps working.
 * Returns the original property, to set a font without the families.
 */
export function hookFont(proto: object, apply: (font: string) => string): PropertyDescriptor | null {
  const desc = Object.getOwnPropertyDescriptor(proto, 'font');
  if (!desc?.set || !desc.get || !desc.configurable) return null;
  const { get, set } = desc;
  Object.defineProperty(proto, 'font', {
    configurable: true,
    enumerable: desc.enumerable ?? false,
    get(this: Record<symbol, string>) {
      const now = get.call(this) as string;
      return now === this[GOT] ? this[SET]! : now;
    },
    set(this: Record<symbol, string>, value: string) {
      set.call(this, apply(String(value)));
      this[SET] = String(value);
      this[GOT] = get.call(this) as string;
    },
  });
  return desc;
}

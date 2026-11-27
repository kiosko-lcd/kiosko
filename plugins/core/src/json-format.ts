/**
 * How a value read from JSON is written on the panel (decimals, unit,
 * prefix) and what colour it takes (thresholds). Pure: the widgets, the
 * tests and the editor's demo use the same functions.
 */

/** The theme's colours a threshold may give a value. */
export const TONES = ['ok', 'info', 'warn', 'alert', 'accent', 'dim'] as const;
export type Tone = (typeof TONES)[number];

/** A number from a JSON value: numbers, and text that is only a number (`"21.5"`, `" 3 "`). */
export function toNumber(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && /^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*$/.test(v)) {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

export interface ValueFormat {
  /** Digits after the decimal point; -1 = as it comes (up to 2). */
  decimals: number;
  prefix: string;
  unit: string;
  locale: string;
}

/** Longest text a value is written as: a value, not a document. */
const MAX_TEXT = 200;

/** A number in the user's way of writing numbers, with `decimals` (-1: as it comes, up to 2). */
export function formatNumber(n: number, decimals: number, locale: string): string {
  const d = Math.max(-1, Math.min(6, Math.round(decimals)));
  try {
    return new Intl.NumberFormat(locale, d < 0 ? { maximumFractionDigits: 2 } : { minimumFractionDigits: d, maximumFractionDigits: d }).format(n);
  } catch {
    return d < 0 ? String(n) : n.toFixed(d);
  }
}

/** The value as text, without prefix or unit: numbers formatted, nothing as `—`, objects as short JSON. */
export function valueText(v: unknown, o: Pick<ValueFormat, 'decimals' | 'locale'>): string {
  const n = typeof v === 'number' || (typeof v === 'string' && o.decimals >= 0) ? toNumber(v) : undefined;
  if (n !== undefined) return formatNumber(n, o.decimals, o.locale);
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'string') return v.length > MAX_TEXT ? `${v.slice(0, MAX_TEXT - 1)}…` : v;
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  let s: string;
  try {
    s = JSON.stringify(v);
  } catch {
    s = String(v);
  }
  return s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT - 1)}…` : s;
}

/** Units written right after the number, with no space: `21°`, `50%`, `5′`. The rest get one. */
const TIGHT_UNIT = /^(%|°|′|″|‰)/;

/** The whole text: prefix, value and unit (`$1,234.50`, `21.5 °C`, `50%`). */
export function formatValue(v: unknown, o: ValueFormat): string {
  const text = valueText(v, o);
  if (text === '—') return text;
  const unit = o.unit.trim();
  return `${o.prefix}${text}${unit ? (TIGHT_UNIT.test(unit) ? unit : ` ${unit}`) : ''}`;
}

/** One rule of a threshold list: when it holds, the value takes `tone`. */
export interface Threshold {
  /** `>= 30`, `> 30`, `< 0`, `<= 5`, `= failed`, `!= ok`, or a bare number (`30`, meaning `>= 30`). */
  when: string;
  tone: Tone;
}

const RULE = /^\s*(>=|<=|!=|==|=|>|<)?\s*(.*?)\s*$/s;

/** Whether `v` meets a rule's condition. A rule that compares numbers never holds for something that isn't one. */
export function meets(v: unknown, when: string): boolean {
  const m = RULE.exec(when);
  if (!m) return false;
  const op = m[1] ?? (toNumber(m[2]) !== undefined ? '>=' : '=');
  const rhs = m[2]!;
  if (op === '=' || op === '==' || op === '!=') {
    const n = toNumber(v), r = toNumber(rhs);
    const equal = n !== undefined && r !== undefined ? n === r : String(v ?? '').trim().toLowerCase() === rhs.toLowerCase();
    return op === '!=' ? !equal : equal;
  }
  const n = toNumber(v), r = toNumber(rhs);
  if (n === undefined || r === undefined) return false;
  return op === '>=' ? n >= r : op === '>' ? n > r : op === '<' ? n < r : n <= r;
}

/** The tone of the first rule that holds, in the order given, or undefined. */
export function toneFor(v: unknown, rules: readonly Threshold[]): Tone | undefined {
  for (const r of rules) if (r.when.trim() && meets(v, r.when)) return r.tone;
  return undefined;
}

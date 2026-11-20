/**
 * Times and lengths of time, written the same way by every widget:
 * `ctx.fmt.time(at)`, `ctx.fmt.ago(at)` and `ctx.fmt.duration(ms)`.
 *
 * They follow the panel's language (English, Spanish, Traditional and
 * Simplified Chinese words; any other language gets the English ones) and the config's `timeFormat`. Hand-written
 * rather than `Intl.RelativeTimeFormat`: its short forms differ between ICU
 * versions (Node, Chromium, WebKit), and a panel must paint the same thing in
 * the editor, the browser demo and on the glass.
 */

import { pickLocale } from './i18n.ts';

/** How clock times are written: `auto` follows the language (24 h in Spanish, 12 h in US English). */
export type TimeFormat = 'auto' | '24h' | '12h';
export const TIME_FORMATS: readonly TimeFormat[] = ['auto', '24h', '12h'];

export interface Formatters {
  /** True when clock times are written on a 12-hour clock. */
  readonly hour12: boolean;
  /**
   * A clock time: `"09:05"` on a 24-hour clock, `"9:05 AM"` (`"9:05 a. m."`)
   * on a 12-hour one (`"上午 9:05"` in Chinese). `seconds` adds `":07"`; `ampm: false` leaves out
   * AM/PM (a big clock that paints it apart).
   */
  time(at: number | Date, o?: { seconds?: boolean; ampm?: boolean }): string;
  /**
   * From one clock time to another: `"14:00–15:30"`, `"3:30–4:00 PM"`,
   * `"下午 3:30–4:00"` (AM/PM once when both are in the same half of the day).
   */
  range(from: number | Date, to: number | Date, o?: { seconds?: boolean }): string;
  /**
   * How long ago `at` (epoch ms, a Date or an ISO string) was, from `ctx.now`:
   * `"just now"`, `"5 min ago"`, `"3 h ago"`, `"4 d ago"`, `"2 wk ago"`,
   * `"1 yr ago"` (`"hace 5 min"`…). `suffix: false` gives the bare age for
   * a meta line: `"now"`, `"5 min"`, `"3 h"`. A future `at` is "now".
   */
  ago(at: number | Date | string, o?: { suffix?: boolean; now?: number }): string;
  /**
   * A length of time: `"45 s"` (only with `seconds`), `"12 min"`,
   * `"1 h 05"`, `"2 d 3 h"`. Rounded down by default; `round: 'up'` for
   * countdowns ("in 0 min" would be a lie until it starts). `compact`
   * drops a zero remainder: `"1 h"` rather than `"1 h 00"`, `"2 d"` rather
   * than `"2 d 0 h"` (a span such as "the last 1 h", not a running timer).
   */
  duration(ms: number, o?: { seconds?: boolean; round?: 'down' | 'up' | 'nearest'; compact?: boolean }): string;
}

/**
 * A language's words for times. Every unit gets the number, so a language
 * whose units change with it (Polish, Russian, Arabic) can say so.
 */
interface Words {
  now: string;
  justNow: string;
  /** `v` is the age already written ("5 min"), `n` its number. */
  ago: (v: string, n: number) => string;
  s: (n: number) => string;
  min: (n: number) => string;
  h: (n: number) => string;
  d: (n: number) => string;
  wk: (n: number) => string;
  yr: (n: number) => string;
  /** Hours and minutes of a running length: "1 h 05", "1 小時 5 分". */
  hm: (h: number, m: number) => string;
  /** Days and hours: "2 d 3 h". */
  dh: (d: number, h: number) => string;
  am: string;
  pm: string;
  /** AM/PM goes before the time (上午 9:05), not after. */
  ampmFirst?: boolean;
}

const latin = (wk: string, yr: (n: number) => string) => ({
  s: (n: number) => `${n} s`,
  min: (n: number) => `${n} min`,
  h: (n: number) => `${n} h`,
  d: (n: number) => `${n} d`,
  wk: (n: number) => `${n} ${wk}`,
  yr: (n: number) => `${n} ${yr(n)}`,
  hm: (h: number, m: number) => `${h} h ${pad2(m)}`,
  dh: (d: number, h: number) => `${d} d ${h} h`,
});
const chinese = (u: { min: string; h: string; wk: string }) => ({
  s: (n: number) => `${n} 秒`,
  min: (n: number) => `${n} ${u.min}`,
  h: (n: number) => `${n} ${u.h}`,
  d: (n: number) => `${n} 天`,
  wk: (n: number) => `${n} ${u.wk}`,
  yr: (n: number) => `${n} 年`,
  // No leading zero in Chinese: 1 小時 5 分.
  hm: (h: number, m: number) => `${h} ${u.h} ${m} 分`,
  dh: (d: number, h: number) => `${d} 天 ${h} ${u.h}`,
});

const WORDS: Record<string, Words> = {
  en: { now: 'now', justNow: 'just now', ago: (v) => `${v} ago`, am: 'AM', pm: 'PM', ...latin('wk', () => 'yr') },
  es: { now: 'ahora', justNow: 'ahora mismo', ago: (v) => `hace ${v}`, am: 'a. m.', pm: 'p. m.', ...latin('sem', (n) => (n === 1 ? 'año' : 'años')) },
  'zh-Hant': { now: '現在', justNow: '剛剛', ago: (v) => `${v}前`, am: '上午', pm: '下午', ampmFirst: true, ...chinese({ min: '分鐘', h: '小時', wk: '週' }) },
  'zh-Hans': { now: '现在', justNow: '刚刚', ago: (v) => `${v}前`, am: '上午', pm: '下午', ampmFirst: true, ...chinese({ min: '分钟', h: '小时', wk: '周' }) },
};
/** The languages ctx.fmt has words for (a test checks every language Kiosko speaks is here). */
export const FORMAT_LANGUAGES = Object.keys(WORDS);
const LANGS = Object.keys(WORDS);

const wordsFor = (locale: string): Words => WORDS[pickLocale(LANGS, locale) ?? 'en'] ?? WORDS.en!;
const pad2 = (n: number) => String(n).padStart(2, '0');

const cycles = new Map<string, boolean>();

/** Whether `locale` writes times on a 12-hour clock, per `timeFormat`. */
export function usesHour12(locale: string, timeFormat: TimeFormat = 'auto'): boolean {
  if (timeFormat !== 'auto') return timeFormat === '12h';
  let h12 = cycles.get(locale);
  if (h12 === undefined) {
    try {
      const cycle = new Intl.DateTimeFormat(locale, { hour: 'numeric' }).resolvedOptions().hourCycle;
      h12 = cycle === 'h11' || cycle === 'h12';
    } catch {
      h12 = false;
    }
    cycles.set(locale, h12);
  }
  return h12;
}

function toMs(at: number | Date | string): number {
  if (typeof at === 'number') return at;
  if (typeof at === 'string') return Date.parse(at);
  return at.getTime();
}

/**
 * The formatters of a context. Kiosko builds them for every plugin context;
 * plugin tests can build their own: `createFormatters({ locale: 'es', now })`.
 */
export function createFormatters(o: { locale: string; timeFormat?: TimeFormat; now: number }): Formatters {
  const w = wordsFor(o.locale);
  const hour12 = usesHour12(o.locale, o.timeFormat);
  const fmt: Formatters = {
    hour12,
    time(at, opts = {}) {
      const d = new Date(toMs(at));
      const h = d.getHours();
      const rest = `:${pad2(d.getMinutes())}${opts.seconds ? `:${pad2(d.getSeconds())}` : ''}`;
      if (!hour12) return `${pad2(h)}${rest}`;
      const base = `${h % 12 || 12}${rest}`;
      if (opts.ampm === false) return base;
      const mark = h < 12 ? w.am : w.pm;
      return w.ampmFirst ? `${mark} ${base}` : `${base} ${mark}`;
    },
    range(from, to, opts = {}) {
      const a = new Date(toMs(from));
      const b = new Date(toMs(to));
      if (!hour12 || (a.getHours() < 12) !== (b.getHours() < 12)) return `${fmt.time(a, opts)}–${fmt.time(b, opts)}`;
      // The same half of the day: AM/PM once, where the language puts it.
      return w.ampmFirst ? `${fmt.time(a, opts)}–${fmt.time(b, { ...opts, ampm: false })}` : `${fmt.time(a, { ...opts, ampm: false })}–${fmt.time(b, opts)}`;
    },
    ago(at, opts = {}) {
      const suffix = opts.suffix !== false;
      const ms = (opts.now ?? o.now) - toMs(at);
      const min = Math.floor(ms / 60_000);
      if (!Number.isFinite(min) || min < 1) return suffix ? w.justNow : w.now;
      const h = Math.floor(min / 60);
      const d = Math.floor(h / 24);
      const [v, n] = min < 60 ? [w.min(min), min] : h < 24 ? [w.h(h), h] : d < 14 ? [w.d(d), d] : d < 365 ? [w.wk(Math.floor(d / 7)), Math.floor(d / 7)] : [w.yr(Math.floor(d / 365)), Math.floor(d / 365)];
      return suffix ? w.ago(v, n) : v;
    },
    duration(ms, opts = {}) {
      const round = opts.round === 'up' ? Math.ceil : opts.round === 'nearest' ? Math.round : Math.floor;
      const safe = Number.isFinite(ms) ? Math.max(0, ms) : 0;
      if (opts.seconds && safe < 60_000) return w.s(round(safe / 1000));
      const min = round(safe / 60_000);
      if (min < 60) return w.min(min);
      const h = Math.floor(min / 60);
      if (h < 24) return opts.compact && min % 60 === 0 ? w.h(h) : w.hm(h, min % 60);
      return opts.compact && h % 24 === 0 ? w.d(h / 24) : w.dh(Math.floor(h / 24), h % 24);
    },
  };
  return fmt;
}

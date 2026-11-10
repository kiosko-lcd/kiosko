/**
 * Times and lengths of time, written the same way by every widget:
 * `ctx.fmt.time(at)`, `ctx.fmt.ago(at)` and `ctx.fmt.duration(ms)`.
 *
 * They follow the panel's language (English and Spanish words; any other
 * language gets the English ones) and the config's `timeFormat`. Hand-written
 * rather than `Intl.RelativeTimeFormat`: its short forms differ between ICU
 * versions (Node, Chromium, WebKit), and a panel must paint the same thing in
 * the editor, the browser demo and on the glass.
 */

/** How clock times are written: `auto` follows the language (24 h in Spanish, 12 h in US English). */
export type TimeFormat = 'auto' | '24h' | '12h';
export const TIME_FORMATS: readonly TimeFormat[] = ['auto', '24h', '12h'];

export interface Formatters {
  /** True when clock times are written on a 12-hour clock. */
  readonly hour12: boolean;
  /**
   * A clock time: `"09:05"` on a 24-hour clock, `"9:05 AM"` (`"9:05 a. m."`)
   * on a 12-hour one. `seconds` adds `":07"`; `ampm: false` leaves out
   * AM/PM (a big clock that paints it apart).
   */
  time(at: number | Date, o?: { seconds?: boolean; ampm?: boolean }): string;
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

interface Words {
  now: string;
  justNow: string;
  ago: (v: string) => string;
  wk: string;
  yr: (n: number) => string;
  am: string;
  pm: string;
}

const WORDS: Record<string, Words> = {
  en: { now: 'now', justNow: 'just now', ago: (v) => `${v} ago`, wk: 'wk', yr: () => 'yr', am: 'AM', pm: 'PM' },
  es: { now: 'ahora', justNow: 'ahora mismo', ago: (v) => `hace ${v}`, wk: 'sem', yr: (n) => (n === 1 ? 'año' : 'años'), am: 'a. m.', pm: 'p. m.' },
};

const langOf = (locale: string) => locale.toLowerCase().split(/[-_]/)[0] ?? 'en';
const wordsFor = (locale: string): Words => WORDS[langOf(locale)] ?? WORDS.en!;
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
  return {
    hour12,
    time(at, opts = {}) {
      const d = new Date(toMs(at));
      const h = d.getHours();
      const rest = `:${pad2(d.getMinutes())}${opts.seconds ? `:${pad2(d.getSeconds())}` : ''}`;
      if (!hour12) return `${pad2(h)}${rest}`;
      const base = `${h % 12 || 12}${rest}`;
      return opts.ampm === false ? base : `${base} ${h < 12 ? w.am : w.pm}`;
    },
    ago(at, opts = {}) {
      const suffix = opts.suffix !== false;
      const ms = (opts.now ?? o.now) - toMs(at);
      const min = Math.floor(ms / 60_000);
      if (!Number.isFinite(min) || min < 1) return suffix ? w.justNow : w.now;
      const h = Math.floor(min / 60);
      const d = Math.floor(h / 24);
      const v = min < 60 ? `${min} min` : h < 24 ? `${h} h` : d < 14 ? `${d} d` : d < 365 ? `${Math.floor(d / 7)} ${w.wk}` : `${Math.floor(d / 365)} ${w.yr(Math.floor(d / 365))}`;
      return suffix ? w.ago(v) : v;
    },
    duration(ms, opts = {}) {
      const round = opts.round === 'up' ? Math.ceil : opts.round === 'nearest' ? Math.round : Math.floor;
      const safe = Number.isFinite(ms) ? Math.max(0, ms) : 0;
      if (opts.seconds && safe < 60_000) return `${round(safe / 1000)} s`;
      const min = round(safe / 60_000);
      if (min < 60) return `${min} min`;
      const h = Math.floor(min / 60);
      if (h < 24) return opts.compact && min % 60 === 0 ? `${h} h` : `${h} h ${pad2(min % 60)}`;
      return opts.compact && h % 24 === 0 ? `${h / 24} d` : `${Math.floor(h / 24)} d ${h % 24} h`;
    },
  };
}

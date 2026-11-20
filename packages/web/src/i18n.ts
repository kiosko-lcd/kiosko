/** Editor texts: the dictionaries in lang/, one file per language; a language without one falls back to English. */
import { pickLocale } from '@kiosko/sdk/i18n';
import { LANGUAGES } from '@kiosko/sdk/languages';
import { DICTIONARIES, en, type Key } from './lang/index.ts';
import { createFormatters, usesHour12 } from '@kiosko/sdk/format';
import { ApiError } from './errors.ts';
import { config, locale } from './store.ts';






export type TKey = Key;

/**
 * The languages the editor speaks: Kiosko's (packages/sdk/src/languages.ts)
 * that have a dictionary in lang/, with their names for the picker.
 */
export const UI_LANGUAGES: { id: string; name: string; dir: 'ltr' | 'rtl'; texts: Record<Key, string> }[] = LANGUAGES.filter((l) => DICTIONARIES[l.id]).map((l) => ({ id: l.id, name: l.name, dir: l.dir, texts: DICTIONARIES[l.id]! }));
const DICTS: Record<string, Record<Key, string>> = Object.fromEntries(UI_LANGUAGES.map((l) => [l.id, l.texts]));
const LANGS = Object.keys(DICTS);

/** The editor language for the current locale (English when there is none). */
export function uiLanguage(): string {
  return pickLocale(LANGS, locale.value) ?? 'en';
}

export function tr(key: Key): string {
  return DICTS[uiLanguage()]?.[key] ?? en[key] ?? key;
}

/** Plugin-provided localized texts in the JSON schema hints. */
export function loc(text: string | Record<string, string> | undefined): string {
  if (!text) return '';
  if (typeof text === 'string') return text;
  const key = pickLocale(Object.keys(text), locale.value);
  return (key ? text[key] : undefined) ?? text.en ?? Object.values(text)[0] ?? '';
}

/** A text with its `{name}` holes filled in. */
export function t(key: Key, vars: Record<string, string | number> = {}): string {
  return tr(key).replace(/\{(\w+)\}/g, (whole, k: string) => (k in vars ? String(vars[k]) : whole));
}

/** `{n} widgets` and friends: the `.one` or `.other` text for `n`, by the language's plural rules. */
export function count(key: 'screens.frames' | 'plugins.widgets' | 'plugins.sources' | 'plugins.interludes', n: number): string {
  const form = new Intl.PluralRules(uiLanguage()).select(n) === 'one' ? 'one' : 'other';
  return t(`${key}.${form}` as Key, { n });
}

/** "90000" ms → "1.5 min" */
export function fmtMs(ms: number): string {
  if (ms < 60_000) return t('unit.s', { n: Math.round(ms / 1000) });
  if (ms < 3_600_000) return t('unit.min', { n: +(ms / 60_000).toFixed(1) });
  return t('unit.h', { n: +(ms / 3_600_000).toFixed(1) });
}

/** A clock time in the editor's language and the config's 12/24-hour setting ("下午 3:05", "15:05:07"). */
export function clock(at: number, o: { seconds?: boolean } = {}): string {
  return createFormatters({ locale: locale.value, timeFormat: config.value?.timeFormat ?? 'auto', now: Date.now() }).time(at, o);
}

/** A date and time, as the editor's language writes them. */
export function dateTime(at: number): string {
  const hour12 = usesHour12(locale.value, config.value?.timeFormat ?? 'auto');
  try {
    return new Date(at).toLocaleString(locale.value, { dateStyle: 'medium', timeStyle: 'short', hour12 });
  } catch {
    return new Date(at).toLocaleString();
  }
}

/** A failed request, in the user's language when the server said which failure it was. */
export function errorText(err: unknown): string {
  if (err instanceof ApiError && err.code && `err.${err.code}` in en) return t(`err.${err.code}` as Key, err.params);
  return err instanceof Error ? err.message : String(err);
}

/** A panel's connection status, in the user's language (`message` in English when it has no code). */
export function deviceText(d: { message: string; code?: string; params?: Record<string, string | number> }): string {
  if (!d.code || !(`device.${d.code}` in en)) return d.message;
  const params = { ...d.params };
  // A failure the editor knows, inside "…; retrying": said in its words too.
  if (d.code === 'usbRetrying' && typeof params.reason === 'string' && `device.${params.reason}` in en) params.why = tr(`device.${params.reason}` as Key);
  return t(`device.${d.code}` as Key, params);
}

/** The days of the week (0 = Sunday) in the order the language's calendars use: Sunday first in Taiwan and the US, Monday in Spain and mainland China. */
export function weekOrder(): number[] {
  let first = 1;
  try {
    const l = new Intl.Locale(locale.value) as Intl.Locale & { getWeekInfo?: () => { firstDay: number }; weekInfo?: { firstDay: number } };
    first = (l.getWeekInfo?.() ?? l.weekInfo)?.firstDay ?? 1;
  } catch {
    /* an odd tag: Monday */
  }
  const start = first % 7;
  return Array.from({ length: 7 }, (_, i) => (start + i) % 7);
}

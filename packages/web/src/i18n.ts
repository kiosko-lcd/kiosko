/** Editor texts: the dictionaries in lang/, one file per language; a language without one falls back to English. */
import { pickLocale } from '@kiosko/sdk/i18n';
import { LANGUAGES } from '@kiosko/sdk/languages';
import { DICTIONARIES, en, type Dictionary, type Key, type PluralKey } from './lang/index.ts';
import { createFormatters, usesHour12 } from '@kiosko/sdk/format';
import { ApiError } from './errors.ts';
import { config, locale } from './store.ts';






export type TKey = Key;

/**
 * The languages the editor speaks: Kiosko's (packages/sdk/src/languages.ts)
 * that have a dictionary in lang/, with their names for the picker.
 */
export const UI_LANGUAGES: { id: string; name: string; dir: 'ltr' | 'rtl'; texts: Dictionary }[] = LANGUAGES.filter((l) => DICTIONARIES[l.id]).map((l) => ({ id: l.id, name: l.name, dir: l.dir, texts: DICTIONARIES[l.id]! }));
const DICTS: Record<string, Dictionary> = Object.fromEntries(UI_LANGUAGES.map((l) => [l.id, l.texts]));
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

/** A text with its `{name}` holes filled in; numbers written the language's way (1,5 in French). */
export function t(key: Key, vars: Record<string, string | number> = {}): string {
  return fill(tr(key), vars);
}

function fill(text: string, vars: Record<string, string | number>): string {
  let nf: Intl.NumberFormat | null = null;
  return text.replace(/\{(\w+)\}/g, (whole, k: string) => {
    const v = vars[k];
    if (v === undefined) return whole;
    if (typeof v !== 'number') return v;
    nf ??= new Intl.NumberFormat(uiLanguage(), { maximumFractionDigits: 3 });
    return nf.format(v);
  });
}

/** `{n} widgets` and friends: the form the language's plural rules ask for, else `.other`. */
export function count(key: PluralKey, n: number): string {
  const lang = uiLanguage();
  const form = new Intl.PluralRules(lang).select(n);
  const dict = (DICTS[lang] ?? en) as Record<string, string | undefined>;
  const text = dict[`${key}.${form}`] ?? dict[`${key}.other`] ?? (en as Record<string, string>)[`${key}.other`]!;
  return fill(text, { n });
}

/** The languages whose install guide is on the site (docs/<id>/install.md, published by landing/docs.mjs). */
/** The guides published on kioskolcd.dev, by language (docs.mjs): English at /docs/…, the others at /<id>/docs/…. */
const GUIDES: Record<string, ReadonlySet<string>> = {
  install: new Set(['zh-Hant', 'zh-Hans']),
  usb: new Set(['en', 'es', 'de', 'zh-Hant', 'zh-Hans']),
  'remote-screens': new Set(['en', 'es', 'de', 'zh-Hant', 'zh-Hans']),
};
const onSite = (lang: string, guide: string) => `https://kioskolcd.dev/${lang === 'en' ? '' : `${lang}/`}docs/${guide}/`;

/**
 * Where "Docs" leads: the install guide in the editor's language, on kioskolcd.dev (which reaches
 * where GitHub may not, as in mainland China), else the README on GitHub.
 */
export function docsUrl(): string {
  const lang = uiLanguage();
  return GUIDES.install!.has(lang) ? onSite(lang, 'install') : 'https://github.com/kiosko-lcd/kiosko#readme';
}

/** The guide to connecting a panel over USB (udev, WinUSB), on the site in the languages it has there, else on GitHub. */
export function usbGuideUrl(): string {
  const lang = uiLanguage();
  return GUIDES.usb!.has(lang) ? onSite(lang, 'usb') : 'https://github.com/kiosko-lcd/kiosko/blob/main/docs/usb.md';
}

/** The guide to Wi-Fi screens (ESP32: firmware, pairing, troubleshooting), on the site, else on GitHub. */
export function remoteGuideUrl(): string {
  const lang = uiLanguage();
  return GUIDES['remote-screens']!.has(lang) ? onSite(lang, 'remote-screens') : 'https://github.com/kiosko-lcd/kiosko/blob/main/docs/remote-screens.md';
}

/** Whether the editor writes in Chinese, Japanese or Korean: full-width punctuation, no spaces around it. */
export function fullWidth(): boolean {
  return /^(zh|ja|ko)\b/.test(uiLanguage());
}

/** `Run: git` — `執行：git` in Chinese (a full-width colon, no space). */
export function labelled(label: string, value: string): string {
  return fullWidth() ? `${label}：${value}` : `${label}: ${value}`;
}

/** `a, b, c` — `a、b、c` in Chinese. */
export function listOf(items: readonly string[]): string {
  return items.join(fullWidth() ? '、' : ', ');
}

/** `Español (Auto)` — `繁體中文（自動）` in Chinese. */
export function aside(text: string, note: string): string {
  return fullWidth() ? `${text}（${note}）` : `${text} (${note})`;
}

/** Two sentences one after the other: with a space between them, but none after a Chinese 。 */
export function sentences(...parts: string[]): string {
  return parts.filter(Boolean).join(fullWidth() ? '' : ' ');
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

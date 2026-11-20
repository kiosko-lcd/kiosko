/**
 * Plugin texts can be a plain string (shown as is) or a map by language.
 * The editor and the panel pick the user's locale (see `pickLocale`), then
 * English, then the first one available.
 *
 * Chinese goes by script: write `zh-Hant` (Taiwan, Hong Kong) and `zh-Hans`
 * (mainland China). `zh-TW` and `zh-CN` work too; a bare `zh` is read as
 * Simplified and never shown to someone who reads Traditional.
 */
export type Localized = string | ({ en: string } & Partial<Record<string, string>>);

/** Tags to try for a Chinese reader, best first. */
const CHINESE: Record<'Hant' | 'Hant-HK' | 'Hans', string[]> = {
  Hant: ['zh-Hant-TW', 'zh-TW', 'zh-Hant'],
  'Hant-HK': ['zh-Hant-HK', 'zh-HK', 'zh-Hant-MO', 'zh-MO', 'zh-Hant', 'zh-TW'],
  Hans: ['zh-Hans-CN', 'zh-CN', 'zh-Hans', 'zh-SG', 'zh'],
};

/**
 * The best of `available` (language tags, any case) for someone reading in
 * `locale`, or undefined if none fits (the caller falls back to English).
 * Exact tag first, then by script for Chinese (Taiwan never gets
 * Simplified), then the language alone (`es` for `es-MX`), then another
 * region of the same language (`pt-BR` for `pt-PT`).
 */
export function pickLocale(available: readonly string[], locale: string | undefined): string | undefined {
  if (!locale || !available.length) return undefined;
  const byLower = new Map(available.map((k) => [k.toLowerCase(), k]));
  const want = locale.replace(/_/g, '-');
  const exact = byLower.get(want.toLowerCase());
  if (exact) return exact;
  const lang = want.split('-')[0]!.toLowerCase();
  if (lang === 'zh') {
    const script = hanScript(want);
    const order = script === 'Hant' || script === 'Hant-HK' || script === 'Hans' ? CHINESE[script] : CHINESE.Hans;
    for (const tag of order) {
      const hit = byLower.get(tag.toLowerCase());
      if (hit) return hit;
    }
    return undefined;
  }
  const base = byLower.get(lang);
  if (base) return base;
  return available.find((k) => k.toLowerCase().startsWith(`${lang}-`));
}

export function localize(text: Localized | undefined, locale = 'en'): string {
  if (text === undefined) return '';
  if (typeof text === 'string') return text;
  const key = pickLocale(Object.keys(text), locale);
  return (key ? text[key] : undefined) ?? text.en ?? Object.values(text).find((v) => typeof v === 'string') ?? '';
}

/**
 * The Han writing a locale reads in, for picking glyphs: the same character
 * is drawn differently in Taiwan (`Hant`), Hong Kong (`Hant-HK`), mainland
 * China (`Hans`), Japan (`Jpan`) and Korea (`Kore`). `null` for locales
 * that do not write with Han characters.
 *
 * Goes by script, not by region code: `zh-TW`, `zh-Hant` and `zh-MO` are
 * Traditional, `zh`, `zh-CN` and `zh-SG` Simplified.
 */
export type HanScript = 'Hant' | 'Hant-HK' | 'Hans' | 'Jpan' | 'Kore';

export function hanScript(locale: string | undefined): HanScript | null {
  let full: Intl.Locale;
  try {
    full = new Intl.Locale((locale || 'en').replace(/_/g, '-')).maximize();
  } catch {
    return null;
  }
  switch (full.language) {
    case 'zh':
      if (full.script === 'Hant') return full.region === 'HK' || full.region === 'MO' ? 'Hant-HK' : 'Hant';
      return 'Hans';
    case 'ja':
      return 'Jpan';
    case 'ko':
      return 'Kore';
    default:
      return null;
  }
}

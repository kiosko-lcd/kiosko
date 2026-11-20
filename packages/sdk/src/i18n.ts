/**
 * Plugin texts can be a plain string (shown as is) or a map by language.
 * The editor and the panel pick the user's locale, then English, then the
 * first one available.
 */
export type Localized = string | ({ en: string } & Partial<Record<string, string>>);

export function localize(text: Localized | undefined, locale = 'en'): string {
  if (text === undefined) return '';
  if (typeof text === 'string') return text;
  const lang = locale.toLowerCase().split(/[-_]/)[0]!;
  return text[locale] ?? text[lang] ?? text.en ?? Object.values(text).find((v) => typeof v === 'string') ?? '';
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

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

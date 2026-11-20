/**
 * The languages Kiosko speaks: the editor, the site, the panel's words for
 * times (ctx.fmt) and the official plugins. One list, read by all of them;
 * a test (packages/web/landing/languages.test.ts) checks that each has its
 * dictionary, site page, time words and plugin texts. Adding a language
 * starts here (CONTRIBUTING.md, "Translations").
 */
export interface Language {
  /** BCP 47 tag, as the texts are keyed (`es`, `zh-Hant`). */
  id: string;
  /** Its name in itself, for the language pickers. */
  name: string;
  /** The locale the panel paints the site's samples in (dates, times): `zh-TW` for `zh-Hant`. */
  panel: string;
  /** Open Graph locale of its site page (`zh_TW`). */
  ogLocale: string;
  /** What its site page is declared to be for (`hreflang`); English is also `x-default`. */
  hreflang: string[];
  /** Writing direction. Right-to-left is not drawn right on the panel yet. */
  dir: 'ltr' | 'rtl';
}

export const LANGUAGES: readonly Language[] = [
  { id: 'en', name: 'English', panel: 'en', ogLocale: 'en_US', hreflang: ['en', 'x-default'], dir: 'ltr' },
  { id: 'es', name: 'Español', panel: 'es', ogLocale: 'es_ES', hreflang: ['es'], dir: 'ltr' },
  { id: 'zh-Hant', name: '繁體中文', panel: 'zh-TW', ogLocale: 'zh_TW', hreflang: ['zh-Hant', 'zh-TW', 'zh-HK'], dir: 'ltr' },
  { id: 'zh-Hans', name: '简体中文', panel: 'zh-CN', ogLocale: 'zh_CN', hreflang: ['zh-Hans', 'zh-CN'], dir: 'ltr' },
];

export const LANGUAGE_IDS: readonly string[] = LANGUAGES.map((l) => l.id);

/** The language with this id (`zh-Hant`), if Kiosko speaks it. */
export function languageById(id: string): Language | undefined {
  return LANGUAGES.find((l) => l.id === id);
}

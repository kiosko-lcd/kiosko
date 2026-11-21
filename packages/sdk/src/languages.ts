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
  /**
   * Where this language's readers live, the services some plugins need may not
   * be offered. The site, the sample config and the editor's tour leave those
   * plugins out for it (`without`), lead with others (`first`) and paint these
   * widgets in place of the missing ones (`instead`, type by type).
   */
  plugins?: { without: readonly string[]; first: readonly string[]; instead: Readonly<Record<string, string>> };
}

/**
 * Simplified Chinese is read in mainland China, where Claude (and Gemini) are
 * not offered: no AI-agent, cats-room nor Claude-usage plugins there, and local
 * models (Qwen, DeepSeek… on your own GPU) in their place.
 */
const MAINLAND_CHINA: NonNullable<Language['plugins']> = {
  without: ['agents', 'cats', 'usage'],
  first: ['llm', 'gpu'],
  instead: { 'agents/summary': 'llm/status', 'agents/sessions': 'llm/models', 'usage/rail': 'gpu/cards', 'cats/room': 'gpu/history' },
};

export const LANGUAGES: readonly Language[] = [
  { id: 'en', name: 'English', panel: 'en', ogLocale: 'en_US', hreflang: ['en', 'x-default'], dir: 'ltr' },
  { id: 'es', name: 'Español', panel: 'es', ogLocale: 'es_ES', hreflang: ['es'], dir: 'ltr' },
  { id: 'de', name: 'Deutsch', panel: 'de', ogLocale: 'de_DE', hreflang: ['de'], dir: 'ltr' },
  { id: 'zh-Hant', name: '繁體中文', panel: 'zh-TW', ogLocale: 'zh_TW', hreflang: ['zh-Hant', 'zh-TW', 'zh-HK'], dir: 'ltr' },
  { id: 'zh-Hans', name: '简体中文', panel: 'zh-CN', ogLocale: 'zh_CN', hreflang: ['zh-Hans', 'zh-CN'], dir: 'ltr', plugins: MAINLAND_CHINA },
];

export const LANGUAGE_IDS: readonly string[] = LANGUAGES.map((l) => l.id);

/** The language with this id (`zh-Hant`), if Kiosko speaks it. */
export function languageById(id: string): Language | undefined {
  return LANGUAGES.find((l) => l.id === id);
}

/**
 * Region names as their readers write them, where `Intl.DisplayNames` says
 * otherwise: mainland usage names Taiwan, Hong Kong and Macau as part of China
 * (and a site that lists it among countries reads as foreign there); in
 * Taiwan, Hong Kong is plain 香港, not the long official name.
 */
const REGION_NAMES: Record<string, Readonly<Record<string, string>>> = {
  'zh-Hans': { TW: '中国台湾', HK: '中国香港', MO: '中国澳门' },
  'zh-Hant': { HK: '香港', MO: '澳門' },
};

/** A region's name (`TW`, `ES`) in a language Kiosko speaks (`zh-Hans`). */
export function regionName(code: string, lang: string): string {
  const own = REGION_NAMES[lang]?.[code.toUpperCase()];
  if (own) return own;
  try {
    return new Intl.DisplayNames([lang], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/**
 * `a, b and c` in `lang`. Chinese lists with 、 throughout, the way prose and
 * labels do (`Intl.ListFormat` gives `Linux、macOS和Windows`, glued to the
 * Latin names).
 */
export function listIn(items: readonly string[], lang: string): string {
  if (/^zh\b/.test(lang)) return items.join('、');
  try {
    return new Intl.ListFormat(lang, { type: 'conjunction' }).format(items);
  } catch {
    return items.join(', ');
  }
}

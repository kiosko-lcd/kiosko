/**
 * Plugin texts can be a plain string (shown as is) or a map by language.
 * The editor and the panel pick the user's locale (see `pickLocale`), then
 * English, then the first one available.
 *
 * Chinese goes by script: write `zh-Hant` (Taiwan, Hong Kong) and `zh-Hans`
 * (mainland China). `zh-TW` and `zh-CN` work too; a bare `zh` is read as
 * Simplified and never shown to someone who reads Traditional. The same
 * holds for any language written in two scripts (`sr-Latn`, `sr-Cyrl`).
 */
export type Localized = string | ({ en: string } & Partial<Record<string, string>>);

/** Old or other codes for the same language, as Intl leaves them. */
const ALIASES: Record<string, string> = { iw: 'he', in: 'id', ji: 'yi', tl: 'fil', no: 'nb', cmn: 'zh' };
/** Languages that read texts written for another one: Cantonese reads Chinese. */
const READS: Record<string, string> = { yue: 'zh', nn: 'nb' };

/**
 * A language tag as Intl understands it, or null: POSIX forms cleaned
 * (`zh_TW.UTF-8` → `zh-TW`, `sr_RS@latin` → `sr-Latn-RS`), old codes mapped
 * (`iw` → `he`), case fixed.
 */
export function parseLocale(tag: string | undefined): Intl.Locale | null {
  if (!tag) return null;
  let t = tag.trim();
  const latin = /@latin\b/i.test(t);
  t = t.replace(/[.@].*$/, '').replace(/_/g, '-');
  if (!t || t === 'C' || t === 'POSIX') return null;
  try {
    let l = new Intl.Locale(Intl.getCanonicalLocales(t)[0]!);
    const alias = ALIASES[l.language];
    if (alias) l = new Intl.Locale(alias, { ...(l.script ? { script: l.script } : {}), ...(l.region ? { region: l.region } : {}) });
    if (latin && !l.script) l = new Intl.Locale(l.language, { script: 'Latn', ...(l.region ? { region: l.region } : {}) });
    return l;
  } catch {
    return null;
  }
}

/** Latin American regions: they read `es-419` (or the Mexican variant) before Spain's. */
const LATAM = new Set(['419', 'AR', 'BO', 'CL', 'CO', 'CR', 'CU', 'DO', 'EC', 'GT', 'HN', 'MX', 'NI', 'PA', 'PE', 'PR', 'PY', 'SV', 'US', 'UY', 'VE']);
/** Portuguese outside Brazil reads Portugal's before Brazil's. */
const PT_PT = new Set(['PT', 'AO', 'MZ', 'CV', 'GW', 'ST', 'TL', 'MO', 'GQ', 'LU', 'CH']);

/**
 * The best of `available` (language tags, any case) for someone reading in
 * `locale`, or undefined if none fits (the caller falls back to English).
 *
 * The same language and the same script, never another script: a reader
 * of Traditional Chinese never gets Simplified (a bare `zh` is
 * Simplified), nor a reader of Serbian in Latin letters Cyrillic. Among
 * those: the exact tag, then the same region, then the region's usual
 * variant (`es-419`/`es-MX` for Latin America, `pt-PT` outside Brazil),
 * then the least specific one (`es` for `es-CL`), then any.
 */
export function pickLocale(available: readonly string[], locale: string | undefined): string | undefined {
  if (!locale || !available.length) return undefined;
  const exact = available.find((k) => k.toLowerCase() === locale.replace(/_/g, '-').toLowerCase());
  if (exact) return exact;
  const want = parseLocale(locale);
  if (!want) return undefined;
  const w = want.maximize();
  const lang = READS[w.language] ?? w.language;
  const fits = available
    .map((k) => ({ k, l: parseLocale(k) }))
    .filter((c): c is { k: string; l: Intl.Locale } => !!c.l)
    .map((c) => ({ ...c, m: c.l.maximize() }))
    .filter((c) => (READS[c.m.language] ?? c.m.language) === lang && c.m.script === w.script);
  if (!fits.length) return undefined;
  const same = (a: Intl.Locale, b: Intl.Locale) => a.baseName === b.baseName;
  const byTag = fits.find((c) => same(c.l, want));
  if (byTag) return byTag.k;
  if (w.region) {
    const byRegion = fits.find((c) => c.m.region === w.region && c.l.region);
    if (byRegion) return byRegion.k;
    const usual = (r: string) => (lang === 'es' && LATAM.has(w.region!) ? ['419', 'MX'].includes(r) : lang === 'pt' && PT_PT.has(w.region!) ? r === 'PT' : false);
    const variant = fits.find((c) => c.l.region && usual(c.l.region));
    if (variant) return variant.k;
  }
  // The least specific: `es` before `es-ES`, `zh-Hant` before `zh-TW`.
  const plain = [...fits].sort((a, b) => a.l.baseName.split('-').length - b.l.baseName.split('-').length);
  return plain[0]!.k;
}

/** Plural forms of a text, as Intl.PluralRules names them; `other` is required. */
export type PluralForms = Partial<Record<Intl.LDMLPluralRule, string>> & { other: string };

/**
 * `{n} files` in the user's language, with the plural form its rules ask
 * for (Polish has four, Chinese one): `forms` by language, `{n}` filled in
 * with the number written the language's way.
 */
export function plural(n: number, forms: Record<string, PluralForms>, locale = 'en'): string {
  const key = pickLocale(Object.keys(forms), locale) ?? (forms.en ? 'en' : Object.keys(forms)[0]!);
  const f = forms[key]!;
  let rule: Intl.LDMLPluralRule = 'other';
  try {
    rule = new Intl.PluralRules(key).select(n);
  } catch {
    /* an odd tag: other */
  }
  const text = f[rule] ?? f.other;
  let num = String(n);
  try {
    num = new Intl.NumberFormat(key).format(n);
  } catch {
    /* as is */
  }
  return text.replaceAll('{n}', num);
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
  const l = parseLocale(locale || 'en');
  if (!l) return null;
  const full = l.maximize();
  switch (READS[full.language] ?? full.language) {
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

/**
 * An error to show the user, in their language: `throw new PluginError({
 * en: 'Set your place in Settings', 'zh-Hant': '請在設定中設定位置', … })`.
 * Its `message` is the English one (logs); Kiosko shows `text` in the
 * user's language in the editor and on the tile.
 */
export class PluginError extends Error {
  readonly text: Localized;
  constructor(text: Localized, options?: { cause?: unknown }) {
    super(localize(text, 'en'), options);
    this.name = 'PluginError';
    this.text = text;
  }
}

/** What to show for an error: a PluginError's text in `locale`, else the message. */
export function errorMessage(err: unknown, locale = 'en'): string {
  if (err instanceof Error && 'text' in err && (err as PluginError).text !== undefined) return localize((err as PluginError).text, locale);
  return err instanceof Error ? err.message : String(err);
}

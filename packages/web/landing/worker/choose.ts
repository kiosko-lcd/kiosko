/**
 * Which language's front page a visit to `/` goes to, decided at Cloudflare's
 * edge before any page is sent (worker/index.ts). The same order as the
 * English page's own script (pages.mjs, `redirect`), which stays as the
 * fallback without the Worker:
 *
 *   1. the visitor's choice in the language menu (cookie `kiosko_lang`);
 *   2. the browser's languages (`Accept-Language`, by preference), the same
 *      language and writing: zh-TW reads zh-Hant, never zh-Hans;
 *   3. only if none of those is a language the site has: the country the visit
 *      comes from, where one language is clearly the one read there.
 *
 * `null`: stay on `/` (English, or nothing better known).
 */
import { LANGUAGES } from '../../../sdk/src/languages.ts';

/** Countries whose visitors, when their browser asks for none of the site's languages, read this one. */
const BY_COUNTRY: Record<string, string> = {
  // Spanish: Spain (also for browsers in Catalan, Basque or Galician), Andorra, Latin America, Equatorial Guinea.
  ...Object.fromEntries('ES AD MX AR CO CL PE VE EC GT CU BO DO HN PY SV NI CR PA UY PR GQ'.split(' ').map((c) => [c, 'es'])),
  // German: not Switzerland, Belgium nor Luxembourg, where a browser that isn't in German is more likely in French.
  DE: 'de', AT: 'de', LI: 'de',
  // Traditional Chinese: Taiwan, Hong Kong, Macau. Simplified: mainland China (Singapore reads English).
  TW: 'zh-Hant', HK: 'zh-Hant', MO: 'zh-Hant',
  CN: 'zh-Hans',
};

/** A language tag as language + writing (`zh-TW` → `zh-Hant`, `es-MX` → `es-Latn`); `null` if it isn't one. */
export function key(tag: string): string | null {
  try {
    const l = new Intl.Locale(tag.replace(/_/g, '-').replace(/[.@].*$/, '')).maximize();
    const lang = ({ yue: 'zh', cmn: 'zh', iw: 'he', no: 'nb' } as Record<string, string>)[l.language] ?? l.language;
    return `${lang}-${l.script}`;
  } catch {
    return null;
  }
}

const SITE_KEYS = LANGUAGES.map((l) => [l.id, key(l.id)] as const);

/** The site's language for a browser tag, if it has one. */
function site(tag: string): string | null {
  const k = key(tag);
  return (k && SITE_KEYS.find(([, s]) => s === k)?.[0]) ?? null;
}

/** `Accept-Language`, most wanted first (`q=0` and `*` left out). */
export function accepted(header: string | null): string[] {
  if (!header) return [];
  return header
    .split(',')
    .map((part, i) => {
      const [tag = '', ...params] = part.trim().split(';');
      const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
      return { tag: tag.trim(), q: q ? Number(q.slice(2)) : 1, i };
    })
    .filter((t) => t.tag && t.tag !== '*' && t.q > 0 && !Number.isNaN(t.q))
    .sort((a, b) => b.q - a.q || a.i - b.i)
    .map((t) => t.tag);
}

/** The value of the `kiosko_lang` cookie, if any. */
export function chosen(cookie: string | null): string | null {
  for (const part of (cookie ?? '').split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === COOKIE) return decodeURIComponent(value.join('='));
  }
  return null;
}

export const COOKIE = 'kiosko_lang';

export function choose(visit: { acceptLanguage: string | null; country: string | null; cookie: string | null }): string | null {
  const pick = chosen(visit.cookie);
  if (pick && LANGUAGES.some((l) => l.id === pick)) return pick === 'en' ? null : pick;
  for (const tag of accepted(visit.acceptLanguage)) {
    const id = site(tag);
    if (id) return id === 'en' ? null : id;
  }
  const byCountry = visit.country ? BY_COUNTRY[visit.country.toUpperCase()] : undefined;
  return byCountry && LANGUAGES.some((l) => l.id === byCountry) ? byCountry : null;
}

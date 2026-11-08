/**
 * On this day. A port of MMM-OnThisDay over Wikipedia's "selected
 * anniversaries" (its REST API, no key), in the user's language. One at a
 * time, changing every `changeMs`.
 */
import { defineWidget, t } from '@tessera/sdk';
import { clamp, isEs, USER_AGENT, within } from './util.ts';

export interface Ephemeris {
  year: number;
  text: string;
}

export interface OnThisDayData {
  /** `MM-DD` the list belongs to. */
  day: string;
  items: Ephemeris[];
}

/** Drops what only makes sense next to the photo on Wikipedia's front page. */
export function cleanText(t: string): string {
  return t
    .replace(/\s*\((?:en la )?imagen[^)]*\)|\s*\(pictured[^)]*\)/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The Wikipedia language to ask: the option, else the user's locale. */
export function wikiLang(option: string, locale: string): string {
  const o = option.trim().toLowerCase();
  if (/^[a-z]{2,3}$/.test(o)) return o;
  const l = locale.toLowerCase().split(/[-_]/)[0]!;
  return /^[a-z]{2,3}$/.test(l) ? l : 'en';
}

/** "53 years ago" / "hace 53 años". */
export function yearsAgo(n: number, locale: string): string {
  if (isEs(locale)) return `hace ${n} ${n === 1 ? 'año' : 'años'}`;
  return `${n} ${n === 1 ? 'year' : 'years'} ago`;
}

const DEMO: Ephemeris[] = [
  { year: 1605, text: 'The Gunpowder Plot is foiled when Guy Fawkes is arrested in the cellars beneath the House of Lords in London.' },
  { year: 1872, text: 'Women\'s suffrage campaigner Susan B. Anthony votes in the United States presidential election, for which she is later fined.' },
  { year: 1940, text: 'Franklin D. Roosevelt becomes the first president of the United States to be elected to a third term.' },
];

export const onthisday = defineWidget({
  id: 'onthisday',
  name: { en: 'On this day', es: 'Tal día como hoy' },
  description: { en: 'Selected anniversaries of today from Wikipedia, one at a time.', es: 'Efemérides de hoy seleccionadas por la Wikipedia, una a una.' },
  icon: 'landmark',
  category: 'info',
  tags: ['magicmirror', 'history', 'wikipedia'],
  size: { min: { w: 240, h: 120 }, preferred: { w: 600, h: 220 } },
  options: t.object({
    lang: t.string({ placeholder: 'en', maxLength: 3, label: { en: 'Wikipedia language', es: 'Idioma de la Wikipedia' }, help: { en: 'A code such as en, es, de; empty = yours. Not every edition has this feed.', es: 'Un código como es, en, de; vacío = el tuyo. No todas las ediciones tienen esta sección.' } }),
    changeMs: t.duration({ default: 10 * 60_000, min: 60_000, label: { en: 'Change every', es: 'Cambia cada' } }),
  }),
  intervalMs: 3 * 3600_000,
  redraw: 'minute',
  async fetch({ options, now, locale, signal }): Promise<OnThisDayData> {
    const d = new Date(now);
    const mm = String(d.getMonth() + 1).padStart(2, '0'), dd = String(d.getDate()).padStart(2, '0');
    const res = await fetch(`https://${wikiLang(options.lang, locale)}.wikipedia.org/api/rest_v1/feed/onthisday/selected/${mm}/${dd}`, {
      headers: { 'User-Agent': USER_AGENT },
      signal: within(signal, 10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as { selected?: { year?: number; text?: string }[] };
    const items = (json.selected ?? []).filter((e) => typeof e.year === 'number' && e.text).map((e) => ({ year: e.year!, text: cleanText(e.text!) }));
    return { day: `${mm}-${dd}`, items };
  },
  visible: ({ data }) => Boolean(data?.items.length),
  render(g, { options, data, now, box, theme, kit, locale }) {
    if (!data?.items.length) return;
    const { colors, fonts } = theme;
    const e = data.items[Math.floor(now / Math.max(60_000, options.changeMs)) % data.items.length]!;
    const yearSize = Math.round(clamp(box.h * 0.24, 18, 64));
    const yw = kit.drawTracked(g, String(e.year), box.x, box.y + yearSize * 0.85, { size: yearSize, family: fonts.sansBold, color: colors.info });
    const ago = new Date(now).getFullYear() - e.year;
    if (ago > 0) {
      const s = Math.round(yearSize * 0.42);
      kit.drawTracked(g, kit.truncate(g, yearsAgo(ago, locale), box.w - yw - s, { size: s, family: fonts.sans }), box.x + yw + s * 0.6, box.y + yearSize * 0.82, { size: s, family: fonts.sans, color: colors.inkDim });
    }
    const top = box.y + yearSize * 1.25;
    const room = box.y + box.h - top;
    // The largest size at which the whole text fits the rest of the card.
    let size = Math.round(clamp(yearSize * 0.68, 12, 42));
    let lines: string[] = [];
    for (; size >= 11; size -= 1) {
      lines = kit.wrapLines(g, e.text, box.w, Math.max(1, Math.floor(room / (size * 1.22))), { size, family: fonts.sans });
      if (!lines.at(-1)?.endsWith('…')) break;
    }
    lines.forEach((l, i) => kit.drawTracked(g, l, box.x, top + size * 0.92 + i * size * 1.22, { size, family: fonts.sans, color: colors.ink }));
  },
  demo: ({ now }) => {
    const d = new Date(now);
    return { data: { day: `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`, items: DEMO } };
  },
});

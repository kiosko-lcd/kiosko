/**
 * The sample config (examples/showcase.json) as a reader of another language
 * sees it: in the gallery's posters, the browser demo and the front page.
 * The showcase is written in English (the README's pictures); elsewhere its
 * hand-written titles give way to the widgets' own names, which are
 * translated, the pages get their names in the language, and the place is
 * one its readers know.
 */
import { LANGUAGE_IDS, languageById, pickLocale } from '@kiosko/sdk';
import type { Config } from './model.ts';

/** The showcase's page names in each language Kiosko speaks (a test checks every language has them). */
export const SAMPLE_PAGE_NAMES: Record<string, Record<string, string>> = {
  Dashboard: { en: 'Dashboard', de: 'Übersicht', es: 'Panel', 'zh-Hant': '總覽', 'zh-Hans': '总览' },
  Cats: { en: 'Cats', de: 'Katzen', es: 'Gatos', 'zh-Hant': '貓咪', 'zh-Hans': '本地模型' },
  News: { en: 'News', de: 'Nachrichten', es: 'Noticias', 'zh-Hant': '新聞', 'zh-Hans': '新闻' },
  Home: { en: 'Home', de: 'Zuhause', es: 'Casa', 'zh-Hant': '居家', 'zh-Hans': '家居' },
};

/** Sample places by language: where the weather, the sun and the earthquakes are for. */
export const SAMPLE_PLACES: Record<string, { latitude: number; longitude: number; name: string }> = {
  de: { latitude: 52.52, longitude: 13.405, name: 'Berlin' },
  'zh-Hant': { latitude: 25.033, longitude: 121.5654, name: '台北' },
  'zh-Hans': { latitude: 31.2304, longitude: 121.4737, name: '上海' },
};

/** `cfg` for a reader of `locale`: unchanged in English. */
export function localizeSample<C extends Partial<Config>>(cfg: C, locale: string): C {
  const lang = pickLocale(LANGUAGE_IDS, locale) ?? 'en';
  if (lang === 'en') return cfg;
  const place = SAMPLE_PLACES[lang];
  const market = languageById(lang)?.plugins;
  const instead = market?.instead;
  return {
    ...cfg,
    // Nor are those plugins offered there: not in the library nor in the templates.
    ...(market ? { plugins: { ...cfg.plugins, disabled: [...new Set([...(cfg.plugins?.disabled ?? []), ...market.without])] } } : {}),
    ...(place ? { location: place } : {}),
    screens: (cfg.screens ?? []).map((s) => ({
      ...s,
      pages: s.pages.map((p) => ({
        ...p,
        name: SAMPLE_PAGE_NAMES[p.name]?.[lang] ?? p.name,
        // Widgets whose service is not offered where the language is read give way to others (languages.ts).
        tiles: p.tiles.map((t) => ({ ...t, widgets: t.widgets.map(({ title: _title, ...w }) => (instead?.[w.type] ? { ...w, type: instead[w.type]!, options: {} } : w)) })),
      })),
    })),
  };
}

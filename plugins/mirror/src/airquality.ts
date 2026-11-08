/**
 * Air quality and pollen. A port of MMM-AirQuality over Open-Meteo's air
 * quality API (no key): the European index (EAQI) with its category, the
 * particles and gases, and whatever pollen is in the air. Pollen comes from
 * the Copernicus models, in Europe and in season only; its levels (low,
 * moderate, high) are a rough guide.
 */
import { defineWidget, t, type Localized } from '@tessera/sdk';
import { clamp, fmt, isEs, NO_PLACE, placeFields, placeFor, within } from './util.ts';

export const POLLEN = {
  grass_pollen: { en: 'Grass', es: 'Gramíneas' },
  olive_pollen: { en: 'Olive', es: 'Olivo' },
  birch_pollen: { en: 'Birch', es: 'Abedul' },
  alder_pollen: { en: 'Alder', es: 'Aliso' },
  mugwort_pollen: { en: 'Mugwort', es: 'Artemisa' },
  ragweed_pollen: { en: 'Ragweed', es: 'Ambrosía' },
} as const satisfies Record<string, Localized>;
export type PollenKey = keyof typeof POLLEN;

export interface AirData {
  aqi: number;
  pm2_5: number;
  pm10: number;
  ozone: number;
  no2: number;
  pollen: Partial<Record<PollenKey, number>>;
}

/** The bands of the European index; Spanish names as the MITECO uses them. */
const BANDS: { max: number; label: Localized }[] = [
  { max: 20, label: { en: 'Good', es: 'Buena' } },
  { max: 40, label: { en: 'Fair', es: 'Razonablemente buena' } },
  { max: 60, label: { en: 'Moderate', es: 'Regular' } },
  { max: 80, label: { en: 'Poor', es: 'Desfavorable' } },
  { max: 100, label: { en: 'Very poor', es: 'Muy desfavorable' } },
  { max: Infinity, label: { en: 'Extremely poor', es: 'Extremadamente desfavorable' } },
];

export function aqiCategory(aqi: number): { label: Localized; level: 0 | 1 | 2 | 3 | 4 | 5 } {
  const i = BANDS.findIndex((b) => aqi <= b.max);
  return { label: BANDS[i]!.label, level: i as 0 | 1 | 2 | 3 | 4 | 5 };
}

/** Rough pollen level, in grains per m³. */
export function pollenLevel(grains: number): 'low' | 'moderate' | 'high' {
  return grains < 10 ? 'low' : grains < 50 ? 'moderate' : 'high';
}

const LEVEL_NAME: Record<ReturnType<typeof pollenLevel>, Localized> = {
  low: { en: 'low', es: 'bajo' },
  moderate: { en: 'moderate', es: 'moderado' },
  high: { en: 'high', es: 'alto' },
};

/** The EAQI's own colour scale, from green to purple. */
const LEVEL_COLOR = ['#3FCB7E', '#9BD45A', '#FFB020', '#FF8A3D', '#F5453D', '#B05CFF'];

/** Open-Meteo's `current` block → our data. */
export function parseAir(current: Record<string, number | null | undefined>): AirData {
  const pollen: AirData['pollen'] = {};
  for (const k of Object.keys(POLLEN) as PollenKey[]) if ((current[k] ?? 0) > 0) pollen[k] = current[k]!;
  return { aqi: Math.round(current.european_aqi ?? 0), pm2_5: current.pm2_5 ?? 0, pm10: current.pm10 ?? 0, ozone: current.ozone ?? 0, no2: current.nitrogen_dioxide ?? 0, pollen };
}

const DEMO: AirData = { aqi: 34, pm2_5: 8.2, pm10: 17.4, ozone: 61, no2: 12.6, pollen: { olive_pollen: 22, grass_pollen: 6.5 } };

export const airquality = defineWidget({
  id: 'airquality',
  name: { en: 'Air quality', es: 'Calidad del aire' },
  description: { en: 'European air quality index, particles, gases and pollen where you are (Open-Meteo).', es: 'Índice europeo de calidad del aire, partículas, gases y polen donde estás (Open-Meteo).' },
  icon: 'wind',
  category: 'info',
  tags: ['magicmirror', 'weather', 'pollen'],
  size: { min: { w: 240, h: 130 }, preferred: { w: 400, h: 300 } },
  options: t.object({
    pollen: t.boolean({ default: true, label: { en: 'Show pollen', es: 'Mostrar el polen' } }),
    ...placeFields(),
  }),
  intervalMs: 30 * 60_000,
  async fetch({ options, location, signal }): Promise<AirData> {
    const at = placeFor(options, location);
    if (!at) throw new Error(NO_PLACE);
    const vars = ['european_aqi', 'pm10', 'pm2_5', 'ozone', 'nitrogen_dioxide', ...Object.keys(POLLEN)].join(',');
    const res = await fetch(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${at.latitude}&longitude=${at.longitude}&current=${vars}&timezone=auto`, { signal: within(signal, 10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parseAir(((await res.json()) as { current?: Record<string, number | null> }).current ?? {});
  },
  render(g, { data, box, theme, kit, t: tr, locale, options }) {
    if (!data) return;
    const { colors, fonts } = theme;
    const cat = aqiCategory(data.aqi);
    const col = LEVEL_COLOR[cat.level]!;
    const label = tr(cat.label);
    const gases: [string, number][] = [[isEs(locale) ? 'PM2,5' : 'PM2.5', data.pm2_5], ['PM10', data.pm10], ['O₃', data.ozone], ['NO₂', data.no2]];
    const pollen = (Object.entries(data.pollen) as [PollenKey, number][]).sort((a, b) => b[1] - a[1]);

    /** Pollen as name over level, left to right, as many as fit in `w`. */
    const drawPollen = (x0: number, y: number, w: number, ps: number, vertical: boolean) => {
      if (!pollen.length) {
        const msg = tr({ en: 'No pollen in the air', es: 'Sin polen en el aire' });
        kit.drawTracked(g, kit.truncate(g, msg, w, { size: ps, family: fonts.sans }), x0, y, { size: ps, family: fonts.sans, color: colors.inkDim });
        return;
      }
      let px = x0, py = y;
      for (const [key, v] of pollen.slice(0, 4)) {
        const lvl = pollenLevel(v);
        const lc = lvl === 'high' ? colors.alert : lvl === 'moderate' ? colors.warn : colors.ok;
        const name = tr(POLLEN[key]), lvlText = tr(LEVEL_NAME[lvl]);
        const ls = Math.round(ps * 0.8);
        if (vertical) {
          if (py > box.y + box.h + 1) break;
          const nw = kit.drawTracked(g, kit.truncate(g, name, w, { size: ps, family: fonts.sans }), px, py, { size: ps, family: fonts.sans, color: colors.ink });
          if (nw + ps * 0.4 + kit.measureTracked(g, lvlText, { size: ls, family: fonts.sans }) <= w) kit.drawTracked(g, lvlText, px + nw + ps * 0.4, py, { size: ls, family: fonts.sans, color: lc });
          py += ps * 1.3;
          continue;
        }
        const need = Math.max(kit.measureTracked(g, name, { size: ps, family: fonts.sans }), kit.measureTracked(g, lvlText, { size: ls, family: fonts.sans }));
        if (px + need > x0 + w) break;
        kit.drawTracked(g, name, px, py, { size: ps, family: fonts.sans, color: colors.ink });
        kit.drawTracked(g, lvlText, px, py + ps * 1.1, { size: ls, family: fonts.sans, color: lc });
        px += need + ps;
      }
    };

    if (box.w >= 440 && box.w >= box.h * 2.2) {
      // Wide and short: index | gases (2 × 2) | pollen, side by side.
      const k = clamp(box.h / 150, 0.5, 1.6);
      const colW = box.w / (options.pollen ? 3.1 : 2.2);
      const big = Math.round(Math.min(box.h * 0.62, colW * 0.5));
      const w = kit.drawTracked(g, String(data.aqi), box.x, box.y + big * 0.86, { size: big, family: fonts.sansBold, color: col });
      kit.drawTracked(g, 'EAQI', box.x + w + 10 * k, box.y + big * 0.4, { size: Math.round(20 * k), family: fonts.sans, color: colors.inkDim });
      const ls = kit.fitSize(g, label, colW - 8, { size: Math.round(28 * k), family: fonts.sans }, Math.round(14 * k));
      kit.drawTracked(g, kit.truncate(g, label, colW - 8, { size: ls, family: fonts.sans }), box.x, box.y + big * 0.86 + ls * 1.4, { size: ls, family: fonts.sans, color: col });
      const gx0 = box.x + colW, gw = colW * 0.55;
      const vs = Math.round(clamp(box.h * 0.24, 14, 44)), us = Math.round(vs * 0.42);
      gases.forEach(([name, v], i) => {
        const gx = gx0 + (i % 2) * gw, gy = box.y + vs * 0.9 + Math.floor(i / 2) * (box.h / 2);
        kit.drawTracked(g, fmt(Math.round(v), locale), gx, gy, { size: vs, family: fonts.sans, color: colors.ink });
        kit.drawTracked(g, `${name} µg/m³`, gx, gy + us * 1.3, { size: us, family: fonts.sans, color: colors.inkDim });
      });
      if (options.pollen) drawPollen(gx0 + 2 * gw + 8 * k, box.y + vs * 0.7, box.x + box.w - (gx0 + 2 * gw + 8 * k), Math.round(clamp(box.h * 0.17, 12, 30)), true);
      return;
    }

    // Stacked: everything scales from one unit (reference layout 368 × 290).
    const k1 = Math.min(box.w / 368, box.h / 290);
    const withPollen = options.pollen && k1 >= 0.6;
    const k = clamp(withPollen ? k1 : Math.min(box.w / 368, box.h / 200), 0.35, 1.6);
    const big = Math.round(100 * k);
    const top = box.y + big * 0.86;
    const w = kit.drawTracked(g, String(data.aqi), box.x, top, { size: big, family: fonts.sansBold, color: col });
    const gap = 14 * k;
    kit.drawTracked(g, 'EAQI', box.x + w + gap, top - big * 0.5, { size: Math.round(24 * k), family: fonts.sans, color: colors.inkDim });
    const ls = kit.fitSize(g, label, box.w - w - gap, { size: Math.round(34 * k), family: fonts.sans }, Math.round(20 * k));
    kit.drawTracked(g, kit.truncate(g, label, box.w - w - gap, { size: ls, family: fonts.sans }), box.x + w + gap, top, { size: ls, family: fonts.sans, color: col });

    const gw = box.w / gases.length;
    const gy = top + 72 * k;
    const unitSize = Math.round(clamp(18 * k, 10, 26));
    gases.forEach(([name, v], i) => {
      const gx = box.x + i * gw;
      kit.drawTracked(g, fmt(Math.round(v), locale), gx, gy, { size: Math.round(44 * k), family: fonts.sans, color: colors.ink });
      kit.drawTracked(g, kit.truncate(g, name, gw - 4, { size: unitSize, family: fonts.sans }), gx, gy + 26 * k, { size: unitSize, family: fonts.sans, color: colors.inkDim });
    });
    kit.drawTracked(g, 'µg/m³', box.x + box.w, gy + 26 * k + unitSize * 1.1, { size: Math.round(unitSize * 0.85), family: fonts.sans, color: colors.inkFaint, align: 'right' });
    if (withPollen) drawPollen(box.x, gy + 88 * k, box.w, Math.round(30 * k), false);
  },
  demo: () => ({ data: DEMO }),
});

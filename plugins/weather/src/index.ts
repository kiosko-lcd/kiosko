/**
 * The weather: one shared source (Open-Meteo, no API key) that any widget can
 * ask for as `weather/current` (the cats' window, the news corner…), and a
 * forecast card that adapts to its tile.
 *
 * The source keeps its last good reading on disk: an outage of the network
 * shouldn't blank the panel, and a restart shouldn't wait for the first read.
 * Readings older than six hours are dropped (see `loadWeather`).
 */
import { join } from 'node:path';
import { fetchWeather, loadWeather, saveWeather, type Weather } from '@loksly/weather-astro';
import { definePlugin, defineSource, defineWidget, t, type Box } from '@tessera/sdk';
import { demoWeather } from './demo.ts';
import { drawDays, drawHourly, drawMoon, drawNow, drawTiny, rule, type Painter } from './draw.ts';

export { demoWeather };

const TIMEOUT_MS = 15_000;

export const current = defineSource({
  id: 'current',
  name: { en: 'Current weather', es: 'Tiempo actual' },
  description: {
    en: 'Now and the next hours and days, from Open-Meteo (no key needed), for your location or the place set here.',
    es: 'Ahora y las próximas horas y días, de Open-Meteo (sin clave), para tu ubicación o el sitio que pongas aquí.',
  },
  options: t.object({
    name: t.string({ label: { en: 'Place name', es: 'Nombre del sitio' }, placeholder: 'Madrid', help: { en: 'Empty: the one in Settings.', es: 'Vacío: el de Ajustes.' } }),
    latitude: t.number({ default: 0, min: -90, max: 90, step: 0.0001, label: { en: 'Latitude', es: 'Latitud' }, help: { en: '0 and 0: use the location in Settings.', es: '0 y 0: usa la ubicación de Ajustes.' } }),
    longitude: t.number({ default: 0, min: -180, max: 180, step: 0.0001, label: { en: 'Longitude', es: 'Longitud' } }),
  }),
  intervalMs: 15 * 60_000,
  async read(ctx): Promise<Weather> {
    const { options: o, location } = ctx;
    const own = o.latitude !== 0 || o.longitude !== 0;
    const lat = own ? o.latitude : location?.latitude;
    const lon = own ? o.longitude : location?.longitude;
    if (lat === undefined || lon === undefined) throw new Error('no place: set your location in Settings or latitude/longitude in this source');
    const name = o.name.trim() || (own ? '' : location?.name) || `${lat.toFixed(2)}, ${lon.toFixed(2)}`;
    const file = join(ctx.dataDir, `weather-${lat.toFixed(3)}_${lon.toFixed(3)}.json`);
    const fresh = await fetchWeather({ name, latitude: lat, longitude: lon }, TIMEOUT_MS, ctx.log);
    if (fresh) {
      try {
        saveWeather(file, fresh);
      } catch (err) {
        ctx.log(`could not keep the reading: ${err instanceof Error ? err.message : String(err)}`);
      }
      return fresh;
    }
    const last = loadWeather(file, ctx.now);
    if (last) return last;
    throw new Error('Open-Meteo did not answer and there is no recent reading on disk');
  },
  demo: ({ now }) => demoWeather(now),
});

export const forecast = defineWidget({
  id: 'forecast',
  name: { en: 'Weather forecast', es: 'Previsión del tiempo' },
  description: {
    en: 'Temperature and sky now, the next hours (temperature curve and rain) and days, and the moon when there is room.',
    es: 'Temperatura y cielo ahora, las próximas horas (curva de temperatura y lluvia) y días, y la luna si hay sitio.',
  },
  icon: 'cloud-sun',
  category: 'info',
  tags: ['weather', 'tiempo', 'forecast', 'moon'],
  size: { min: { w: 120, h: 70 }, preferred: { w: 900, h: 300 } },
  options: t.object({
    hours: t.boolean({ default: true, label: { en: 'Next hours', es: 'Próximas horas' } }),
    days: t.boolean({ default: true, label: { en: 'Next days', es: 'Próximos días' } }),
    moon: t.boolean({ default: true, label: { en: 'Moon phase', es: 'Fase de la luna' }, help: { en: 'Only on wide tiles.', es: 'Sólo en teselas anchas.' } }),
  }),
  sources: ['weather/current'],
  redraw: 'never',
  render(g, ctx) {
    const { box, theme, kit, options } = ctx;
    const w = ctx.sources['weather/current'] as Weather | undefined;
    const p: Painter = { g, kit, theme, t: ctx.t, locale: ctx.locale, now: ctx.now };
    if (!w) {
      const size = Math.max(10, Math.min(24, box.h / 5));
      const msg = ctx.t({ en: 'No weather yet', es: 'Aún sin datos del tiempo' });
      kit.drawTracked(g, kit.truncate(g, msg, box.w, { size, family: theme.fonts.sans }), box.x + box.w / 2, box.y + box.h / 2 + size * 0.35, { size, family: theme.fonts.sans, color: theme.colors.inkFaint, align: 'center' });
      return;
    }
    if (box.w < 200 || box.h < 90) return drawTiny(p, w, box);

    const gap = Math.round(Math.max(8, Math.min(22, box.h * 0.05)));
    const hasHours = options.hours && w.hours.length >= 2;
    const hasDays = options.days && w.days.length > 0;
    if (box.w >= box.h * 2) {
      // Wide: blocks side by side, left to right: now, moon, hours, days.
      const nowW = Math.min(box.w * 0.45, Math.max(220, Math.min(460, box.h * 1.15)));
      let rest = box.w - nowW - gap;
      const daysW = hasDays && (rest >= 780 || (!hasHours && rest >= 160)) ? Math.min(hasHours ? 320 : rest, Math.max(200, rest * 0.25)) : 0;
      if (daysW) rest -= daysW + gap;
      const moonW = options.moon && box.h >= 160 && rest >= 900 ? Math.max(150, Math.min(220, box.h * 0.6)) : 0;
      if (moonW) rest -= moonW + gap;
      const chart = hasHours && rest >= 240 && box.h >= 100;
      drawNow(p, w, { x: box.x, y: box.y, w: nowW, h: box.h });
      let x = box.x + nowW + gap;
      const sep = () => rule(p, x - gap / 2, box.y + box.h * 0.08, box.y + box.h * 0.92);
      if (moonW) {
        sep();
        drawMoon(p, { x, y: box.y, w: moonW, h: box.h });
        x += moonW + gap;
      }
      if (chart) {
        sep();
        drawHourly(p, w.hours, { x: x + gap * 0.5, y: box.y, w: rest - gap * 0.5, h: box.h });
        x += rest + gap;
      }
      if (daysW) {
        sep();
        drawDays(p, w.days, { x: x + gap * 0.5, y: box.y + box.h * 0.04, w: daysW - gap * 0.5, h: box.h * 0.92 });
      }
      return;
    }
    // Stacked: now on top (with the days beside it if there's width), the hours below.
    const topH = Math.max(80, Math.min(180, box.h * 0.42));
    const below = box.h - topH - gap;
    const sideDays = hasDays && box.w >= 480;
    const daysW = sideDays ? Math.max(180, Math.min(320, box.w * 0.42)) : 0;
    const top: Box = { x: box.x, y: box.y, w: box.w - (daysW ? daysW + gap : 0), h: below >= 60 ? topH : box.h };
    drawNow(p, w, top);
    if (daysW) {
      rule(p, box.x + top.w + gap / 2, top.y + top.h * 0.1, top.y + top.h * 0.9);
      drawDays(p, w.days, { x: box.x + box.w - daysW + gap / 2, y: top.y, w: daysW - gap / 2, h: top.h });
    }
    if (below < 60) return;
    const area: Box = { x: box.x, y: box.y + topH + gap, w: box.w, h: below };
    if (hasHours && below >= 110) drawHourly(p, w.hours, area);
    else if (hasDays && !daysW) drawDays(p, w.days, area);
  },
  demo: ({ now }) => ({ sources: { 'weather/current': demoWeather(now) } }),
});

export default definePlugin({
  id: 'weather',
  name: { en: 'Weather', es: 'El tiempo' },
  version: '0.1.0',
  description: { en: 'Weather from Open-Meteo, shared with every widget, and a forecast card.', es: 'El tiempo de Open-Meteo, compartido con todos los widgets, y una tarjeta de previsión.' },
  author: 'Tessera',
  license: 'MIT',
  icon: 'cloud-sun',
  sources: [current],
  widgets: [forecast],
});

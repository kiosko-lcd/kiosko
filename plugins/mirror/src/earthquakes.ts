/**
 * Earthquakes nearby. Inspired by MMM-EarthquakeAlerts, over the EMSC FDSN
 * service (no key), which also collects the small ones that national feeds
 * often leave out.
 *
 * On the left, a polar map with home at the centre and every quake at its
 * distance and bearing, bigger the stronger and brighter the more recent; on
 * the right, the latest ones with magnitude, where (the nearest town, from
 * OpenStreetMap) and when.
 */
import { defineWidget, t } from '@tessera/sdk';
import { clamp, fmt, isEs, NO_PLACE, placeFields, placeFor, USER_AGENT, within } from './util.ts';

export interface Quake {
  id: string;
  time: number;
  mag: number;
  lat: number;
  lon: number;
  depth: number;
  km: number;
  bearing: number;
  place: string | null;
}

export interface QuakesData {
  quakes: Quake[];
  radiusKm: number;
}

const R = 6371;
const rad = (d: number) => (d * Math.PI) / 180;

/** Distance (km) and bearing (degrees from north) from `a` to `b`. */
export function distanceBearing(a: { lat: number; lon: number }, b: { lat: number; lon: number }): { km: number; bearing: number } {
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  const km = 2 * R * Math.asin(Math.sqrt(h));
  const y = Math.sin(dLon) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(dLon);
  return { km, bearing: ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360 };
}

/** "N", "NE", "SW"… (Spanish uses O for west: "SO", "NO"). */
export function compass(bearing: number, locale = 'en'): string {
  const es = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
  const en = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return (isEs(locale) ? es : en)[Math.round(bearing / 45) % 8]!;
}

/** "20 min ago", "5 h ago", "3 d ago" (or "hace 20 min"…). */
export function ago(ms: number, locale = 'en'): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  const h = Math.round(min / 60);
  const v = min < 60 ? `${min} min` : h < 48 ? `${h} h` : `${Math.round(h / 24)} d`;
  return isEs(locale) ? `hace ${v}` : `${v} ago`;
}

interface EmscFeature {
  id: string;
  properties: { time: string; mag: number; lat: number; lon: number; depth: number };
}

/** EMSC's, with distance and bearing from home, newest first. */
export function parseEmsc(json: { features?: EmscFeature[] }, home: { lat: number; lon: number }): Quake[] {
  return (json.features ?? [])
    .map((f) => {
      const p = f.properties;
      return { id: f.id, time: Date.parse(p.time), mag: p.mag, lat: p.lat, lon: p.lon, depth: Math.abs(p.depth), ...distanceBearing(home, p), place: null };
    })
    .filter((q) => Number.isFinite(q.time) && Number.isFinite(q.mag))
    .sort((a, b) => b.time - a.time);
}

/** Names already looked up, by rounded coordinates (Nominatim asks for at most one query per second). */
const names = new Map<string, string | null>();

async function placeName(lat: number, lon: number, locale: string, signal: AbortSignal): Promise<string | null> {
  const lang = locale.split(/[-_]/)[0] || 'en';
  const key = `${lang}:${lat.toFixed(2)},${lon.toFixed(2)}`;
  if (names.has(key)) return names.get(key)!;
  await new Promise((r) => setTimeout(r, 1100));
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=10&accept-language=${lang}`, {
      headers: { 'User-Agent': USER_AGENT },
      signal: within(signal, 10_000),
    });
    if (!res.ok) return null; // Not cached: retried on the next round.
    const j = (await res.json()) as { name?: string; error?: string; address?: Record<string, string> };
    const a = j.address ?? {};
    const name = j.error ? (isEs(locale) ? 'en el mar' : 'at sea') : (a.village ?? a.town ?? a.city ?? a.municipality ?? j.name ?? null);
    if (names.size > 500) names.clear();
    names.set(key, name);
    return name;
  } catch {
    return null;
  }
}

/** Colour by magnitude: what nobody feels, what you feel and what scares. */
function magColor(mag: number, colors: { inkDim: string; info: string; warn: string; alert: string }): string {
  return mag >= 4 ? colors.alert : mag >= 3 ? colors.warn : mag >= 2.5 ? colors.info : colors.inkDim;
}

export const earthquakes = defineWidget({
  id: 'earthquakes',
  name: { en: 'Earthquakes nearby', es: 'Terremotos cercanos' },
  description: {
    en: 'Recent earthquakes around you (EMSC) on a polar map, with magnitude, place and time. Hidden when there are none.',
    es: 'Los terremotos recientes a tu alrededor (EMSC) en un mapa polar, con magnitud, lugar y hora. Se oculta si no hay ninguno.',
  },
  icon: 'activity',
  category: 'info',
  tags: ['magicmirror', 'seismic'],
  size: { min: { w: 280, h: 140 }, preferred: { w: 600, h: 300 } },
  options: t.object({
    radiusKm: t.integer({ default: 150, min: 20, max: 2000, step: 10, unit: 'km', label: { en: 'Radius', es: 'Radio' } }),
    days: t.integer({ default: 30, min: 1, max: 365, unit: 'd', label: { en: 'Days back', es: 'Días hacia atrás' } }),
    minMagnitude: t.number({ default: 1.5, min: 0, max: 9, step: 0.1, label: { en: 'Minimum magnitude', es: 'Magnitud mínima' } }),
    rows: t.integer({ default: 4, min: 1, max: 8, label: { en: 'Rows in the list', es: 'Filas de la lista' } }),
    ...placeFields(),
  }),
  intervalMs: 15 * 60_000,
  redraw: 'minute',
  async fetch({ options, now, location, locale, signal }): Promise<QuakesData> {
    const at = placeFor(options, location);
    if (!at) throw new Error(NO_PLACE);
    const home = { lat: at.latitude, lon: at.longitude };
    const start = new Date(now - options.days * 86_400_000).toISOString().slice(0, 19);
    const url = `https://www.seismicportal.eu/fdsnws/event/1/query?format=json&lat=${home.lat}&lon=${home.lon}&maxradius=${(options.radiusKm / 111.2).toFixed(3)}&minmag=${options.minMagnitude}&start=${start}&limit=200`;
    const res = await fetch(url, { signal: within(signal, 15_000) });
    // With none in the window, FDSN answers 204.
    if (res.status === 204) return { quakes: [], radiusKm: options.radiusKm };
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const quakes = parseEmsc((await res.json()) as { features?: EmscFeature[] }, home);
    for (const q of quakes.slice(0, options.rows)) q.place = await placeName(q.lat, q.lon, locale, signal);
    return { quakes, radiusKm: options.radiusKm };
  },
  visible: ({ data }) => Boolean(data?.quakes.length),
  render(g, { options, data, now, box, theme, kit, locale, t: tr }) {
    if (!data?.quakes.length) return;
    const { colors, fonts } = theme;
    const { quakes, radiusKm } = data;
    const maxAge = options.days * 86_400_000;
    const mag = (m: number) => fmt(m, locale, 1);

    // Map beside the list on wide tiles, above it on tall ones, left out
    // when there's no room for both.
    let list = { ...box };
    let map: { cx: number; cy: number; r: number } | null = null;
    const ns = Math.round(clamp(Math.min(box.w, box.h) * 0.05, 10, 16));
    const side = Math.min(box.h, 300, box.w * 0.42);
    if (box.h >= box.w * 0.9) {
      const d = Math.min(box.w, box.h * 0.48);
      if (d > 90) {
        map = { cx: box.x + box.w / 2, cy: box.y + d / 2 + ns / 2, r: d / 2 - ns / 2 - 2 };
        const ly = box.y + d + 10;
        list = { x: box.x, y: ly, w: box.w, h: box.y + box.h - ly };
      }
    } else if (box.w - side > 200 && side > 70) {
      map = { cx: box.x + side / 2, cy: box.y + box.h / 2 + ns / 2, r: Math.min(side / 2, (box.h - ns) / 2) - 3 };
      const lx = box.x + side + clamp(side * 0.1, 12, 28);
      list = { x: lx, y: box.y, w: box.x + box.w - lx, h: box.h };
    }
    if (map) {
      const { cx, cy, r } = map;
      g.strokeStyle = colors.surfaceEdge;
      g.lineWidth = 1;
      // A ring every 50 km, or every quarter of the radius when that's too many.
      const step = radiusKm / 50 <= 6 ? 50 : radiusKm / 4;
      for (let km = step; km <= radiusKm + 0.1; km += step) {
        g.beginPath();
        g.arc(cx, cy, (r * km) / radiusKm, 0, Math.PI * 2);
        g.stroke();
      }
      kit.drawTracked(g, 'N', cx, cy - r - 2, { size: ns, family: fonts.sans, color: colors.inkFaint, align: 'center' });
      // Old ones first, so the recent ones end up on top.
      const dot = r / 146;
      for (const q of [...quakes].reverse()) {
        const d = (r * Math.min(q.km, radiusKm)) / radiusKm;
        const a = rad(q.bearing);
        const fresh = 1 - Math.min(1, (now - q.time) / maxAge);
        g.globalAlpha = 0.25 + 0.75 * fresh;
        g.fillStyle = magColor(q.mag, colors);
        g.beginPath();
        g.arc(cx + d * Math.sin(a), cy - d * Math.cos(a), Math.max(1.5, (2 + (q.mag - 1) * 3.5) * dot), 0, Math.PI * 2);
        g.fill();
      }
      g.globalAlpha = 1;
      g.fillStyle = colors.ink;
      g.fillRect(cx - 3, cy - 3, 6, 6);
    }

    // List: the latest, with magnitude, place, distance and when.
    const more = quakes.length > options.rows;
    const footer = more ? Math.round(clamp(list.h * 0.09, 11, 22)) : 0;
    const avail = list.h - footer * 1.4;
    const rows = Math.max(1, Math.min(options.rows, Math.floor(avail / 30)));
    const rowH = Math.min(72, avail / rows);
    const ms = Math.round(Math.min(rowH * 0.55, 40)), ps = Math.round(Math.min(rowH * 0.4, 28)), meta = Math.round(clamp(rowH * 0.28, 10, 20));
    const magW = kit.measureTracked(g, mag(8.8), { size: ms, family: fonts.sansBold });
    const shown = quakes.slice(0, rows);
    shown.forEach((q, i) => {
      const y = list.y + i * rowH + rowH * 0.62;
      const col = magColor(q.mag, colors);
      kit.drawTracked(g, mag(q.mag), list.x, y, { size: ms, family: fonts.sansBold, color: col === colors.inkDim ? colors.ink : col });
      const tx = list.x + magW + ms * 0.3;
      const tw = list.x + list.w - tx;
      const distance = `${Math.round(q.km)} km ${compass(q.bearing, locale)}`;
      const place = q.place ?? distance;
      kit.drawTracked(g, kit.truncate(g, place, tw, { size: ps, family: fonts.sans }), tx, y - rowH * 0.1, { size: ps, family: fonts.sans, color: colors.ink });
      const line = `${q.place ? `${distance} · ` : ''}${ago(now - q.time, locale)}`;
      kit.drawTracked(g, kit.truncate(g, line, tw, { size: meta, family: fonts.sans }), tx, y + meta * 1.05, { size: meta, family: fonts.sans, color: colors.inkDim });
    });
    if (more) {
      const strongest = quakes.reduce((a, b) => (b.mag > a.mag ? b : a));
      const s = tr({ en: `${quakes.length} in ${options.days} d · strongest ${mag(strongest.mag)}`, es: `${quakes.length} en ${options.days} d · el mayor, ${mag(strongest.mag)}` });
      const fy = Math.min(list.y + list.h - 4, list.y + shown.length * rowH + footer * 1.3);
      kit.drawTracked(g, kit.truncate(g, s, list.w, { size: footer, family: fonts.sans }), list.x, fy, { size: footer, family: fonts.sans, color: colors.inkDim });
    }
  },
  demo: ({ now }) => {
    const h = 3_600_000;
    const q = (id: string, ageH: number, mag: number, km: number, bearing: number, place: string | null): Quake => ({ id, time: now - ageH * h, mag, lat: 0, lon: 0, depth: 8, km, bearing, place });
    return {
      data: {
        radiusKm: 150,
        quakes: [
          q('d1', 2.4, 2.1, 46, 38, null),
          q('d2', 19, 3.2, 112, 205, null),
          q('d3', 53, 1.7, 23, 290, null),
          q('d4', 130, 1.9, 87, 140, null),
          q('d5', 260, 2.6, 131, 75, null),
          q('d6', 410, 1.6, 64, 330, null),
        ],
      } satisfies QuakesData,
    };
  },
});

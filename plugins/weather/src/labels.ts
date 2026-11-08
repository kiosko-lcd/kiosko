/**
 * Texts of the weather card, in the user's language: WMO codes, moon phases
 * and how old a reading is. Kept apart from the drawing so they can be tested.
 */
import type { Localized } from '@tessera/sdk';
import type { Moon, PhaseName, Weather } from '@loksly/weather-astro';

/** WMO code → text. Codes not listed are not emitted by the Open-Meteo endpoint. */
const WMO: Record<number, Localized> = {
  0: { en: 'Clear', es: 'Despejado' },
  1: { en: 'Mostly clear', es: 'Poco nuboso' },
  2: { en: 'Partly cloudy', es: 'Parcialmente nuboso' },
  3: { en: 'Overcast', es: 'Nublado' },
  45: { en: 'Fog', es: 'Niebla' },
  48: { en: 'Freezing fog', es: 'Niebla helada' },
  51: { en: 'Light drizzle', es: 'Llovizna débil' },
  53: { en: 'Drizzle', es: 'Llovizna' },
  55: { en: 'Heavy drizzle', es: 'Llovizna intensa' },
  56: { en: 'Freezing drizzle', es: 'Llovizna helada' },
  57: { en: 'Freezing drizzle', es: 'Llovizna helada' },
  61: { en: 'Light rain', es: 'Lluvia débil' },
  63: { en: 'Rain', es: 'Lluvia' },
  65: { en: 'Heavy rain', es: 'Lluvia fuerte' },
  66: { en: 'Freezing rain', es: 'Lluvia helada' },
  67: { en: 'Freezing rain', es: 'Lluvia helada' },
  71: { en: 'Light snow', es: 'Nieve débil' },
  73: { en: 'Snow', es: 'Nieve' },
  75: { en: 'Heavy snow', es: 'Nieve intensa' },
  77: { en: 'Snow grains', es: 'Cinarra' },
  80: { en: 'Showers', es: 'Chubascos' },
  81: { en: 'Showers', es: 'Chubascos' },
  82: { en: 'Heavy showers', es: 'Chubascos fuertes' },
  85: { en: 'Snow showers', es: 'Chubascos de nieve' },
  86: { en: 'Snow showers', es: 'Chubascos de nieve' },
  95: { en: 'Thunderstorm', es: 'Tormenta' },
  96: { en: 'Thunderstorm with hail', es: 'Tormenta con granizo' },
  99: { en: 'Thunderstorm with hail', es: 'Tormenta con granizo' },
};

const NO_DATA: Localized = { en: 'No data', es: 'Sin datos' };

/** Text for a WMO code; an unknown code must not break the frame. */
export function describeCode(code: number): Localized {
  return WMO[code] ?? NO_DATA;
}

const MOON: Record<PhaseName, Localized> = {
  new: { en: 'New moon', es: 'Luna nueva' },
  'waxing-crescent': { en: 'Waxing crescent', es: 'Creciente' },
  'first-quarter': { en: 'First quarter', es: 'Cuarto creciente' },
  'waxing-gibbous': { en: 'Waxing gibbous', es: 'Gibosa creciente' },
  full: { en: 'Full moon', es: 'Luna llena' },
  'waning-gibbous': { en: 'Waning gibbous', es: 'Gibosa menguante' },
  'last-quarter': { en: 'Last quarter', es: 'Cuarto menguante' },
  'waning-crescent': { en: 'Waning crescent', es: 'Menguante' },
};

export function moonName(m: Moon): Localized {
  return MOON[m.name];
}

/**
 * The line under the moon. Close to full it counts down to it; just after,
 * to the new moon, which is the next milestone anyone cares about.
 */
export function moonHeadline(m: Moon): Localized {
  if (m.daysToFull === 0) return { en: 'Full today', es: 'Llena hoy' };
  if (m.daysToNew === 0) return { en: 'New today', es: 'Nueva hoy' };
  if (m.daysToFull <= m.daysToNew) {
    return m.daysToFull === 1 ? { en: 'Full tomorrow', es: 'Llena mañana' } : { en: `Full in ${m.daysToFull} days`, es: `Llena en ${m.daysToFull} días` };
  }
  return m.daysToNew === 1 ? { en: 'New tomorrow', es: 'Nueva mañana' } : { en: `New in ${m.daysToNew} days`, es: `Nueva en ${m.daysToNew} días` };
}

/** "35 min ago" for a reading that's getting old; nothing while it's recent. */
export function staleness(w: Pick<Weather, 'fetched'>, now: number): Localized | null {
  const mins = Math.floor((now - w.fetched) / 60_000);
  if (mins < 20) return null;
  if (mins < 60) return { en: `${mins} min ago`, es: `hace ${mins} min` };
  const h = Math.floor(mins / 60);
  return { en: `${h} h ago`, es: `hace ${h} h` };
}

/** Short weekday of a forecast day ("YYYY-MM-DD"), "Today" for the first one. */
export function dayLabel(date: string, index: number, locale: string, t: (x: Localized) => string): string {
  if (index === 0) return t({ en: 'Today', es: 'Hoy' });
  const [y, m, d] = date.split('-').map(Number);
  if (!y || !m || !d) return date;
  const s = new Date(y, m - 1, d).toLocaleDateString(locale, { weekday: 'short' }).replace(/\.$/, '');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

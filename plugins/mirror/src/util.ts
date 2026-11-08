/**
 * Small helpers shared by the mirror cards: language picking for labels
 * built in code, where the panel is, network timeouts and number formats.
 */
import { homedir } from 'node:os';
import { t } from '@tessera/sdk';

/** True for Spanish locales (`es`, `es-ES`, `es_MX`…). */
export const isEs = (locale: string): boolean => /^es(?:$|[-_])/i.test(locale);

/** Picks the Spanish or the English text by locale. */
export const pickLang = (locale: string, en: string, es: string): string => (isEs(locale) ? es : en);

/** Latitude/longitude override fields, for the cards that look outside. */
export const placeFields = () => ({
  latitude: t.number({
    default: 0,
    min: -90,
    max: 90,
    step: 0.0001,
    unit: '°',
    advanced: true,
    label: { en: 'Latitude', es: 'Latitud' },
    help: { en: 'Leave latitude and longitude at 0 to use the place set in Settings.', es: 'Con latitud y longitud a 0 se usa el lugar de los ajustes.' },
  }),
  longitude: t.number({ default: 0, min: -180, max: 180, step: 0.0001, unit: '°', advanced: true, label: { en: 'Longitude', es: 'Longitud' } }),
});

export interface Place {
  latitude: number;
  longitude: number;
}

/** The card's own coordinates if set (not 0,0), else the user's place. */
export function placeFor(options: { latitude: number; longitude: number }, location: Place | undefined): Place | null {
  if (options.latitude !== 0 || options.longitude !== 0) return { latitude: options.latitude, longitude: options.longitude };
  return location ? { latitude: location.latitude, longitude: location.longitude } : null;
}

export const NO_PLACE = 'no coordinates: set your place in Settings, or latitude and longitude in the card options';

/** The widget's abort signal plus a timeout, for one network request. */
export const within = (signal: AbortSignal, ms: number): AbortSignal => AbortSignal.any([signal, AbortSignal.timeout(ms)]);

export const USER_AGENT = 'Tessera LCD panel (plugin mirror)';

/** `~/x` → `/home/me/x`. */
export function expandHome(p: string): string {
  return p === '~' ? homedir() : p.startsWith('~/') ? `${homedir()}${p.slice(1)}` : p;
}

/** Number with the locale's decimal mark and a fixed number of decimals. */
export function fmt(n: number, locale: string, decimals = 0): string {
  try {
    return n.toLocaleString(locale, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  } catch {
    return n.toFixed(decimals);
  }
}

export const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** `HH:MM`, local time. */
export const hhmm = (ms: number): string => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** `YYYY-MM-DD` of a local day. */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** `YYYY-MM-DD` of the day `days` after the one of `now`. */
export function dayOffset(now: number, days: number): string {
  const d = new Date(now);
  d.setDate(d.getDate() + days);
  return dayKey(d.getTime());
}

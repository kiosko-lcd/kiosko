/**
 * Weather from Open-Meteo.
 *
 * Why Open-Meteo: it needs **no API key**, which rules out almost every other
 * provider, and it returns plain JSON with standard WMO weather codes, so
 * turning a reading into an icon is a lookup table.
 *
 * The on-disk cache (`saveWeather`/`loadWeather`) is not an optimisation: it
 * keeps the last good reading so that a network outage does not blank the
 * screen. Readings older than six hours are dropped instead of being shown as
 * if they were current.
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs';

/** A reading older than this no longer describes the street outside. */
export const MAX_AGE_MS = 6 * 3600_000;

/** Icon for a weather code; `sun`/`moon` variants depend on the time of day. */
export type IconKind =
  | 'sun'
  | 'moon'
  | 'sun-cloud'
  | 'moon-cloud'
  | 'cloud'
  | 'fog'
  | 'drizzle'
  | 'rain'
  | 'snow'
  | 'storm';

export interface DayForecast {
  /** ISO date (YYYY-MM-DD). */
  date: string;
  /** WMO weather code. */
  code: number;
  min: number;
  max: number;
  /** Probability of precipitation, in %. */
  rain: number;
}

export interface HourForecast {
  /** Local time at the place, "HH:MM". */
  label: string;
  temp: number;
  /** Probability of precipitation, in %. */
  rain: number;
}

export interface Weather {
  place: string;
  /** Coordinates of the reading, when the provider returned them. */
  latitude?: number;
  longitude?: number;
  temp: number;
  /** Apparent ("feels like") temperature. */
  feels: number;
  /** WMO weather code. */
  code: number;
  humidity: number;
  wind: number;
  /** Is it night at the place? Turns sun icons into moon icons. */
  night: boolean;
  days: DayForecast[];
  /** The next hours, starting with the current one. */
  hours: HourForecast[];
  /** When it was read, ms epoch. */
  fetched: number;
}

/**
 * WMO codes → icon. Codes not listed are not emitted by this endpoint.
 * Text descriptions are left to the caller, in its own language.
 */
export const WMO_ICON: Readonly<Record<number, IconKind>> = {
  0: 'sun', 1: 'sun-cloud', 2: 'sun-cloud', 3: 'cloud',
  45: 'fog', 48: 'fog',
  51: 'drizzle', 53: 'drizzle', 55: 'drizzle', 56: 'drizzle', 57: 'drizzle',
  61: 'rain', 63: 'rain', 65: 'rain', 66: 'rain', 67: 'rain',
  71: 'snow', 73: 'snow', 75: 'snow', 77: 'snow',
  80: 'rain', 81: 'rain', 82: 'rain',
  85: 'snow', 86: 'snow',
  95: 'storm', 96: 'storm', 99: 'storm',
};

/** Icon for a code, swapping the sun for the moon at night. */
export function iconFor(code: number, night = false): IconKind {
  const icon = WMO_ICON[code] ?? 'cloud';
  if (!night) return icon;
  if (icon === 'sun') return 'moon';
  if (icon === 'sun-cloud') return 'moon-cloud';
  return icon;
}

/** The subset of Open-Meteo's response that is read. */
export interface OpenMeteo {
  latitude?: number;
  longitude?: number;
  current?: {
    time?: string;
    temperature_2m?: number;
    apparent_temperature?: number;
    weather_code?: number;
    relative_humidity_2m?: number;
    wind_speed_10m?: number;
  };
  daily?: {
    time?: string[];
    weather_code?: number[];
    temperature_2m_max?: number[];
    temperature_2m_min?: number[];
    precipitation_probability_max?: number[];
  };
  hourly?: {
    time?: string[];
    temperature_2m?: number[];
    precipitation_probability?: number[];
  };
}

/** How many hourly entries `parseOpenMeteo` keeps. */
export const HOURS_AHEAD = 12;

/**
 * Trims the hourly series so that it starts at the current hour.
 *
 * The API returns the whole day from 00:00. ISO strings are compared as text
 * ("2026-09-04T14" sorts the same as a date), which avoids building `Date`s and
 * time-zone mistakes: the place may be in a different zone than the computer.
 */
export function sliceHours(
  times: string[],
  temps: number[],
  rains: number[],
  currentIso: string,
  count = HOURS_AHEAD,
): HourForecast[] {
  const key = currentIso.slice(0, 13);
  let start = times.findIndex((t) => t.slice(0, 13) >= key);
  if (start < 0) start = 0;

  const out: HourForecast[] = [];
  for (let i = start; i < times.length && out.length < count; i += 1) {
    const t = times[i];
    if (t === undefined) continue;
    out.push({
      label: t.slice(11, 16),
      temp: Math.round(temps[i] ?? 0),
      rain: Math.round(rains[i] ?? 0),
    });
  }
  return out;
}

/**
 * Is it night? Decided with the local time the API itself returns, in the
 * place's zone, not the computer's.
 */
export function isNight(localTime: string | undefined): boolean {
  const hour = Number.parseInt(localTime?.slice(11, 13) ?? '', 10);
  if (!Number.isFinite(hour)) return false;
  return hour < 7 || hour >= 21;
}

/** Turns an Open-Meteo response into a `Weather`, or null if it has no current data. */
export function parseOpenMeteo(raw: OpenMeteo, place: string, now = Date.now()): Weather | null {
  const c = raw.current;
  if (!c || typeof c.temperature_2m !== 'number') return null;

  const d = raw.daily;
  const days: DayForecast[] = [];
  for (let i = 0; i < (d?.time?.length ?? 0); i += 1) {
    days.push({
      date: d?.time?.[i] ?? '',
      code: d?.weather_code?.[i] ?? 0,
      min: Math.round(d?.temperature_2m_min?.[i] ?? 0),
      max: Math.round(d?.temperature_2m_max?.[i] ?? 0),
      rain: Math.round(d?.precipitation_probability_max?.[i] ?? 0),
    });
  }

  const h = raw.hourly;
  const hours = h?.time
    ? sliceHours(h.time, h.temperature_2m ?? [], h.precipitation_probability ?? [], c.time ?? '')
    : [];

  return {
    place,
    ...(typeof raw.latitude === 'number' && typeof raw.longitude === 'number' ? { latitude: raw.latitude, longitude: raw.longitude } : {}),
    temp: Math.round(c.temperature_2m),
    feels: Math.round(c.apparent_temperature ?? c.temperature_2m),
    code: c.weather_code ?? 0,
    humidity: Math.round(c.relative_humidity_2m ?? 0),
    wind: Math.round(c.wind_speed_10m ?? 0),
    night: isNight(c.time),
    days,
    hours,
    fetched: now,
  };
}

export interface WeatherPlace {
  name: string;
  latitude: number;
  longitude: number;
}

/** Reads the current weather and a three-day forecast. Never throws: null on failure. */
export async function fetchWeather(
  place: WeatherPlace,
  timeoutMs: number,
  log: (msg: string) => void = () => {},
): Promise<Weather | null> {
  const url =
    'https://api.open-meteo.com/v1/forecast' +
    `?latitude=${place.latitude}&longitude=${place.longitude}` +
    '&current=temperature_2m,apparent_temperature,weather_code,relative_humidity_2m,wind_speed_10m' +
    '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max' +
    '&hourly=temperature_2m,precipitation_probability' +
    '&timezone=auto&forecast_days=3';
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const parsed = parseOpenMeteo((await res.json()) as OpenMeteo, place.name);
    if (!parsed) throw new Error('response without current data');
    return parsed;
  } catch (err) {
    log(`weather: failed (${err instanceof Error ? err.message : String(err)})`);
    return null;
  }
}

/** Atomic write, so that no reader ever sees half a JSON file. */
export function saveWeather(path: string, w: Weather): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(w));
  renameSync(tmp, path);
}

/** The last reading saved at `path`, or null if missing, invalid or older than `MAX_AGE_MS`. */
export function loadWeather(path: string, now = Date.now()): Weather | null {
  try {
    const w = JSON.parse(readFileSync(path, 'utf8')) as Weather;
    if (typeof w?.temp !== 'number' || typeof w.fetched !== 'number') return null;
    return now - w.fetched > MAX_AGE_MS ? null : w;
  } catch {
    return null;
  }
}

/**
 * The user's place is set once, in Settings, and reaches every plugin as
 * `ctx.location`. A widget or source that can look somewhere else (the
 * weather of another city) offers `locationOptions()`, advanced, and picks
 * with `placeOf`: its own place when both coordinates are set, otherwise the
 * user's.
 */
import type { Location } from './plugin.ts';
import { t, type NumberField, type StringField } from './schema.ts';

/** Advanced latitude, longitude and name fields; 0, 0 means "the place in Settings". */
export function locationOptions(): { latitude: NumberField; longitude: NumberField; placeName: StringField } {
  return {
    latitude: t.number({
      default: 0,
      min: -90,
      max: 90,
      step: 0.0001,
      unit: '°',
      advanced: true,
      label: { en: 'Latitude', es: 'Latitud' },
      help: { en: 'Leave latitude and longitude at 0 to use the place in Settings.', es: 'Con latitud y longitud a 0 se usa el lugar de los ajustes.' },
    }),
    longitude: t.number({ default: 0, min: -180, max: 180, step: 0.0001, unit: '°', advanced: true, label: { en: 'Longitude', es: 'Longitud' } }),
    placeName: t.string({ advanced: true, placeholder: 'Madrid', label: { en: 'Place name', es: 'Nombre del lugar' }, help: { en: 'Empty: the one in Settings.', es: 'Vacío: el de los ajustes.' } }),
  };
}

/**
 * The place to use: `own` when it has both coordinates (not 0, 0), with its
 * name or the user's; otherwise the user's (`ctx.location`), which may be
 * unset.
 */
export function placeOf(own: { latitude?: number; longitude?: number; placeName?: string; name?: string } | undefined, user: Location | undefined): Location | undefined {
  const lat = own?.latitude ?? 0;
  const lon = own?.longitude ?? 0;
  const name = (own?.placeName ?? own?.name ?? '').trim();
  if (Number.isFinite(lat) && Number.isFinite(lon) && (lat !== 0 || lon !== 0)) return { latitude: lat, longitude: lon, ...(name ? { name } : {}) };
  if (!user) return undefined;
  return name ? { ...user, name } : user;
}

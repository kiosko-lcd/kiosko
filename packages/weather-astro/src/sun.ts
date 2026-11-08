/**
 * Sunrise and sunset, computed locally with NOAA's equation (the one behind
 * its solar calculator). No network needed.
 *
 * Accuracy: a couple of minutes at mid latitudes. Near the poles there may be
 * no sunrise or sunset; then `sunTimes` returns null.
 */
const RAD = Math.PI / 180;

export interface SunTimes {
  /** Local time as decimal hours (7.5 = 7:30), in the machine's time zone. */
  rise: number;
  set: number;
}

/** UTC minutes of sunrise and sunset for the UTC day of `date`. */
function utcMinutes(date: Date, lat: number, lon: number): { rise: number; set: number } | null {
  const start = Date.UTC(date.getUTCFullYear(), 0, 1);
  const day = Math.floor((Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - start) / 86_400_000) + 1;
  const g = ((2 * Math.PI) / 365) * (day - 1);
  const eq = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  // 90.833°: the whole disc below the horizon, allowing for atmospheric refraction.
  const cosH = Math.cos(90.833 * RAD) / (Math.cos(lat * RAD) * Math.cos(decl)) - Math.tan(lat * RAD) * Math.tan(decl);
  if (cosH < -1 || cosH > 1) return null;
  const h = Math.acos(cosH) / RAD;
  return { rise: 720 - 4 * (lon + h) - eq, set: 720 - 4 * (lon - h) - eq };
}

/** Sunrise and sunset on the day of `date` at a place, or null if the sun does not rise or set. */
export function sunTimes(date: Date, lat: number, lon: number): SunTimes | null {
  const m = utcMinutes(date, lat, lon);
  if (!m) return null;
  // To local time on that day, with its summer or winter offset.
  const toLocal = (min: number) => {
    const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) + min * 60_000);
    return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
  };
  return { rise: toLocal(m.rise), set: toLocal(m.set) };
}

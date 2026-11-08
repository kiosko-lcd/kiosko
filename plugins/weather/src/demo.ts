/**
 * A believable reading for the gallery and the editor: an autumn day in a
 * mid-latitude city, with a shower in the afternoon. Derived from `now` only,
 * so the same instant always draws the same card.
 */
import type { DayForecast, HourForecast, Weather } from '@loksly/weather-astro';

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Temperature along the day: coldest at 7:00, warmest at 15:00. */
function tempAt(hour: number): number {
  return 11 + 5 * Math.cos(((hour - 15) / 24) * 2 * Math.PI);
}

export function demoWeather(now: number): Weather {
  const d = new Date(now);
  const h0 = d.getHours();
  const hours: HourForecast[] = Array.from({ length: 12 }, (_, i) => {
    const h = (h0 + i) % 24;
    // A shower crosses between 4 and 7 hours from now.
    const rain = i >= 4 && i <= 7 ? [30, 60, 55, 25][i - 4]! : i === 3 ? 10 : 0;
    return { label: `${pad2(h)}:00`, temp: Math.round(tempAt(h) - (rain >= 50 ? 1 : 0)), rain };
  });
  const iso = (offset: number) => {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate() + offset);
    return `${x.getFullYear()}-${pad2(x.getMonth() + 1)}-${pad2(x.getDate())}`;
  };
  const days: DayForecast[] = [
    { date: iso(0), code: 80, min: 6, max: 16, rain: 60 },
    { date: iso(1), code: 3, min: 8, max: 14, rain: 20 },
    { date: iso(2), code: 1, min: 5, max: 17, rain: 0 },
  ];
  return {
    place: 'Madrid',
    latitude: 40.42,
    longitude: -3.7,
    temp: Math.round(tempAt(h0 + d.getMinutes() / 60)),
    feels: Math.round(tempAt(h0) - 2),
    code: 2,
    humidity: 64,
    wind: 14,
    night: h0 < 7 || h0 >= 19,
    days,
    hours,
    fetched: now - 4 * 60_000,
  };
}

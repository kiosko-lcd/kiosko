import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FORECAST_DAYS,
  HOURS_AHEAD,
  iconFor,
  isNight,
  loadWeather,
  openMeteoUrl,
  parseOpenMeteo,
  saveWeather,
  sliceHours,
  type Weather,
} from './weather.ts';

test('weather: unknown WMO codes fall back to a cloud instead of breaking the render', () => {
  assert.strictEqual(iconFor(45), 'fog');
  assert.strictEqual(iconFor(95), 'storm');
  assert.strictEqual(iconFor(1234), 'cloud');
});

test('weather: at night the sun becomes the moon, rain stays rain', () => {
  assert.strictEqual(iconFor(0, false), 'sun');
  assert.strictEqual(iconFor(0, true), 'moon');
  assert.strictEqual(iconFor(2, false), 'sun-cloud');
  assert.strictEqual(iconFor(2, true), 'moon-cloud');
  // Rain is rain at night too.
  assert.strictEqual(iconFor(63, true), 'rain');
  assert.strictEqual(iconFor(3, true), 'cloud');
});

test("weather: night is decided with the place's LOCAL time", () => {
  assert.strictEqual(isNight('2026-09-03T23:30'), true);
  assert.strictEqual(isNight('2026-09-03T03:00'), true);
  assert.strictEqual(isNight('2026-09-03T14:00'), false);
  assert.strictEqual(isNight('2026-09-03T07:00'), false);
  assert.strictEqual(isNight(undefined), false, 'no data does not make up a night');
});

test('weather: parses a real Open-Meteo response', () => {
  const w = parseOpenMeteo(
    {
      current: {
        time: '2026-09-03T23:30',
        temperature_2m: 25.4,
        apparent_temperature: 29.8,
        weather_code: 0,
        relative_humidity_2m: 79.2,
        wind_speed_10m: 3.4,
      },
      daily: {
        time: ['2026-09-03', '2026-09-04'],
        weather_code: [45, 45],
        temperature_2m_max: [35.2, 38.9],
        temperature_2m_min: [21.4, 20.6],
        precipitation_probability_max: [0, 3],
      },
    },
    'Altorreal',
    1_000_000,
  );
  assert.ok(w);
  assert.strictEqual(w.temp, 25, 'it is rounded');
  assert.strictEqual(w.feels, 30);
  assert.strictEqual(w.night, true);
  assert.strictEqual(w.days.length, 2);
  assert.deepStrictEqual(w.days[0], { date: '2026-09-03', code: 45, min: 21, max: 35, rain: 0 });
  assert.strictEqual(w.fetched, 1_000_000);
});

test('weather: a response without current data gives null', () => {
  assert.strictEqual(parseOpenMeteo({}, 'X'), null);
  assert.strictEqual(parseOpenMeteo({ current: {} }, 'X'), null);
});

function fake(fetched: number): Weather {
  return {
    place: 'X', temp: 20, feels: 20, code: 0, humidity: 50, wind: 5,
    night: false, days: [], fetched,
  };
}

test('weather: a stale reading is dropped instead of lying', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'weather-'));
  // Without this, every test run leaves a directory in /tmp.
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'weather.json');
  const now = 10 * 3600_000;

  saveWeather(path, fake(now - 60_000));
  assert.ok(loadWeather(path, now), 'one minute old is fine');

  saveWeather(path, fake(now - 7 * 3600_000));
  assert.strictEqual(loadWeather(path, now), null, 'seven hours old no longer describes the street outside');

  writeFileSync(path, 'this is not json');
  assert.strictEqual(loadWeather(path, now), null);
});

test('weather: the hourly series starts at the current hour', () => {
  const times = Array.from({ length: 24 }, (_, i) => `2026-09-04T${String(i).padStart(2, '0')}:00`);
  const temps = times.map((_, i) => 20 + i);
  const rains = times.map((_, i) => i);

  const from14 = sliceHours(times, temps, rains, '2026-09-04T14:30', 4);
  assert.deepStrictEqual(from14.map((h) => h.label), ['14:00', '15:00', '16:00', '17:00']);
  assert.strictEqual(from14[0]?.temp, 34);
  assert.strictEqual(from14[0]?.rain, 14);

  // Near the end of the day, whatever is left is returned, without making up hours.
  assert.strictEqual(sliceHours(times, temps, rains, '2026-09-04T22:00', 12).length, 2);

  // An hour that is not in the series must not leave the strip empty.
  assert.strictEqual(sliceHours(times, temps, rains, '', 3).length, 3);
});

test('weather: the hourly series is part of the full parse', () => {
  const w = parseOpenMeteo(
    {
      current: { time: '2026-09-04T02:00', temperature_2m: 23 },
      hourly: {
        time: ['2026-09-04T01:00', '2026-09-04T02:00', '2026-09-04T03:00'],
        temperature_2m: [24.4, 23.2, 22.7],
        precipitation_probability: [0, 10, 35],
      },
    },
    'X',
  );
  assert.ok(w);
  assert.deepStrictEqual(w.hours, [
    { label: '02:00', temp: 23, rain: 10 },
    { label: '03:00', temp: 23, rain: 35 },
  ]);
});

test('weather: asks for two days of hours and a week of days, in the units wanted', () => {
  assert.strictEqual(HOURS_AHEAD, 48);
  assert.strictEqual(FORECAST_DAYS, 7);
  const metric = openMeteoUrl({ latitude: 40.4, longitude: -3.7 });
  assert.ok(metric.includes('forecast_days=7'));
  assert.ok(!metric.includes('fahrenheit'), 'metric is the API default');
  const imperial = openMeteoUrl({ latitude: 40.4, longitude: -3.7 }, 'imperial');
  assert.ok(imperial.includes('temperature_unit=fahrenheit') && imperial.includes('wind_speed_unit=mph'));
});

test('weather: two days of hours are kept, starting at the current one', () => {
  const times = Array.from({ length: 7 * 24 }, (_, i) => `2026-09-0${4 + Math.floor(i / 24)}T${String(i % 24).padStart(2, '0')}:00`);
  const w = parseOpenMeteo({ current: { time: '2026-09-04T22:15', temperature_2m: 20 }, hourly: { time: times, temperature_2m: times.map(() => 20), precipitation_probability: times.map(() => 0) } }, 'X');
  assert.ok(w);
  assert.strictEqual(w.hours.length, 48);
  assert.strictEqual(w.hours[0]?.label, '22:00');
  assert.strictEqual(w.hours[47]?.label, '21:00', 'until the same hour two days later');
});

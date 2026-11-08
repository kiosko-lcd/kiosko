import { test } from 'node:test';
import assert from 'node:assert';
import { localize } from '@tessera/sdk';
import { moonPhase } from '@loksly/weather-astro';
import { dayLabel, describeCode, moonHeadline, staleness } from './labels.ts';
import { demoWeather } from './demo.ts';

test('weather: WMO codes become text in both languages', () => {
  assert.strictEqual(localize(describeCode(0), 'es'), 'Despejado');
  assert.strictEqual(localize(describeCode(45), 'es'), 'Niebla');
  assert.strictEqual(localize(describeCode(95), 'en'), 'Thunderstorm');
  // A code this endpoint doesn't emit must not break the frame.
  assert.strictEqual(localize(describeCode(1234), 'es'), 'Sin datos');
});

test('weather: the age of a reading is only shown when it matters', () => {
  const now = 10 * 3600_000;
  assert.strictEqual(staleness({ fetched: now - 60_000 }, now), null, 'a fresh reading is not marked');
  assert.strictEqual(localize(staleness({ fetched: now - 35 * 60_000 }, now)!, 'es'), 'hace 35 min');
  assert.strictEqual(localize(staleness({ fetched: now - 2 * 3600_000 }, now)!, 'en'), '2 h ago');
});

test('weather: the first forecast day is "today", the rest their weekday', () => {
  const t = (x: Parameters<typeof localize>[0]) => localize(x, 'es');
  assert.strictEqual(dayLabel('2026-11-05', 0, 'es', t), 'Hoy');
  assert.match(dayLabel('2026-11-06', 1, 'es', t), /^Vie/);
  assert.match(dayLabel('2026-11-07', 1, 'en', (x) => localize(x, 'en')), /^Sat/);
});

test('weather: the moon counts down to the nearest milestone', () => {
  const m = moonPhase(Date.UTC(2026, 10, 5));
  const line = localize(moonHeadline(m), 'en');
  assert.match(line, /^(Full|New) (today|tomorrow|in \d+ days)$/);
});

test('weather: the demo reading is complete and deterministic', () => {
  const now = Date.parse('2026-11-05T10:42:00');
  const a = demoWeather(now);
  assert.deepStrictEqual(a, demoWeather(now));
  assert.strictEqual(a.hours.length, 12);
  assert.strictEqual(a.days.length, 3);
  assert.strictEqual(a.hours[0]!.label, '10:00');
  assert.ok(a.hours.some((h) => h.rain >= 50), 'there is a shower to draw');
});

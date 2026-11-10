import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFormatters, usesHour12 } from './format.ts';

// Local times, so the tests pass in any time zone.
const at = (h: number, m: number, s = 0) => new Date(2026, 10, 10, h, m, s).getTime();
const now = at(15, 0);
const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;

test('time: 24 h by default in Spanish and en-GB, 12 h in US English', () => {
  assert.equal(usesHour12('es'), false);
  assert.equal(usesHour12('en-GB'), false);
  assert.equal(usesHour12('en-US'), true);
  assert.equal(usesHour12('en'), true);
  assert.equal(usesHour12('xx-not-a-locale!'), false);
  assert.equal(createFormatters({ locale: 'es', now }).time(at(9, 5)), '09:05');
  assert.equal(createFormatters({ locale: 'en-US', now }).time(at(21, 5)), '9:05 PM');
});

test('time: the config timeFormat wins over the language', () => {
  const es12 = createFormatters({ locale: 'es', timeFormat: '12h', now });
  assert.equal(es12.hour12, true);
  assert.equal(es12.time(at(0, 30)), '12:30 a. m.');
  assert.equal(es12.time(at(12, 30)), '12:30 p. m.');
  assert.equal(es12.time(at(13, 30), { ampm: false }), '1:30');
  const en24 = createFormatters({ locale: 'en-US', timeFormat: '24h', now });
  assert.equal(en24.hour12, false);
  assert.equal(en24.time(at(21, 5, 7), { seconds: true }), '21:05:07');
  assert.equal(en24.time(new Date(at(7, 0))), '07:00');
});

test('ago: one compact scale, with or without "ago"', () => {
  const en = createFormatters({ locale: 'en', now });
  const es = createFormatters({ locale: 'es-ES', now });
  assert.equal(en.ago(now - 20_000), 'just now');
  assert.equal(en.ago(now + 5 * MIN), 'just now');
  assert.equal(en.ago(now - 5 * MIN), '5 min ago');
  assert.equal(es.ago(now - 5 * MIN), 'hace 5 min');
  assert.equal(en.ago(now - 3 * H - 10 * MIN), '3 h ago');
  assert.equal(en.ago(now - 4 * D), '4 d ago');
  assert.equal(es.ago(now - 20 * D), 'hace 2 sem');
  assert.equal(en.ago(now - 400 * D), '1 yr ago');
  assert.equal(es.ago(now - 800 * D), 'hace 2 años');
  assert.equal(en.ago(now - 3 * H, { suffix: false }), '3 h');
  assert.equal(es.ago(now, { suffix: false }), 'ahora');
  assert.equal(en.ago(new Date(now - 2 * H).toISOString()), '2 h ago');
  assert.equal(en.ago(now - 2 * H, { now: now + H }), '3 h ago');
  assert.equal(en.ago('not a date'), 'just now');
  // Other languages get the English words.
  assert.equal(createFormatters({ locale: 'fr', now }).ago(now - 5 * MIN), '5 min ago');
});

test('duration: min, h 05, d h; rounding for countdowns', () => {
  const f = createFormatters({ locale: 'en', now });
  assert.equal(f.duration(45_000), '0 min');
  assert.equal(f.duration(45_000, { seconds: true }), '45 s');
  assert.equal(f.duration(12 * MIN + 59_000), '12 min');
  assert.equal(f.duration(H + 5 * MIN), '1 h 05');
  assert.equal(f.duration(2 * H), '2 h 00');
  assert.equal(f.duration(2 * D + 3 * H + 10 * MIN), '2 d 3 h');
  assert.equal(f.duration(30_000, { round: 'up' }), '1 min');
  assert.equal(f.duration(59 * MIN + 40_000, { round: 'nearest' }), '1 h 00');
  // Compact: no zero remainder, for spans ("the last 1 h").
  assert.equal(f.duration(H, { compact: true }), '1 h');
  assert.equal(f.duration(H + 5 * MIN, { compact: true }), '1 h 05');
  assert.equal(f.duration(59 * MIN + 40_000, { round: 'nearest', compact: true }), '1 h');
  assert.equal(f.duration(2 * D, { compact: true }), '2 d');
  assert.equal(f.duration(2 * D + 3 * H, { compact: true }), '2 d 3 h');
  assert.equal(f.duration(15 * MIN, { compact: true }), '15 min');
  assert.equal(f.duration(-5), '0 min');
  assert.equal(f.duration(Number.NaN), '0 min');
});

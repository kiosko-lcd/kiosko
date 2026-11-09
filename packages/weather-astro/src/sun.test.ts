import { test } from 'node:test';
import assert from 'node:assert';
import { sunTimes } from './sun.ts';

const hm = (h: number) => `${Math.floor(h)}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`;
const near = (got: number, want: number, min = 4) => assert.ok(Math.abs(got - want) * 60 <= min, `${hm(got)} vs ${hm(want)}`);

test('sun: Greenwich at the summer solstice (checked against NOAA)', { skip: Intl.DateTimeFormat().resolvedOptions().timeZone !== 'Europe/Madrid' ? 'depends on the time zone' : false }, () => {
  // Sunrise 03:43 UTC and sunset 20:21 UTC → 05:43 and 22:21 in Madrid summer time.
  const s = sunTimes(new Date('2026-06-21T12:00:00Z'), 51.4769, 0)!;
  near(s.rise, 5 + 43 / 60);
  near(s.set, 22 + 21 / 60);
});

test('sun: day length at a mid-latitude place follows the seasons', () => {
  const len = (iso: string) => { const s = sunTimes(new Date(iso), 38.3452, -0.4810)!; return s.set - s.rise; };
  near(len('2026-06-21T12:00:00Z'), 14 + 48 / 60, 10);
  near(len('2026-12-21T12:00:00Z'), 9 + 33 / 60, 10);
  near(len('2026-09-23T12:00:00Z'), 12 + 9 / 60, 10);
});

test('sun: daylight saving moves local time, not the sun', { skip: Intl.DateTimeFormat().resolvedOptions().timeZone !== 'Europe/Madrid' ? 'depends on the time zone' : false }, () => {
  // Before and after the October clock change: sunrise jumps back an hour.
  const before = sunTimes(new Date('2026-10-24T12:00:00Z'), 38.3452, -0.4810)!;
  const after = sunTimes(new Date('2026-10-25T12:00:00Z'), 38.3452, -0.4810)!;
  near(before.rise - after.rise, 1, 5);
});

test('sun: inside the polar circle there is sometimes no sunrise or sunset', () => {
  assert.strictEqual(sunTimes(new Date('2026-06-21T12:00:00Z'), 78.2, 15.6), null, 'midnight sun');
  assert.strictEqual(sunTimes(new Date('2026-12-21T12:00:00Z'), 78.2, 15.6), null, 'polar night');
});


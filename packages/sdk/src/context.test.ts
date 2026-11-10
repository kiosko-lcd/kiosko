import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBaseContext } from './context.ts';
import { DEFAULT_WORKDAY } from './workday.ts';

test('createBaseContext fills language, formatters and working week', () => {
  const now = new Date(2026, 10, 10, 21, 5).getTime();
  const ctx = createBaseContext({ now, locale: 'es', timeFormat: '12h' });
  assert.equal(ctx.t({ en: 'Hello', es: 'Hola' }), 'Hola');
  assert.equal(ctx.fmt.time(now), '9:05 p. m.');
  assert.equal(ctx.fmt.ago(now - 120_000), 'hace 2 min');
  assert.deepEqual(ctx.workday, DEFAULT_WORKDAY);
  assert.equal(ctx.location, undefined);
  const placed = createBaseContext({ now, location: { latitude: 1, longitude: 2 }, workday: { ...DEFAULT_WORKDAY, start: '08:00' } });
  assert.equal(placed.locale, 'en');
  assert.deepEqual([placed.location?.latitude, placed.workday.start], [1, '08:00']);
});

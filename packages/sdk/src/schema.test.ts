import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultsOf, t, toJsonSchema, validate } from './schema.ts';
import { localize } from './i18n.ts';

const S = t.object({
  name: t.string({ default: 'x' }),
  max: t.integer({ default: 4, min: 1, max: 10 }),
  mode: t.enum(['a', 'b'] as const),
  on: t.boolean({ default: true }),
  events: t.list(t.object({ name: t.string(), date: t.string({ format: 'date' }) })),
  aliases: t.map(),
});

test('defaults come from the fields', () => {
  assert.deepEqual(defaultsOf(S), { name: 'x', max: 4, mode: 'a', on: true, events: [], aliases: {} });
});

test('validate coerces, clamps, keeps unknown keys and reports problems', () => {
  const r = validate(S, { max: '42', mode: 'zzz', on: 'false', events: [{ name: 'Exam' }], extra: 1 });
  assert.equal(r.value.max, 10);
  assert.equal(r.value.mode, 'a');
  assert.equal(r.value.on, false);
  assert.deepEqual(r.value.events, [{ name: 'Exam', date: '' }]);
  assert.equal((r.value as Record<string, unknown>).extra, 1);
  assert.deepEqual(r.issues.map((i) => i.path), ['mode']);
});

test('validate never throws on garbage', () => {
  assert.deepEqual(validate(S, 'nope').value, defaultsOf(S));
});

test('toJsonSchema emits standard types with ui hints', () => {
  const js = toJsonSchema(S) as { properties: Record<string, { type: string; enum?: string[]; maximum?: number }> };
  assert.equal(js.properties.max!.type, 'integer');
  assert.equal(js.properties.max!.maximum, 10);
  assert.deepEqual(js.properties.mode!.enum, ['a', 'b']);
});

test('localize picks the language, then English', () => {
  const x = { en: 'Clock', es: 'Reloj' };
  assert.equal(localize(x, 'es-ES'), 'Reloj');
  assert.equal(localize(x, 'fr'), 'Clock');
  assert.equal(localize('plain', 'es'), 'plain');
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { locationOptions, placeOf } from './location.ts';
import { defaultsOf, t } from './schema.ts';

const madrid = { latitude: 40.4, longitude: -3.7, name: 'Madrid' };

test('placeOf: the own place when it has coordinates, else the user\'s', () => {
  assert.deepEqual(placeOf({ latitude: 0, longitude: 0 }, madrid), madrid);
  assert.deepEqual(placeOf(undefined, madrid), madrid);
  assert.deepEqual(placeOf({ latitude: 48.85, longitude: 2.35, placeName: 'Paris' }, madrid), { latitude: 48.85, longitude: 2.35, name: 'Paris' });
  assert.deepEqual(placeOf({ latitude: 0, longitude: 10 }, madrid), { latitude: 0, longitude: 10 });
  assert.deepEqual(placeOf({ placeName: 'Casa' }, madrid), { ...madrid, name: 'Casa' });
  assert.equal(placeOf({}, undefined), undefined);
});

test('locationOptions: advanced fields that default to "the place in Settings"', () => {
  const S = t.object({ ...locationOptions() });
  assert.deepEqual(defaultsOf(S), { latitude: 0, longitude: 0, placeName: '' });
  assert.ok(Object.values(S.props).every((f) => f.advanced));
});

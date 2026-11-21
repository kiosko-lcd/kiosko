import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isRegion, licenseKind, parseLicense } from './licenses.ts';

test('parseLicense: SPDX expressions, with what is unknown or miscased', () => {
  assert.deepEqual(parseLicense('MIT'), { ids: ['MIT'], unknown: [], fix: [] });
  assert.deepEqual(parseLicense('(MIT OR Apache-2.0) AND CC-BY-4.0').ids, ['MIT', 'Apache-2.0', 'CC-BY-4.0']);
  assert.deepEqual(parseLicense('apache-2.0').fix, [{ from: 'apache-2.0', to: 'Apache-2.0' }]);
  assert.deepEqual(parseLicense('LicenseRef-mine').unknown, []);
  assert.deepEqual(parseLicense('UNLICENSED').ids, ['UNLICENSED']);
  for (const bad of ['', 'MIT AND', '(MIT', 'MIT Apache-2.0', 'MIT/Apache-2.0', 'OR MIT']) assert.throws(() => parseLicense(bad), Error, bad);
});

test('licenseKind: the freest choice with OR, the strictest part with AND', () => {
  assert.equal(licenseKind('MIT'), 'permissive');
  assert.equal(licenseKind('GPL-3.0-only'), 'copyleft');
  assert.equal(licenseKind('GPL-2.0-or-later OR MIT'), 'permissive');
  assert.equal(licenseKind('MIT AND GPL-3.0-only'), 'copyleft');
  assert.equal(licenseKind('BUSL-1.1'), 'other');
  assert.equal(licenseKind('UNLICENSED'), 'other');
  assert.equal(licenseKind(undefined), 'other');
  assert.equal(licenseKind('nonsense/x'), 'other');
});

test('isRegion: ISO 3166-1 alpha-2 and EU', () => {
  for (const ok of ['ES', 'TW', 'HK', 'CN', 'DE', 'US', 'EU']) assert.ok(isRegion(ok), ok);
  for (const no of ['es', 'ESP', 'Spain', 'QQ', '']) assert.ok(!isRegion(no), no);
});

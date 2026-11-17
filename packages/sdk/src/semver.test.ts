import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, parseVersion, satisfies } from './semver.ts';

test('parseVersion and compareVersions', () => {
  assert.deepEqual(parseVersion('1.2.3'), [1, 2, 3, '']);
  assert.deepEqual(parseVersion('v0.2.1-beta.1+build'), [0, 2, 1, 'beta.1']);
  assert.equal(parseVersion('1.2'), null);
  assert.equal(compareVersions('0.2.1', '0.2.0'), 1);
  assert.equal(compareVersions('0.2.0', '0.10.0'), -1);
  assert.equal(compareVersions('1.0.0-beta', '1.0.0'), -1);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
});

test('satisfies: caret, tilde, wildcards, comparators and alternatives', () => {
  const yes = (v: string, r: string) => assert.equal(satisfies(v, r), true, `${v} in ${r}`);
  const no = (v: string, r: string) => assert.equal(satisfies(v, r), false, `${v} not in ${r}`);
  yes('0.2.1', '^0.2.0');
  yes('0.2.9', '^0.2');
  no('0.3.0', '^0.2.0');
  no('0.1.9', '^0.2.0');
  yes('1.4.0', '^1.2.0');
  no('2.0.0', '^1.2.0');
  yes('0.0.3', '^0.0.3');
  no('0.0.4', '^0.0.3');
  yes('0.2.5', '~0.2.1');
  no('0.3.0', '~0.2.1');
  yes('1.9.0', '~1');
  yes('0.2.7', '0.2');
  yes('0.2.7', '0.2.x');
  no('0.3.0', '0.2.x');
  yes('5.0.0', '*');
  yes('5.0.0', '');
  yes('0.2.1', '>=0.2.0 <1');
  no('1.0.0', '>=0.2.0 <1');
  yes('0.2.1', '>= 0.2.0');
  yes('1.0.0', '^0.2 || ^1');
  no('0.5.0', '^0.2 || ^1');
  yes('0.2.1', '0.2.1');
  no('0.2.2', '=0.2.1');
  yes('0.3.0', '>0.2');
  no('0.2.9', '>0.2');
  yes('0.2.9', '<=0.2');
  no('0.3.0', '<=0.2');
});

test('satisfies: pre-releases only where the range names one, and junk is false', () => {
  assert.equal(satisfies('0.3.0-beta.1', '^0.2.0'), false);
  assert.equal(satisfies('0.3.0-beta.1', '>=0.2.0'), false);
  assert.equal(satisfies('0.3.0-beta.2', '>=0.3.0-beta.1'), true);
  assert.equal(satisfies('0.2.1', 'banana'), false);
  assert.equal(satisfies('latest', '^0.2'), false);
});

test('SDK_VERSION is the SDK package version', async () => {
  const { readFileSync } = await import('node:fs');
  const { SDK_VERSION } = await import('./plugin.ts');
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  assert.equal(SDK_VERSION, pkg.version);
});

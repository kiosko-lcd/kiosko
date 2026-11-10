import assert from 'node:assert/strict';
import { test } from 'node:test';
import { filterPatterns, matchFilter } from './filter.ts';
import { defaultsOf, t, toJsonSchema, validate } from './schema.ts';

test('an empty filter lets everything through', () => {
  assert.equal(matchFilter('acme/web', []), true);
  assert.equal(matchFilter('acme/web', undefined), true);
  assert.equal(matchFilter('acme/web', ' , '), true);
});

test('names match by full path or last segment, without case', () => {
  assert.equal(matchFilter('acme/tools/Web', ['web']), true);
  assert.equal(matchFilter('acme/tools/web', ['acme/tools/web']), true);
  assert.equal(matchFilter('acme/tools/web', ['tools/web']), false);
  assert.equal(matchFilter('acme/web', ['api']), false);
});

test('globs: * crosses slashes, ? is one character, *x* is contains', () => {
  assert.equal(matchFilter('acme/tools/web', ['acme/*']), true);
  assert.equal(matchFilter('other/web', ['acme/*']), false);
  assert.equal(matchFilter('web-2', ['web-?']), true);
  assert.equal(matchFilter('web-22', ['web-?']), false);
  assert.equal(matchFilter('my-web-app', ['*web*']), true);
  assert.equal(matchFilter('a.b(c)', ['a.b(c)']), true);
  assert.equal(matchFilter('axb(c)', ['a.b(c)']), false);
});

test('a leading ! excludes; includes and excludes combine', () => {
  assert.equal(matchFilter('acme/legacy-api', ['!legacy-*']), false);
  assert.equal(matchFilter('acme/web', ['!legacy-*']), true);
  assert.equal(matchFilter('acme/web-old', ['acme/*', '!*-old']), false);
  assert.equal(matchFilter('acme/web', ['acme/*', '!*-old']), true);
  assert.equal(matchFilter('other/web', ['acme/*', '!*-old']), false);
});

test('several names of one item, and filters written as text', () => {
  assert.equal(matchFilter(['octo/web-app', 'Web'], ['web']), true);
  assert.equal(matchFilter(['octo/web-app', 'Web'], ['!web']), false);
  assert.equal(matchFilter('acme/web', 'api, web'), true);
  assert.equal(matchFilter('acme/web', 'api\n!web'), false);
  assert.deepEqual(filterPatterns(' a ,, !b ,!'), ['a', '!b']);
});

test('t.filter is a list of patterns with its help and an editor hint', () => {
  const S = t.object({ repos: t.filter({ label: { en: 'Repositories', es: 'Repositorios' } }) });
  assert.deepEqual(defaultsOf(S), { repos: [] });
  assert.deepEqual(validate(S, { repos: ['web', 3] }).value.repos, ['web', '3']);
  const js = toJsonSchema(S) as { properties: { repos: Record<string, any> } };
  assert.equal(js.properties.repos.type, 'array');
  assert.equal(js.properties.repos['x-filter'], true);
  assert.equal(js.properties.repos['x-ui'].widget, 'filter');
  assert.match(js.properties.repos.description, /leading ! leaves out/);
  assert.equal(js.properties.repos.title, 'Repositories');
});

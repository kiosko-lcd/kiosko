import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildIndex, entryFrom } from './build.ts';
import { featuredOrder, installableRelease, marketFor, matches, regionOf, releaseProblem, textIn } from './client.ts';
import { manifest, packument } from './fixtures/npm.ts';

const plugin = (id: string, versions: string[], o: Parameters<typeof packument>[2] = {}, official = false) => entryFrom({ packument: packument(`kiosko-plugin-${id}`, versions, o), manifest: manifest(id, versions.at(-1)!), official: official ? { bundled: true } : null })!.plugin;

test('textIn: the reader’s language, the same script, else English', () => {
  const t = { en: 'Weather', es: 'El tiempo', 'zh-Hant': '天氣', 'zh-Hans': '天气' };
  assert.equal(textIn(t, 'es-MX'), 'El tiempo');
  assert.equal(textIn(t, 'zh-TW'), '天氣');
  assert.equal(textIn(t, 'zh-CN'), '天气');
  assert.equal(textIn({ en: 'X', 'zh-Hans': '简' }, 'zh-TW'), 'X');
  assert.equal(textIn(t, 'de'), 'Weather');
  assert.equal(textIn(undefined, 'es'), '');
});

test('releaseProblem and installableRelease: the newest that fits this Kiosko and system, not withdrawn', () => {
  const env = { sdk: '0.2.6', platform: 'linux' };
  assert.equal(releaseProblem({ sdk: '^0.2.0' }, env), null);
  assert.deepEqual(releaseProblem({ sdk: '^0.3.0' }, env), { code: 'sdk', range: '^0.3.0' });
  assert.deepEqual(releaseProblem({ platforms: ['win32'] }, env), { code: 'os', platforms: ['win32'] });
  const p = plugin('a', ['1.0.0', '1.1.0', '1.2.0'], { deprecated: { '1.1.0': 'broken' } });
  p.releases[0]!.sdk = '^0.3.0';
  assert.equal(installableRelease(p, env)!.version, '1.0.0');
  p.releases[0]!.sdk = '^0.2.0';
  p.releases[0]!.withdrawn = true;
  assert.equal(installableRelease(p, env)!.version, '1.0.0');
  p.releases[2]!.withdrawn = true;
  // Only a deprecated one left: still offered (it says so).
  assert.equal(installableRelease(p, env)!.version, '1.1.0');
  p.releases[1]!.withdrawn = true;
  assert.equal(installableRelease(p, env), null);
});

test('regionOf: from the locale when it says, from the script for Chinese', () => {
  assert.equal(regionOf('es-ES'), 'ES');
  assert.equal(regionOf('es_AR.UTF-8'), 'AR');
  assert.equal(regionOf('zh-Hant'), 'TW');
  assert.equal(regionOf('zh-Hans'), 'CN');
  assert.equal(regionOf('en'), null);
  assert.equal(regionOf(undefined), null);
});

test('marketFor: useful here, only elsewhere, or missing here (and the per-language list)', () => {
  const p = { id: 'pvpc', markets: { only: ['ES'] } };
  assert.equal(marketFor(p, { region: 'ES', lang: 'es' }), 'ok');
  assert.equal(marketFor(p, { region: 'MX', lang: 'es' }), 'elsewhere');
  assert.equal(marketFor(p, { region: null, lang: 'en' }), 'ok');
  assert.equal(marketFor({ id: 'eu', markets: { only: ['EU'] } }, { region: 'DE', lang: 'de' }), 'ok');
  assert.equal(marketFor({ id: 'x', markets: { without: ['CN'] } }, { region: 'CN', lang: 'zh-Hans' }), 'missing');
  // Simplified Chinese: no Claude there (languages.ts), as on the front page.
  assert.equal(marketFor({ id: 'agents' }, { region: 'CN', lang: 'zh-Hans' }), 'missing');
  assert.equal(marketFor({ id: 'agents' }, { region: 'TW', lang: 'zh-Hant' }), 'ok');
});

test('matches and featuredOrder', () => {
  const official = plugin('weather', ['0.2.0'], {}, true);
  const other = plugin('acuario', ['0.0.3']);
  assert.ok(matches(official, 'weather'));
  assert.ok(matches(official, 'WEATHER (es)'));
  assert.ok(!matches(other, 'weather'));
  const idx = buildIndex([other, official], { generatedAt: '2026-11-21T03:17:00Z' });
  assert.deepEqual([...idx.plugins].sort(featuredOrder).map((p) => p.id), ['weather', 'acuario']);
});

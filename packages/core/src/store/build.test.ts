import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { validateJson, type JsonSchema } from '../config/jsonschema.ts';
import { addedPermissions, buildIndex, downloadsBucket, entryFrom, githubRepo, manifestProblems, pickReleases, stableVersions, tierOf, weeklyDownloads, withdrawnFile } from './build.ts';
import { manifest, packument } from './fixtures/npm.ts';

const schema = JSON.parse(readFileSync(new URL('../../schema/store-index.json', import.meta.url), 'utf8')) as JsonSchema;
const manifestSchema = JSON.parse(readFileSync(new URL('../../schema/manifest.json', import.meta.url), 'utf8')) as JsonSchema;

test('stableVersions and pickReleases: stable only, newest first, deprecation and provenance copied', () => {
  const p = packument('kiosko-plugin-a', ['0.1.0', '0.2.0-beta.1', '0.2.0', '0.10.0'], { deprecated: { '0.1.0': 'use 0.2' }, attest: ['0.10.0'] });
  assert.deepEqual(stableVersions(p), ['0.10.0', '0.2.0', '0.1.0']);
  const r = pickReleases(p);
  assert.deepEqual(r.map((x) => x.version), ['0.10.0', '0.2.0', '0.1.0']);
  assert.equal(r[2]!.deprecated, 'use 0.2');
  assert.deepEqual(r[0]!.provenance, {});
  assert.equal(r[1]!.provenance, undefined);
  assert.equal(r[0]!.sdk, '^0.2.0');
  assert.match(r[0]!.integrity, /^sha512-/);
  // At most 20.
  assert.equal(pickReleases(packument('kiosko-plugin-b', Array.from({ length: 30 }, (_, i) => `1.${i}.0`))).length, 20);
});

test('pickReleases: what each release asks for on top of the one before, when both manifests are known', () => {
  const p = packument('kiosko-plugin-logs', ['0.3.0', '0.4.0']);
  const r = pickReleases(p, { manifests: { '0.3.0': manifest('logs', '0.3.0', { permissions: { exec: ['docker'] } }), '0.4.0': manifest('logs', '0.4.0', { permissions: { exec: ['docker', 'journalctl'], files: ['/var/log'] } }) } });
  assert.deepEqual(r[0]!.addedPermissions, { exec: ['journalctl'], files: ['/var/log'] });
  assert.equal(r[1]!.addedPermissions, undefined);
  assert.deepEqual(addedPermissions({ network: ['a'] }, { network: ['a'] }), {});
});

test('pickReleases: withdrawn by range or by integrity', () => {
  const p = packument('kiosko-plugin-x', ['1.2.0', '1.2.1', '1.2.3']);
  const r = pickReleases(p, { withdrawn: [{ package: 'kiosko-plugin-x', versions: '>=1.2.0 <1.2.1', severity: 'disable', reason: { en: 'bad' }, date: '2026-11-20' }, { package: 'kiosko-plugin-x', versions: '0.0.0', integrity: [p.versions!['1.2.1']!.dist.integrity], severity: 'warn', reason: { en: 'meh' }, date: '2026-11-20' }] });
  assert.deepEqual(r.map((x) => [x.version, !!x.withdrawn]), [['1.2.3', false], ['1.2.1', true], ['1.2.0', true]]);
});

test('downloads: the median of four weeks, in steps', () => {
  const steady = Array.from({ length: 28 }, () => 10);
  assert.equal(weeklyDownloads(steady), 70);
  // One week with a bot spike changes nothing.
  assert.equal(weeklyDownloads([...Array(21).fill(10), ...Array(7).fill(5000)]), 70);
  assert.deepEqual([0, 9, 10, 49, 50, 640, 1000, 1_234_567].map(downloadsBucket), [0, 0, 10, 10, 50, 500, 1000, 1_000_000]);
});

test('entryFrom: an official plugin with its manifest', () => {
  const e = entryFrom({
    packument: packument('kiosko-plugin-weather', ['0.1.0', '0.2.0']),
    manifest: manifest('weather', '0.2.0', { license: 'MIT', permissions: { network: ['api.open-meteo.com'] }, markets: { only: ['ES'] }, funding: 'https://github.com/sponsors/ana' }),
    official: { bundled: true },
    downloads: Array(28).fill(20),
    shots: { 'weather/clock': { files: { en: 'gallery/img/weather-clock.png', es: 'gallery/img/es/weather-clock.png' }, w: 400, h: 200 } },
  })!;
  const p = e.plugin;
  assert.equal(p.id, 'weather');
  assert.equal(p.tier, 'official');
  assert.deepEqual(p.badges, ['official', 'bundled']);
  assert.equal(p.bundled, true);
  assert.equal(p.latest, '0.2.0');
  assert.equal(p.licenseKind, 'permissive');
  assert.deepEqual(p.popularity, { weekly: 100 });
  assert.equal(p.links.repository, 'https://github.com/ana/kiosko-plugin-weather');
  assert.equal(p.links.issues, 'https://github.com/ana/kiosko-plugin-weather/issues');
  assert.equal(p.links.funding, 'https://github.com/sponsors/ana');
  assert.deepEqual(p.markets, { only: ['ES'] });
  assert.equal(p.health.manifest, 'ok');
  assert.equal(p.health.problems, undefined);
  const w = p.widgets.find((x) => x.type === 'weather/clock')!;
  assert.deepEqual(w.shots, { en: 'gallery/img/weather-clock.png', es: 'gallery/img/es/weather-clock.png' });
  assert.ok(w.fits!.includes('bar'));
  assert.deepEqual(validateJson(schema, buildIndex([p], { generatedAt: '2026-11-21T03:17:00Z' })), []);
});

test('entryFrom: no manifest → what package.json says, and why', () => {
  const p = entryFrom({ packument: packument('kiosko-plugin-cosa', ['0.0.3'], { pkg: { os: ['darwin'], description: 'A thing' } }), manifest: null })!.plugin;
  assert.equal(p.tier, 'found');
  assert.deepEqual(p.badges, []);
  assert.deepEqual(p.platforms, ['darwin']);
  assert.deepEqual(p.description, { en: 'A thing' });
  assert.equal(p.health.manifest, 'missing');
  assert.match(p.health.problems![0]!, /no kiosko-manifest\.json/);
  assert.deepEqual(validateJson(schema, buildIndex([p], { generatedAt: '2026-11-21T03:17:00Z' })), []);
});

test('entryFrom: a manifest that is invalid, or lies about its id or version, is kept with its problems', () => {
  const bad = { ...manifest('x', '9.9.9'), id: 'other', pricing: { model: 'paid' } } as never;
  const problems = manifestProblems(bad, { id: 'x', version: '1.0.0', schema: manifestSchema });
  assert.ok(problems.some((m) => /pricing\.model/.test(m)), problems.join('\n'));
  assert.ok(problems.some((m) => /says id "other"/.test(m)));
  assert.ok(problems.some((m) => /is for version 9\.9\.9/.test(m)));
  const p = entryFrom({ packument: packument('kiosko-plugin-x', ['1.0.0']), manifest: bad, problems })!.plugin;
  assert.equal(p.health.manifest, 'invalid');
  assert.equal(p.pricing.model, 'free');
});

test('entryFrom: a broken licence is not trusted, no stable release is no entry', () => {
  const p = entryFrom({ packument: packument('kiosko-plugin-l', ['1.0.0'], { pkg: { license: 'MIT/GPL' } }), manifest: null })!.plugin;
  assert.equal(p.license, '');
  assert.equal(p.licenseKind, 'other');
  assert.equal(entryFrom({ packument: packument('kiosko-plugin-pre', ['1.0.0-rc.1']), manifest: null }), null);
});

test('buildIndex: an id taken by another package is hidden, the official one wins', () => {
  const official = entryFrom({ packument: packument('kiosko-plugin-weather', ['0.2.0']), manifest: manifest('weather', '0.2.0'), official: { bundled: true } })!.plugin;
  const squatter = entryFrom({ packument: packument('@evil/kiosko-plugin-weather', ['9.0.0']), manifest: manifest('weather', '9.0.0') })!.plugin;
  const idx = buildIndex([squatter, official], { generatedAt: '2026-11-21T03:17:00Z', hidden: [] });
  assert.equal(idx.plugins.find((p) => p.package === 'kiosko-plugin-weather')!.hidden, undefined);
  const s = idx.plugins.find((p) => p.package === '@evil/kiosko-plugin-weather')!;
  assert.equal(s.hidden, true);
  assert.match(s.health.problems!.join(), /is kiosko-plugin-weather's/);
  assert.equal(idx.categories!.length, 9);
  assert.deepEqual(validateJson(schema, idx), []);
  // Taken out by hand.
  assert.equal(buildIndex([official], { generatedAt: '2026-11-21T03:17:00Z', hidden: ['kiosko-plugin-weather'] }).plugins[0]!.hidden, true);
});

test('the index schema says no to what the editor must not trust', () => {
  const p = entryFrom({ packument: packument('kiosko-plugin-a', ['1.0.0']), manifest: manifest('a', '1.0.0') })!.plugin;
  const idx = buildIndex([p], { generatedAt: '2026-11-21T03:17:00Z' });
  const bad = (change: (x: any) => void) => {
    const x = structuredClone(idx) as any;
    change(x.plugins[0]);
    return validateJson(schema, x).map((i) => i.path);
  };
  assert.deepEqual(bad((x) => (x.releases[0].integrity = 'sha1-abc')), ['plugins[0].releases[0].integrity']);
  assert.deepEqual(bad((x) => (x.package = 'left-pad')), ['plugins[0].package']);
  assert.deepEqual(bad((x) => (x.links.repository = 'javascript:alert(1)')), ['plugins[0].links.repository']);
  assert.deepEqual(bad((x) => (x.widgets[0].shots = { en: '../../x.png' })), ['plugins[0].widgets[0].shots.en']);
});

test('small helpers', () => {
  assert.equal(tierOf({ official: true }), 'official');
  assert.equal(tierOf({ official: false }), 'found');
  assert.equal(githubRepo('https://github.com/kiosko-lcd/kiosko-plugin-weather'), 'kiosko-lcd/kiosko-plugin-weather');
  assert.equal(githubRepo('https://gitlab.com/a/b'), undefined);
  assert.deepEqual(withdrawnFile([], '2026-11-21T03:17:00Z'), { schema: 1, generatedAt: '2026-11-21T03:17:00Z', entries: [] });
});

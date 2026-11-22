import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHttp } from '@kiosko/sdk';
import { checkUpdates, pickUpdate } from './plugin-updates.ts';

const env = { sdk: '0.2.2', platform: 'linux' };
const v = (sdk?: string, os?: string[]) => ({ ...(sdk ? { peerDependencies: { '@kiosko/sdk': sdk } } : {}), ...(os ? { os } : {}) });

test('pickUpdate: the newest version that fits; why latest does not', () => {
  const weather = { id: 'weather', package: 'kiosko-plugin-weather', version: '0.2.1' };
  // Latest fits: it is the one.
  assert.deepEqual(pickUpdate(weather, { 'dist-tags': { latest: '0.2.3' }, versions: { '0.2.1': v('^0.2.0'), '0.2.2': v('^0.2.0'), '0.2.3': v('^0.2.0') } }, env), { id: 'weather', package: 'kiosko-plugin-weather', current: '0.2.1', latest: '0.2.3', version: '0.2.3' });
  // Latest needs a newer Kiosko: the newest that fits, and why latest doesn't.
  const later = pickUpdate(weather, { 'dist-tags': { latest: '0.3.0' }, versions: { '0.2.1': v('^0.2.0'), '0.2.2': v('^0.2.0'), '0.3.0': v('^0.3.0') } }, env)!;
  assert.equal(later.version, '0.2.2');
  assert.match(later.blocked!, /written for the plugin API \^0\.3\.0; this Kiosko has 0\.2\.2/);
  // Nothing newer fits: only the reason.
  const none = pickUpdate(weather, { 'dist-tags': { latest: '0.3.0' }, versions: { '0.2.1': {}, '0.3.0': v('^0.3.0') } }, env)!;
  assert.equal(none.version, undefined);
  assert.ok(none.blocked);
  // Another system: skipped.
  assert.equal(pickUpdate(weather, { 'dist-tags': { latest: '0.2.2' }, versions: { '0.2.2': v(undefined, ['win32']) } }, env)!.version, undefined);
  // Up to date, or ahead of npm (a local build): nothing.
  assert.equal(pickUpdate(weather, { 'dist-tags': { latest: '0.2.1' }, versions: {} }, env), null);
  assert.equal(pickUpdate({ ...weather, version: '0.9.0' }, { 'dist-tags': { latest: '0.2.1' }, versions: {} }, env), null);
  // A pre-release is never offered on its own.
  assert.equal(pickUpdate(weather, { 'dist-tags': { latest: '0.2.2' }, versions: { '0.2.2-beta.1': {}, '0.2.2': v('^0.2.0') } }, env)!.version, '0.2.2');
  // Without a declared range (older plugins), any version fits.
  assert.equal(pickUpdate(weather, { 'dist-tags': { latest: '0.2.5' }, versions: { '0.2.5': {} } }, env)!.version, '0.2.5');
});

test('checkUpdates: every plugin and Kiosko, with the abbreviated metadata; a package that fails is listed, never thrown', async () => {
  const asked: { url: string; accept: string | undefined }[] = [];
  const fake = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const u = String(url);
    asked.push({ url: u, accept: (init.headers as Record<string, string>).Accept });
    if (u.endsWith('/kiosko-plugin-weather')) return new Response(JSON.stringify({ 'dist-tags': { latest: '0.2.2' }, versions: { '0.2.2': v('^0.2.0') } }));
    if (u.endsWith('/%40acme%2Fkiosko-plugin-x') || u.endsWith('/@acme%2Fkiosko-plugin-x')) return new Response(JSON.stringify({ 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': {} } }));
    if (u.endsWith('/kiosko')) return new Response(JSON.stringify({ 'dist-tags': { latest: '0.3.0' }, versions: {} }));
    return new Response('{"error":"Not found"}', { status: 404 });
  }) as typeof fetch;
  const r = await checkUpdates(
    [
      { id: 'weather', package: 'kiosko-plugin-weather', version: '0.2.1' },
      { id: 'x', package: '@acme/kiosko-plugin-x', version: '1.0.0' },
      { id: 'gone', package: 'kiosko-plugin-gone', version: '0.1.0' },
    ],
    { http: createHttp({ fetch: fake }), registry: 'https://reg.test', sdk: '0.2.2', platform: 'linux', kioskoVersion: '0.2.2', now: 42 },
  );
  assert.deepEqual(r.plugins.map((p) => [p.id, p.version]), [['weather', '0.2.2']]);
  // GitHub (the same fake: 404) can't be read: npm's versions stand in for the notes, and the check still succeeds.
  assert.equal(r.kiosko?.current, '0.2.2');
  assert.equal(r.kiosko?.latest, '0.3.0');
  assert.deepEqual(r.kiosko?.versions, ['0.3.0']);
  assert.equal(r.kiosko?.notes?.from, 'npm');
  assert.deepEqual(r.kiosko?.notes?.releases.map((x) => x.version), ['0.3.0']);
  assert.deepEqual(r.errors.map((e) => e.package), ['kiosko-plugin-gone']);
  assert.equal(r.checkedAt, 42);
  assert.ok(asked.filter((a) => !a.url.startsWith('https://api.github.com/')).every((a) => a.accept === 'application/vnd.npm.install-v1+json'));
  assert.ok(asked.some((a) => a.url === 'https://reg.test/@acme%2Fkiosko-plugin-x'), 'scoped names keep their @');
});

test('npmRegistry: where npm installs from (npmmirror in mainland China), else registry.npmjs.org', async () => {
  const { npmRegistry, REGISTRY } = await import('./plugin-updates.ts');
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const home = mkdtempSync(join(tmpdir(), 'kiosko-npmrc-'));
  assert.equal(npmRegistry({}, home), REGISTRY);
  writeFileSync(join(home, '.npmrc'), 'fund=false\nregistry = "https://registry.npmmirror.com/"\n');
  assert.equal(npmRegistry({}, home), 'https://registry.npmmirror.com');
  assert.equal(npmRegistry({ npm_config_registry: 'https://r.example/' }, home), 'https://r.example');
});

test('pickUpdate: a plugin blocked only by this Kiosko\'s plugin API says which newer Kiosko takes it', () => {
  const weather = { id: 'weather', package: 'kiosko-plugin-weather', version: '0.2.1' };
  const p = { 'dist-tags': { latest: '0.3.0' }, versions: { '0.2.1': v('^0.2.0'), '0.3.0': v('^0.3.0') } };
  assert.equal(pickUpdate(weather, p, { ...env, kioskoLatest: '0.3.1' })!.unlockedBy, '0.3.1');
  // The newer Kiosko is still too old for it, or there is none: nothing promised.
  assert.equal(pickUpdate(weather, p, { ...env, kioskoLatest: '0.2.9' })!.unlockedBy, undefined);
  assert.equal(pickUpdate(weather, p, env)!.unlockedBy, undefined);
  // Blocked by the operating system: a newer Kiosko doesn't help.
  const win = { 'dist-tags': { latest: '0.3.0' }, versions: { '0.3.0': v('^0.3.0', ['win32']) } };
  assert.equal(pickUpdate(weather, win, { ...env, kioskoLatest: '0.3.1' })!.unlockedBy, undefined);
});

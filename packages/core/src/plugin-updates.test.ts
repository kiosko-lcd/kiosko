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
  assert.deepEqual(r.kiosko, { current: '0.2.2', latest: '0.3.0' });
  assert.deepEqual(r.errors.map((e) => e.package), ['kiosko-plugin-gone']);
  assert.equal(r.checkedAt, 42);
  assert.ok(asked.every((a) => a.accept === 'application/vnd.npm.install-v1+json'));
  assert.ok(asked.some((a) => a.url === 'https://reg.test/@acme%2Fkiosko-plugin-x'), 'scoped names keep their @');
});

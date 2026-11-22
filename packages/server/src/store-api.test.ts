import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildIndex, entryFrom, normalize, Registry, Runtime } from '@kiosko/core';
import { manifest, packument } from '../../core/src/store/fixtures/npm.ts';
import { startServer } from './server.ts';
import { StoreCatalog } from './store.ts';

process.env.KIOSKO_QUIET = '1';

test('the store API: the catalogue for this Kiosko, and installs only of a release it names, never without consent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kiosko-store-api-'));
  const entry = (id: string, o: { official?: boolean; os?: string[]; withdrawn?: boolean } = {}) => {
    const p = entryFrom({ packument: packument(`kiosko-plugin-${id}`, ['1.0.0'], o.os ? { pkg: { os: o.os } } : {}), manifest: manifest(id, '1.0.0', o.os ? { platforms: o.os as never } : {}), official: o.official ? { bundled: false } : null })!.plugin;
    if (o.withdrawn) p.releases[0]!.withdrawn = true;
    return p;
  };
  const other = process.platform === 'win32' ? 'linux' : 'win32';
  const index = buildIndex([entry('doom', { official: true }), entry('acuario'), entry('cosa', { os: [other] }), entry('bad', { withdrawn: true })], { generatedAt: '2026-11-21T03:17:00Z' });
  index.plugins.push({ ...entry('hidden'), hidden: true });
  const rt = new Runtime(new Registry(), normalize({ screens: [] }));
  // Below 40 000: Windows reserves blocks of its dynamic range (49 152 and up: Hyper-V, WSL), and listening there fails with EACCES.
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const store = new StoreCatalog({ cacheDir: dir, snapshot: () => index, fetch: (async () => { throw new Error('offline'); }) as never });
  const srv = startServer({ runtime: rt, host: '127.0.0.1', port, configPath: join(dir, 'config.json'), webDir: dir, version: '0', checkUpdates: false, homeassistant: false, store });
  const base = `http://127.0.0.1:${port}`;
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = { 'x-kiosko': '1' }) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: (await r.json()) as any };
  };
  try {
    const st = await call('GET', '/api/store');
    assert.equal(st.status, 200);
    assert.equal(st.body.from, 'snapshot');
    assert.equal(st.body.platform, process.platform);
    assert.match(st.body.sdk, /^\d+\.\d+\.\d+$/);
    assert.deepEqual(st.body.index.plugins.map((p: { id: string }) => p.id).sort(), ['acuario', 'bad', 'cosa', 'doom'], 'hidden ones are not offered');
    assert.equal((await call('GET', '/api/store/doom')).status, 200);
    assert.equal((await call('GET', '/api/store/hidden')).status, 404);
    // A web page can't install: no X-Kiosko header, no install.
    assert.equal((await call('POST', '/api/store/install', { id: 'doom', version: '1.0.0' }, {})).status, 403);
    const refused = async (b: object) => (await call('POST', '/api/store/install', b)).body.code;
    assert.equal(await refused({ id: 'nope', version: '1.0.0' }), 'notInStore');
    assert.equal(await refused({ id: 'hidden', version: '1.0.0' }), 'notInStore');
    assert.equal(await refused({ id: 'doom', version: '9.9.9' }), 'noRelease');
    assert.equal(await refused({ id: 'doom', version: 'latest' }), 'noRelease');
    assert.equal(await refused({ id: 'bad', version: '1.0.0' }), 'withdrawn');
    assert.equal(await refused({ id: 'cosa', version: '1.0.0', acceptRisk: true }), 'cantInstall');
    // Unreviewed: only once the person says they understand.
    assert.equal(await refused({ id: 'acuario', version: '1.0.0' }), 'acceptRisk');
    // Offline refresh: says so, keeps the catalogue.
    const r = await call('POST', '/api/store/refresh');
    assert.equal(r.status, 502);
    assert.equal(r.body.from, 'snapshot');
  } finally {
    srv.close();
    rt.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

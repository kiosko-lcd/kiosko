import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildIndex, entryFrom } from '@kiosko/core';
import { manifest, packument } from '../../core/src/store/fixtures/npm.ts';
import { StoreCatalog, indexProblem, snapshotIndex } from './store.ts';

const index = (generatedAt: string, ids = ['weather']) => buildIndex(ids.map((id) => entryFrom({ packument: packument(`kiosko-plugin-${id}`, ['0.2.0']), manifest: manifest(id, '0.2.0'), official: { bundled: true } })!.plugin), { generatedAt });

/** A fake site: answers with an index and an ETag, 304 when asked with it, or fails. */
function site(o: { index?: unknown; down?: boolean; etag?: string }) {
  const asked: { url: string; etag?: string }[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    const h = (init?.headers ?? {}) as Record<string, string>;
    asked.push({ url: String(url), ...(h['if-none-match'] ? { etag: h['if-none-match'] } : {}) });
    if (o.down) throw new TypeError('fetch failed');
    if (o.etag && h['if-none-match'] === o.etag) return new Response(null, { status: 304 });
    if (String(url).endsWith('/plugins/weather.json')) return Response.json({ schema: 1, generatedAt: 'x', plugin: {}, riskyOptions: [{ path: 'weather/current: url', risk: ['network'], secret: false }], sources: [] });
    return Response.json(o.index, { headers: o.etag ? { etag: o.etag } : {} });
  }) as typeof globalThis.fetch;
  return { fetch, asked };
}

test('the catalogue that comes with Kiosko passes its schema', () => {
  const snap = snapshotIndex();
  assert.ok(snap && snap.plugins.length > 0);
  assert.equal(indexProblem(snap), null);
});

test('store: offline from the start (the copy that comes with Kiosko), then the site’s, kept with its ETag', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kiosko-store-'));
  try {
    const snap = index('2026-11-01T00:00:00Z');
    const offline = new StoreCatalog({ cacheDir: dir, snapshot: () => snap, ...site({ down: true }), url: 'https://x.dev/store/v1' });
    assert.equal(offline.current().from, 'snapshot');
    const st = await offline.refresh();
    assert.equal(st.from, 'snapshot');
    assert.match(st.error!, /fetch failed/);
    assert.equal(st.index!.generatedAt, '2026-11-01T00:00:00Z');

    const newer = index('2026-11-21T03:17:00Z', ['weather', 'gpu']);
    const s1 = site({ index: newer, etag: '"v2"' });
    const online = new StoreCatalog({ cacheDir: dir, snapshot: () => snap, fetch: s1.fetch, url: 'https://x.dev/store/v1' });
    assert.equal((await online.refresh()).from, 'network');
    assert.equal(s1.asked[0]!.url, 'https://x.dev/store/v1/index.json');
    assert.equal(s1.asked[0]!.etag, undefined, 'the snapshot has no ETag to send');
    assert.equal(online.current().index!.plugins.length, 2);

    // Next start: the kept copy (newer than the snapshot), asked again with its ETag; 304 keeps it.
    const s2 = site({ index: newer, etag: '"v2"' });
    const again = new StoreCatalog({ cacheDir: dir, snapshot: () => snap, fetch: s2.fetch, url: 'https://x.dev/store/v1' });
    assert.equal(again.current().from, 'cache');
    await again.refresh();
    assert.equal(s2.asked[0]!.etag, '"v2"');
    assert.equal(again.current().index!.plugins.length, 2);
    assert.equal(again.current().error, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('store: a broken or tampered catalogue is refused and the one it had stays', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kiosko-store-'));
  try {
    const good = index('2026-11-21T03:17:00Z');
    const bad = structuredClone(good) as any;
    bad.plugins[0].releases[0].integrity = 'md5-123';
    const c = new StoreCatalog({ cacheDir: dir, snapshot: () => good, ...site({ index: bad }) });
    const st = await c.refresh();
    assert.equal(st.from, 'snapshot');
    assert.match(st.error!, /schema.*integrity/);
    assert.equal(st.index!.plugins[0]!.releases[0]!.integrity, good.plugins[0]!.releases[0]!.integrity);
    assert.equal((await new StoreCatalog({ cacheDir: dir, snapshot: () => good, ...site({ index: { hello: 1 } }) }).refresh()).error, 'the catalogue doesn\'t pass its schema: not a Kiosko store index (schema 1)');
    // A kept copy that is broken is ignored too.
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'index.json'), '{"index":{"schema":2}}');
    assert.equal(new StoreCatalog({ cacheDir: dir, snapshot: () => good }).current().from, 'snapshot');
    // Nothing at all: no store, and it says so.
    assert.equal(new StoreCatalog({ cacheDir: join(dir, 'none'), snapshot: () => null }).current().from, 'none');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('store: a plugin’s record, with the catalogue’s own entry', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kiosko-store-'));
  try {
    const c = new StoreCatalog({ cacheDir: dir, snapshot: () => index('2026-11-21T03:17:00Z'), ...site({}) });
    const sheet = (await c.sheet('weather'))!;
    assert.equal(sheet.riskyOptions[0]!.path, 'weather/current: url');
    assert.equal(sheet.plugin.package, 'kiosko-plugin-weather');
    assert.equal(await c.sheet('nope'), null);
    // Offline: what the index knows.
    const off = new StoreCatalog({ cacheDir: dir, snapshot: () => index('2026-11-21T03:17:00Z'), ...site({ down: true }) });
    assert.deepEqual((await off.sheet('weather'))!.riskyOptions, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

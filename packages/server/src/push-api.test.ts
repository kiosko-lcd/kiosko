import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { normalize, Registry, Runtime } from '@kiosko/core';
import core, { pushes, PUSH_LIMITS, type PushData } from '@kiosko/plugin-core';
import { parsePushBody, PUSH_RATE } from './push-api.ts';
import { startServer } from './server.ts';

process.env.KIOSKO_QUIET = '1';

const TOKEN = 'tok_0123456789abcdefABCDEF';
const page = { id: 'p', name: 'p', grid: { cols: 1, rows: 1, gap: 0, padding: 0 }, tiles: [{ id: 't', x: 0, y: 0, w: 1, h: 1, widgets: [{ id: 'w', type: 'core/push', options: { name: 'garage' } }] }] };

test('parsePushBody: JSON whatever the type, forms as objects, text as { text }', () => {
  const b = (s: string) => Buffer.from(s);
  assert.deepEqual(parsePushBody(b('{"temp":21}'), 'application/x-www-form-urlencoded'), { ok: true, payload: { temp: 21 } }, 'curl -d sends JSON as a form');
  assert.deepEqual(parsePushBody(b('value=21.5&text=hi'), 'application/x-www-form-urlencoded'), { ok: true, payload: { value: 21.5, text: 'hi' } });
  assert.deepEqual(parsePushBody(b('Deploy done\n'), 'text/plain'), { ok: true, payload: { text: 'Deploy done' } });
  assert.deepEqual(parsePushBody(b('42'), undefined), { ok: true, payload: 42 });
  assert.equal(parsePushBody(b('{"broken'), 'application/json').ok, false);
  assert.equal(parsePushBody(b('  '), 'application/json').ok, false);
});

test('POST /api/push/<name>: token-checked, size- and rate-limited, kept on disk; the payload reaches the widget', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'kiosko-push-'));
  const registry = new Registry();
  registry.add(core);
  const cfg = normalize({ push: { hooks: [{ name: 'garage', token: TOKEN }, { name: 'weak', token: 'short' }] }, screens: [{ id: 'desk', name: 'Desk', width: 64, height: 32, device: { driver: 'virtual' }, pages: [page] }] });
  const rt = new Runtime(registry, cfg);
  rt.start();
  // Below 40 000: Windows reserves blocks of its dynamic range (49 152 and up), and listening there fails with EACCES.
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const srv = startServer({ runtime: rt, host: '127.0.0.1', port, configPath: join(dir, 'config.json'), webDir: dir, home: dir, version: '0', checkUpdates: false, homeassistant: false });
  t.after(() => {
    srv.close();
    rt.stop();
    pushes.configure([]);
    rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  const push = async (path: string, init: { method?: string; body?: string | Buffer; headers?: Record<string, string> } = {}) => {
    const r = await fetch(base + path, { method: init.method ?? 'POST', headers: init.headers ?? {}, ...(init.body !== undefined ? { body: init.body } : {}) });
    const text = await r.text();
    return { status: r.status, headers: r.headers, body: text ? (JSON.parse(text) as any) : null };
  };
  const auth = { authorization: `Bearer ${TOKEN}` };
  await new Promise((r) => setTimeout(r, 50));

  // No token, a wrong one, an unknown name, a hook whose token is too short: all the same 401.
  for (const [path, headers] of [['/api/push/garage', {}], ['/api/push/garage', { authorization: 'Bearer nope' }], ['/api/push/attic', auth], ['/api/push/weak', { authorization: 'Bearer short' }]] as const) {
    const r = await push(path, { headers, body: '{"temp":1}' });
    assert.equal(r.status, 401, `${path} ${JSON.stringify(headers)}`);
    assert.equal(r.body.code, 'unauthorized');
    assert.match(r.headers.get('www-authenticate') ?? '', /^Bearer/);
  }
  assert.equal(pushes.get('garage'), undefined, 'nothing was kept');

  // The right token: no X-Kiosko needed, Bearer or ?token=.
  const ok = await push('/api/push/garage', { headers: auth, body: '{"temp":21.5,"ttlMs":60000}' });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.expiresAt > ok.body.at);
  assert.equal((await push(`/api/push/garage?token=${TOKEN}`, { body: 'value=22' , headers: { 'content-type': 'application/x-www-form-urlencoded' } })).status, 200);
  assert.deepEqual(pushes.get('garage')?.payload, { value: 22 });
  assert.equal((await push('/api/push/garage', { method: 'GET', headers: auth })).body.payload.value, 22);

  // It reaches the core/push source the Push widget reads.
  await new Promise((r) => setTimeout(r, 50));
  const data = rt.hub.data('core/push') as PushData;
  assert.deepEqual(data.hooks.garage?.payload, { value: 22 });
  assert.equal(data.hooks.garage?.history.length, 2);
  assert.deepEqual(Object.keys(data.hooks).sort(), ['garage', 'weak']);
  // And the editor's status says when.
  const state = (await (await fetch(`${base}/api/state`)).json()) as { status: { push: { name: string; at: number | null }[] } };
  assert.ok(state.status.push.find((p) => p.name === 'garage')!.at! > 0);

  // Broken JSON sent as JSON, an empty body, the wrong method.
  assert.equal((await push('/api/push/garage', { headers: { ...auth, 'content-type': 'application/json' }, body: '{"temp":' })).status, 400);
  assert.equal((await push('/api/push/garage', { headers: auth, body: '' })).status, 400);
  assert.equal((await push('/api/push/garage', { method: 'PATCH', headers: auth, body: '{}' })).status, 405);

  // Over 64 KB: refused, and the last good payload stays.
  const big = await push('/api/push/garage', { headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ text: 'x'.repeat(PUSH_LIMITS.maxBytes) }) });
  assert.equal(big.status, 413);
  assert.deepEqual(pushes.get('garage')?.payload, { value: 22 });

  // DELETE forgets it.
  assert.equal((await push('/api/push/garage', { method: 'DELETE', headers: auth })).status, 200);
  assert.equal(pushes.get('garage'), undefined);

  // The rest of the API still wants X-Kiosko.
  assert.equal((await fetch(`${base}/api/alerts`, { method: 'POST', body: '{}' })).status, 403);

  // A burst over the limit gets 429 with Retry-After.
  const codes: number[] = [];
  for (let i = 0; i < PUSH_RATE.burst + 5; i++) codes.push((await push('/api/push/garage', { headers: auth, body: String(i) })).status);
  assert.equal(codes[0], 200);
  assert.ok(codes.includes(429), codes.join(','));
  assert.ok(codes.filter((c) => c === 200).length <= PUSH_RATE.burst + 1, 'no more than a burst (and what trickled in meanwhile)');

  // Kept on disk, readable only by its owner.
  await new Promise((r) => setTimeout(r, 1200));
  const file = join(dir, 'push.json');
  assert.ok(existsSync(file));
  assert.ok('garage' in JSON.parse(readFileSync(file, 'utf8')));
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o077, 0);
});

test('a push name removed from the config forgets its payloads and refuses its token', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'kiosko-push-'));
  const rt = new Runtime(new Registry(), normalize({ push: { hooks: [{ name: 'deploy', token: TOKEN }] }, screens: [] }));
  rt.start();
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const srv = startServer({ runtime: rt, host: '127.0.0.1', port, configPath: join(dir, 'config.json'), webDir: dir, home: dir, version: '0', checkUpdates: false, homeassistant: false });
  t.after(() => {
    srv.close();
    rt.stop();
    pushes.configure([]);
    rmSync(dir, { recursive: true, force: true });
  });
  await new Promise((r) => setTimeout(r, 50));
  const post = () => fetch(`http://127.0.0.1:${port}/api/push/deploy`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` }, body: 'Deploy done' });
  assert.equal((await post()).status, 200);
  assert.deepEqual(pushes.get('deploy')?.payload, { text: 'Deploy done' });
  rt.apply(normalize({ screens: [] }));
  assert.equal(pushes.get('deploy'), undefined);
  assert.equal((await post()).status, 401);
});

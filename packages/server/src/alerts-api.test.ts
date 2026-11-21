import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { normalize, Registry, Runtime } from '@kiosko/core';
import { startServer } from './server.ts';

process.env.KIOSKO_QUIET = '1';

const page = { id: 'p', name: 'p', grid: { cols: 1, rows: 1, gap: 0, padding: 0 }, tiles: [] };

test('the alerts API: post, list, snooze, ack, take away, a screen\'s test; the editor hears of each change', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kiosko-alerts-'));
  const rt = new Runtime(new Registry(), normalize({ screens: [{ id: 'desk', name: 'Desk', width: 64, height: 32, device: { driver: 'virtual' }, pages: [page] }, { id: 'hall', name: 'Hall', width: 64, height: 32, device: { driver: 'virtual' }, pages: [page] }] }));
  rt.start();
  const port = 20_000 + Math.floor(Math.random() * 30_000);
  const srv = startServer({ runtime: rt, host: '127.0.0.1', port, configPath: join(dir, 'config.json'), webDir: dir, version: '0', checkUpdates: false, homeassistant: false });
  const base = `http://127.0.0.1:${port}`;
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = { 'x-kiosko': '1' }) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}) });
    return { status: r.status, body: (await r.json()) as any };
  };
  // The editor's live events.
  const events: string[] = [];
  const ac = new AbortController();
  const sse = fetch(`${base}/api/events`, { signal: ac.signal }).then(async (r) => {
    const reader = r.body!.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const m of new TextDecoder().decode(value).matchAll(/event: alerts\ndata: (.*)\n/g)) events.push(m[1]!);
    }
  }).catch(() => undefined);
  try {
    await new Promise((r) => setTimeout(r, 100));
    assert.equal((await call('POST', '/api/alerts', { level: 'info', title: 'x' }, {})).status, 403, 'mutating needs X-Kiosko');
    assert.equal((await call('POST', '/api/alerts', { level: 'loud', title: 'x' })).status, 400);
    assert.equal((await call('POST', '/api/alerts', 'not json')).status, 400);
    // Who published it and the instruction: optional, text, said back; checked.
    const bad = await call('POST', '/api/alerts', { level: 'warn', title: 'Quake', source: 42 });
    assert.deepEqual([bad.status, bad.body.code], [400, 'badAlert']);
    assert.match(bad.body.error, /^source is a text/);
    const quake = await call('POST', '/api/alerts', { id: 'quake', level: 'info', title: 'Earthquake M4.1', source: 'IGN', detail: 'Felt nearby' });
    assert.deepEqual([quake.body.alert.source, quake.body.alert.detail], ['IGN', 'Felt nearby']);
    assert.equal((await call('DELETE', '/api/alerts/quake')).status, 200);
    const posted = await call('POST', '/api/alerts', { id: 'door', level: 'warn', title: 'Someone at the door', icon: 'bell-ring', screens: ['hall'] });
    assert.equal(posted.status, 200);
    assert.deepEqual(posted.body.alert.screens, ['hall']);
    await call('POST', '/api/alerts', { id: 'ci', level: 'critical', title: 'main is broken' });
    assert.deepEqual((await call('GET', '/api/alerts')).body.alerts.map((a: { id: string }) => a.id), ['ci', 'door']);
    assert.deepEqual(rt.status().screens.map((s) => s.alert), ['ci', 'ci']);
    // Also in the editor's state.
    assert.equal((await call('GET', '/api/state')).body.alerts.length, 2);

    const snoozed = await call('POST', '/api/alerts/ci/snooze', { minutes: 5 });
    assert.equal(snoozed.status, 200);
    assert.ok(snoozed.body.alerts.find((a: { id: string }) => a.id === 'ci').snoozedUntil > Date.now() + 4 * 60_000);
    assert.deepEqual(rt.status().screens.map((s) => s.alert), [null, 'door']);
    assert.equal((await call('POST', '/api/alerts/door/ack')).status, 200);
    assert.equal((await call('POST', '/api/alerts/door/ack')).status, 404);
    assert.equal((await call('DELETE', '/api/alerts/ci')).status, 200);
    assert.equal((await call('DELETE', '/api/alerts/ci')).status, 404);
    await call('POST', '/api/alerts', { id: 'stuck', level: 'warn', title: 'Stuck', dismissible: false });
    assert.equal((await call('POST', '/api/alerts/stuck/ack')).status, 409);
    await call('DELETE', '/api/alerts/stuck');

    const t = await call('POST', '/api/screens/desk/test-alert', { level: 'info' });
    assert.equal(t.body.alert.id, 'test:desk');
    assert.equal(t.body.alert.level, 'info');
    assert.deepEqual(rt.status().screens.map((s) => s.alert), ['test:desk', null]);
    assert.equal((await call('POST', '/api/screens/nope/test-alert', {})).status, 404);

    await new Promise((r) => setTimeout(r, 100));
    assert.ok(events.length >= 5, `${events.length} alerts events`);
    assert.deepEqual(JSON.parse(events.at(-1)!).map((a: { id: string }) => a.id), ['test:desk']);
  } finally {
    ac.abort();
    await sse;
    srv.close();
    rt.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

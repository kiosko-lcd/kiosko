import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Registry, Runtime } from '@kiosko/core';
import core from '@kiosko/plugin-core';
import { FakeScreen } from '../../core/src/remote/fake-screen.test-helper.ts';
import { startServer } from './server.ts';
import { starterConfig } from './starter.ts';

process.env.KIOSKO_QUIET = '1';

const until = async (what: () => boolean | Promise<boolean>, ms = 5000) => {
  const end = Date.now() + ms;
  while (!(await what())) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
};

/**
 * The editor's pairing flow against a fake screen: start (the screen shows a code), a wrong code
 * (refused, no key), the right one (the key lands in a new screen's config, never shown), the
 * screen online with Kiosko's rotation, then unpairing.
 */
test('remote screens: pair from the editor, the key goes to the config, the screen comes online, unpair', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kiosko-remote-api-'));
  const reg = new Registry();
  reg.add(core);
  const rt = new Runtime(reg, starterConfig(reg, { locale: 'en' }));
  const fake = new FakeScreen({ code: '135790', rot: 90 });
  const fport = await fake.listen();
  const port = 20_000 + Math.floor(Math.random() * 30_000);
  const configPath = join(dir, 'config.json');
  const srv = startServer({ runtime: rt, host: '127.0.0.1', port, configPath, webDir: dir, version: '0', checkUpdates: false, homeassistant: false });
  rt.start();
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'content-type': 'application/json', 'x-kiosko': '1' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: (await r.json()) as any };
  };
  try {
    const bad = await call('POST', '/api/remote/pair', { uid: fake.uid, host: '127.0.0.1', port: fport });
    assert.equal(bad.status, 200);
    assert.equal(bad.body.screen.uid, fake.uid);
    const wrong = await call('POST', `/api/remote/pair/${bad.body.pairId}`, { code: '000000' });
    assert.equal(wrong.body.code, 'remote.badCode');
    assert.equal(fake.key, null);
    const start = await call('POST', '/api/remote/pair', { uid: fake.uid, host: '127.0.0.1', port: fport });
    const done = await call('POST', `/api/remote/pair/${start.body.pairId}`, { code: '135790' });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    const saved = JSON.parse(readFileSync(configPath, 'utf8'));
    const s = saved.screens.find((x: any) => x.id === done.body.screenId);
    assert.equal(s.device.driver, 'remote');
    assert.equal(s.device.uid, fake.uid);
    assert.equal(s.device.key, fake.key!.toString('hex'));
    // The glass is 172×320 and turned 90°: the page is 320×172, and the screen keeps turning it.
    assert.deepEqual([s.width, s.height, s.rotate], [320, 172, 90]);
    // mDNS can't find a fake: give it its address, as a user on another subnet would.
    s.device.host = '127.0.0.1';
    s.device.port = fport;
    const st = await call('GET', '/api/state');
    assert.equal((await call('PUT', '/api/config', { config: saved, baseRev: st.body.rev })).status, 200);
    await until(() => fake.frames.length > 0);
    assert.equal(fake.sets[0]!.rot, 90);
    const status = (await call('GET', '/api/state')).body.status.screens.find((x: any) => x.id === s.id);
    assert.equal(status.device.remote.online, true);
    // Turned upright in Kiosko's config (the device itself unchanged): the screen turns too.
    const cur = (await call('GET', '/api/state')).body;
    const upright = structuredClone(cur.config);
    const u = upright.screens.find((x: any) => x.id === s.id);
    Object.assign(u, { width: 172, height: 320, rotate: 0 });
    assert.equal((await call('PUT', '/api/config', { config: upright, baseRev: cur.rev })).status, 200);
    await until(() => fake.rot === 0);
    const logs = await call('GET', `/api/screens/${s.id}/remote/logs`);
    assert.match(logs.body.text, /fake: hello/);
    const un = await call('POST', `/api/screens/${s.id}/remote/unpair`);
    assert.deepEqual(un.body, { ok: true, told: true });
    assert.equal(fake.key, null);
    assert.equal(JSON.parse(readFileSync(configPath, 'utf8')).screens.find((x: any) => x.id === s.id).device.key, undefined);
  } finally {
    srv.close();
    rt.stop();
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

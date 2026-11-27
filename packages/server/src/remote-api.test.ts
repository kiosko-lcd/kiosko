import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { Registry, Runtime, SCREEN_FIRMWARE } from '@kiosko/core';
import core from '@kiosko/plugin-core';
import { FakeScreen } from '../../core/src/remote/fake-screen.test-helper.ts';
import { remoteScreen } from './remote-api.ts';
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
  // Below 40 000: Windows reserves blocks of its dynamic range (49 152 and up: Hyper-V, WSL), and listening there fails with EACCES.
  const port = 20_000 + Math.floor(Math.random() * 20_000);
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

/**
 * Night mode and the firmware this Kiosko brings, against a fake screen that says firmware 0.1.3
 * of the Waveshare board: switched off, its backlight goes off (and back); the editor offers the
 * newer firmware, which comes from this version's release (a fake GitHub), checked, and sent.
 */
test('remote screens: backlight off while switched off; the firmware offered is downloaded, checked and sent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kiosko-remote-fw-'));
  const reg = new Registry();
  reg.add(core);
  const key = Buffer.alloc(32, 9);
  const fake = new FakeScreen({ key, bright: 70, dims: true, model: 'waveshare-esp32c6-lcd-1.47', fw: '0.1.3' });
  const fport = await fake.listen();
  const cfg = starterConfig(reg, { locale: 'en' });
  const s = remoteScreen(reg, { uid: fake.uid, id: fake.id, w: 172, h: 320, rot: 90, max: 98_000 }, key.toString('hex'), 'en', '127.0.0.1');
  if (s.device.driver === 'remote') s.device.port = fport;
  cfg.screens = [s];
  const rt = new Runtime(reg, cfg);
  const image = Buffer.concat([Buffer.from([0xe9]), Buffer.alloc(40_000, 3)]);
  const name = `kiosko-screen-${SCREEN_FIRMWARE.version}-waveshare-esp32c6-lcd-1.47.bin`;
  const url = `https://github.com/kiosko-lcd/kiosko/releases/download/v9.8.7/${name}`;
  const asked: string[] = [];
  let online = true;
  const firmwareFetch = async (u: string) => {
    asked.push(u);
    if (!online) throw new TypeError('fetch failed');
    const body = u === url ? image : u === `${url}.sha256` ? Buffer.from(`${createHash('sha256').update(image).digest('hex')}  ${name}\n`) : null;
    return { ok: !!body, status: body ? 200 : 404, arrayBuffer: async () => new Uint8Array(body ?? []).buffer, text: async () => String(body ?? '') };
  };
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const srv = startServer({ runtime: rt, host: '127.0.0.1', port, configPath: join(dir, 'config.json'), webDir: dir, version: '9.8.7', checkUpdates: false, homeassistant: false, firmwareFetch });
  rt.start();
  const call = async (method: string, path: string) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'x-kiosko': '1' } });
    return { status: r.status, body: (await r.json()) as any };
  };
  const remote = async () => (await call('GET', '/api/state')).body.status.screens.find((x: any) => x.id === s.id).device.remote;
  try {
    await until(async () => (await remote())?.online === true && fake.frames.length > 0);
    assert.equal(fake.dim, -1);
    rt.setOff(s.id, true);
    await until(() => fake.dim === 0);
    assert.equal(fake.bright, 70, 'the saved brightness stays');
    rt.setOff(s.id, false);
    await until(() => fake.dim === -1);
    const r = await remote();
    assert.equal(r.dimmable, true);
    assert.equal(r.firmwareOffer, SCREEN_FIRMWARE.version);
    // GitHub out of reach: a clear error, nothing sent.
    online = false;
    const off = await call('POST', `/api/screens/${s.id}/remote/firmware`);
    assert.equal(off.body.code, 'remote.downloadFailed');
    assert.equal(fake.ota, null);
    online = true;
    const ok = await call('POST', `/api/screens/${s.id}/remote/firmware`);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.version, SCREEN_FIRMWARE.version);
    assert.ok((fake.ota as Buffer | null)?.equals(image));
    assert.deepEqual(asked.slice(-2), [`${url}.sha256`, url]);
    // Up to date: nothing to offer, and nothing is sent on a call anyway.
    fake.fw = SCREEN_FIRMWARE.version;
    fake.drop();
    await until(async () => (await remote())?.online === true && (await remote()).fw === SCREEN_FIRMWARE.version);
    assert.equal((await remote()).firmwareOffer, null);
    assert.equal((await call('POST', `/api/screens/${s.id}/remote/firmware`)).body.code, 'remote.upToDate');
  } finally {
    srv.close();
    rt.stop();
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { Registry, Runtime, normalize, type Config } from '@kiosko/core';
import core from '@kiosko/plugin-core';
import { ViewerClient, type KeyStore, type ViewerState, type WsLike } from '../../web/src/viewer/client.ts';
import { followViewer } from './browser-api.ts';
import { startServer } from './server.ts';
import { starterConfig } from './starter.ts';

process.env.KIOSKO_QUIET = '1';

const until = async (what: () => boolean | Promise<boolean>, ms = 8000) => {
  const end = Date.now() + ms;
  while (!(await what())) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
};

/** Two ports below 40 000 (Windows reserves blocks of its dynamic range above: EACCES). */
const ports = () => {
  const base = 20_000 + Math.floor(Math.random() * 9_000) * 2;
  return { editor: base, net: base + 1 };
};

class MemStore implements KeyStore {
  m = new Map<string, string>();
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
}

/** A Kiosko with the network-screens server on (or not), and a way to call the editor's API. */
function kiosko(t: TestContext, net?: Config['networkScreens'], sandbox?: Parameters<typeof startServer>[0]['sandbox']) {
  const dir = mkdtempSync(join(tmpdir(), 'kiosko-browser-'));
  mkdirSync(join(dir, 'viewer'));
  writeFileSync(join(dir, 'viewer', 'index.html'), '<!doctype html><title>viewer</title>');
  writeFileSync(join(dir, 'viewer', 'viewer.js'), 'console.log(1)');
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>editor</title>');
  writeFileSync(join(dir, 'secret.txt'), 'editor file');
  const reg = new Registry();
  reg.add(core);
  const cfg = normalize({ ...starterConfig(reg, { locale: 'en' }), ...(net ? { networkScreens: net } : {}) });
  const rt = new Runtime(reg, cfg);
  rt.browsers.setOptions({ waitMs: 300, maxWaitMs: 2000 });
  const p = ports();
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify(cfg));
  const srv = startServer({ runtime: rt, host: '127.0.0.1', port: p.editor, configPath, webDir: dir, version: '0', checkUpdates: false, homeassistant: false, ...(sandbox !== undefined ? { sandbox } : {}) });
  rt.start();
  const viewers: ViewerClient[] = [];
  t.after(async () => {
    for (const v of viewers) v.stop();
    srv.close();
    rt.stop();
    await srv.networkScreensReady();
    rmSync(dir, { recursive: true, force: true });
  });
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`http://127.0.0.1:${p.editor}${path}`, { method, headers: { 'content-type': 'application/json', 'x-kiosko': '1' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: (await r.json()) as any };
  };
  /** A viewer as the page runs it, with Node's WebSocket. */
  const viewer = (store = new MemStore(), size = { w: 1280, h: 800 }) => {
    const v = {
      store,
      size,
      states: [] as ViewerState[],
      frames: [] as { n: number; bytes: number; jpeg: boolean }[],
      client: null as unknown as ViewerClient,
    };
    v.client = new ViewerClient({
      url: `ws://127.0.0.1:${rt.config.networkScreens?.port ?? p.net}/ws`,
      store,
      WebSocket: WebSocket as unknown as new (url: string) => WsLike,
      id: 'Test tablet',
      size: () => v.size,
      onState: (s) => v.states.push(s),
      onFrame: (n, img, done) => {
        v.frames.push({ n, bytes: img.length, jpeg: img[0] === 0xff && img[1] === 0xd8 });
        done(true, 3);
      },
      retryMs: 50,
      maxRetryMs: 200,
    });
    viewers.push(v.client);
    v.client.start();
    return v;
  };
  return { rt, srv, call, viewer, port: p, configPath, dir };
}

const state = (v: { client: ViewerClient }) => v.client.state;

test('network screens: off unless the config says so, nothing listens', async (t) => {
  const k = kiosko(t);
  await k.srv.networkScreensReady();
  const st = await k.call('GET', '/api/browser');
  assert.equal(st.body.enabled, false);
  assert.equal(st.body.listening, false);
  // Nothing on the port it would use.
  for (const port of [k.port.net, 7429]) {
    const refused = await new Promise<boolean>((ok) => {
      const s = connect({ host: '127.0.0.1', port });
      s.once('connect', () => (s.destroy(), ok(false)));
      s.once('error', () => ok(true));
    });
    if (port === k.port.net) assert.ok(refused, 'nothing listens on its port');
  }
  // Switched on in the config, it listens; switched off, it stops.
  const cur = (await k.call('GET', '/api/state')).body;
  const on = structuredClone(cur.config);
  on.networkScreens = { enabled: true, host: '127.0.0.1', port: k.port.net };
  assert.equal((await k.call('PUT', '/api/config', { config: on, baseRev: cur.rev })).status, 200);
  await k.srv.networkScreensReady();
  assert.equal((await fetch(`http://127.0.0.1:${k.port.net}/`)).status, 200);
  const st2 = (await k.call('GET', '/api/browser')).body;
  assert.equal(st2.listening, true);
  assert.deepEqual(st2.urls, [`http://127.0.0.1:${k.port.net}/`]);
  const cur2 = (await k.call('GET', '/api/state')).body;
  const off = structuredClone(cur2.config);
  off.networkScreens.enabled = false;
  await k.call('PUT', '/api/config', { config: off, baseRev: cur2.rev });
  await k.srv.networkScreensReady();
  await assert.rejects(fetch(`http://127.0.0.1:${k.port.net}/`));
});

test('network screens: only the viewer is served there; the editor and its API are not', async (t) => {
  const k = kiosko(t, { enabled: true, host: '127.0.0.1', port: ports().net });
  await k.srv.networkScreensReady();
  const net = k.rt.config.networkScreens!.port;
  const at = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${net}${path}`, init);
  const home = await at('/');
  assert.equal(home.status, 200);
  assert.match(await home.text(), /viewer/);
  assert.match(home.headers.get('content-security-policy') ?? '', /default-src 'none'/);
  assert.equal((await at('/viewer.js')).status, 200);
  for (const path of ['/api/state', '/api/config', '/api/version', '/api/events', '/api/browser', '/api/plugins/install', '/api/screens/x/frame.jpg', '/secret.txt', '/../secret.txt', '/%2e%2e/secret.txt', '/index.html/../secret.txt', '/assets/app.js', '/viewer', '/ws/x']) {
    const r = await at(path);
    assert.equal(r.status, 404, path);
    assert.doesNotMatch(await r.text(), /editor|"config"|version/, path);
  }
  for (const method of ['POST', 'PUT', 'DELETE']) {
    assert.equal((await at('/api/config', { method, headers: { 'x-kiosko': '1', 'content-type': 'application/json' }, body: method === 'DELETE' ? null : '{}' })).status, 404, method);
    assert.equal((await at('/', { method, body: method === 'DELETE' ? null : 'x' })).status, 404, `${method} /`);
  }
  // The editor still answers on its own port, as before.
  assert.equal((await k.call('GET', '/api/version')).status, 200);
  // A WebSocket from a page of another site is refused.
  const foreign = await new Promise<string>((ok) => {
    const s = connect({ host: '127.0.0.1', port: net }, () => s.write(`GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${net}\r\nOrigin: http://evil.example\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${Buffer.alloc(16, 1).toString('base64')}\r\n\r\n`));
    let got = '';
    s.on('data', (d) => (got += d));
    s.on('close', () => ok(got));
    s.on('error', () => ok(got));
  });
  assert.match(foreign, /^HTTP\/1\.1 403/);
});

test('browser screens: pair with the code it shows (a wrong one first), frames, turning, reload, revoke', async (t) => {
  const k = kiosko(t, { enabled: true, host: '127.0.0.1', port: ports().net });
  await k.srv.networkScreensReady();
  const v = viewer(k);
  await until(() => state(v).kind === 'pairing');
  const first = (state(v) as { code: string }).code;
  assert.match(first, /^\d{6}$/);
  const list = (await k.call('GET', '/api/browser')).body;
  assert.equal(list.waiting.length, 1);
  const w = list.waiting[0];
  assert.equal(w.uid, v.client.uid);
  assert.deepEqual([w.id, w.w, w.h], ['Test tablet', 1280, 800]);
  // Unpaired: no frame, whatever Kiosko paints.
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(v.frames.length, 0);

  // A wrong code: refused, the browser makes a new one, and the next try has to wait.
  const wrong = String((Number(first) + 1) % 1_000_000).padStart(6, '0');
  const bad = await k.call('POST', '/api/browser/pair', { uid: w.uid, code: wrong });
  assert.equal(bad.status, 409);
  assert.equal(bad.body.code, 'browser.badCode');
  await until(() => state(v).kind === 'pairing' && (state(v) as { code: string }).code !== first);
  const second = (state(v) as { code: string }).code;
  const early = await k.call('POST', '/api/browser/pair', { uid: w.uid, code: second });
  assert.equal(early.status, 429);
  assert.equal(early.body.code, 'browser.wait');
  assert.equal(v.store.getItem('kiosko.viewer.key'), null);
  await new Promise((r) => setTimeout(r, 450));

  // The right one: a new screen with the browser's size, its key in the config only.
  const ok = await k.call('POST', '/api/browser/pair', { uid: w.uid, code: second });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const saved = JSON.parse(readFileSync(k.configPath, 'utf8'));
  const s = saved.screens.find((x: any) => x.id === ok.body.screenId);
  assert.equal(s.device.driver, 'browser');
  assert.equal(s.device.uid, v.client.uid);
  assert.match(s.device.key, /^[0-9a-f]{64}$/);
  assert.equal(v.store.getItem('kiosko.viewer.key'), s.device.key);
  assert.deepEqual([s.width, s.height, s.rotate], [1280, 800, 0]);
  assert.equal((await k.call('GET', '/api/browser')).body.waiting.length, 0);

  // It connects with its key and gets frames, decoded here and ACKed.
  await until(() => state(v).kind === 'live');
  await until(() => v.frames.length > 0);
  assert.ok(v.frames[0]!.jpeg);
  await until(async () => (await k.call('GET', '/api/state')).body.status.screens.find((x: any) => x.id === s.id)?.device.browser?.online === true);
  const dev = (await k.call('GET', '/api/state')).body.status.screens.find((x: any) => x.id === s.id).device;
  assert.equal(dev.code, 'browserOnline');
  assert.equal(dev.browser.address, '127.0.0.1');

  // Turned to portrait: the screen turns with it.
  v.size = { w: 800, h: 1280 };
  v.client.sizeChanged();
  await until(() => {
    const x = k.rt.config.screens.find((y) => y.id === s.id)!;
    return x.width === 800 && x.height === 1280 && x.rotate === 90;
  });
  // A few pixels less (an address bar): not worth new layouts.
  v.size = { w: 800, h: 1250 };
  v.client.sizeChanged();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(k.rt.config.screens.find((y) => y.id === s.id)!.height, 1280);

  // Reloaded (the same storage): back without pairing again, and the picture comes at once.
  v.client.stop();
  const n = v.frames.length;
  const again = viewer(k, v.store, { w: 800, h: 1280 });
  await until(() => state(again).kind === 'live');
  await until(() => again.frames.length > 0);
  assert.ok(!again.states.some((x) => x.kind === 'pairing'));
  assert.equal(v.frames.length, n);

  // Revoked in the editor: it forgets its key and shows a code again; the config has no key any more.
  const un = await k.call('POST', `/api/screens/${s.id}/browser/unpair`);
  assert.deepEqual(un.body, { ok: true, told: true });
  await until(() => state(again).kind === 'pairing');
  assert.equal(again.store.getItem('kiosko.viewer.key'), null);
  assert.equal(JSON.parse(readFileSync(k.configPath, 'utf8')).screens.find((x: any) => x.id === s.id).device.key, undefined);
  const frames = again.frames.length;
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(again.frames.length, frames, 'no frame after revoking');
});

test('browser screens: a key Kiosko does not have gets nothing, and the viewer goes back to pairing', async (t) => {
  const k = kiosko(t, { enabled: true, host: '127.0.0.1', port: ports().net });
  await k.srv.networkScreensReady();
  // A browser screen in the config with one key; a viewer with its id but another key.
  const cur = (await k.call('GET', '/api/state')).body;
  const cfg = structuredClone(cur.config);
  cfg.screens[0].device = { driver: 'browser', uid: 'abcdefabcdef', key: 'aa'.repeat(32) };
  assert.equal((await k.call('PUT', '/api/config', { config: cfg, baseRev: cur.rev })).status, 200);
  const store = new MemStore();
  store.setItem('kiosko.viewer.uid', 'abcdefabcdef');
  store.setItem('kiosko.viewer.key', 'bb'.repeat(32));
  const v = viewer(k, store);
  await until(() => state(v).kind === 'pairing');
  assert.equal(v.frames.length, 0);
  assert.ok(!v.states.some((x) => x.kind === 'live'));
  assert.equal(store.getItem('kiosko.viewer.key'), null);
});

test('followViewer: turns on a change of orientation, resizes on a real change only', () => {
  const reg = new Registry();
  reg.add(core);
  const s = normalize({ screens: [{ width: 1280, height: 800, device: { driver: 'browser', uid: 'abcdefabcdef' }, pages: [{ tiles: [{ x: 0, y: 0, w: 4, h: 2 }] }] }] }).screens[0]!;
  assert.equal(followViewer(s, 1270, 790), false);
  assert.equal(followViewer(s, 800, 1280), true);
  assert.deepEqual([s.width, s.height, s.rotate], [800, 1280, 90]);
  assert.equal(followViewer(s, 1920, 1080), true);
  assert.deepEqual([s.width, s.height, s.rotate], [1920, 1080, 0]);
  s.device = { driver: 'browser', uid: 'abcdefabcdef', follow: false };
  assert.equal(followViewer(s, 800, 1280), false);
});

/** A viewer on `k`'s network-screens server. */
function viewer(k: ReturnType<typeof kiosko>, store?: MemStore, size?: { w: number; h: number }) {
  return k.viewer(store, size);
}

test('browser screens: paused (nothing painted) while no browser shows it, a full frame when one comes back', async (t) => {
  const k = kiosko(t, { enabled: true, host: '127.0.0.1', port: ports().net });
  await k.srv.networkScreensReady();
  const v = viewer(k);
  await until(() => state(v).kind === 'pairing');
  const w = (await k.call('GET', '/api/browser')).body.waiting[0];
  const ok = await k.call('POST', '/api/browser/pair', { uid: w.uid, code: (state(v) as { code: string }).code });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const id = ok.body.screenId as string;
  const screen = async () => (await k.call('GET', '/api/state')).body.status.screens.find((x: any) => x.id === id);
  await until(() => v.frames.length > 0);
  assert.equal((await screen()).presence.state, 'present');
  assert.equal((await screen()).paused, false);

  // Gone: absent, and the screen is paused; nothing is painted for it.
  v.client.stop();
  await until(async () => (await screen()).paused === true);
  assert.equal((await screen()).presence.state, 'absent');
  const painted: string[] = [];
  const onFrame = (f: { screenId: string }) => void (f.screenId === id && painted.push(f.screenId));
  k.rt.on('frame', onFrame);
  t.after(() => k.rt.off('frame', onFrame));
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(painted.length, 0, 'nothing painted while no browser shows it');

  // Back (the same storage): resumed, and a full frame comes although the page looks the same.
  const again = viewer(k, v.store);
  await until(() => state(again).kind === 'live');
  await until(() => again.frames.length > 0);
  assert.ok(again.frames[0]!.jpeg);
  await until(async () => (await screen()).paused === false);
  assert.equal((await screen()).presence.state, 'present');
});

test('network screens in a sandbox: on 127.0.0.1 whatever the config says, unless it may use the LAN', async (t) => {
  const sb = (allow: ('usb' | 'remote' | 'lan')[]) => ({ dir: tmpdir(), allow: new Set(allow), registry: tmpdir(), expires: null });
  const shut = kiosko(t, { enabled: true, host: '0.0.0.0', port: ports().net }, sb([]));
  await shut.srv.networkScreensReady();
  const a = (await shut.call('GET', '/api/browser')).body;
  assert.deepEqual([a.listening, a.host, a.sandboxed], [true, '127.0.0.1', true]);
  assert.deepEqual(shut.srv.screens?.listening?.host, '127.0.0.1');
  const open = kiosko(t, { enabled: true, host: '0.0.0.0', port: ports().net }, sb(['lan']));
  await open.srv.networkScreensReady();
  const b = (await open.call('GET', '/api/browser')).body;
  assert.deepEqual([b.listening, b.host, b.sandboxed], [true, '0.0.0.0', undefined]);
});

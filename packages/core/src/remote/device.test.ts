import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { FakeScreen } from './fake-screen.test-helper.ts';
import { Pairing, ScreenError, T, Wire, openSession, sendSealed } from './link.ts';
import { seal } from './crypto.ts';
import { RemoteDevice, type ScreenFinder } from './device.ts';
import { otaUpdate, screenLogs, unpairScreen } from './ops.ts';
import { buildQuery, parseResponse, ScreenBrowser, type FoundScreen } from './mdns.ts';

const until = async (what: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!what()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
};

/** Closes what a test opened even when it fails, so a failing test can't hang the run. */
function after(t: { after: (fn: () => unknown) => void }) {
  const items: { close: () => unknown }[] = [];
  t.after(async () => {
    for (const i of items.reverse()) await Promise.resolve(i.close()).catch(() => undefined);
  });
  return <T extends { close: () => unknown }>(x: T): T => (items.push(x), x);
}

/** A browser that knows nothing: these tests give the host. */
const noMdns = (): ScreenFinder & EventEmitter => Object.assign(new EventEmitter(), { get: (_uid: string): FoundScreen | undefined => undefined, retain() {}, release() {}, query() {} });

test('pairing: the right code gives both sides the same key; a wrong one gives none', async (t) => {
  const cleanup = after(t);
  const fake = cleanup(new FakeScreen({ code: '480213' }));
  const port = await fake.listen();
  const bad = await Pairing.start('127.0.0.1', port, 'test');
  await assert.rejects(bad.finish('480214'), (e: unknown) => e instanceof ScreenError && e.code === 'badCode');
  assert.equal(fake.key, null);
  const p = await Pairing.start('127.0.0.1', port, 'test');
  assert.equal(p.info.uid, fake.uid);
  assert.equal(p.info.paired, false);
  const key = await p.finish('480 213');
  assert.ok(fake.key && key.equals(fake.key));
  // Paired now: another pairing is refused (the real screen wants BOOT pressed).
  await assert.rejects(Pairing.start('127.0.0.1', port, 'test'), (e: unknown) => e instanceof ScreenError && e.code === 'pairingClosed');
  await fake.close();
});

test('session: the wrong key is refused, quietly and for a while', async (t) => {
  const cleanup = after(t);
  const fake = cleanup(new FakeScreen({ key: randomBytes(32) }));
  const port = await fake.listen();
  const logs: string[] = [];
  const d = cleanup(new RemoteDevice({ driver: 'remote', uid: fake.uid, key: randomBytes(32).toString('hex'), host: '127.0.0.1', port }, (m) => logs.push(m), 0, { browser: noMdns(), retryMs: 10 }));
  await until(() => d.status.code === 'remoteBadKey');
  assert.equal(d.status.ok, false);
  assert.ok(fake.events.includes('refused:badKey'));
  assert.equal(fake.sessions, 0);
  assert.equal(logs.length, 1, 'one log line, not one per retry');
  d.close();
  await fake.close();
});

test('session: a replayed or forged message ends it', async (t) => {
  const cleanup = after(t);
  const key = randomBytes(32);
  const fake = cleanup(new FakeScreen({ key }));
  const port = await fake.listen();
  const { wire, session } = await openSession('127.0.0.1', port, key, fake.uid);
  const msg = seal(session.tx, T.FRAME, Buffer.concat([Buffer.from([0, 0, 0, 1]), Buffer.from('jpeg')]));
  wire.write(msg);
  await until(() => fake.frames.length === 1);
  wire.write(msg); // the same bytes again
  await until(() => wire.closed);
  assert.equal(fake.frames.length, 1);
  // A screen that isn't the one paired can't fake the answer: another uid is caught first.
  await assert.rejects(openSession('127.0.0.1', port, key, 'ffffffffffff'), (e: unknown) => e instanceof ScreenError && e.code === 'otherScreen');
  await fake.close();
});

test('frames: one in flight, the newest wins, the rotation goes first, nothing piles up', async (t) => {
  const cleanup = after(t);
  const key = randomBytes(32);
  const fake = cleanup(new FakeScreen({ key, decodeMs: 40 }));
  const port = await fake.listen();
  const d = cleanup(new RemoteDevice({ driver: 'remote', uid: fake.uid, key: key.toString('hex'), host: '127.0.0.1', port }, () => {}, 90, { browser: noMdns(), settings: () => ({ lang: 'es', tz: 'CET-1CEST,M3.5.0,M10.5.0/3' }) }));
  await until(() => d.status.code === 'remoteOnline' && fake.sets.length > 0);
  assert.deepEqual(fake.sets[0], { rot: 90, lang: 'es', tz: 'CET-1CEST,M3.5.0,M10.5.0/3' });
  for (let i = 1; i <= 30; i++) {
    await d.send(Buffer.from(`frame ${i}`));
    await new Promise((r) => setTimeout(r, 5));
  }
  await until(() => fake.frames.at(-1)?.jpeg.toString() === 'frame 30');
  assert.equal(fake.inflightMax, 1);
  assert.ok(fake.frames.length < 15, `only some of 30 went (${fake.frames.length})`);
  assert.ok(d.status.remote.dropped > 10);
  assert.ok(d.status.remote.rttMs! >= 40);
  // An unchanged picture is not sent again.
  const n = fake.frames.length;
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(fake.frames.length, n);
  // The rotation changed in Kiosko's config: pushed at once, and again on a reconnection.
  d.setRotation(0);
  await until(() => fake.rot === 0);
  d.setLed('ff0000', 500);
  await until(() => fake.leds.length === 1);
  assert.deepEqual(fake.leds[0], { rgb: 'ff0000', blink: 500 });
  d.close();
  await fake.close();
});

test('resync: after a drop it reconnects with a growing pause and sends the current frame and rotation again', async (t) => {
  const cleanup = after(t);
  const key = randomBytes(32);
  const fake = cleanup(new FakeScreen({ key }));
  const port = await fake.listen();
  const d = cleanup(new RemoteDevice({ driver: 'remote', uid: fake.uid, key: key.toString('hex'), host: '127.0.0.1', port }, () => {}, 270, { browser: noMdns(), retryMs: 20 }));
  await d.send(Buffer.from('the page'));
  await until(() => fake.frames.length === 1);
  fake.drop();
  await until(() => fake.sessions === 2 && fake.frames.length === 2);
  assert.equal(fake.frames[1]!.jpeg.toString(), 'the page', 'the same picture, without a new paint');
  assert.equal(fake.sets.length, 2);
  assert.equal(fake.sets[1]!.rot, 270);
  d.close();
  await fake.close();
});

test('resync: a screen that is away is retried quietly until it comes back', async (t) => {
  const cleanup = after(t);
  const key = randomBytes(32);
  // Away: the port takes the connection and drops it, as a rebooting screen would.
  const fake = cleanup(new FakeScreen({ key }));
  fake.away = true;
  const port = await fake.listen();
  const logs: string[] = [];
  const d = cleanup(new RemoteDevice({ driver: 'remote', uid: fake.uid, key: key.toString('hex'), host: '127.0.0.1', port }, (m) => logs.push(m), 0, { browser: noMdns(), retryMs: 10, maxRetryMs: 40 }));
  await d.send(Buffer.from('waiting'));
  await until(() => d.status.code === 'remoteOffline');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(logs.length, 1, 'one line while it is away, however many retries');
  fake.away = false;
  await until(() => fake.frames.length === 1);
  assert.equal(d.status.code, 'remoteOnline');
  assert.equal(logs.length, 2);
});

test('resync: an announcement of the screen cuts the pause short', async (t) => {
  const cleanup = after(t);
  const key = randomBytes(32);
  const fake = cleanup(new FakeScreen({ key }));
  const port = await fake.listen();
  const mdns = noMdns();
  let known: FoundScreen | undefined;
  mdns.get = () => known;
  const d = cleanup(new RemoteDevice({ driver: 'remote', uid: fake.uid, key: key.toString('hex') }, () => {}, 0, { browser: mdns, retryMs: 60_000, maxRetryMs: 60_000 }));
  await until(() => d.status.code === 'remoteOffline');
  known = { uid: fake.uid, id: 'desk', model: 'fake', w: 172, h: 320, rot: 0, fw: '0', proto: 1, paired: true, address: '127.0.0.1', port, hostname: 'kiosko-desk.local', seenAt: Date.now() };
  mdns.emit('found', known);
  await until(() => d.status.code === 'remoteOnline', 1000);
  d.close();
  await fake.close();
});

test('brightness and temperature: pushed and read where the firmware has them, absent where not', async (t) => {
  const cleanup = after(t);
  const key = randomBytes(32);
  // Firmware 0.1.2: it says its temperature and brightness, and takes the config's brightness.
  const fake = cleanup(new FakeScreen({ key, tempC: 41.5, bright: 70 }));
  const port = await fake.listen();
  const d = cleanup(new RemoteDevice({ driver: 'remote', uid: fake.uid, key: key.toString('hex'), host: '127.0.0.1', port, brightness: 40 }, () => undefined, 0, { browser: noMdns() }));
  await until(() => d.status.remote.bright === 40);
  assert.equal(fake.sets[0]!.bright, 40);
  assert.equal(fake.bright, 40);
  assert.equal(d.status.remote.tempC, 41.5);
  d.close();
  await fake.close();
  // An older firmware, and no brightness in the config: nothing is pushed, nothing is shown.
  const old = cleanup(new FakeScreen({ key }));
  const port2 = await old.listen();
  const d2 = cleanup(new RemoteDevice({ driver: 'remote', uid: old.uid, key: key.toString('hex'), host: '127.0.0.1', port: port2 }, () => undefined, 0, { browser: noMdns() }));
  await until(() => old.sets.length > 0 && d2.status.remote.online);
  assert.equal('bright' in old.sets[0]!, false);
  assert.equal(d2.status.remote.tempC, null);
  assert.equal(d2.status.remote.bright, null);
  d2.close();
  await old.close();
});

test('dimming: sent on connect and on change where the firmware dims (0.1.4), ignored by older firmware', async (t) => {
  const cleanup = after(t);
  const key = randomBytes(32);
  const fake = cleanup(new FakeScreen({ key, bright: 70, dims: true, model: 'waveshare-esp32c6-lcd-1.47', fw: '0.1.3' }));
  const port = await fake.listen();
  const d = cleanup(new RemoteDevice({ driver: 'remote', uid: fake.uid, key: key.toString('hex'), host: '127.0.0.1', port }, () => undefined, 0, { browser: noMdns() }));
  // Dimmed before it connects: the first SET carries it.
  d.setDim(0);
  await until(() => d.status.remote.online && fake.sets.length > 0);
  assert.equal(fake.sets[0]!.dim, 0);
  await until(() => d.status.remote.dimmable === true);
  assert.equal(fake.dim, 0);
  // The saved brightness is not touched.
  assert.equal(fake.bright, 70);
  d.setDim(30);
  await until(() => fake.dim === 30);
  d.setDim(30); // the same again: nothing sent
  d.setDim(null);
  await until(() => fake.dim === -1);
  assert.equal(fake.sets.filter((x) => 'dim' in x).length, 3);
  assert.equal(d.status.remote.dim, null);
  // It says 0.1.3 and is a board this Kiosko has firmware for: a newer one is offered.
  assert.ok(d.status.remote.firmwareOffer);
  d.close();
  await fake.close();
  // Firmware 0.1.3: it gets the field and ignores it; Kiosko knows it can't dim.
  const old = cleanup(new FakeScreen({ key, bright: 70, model: 'fake' }));
  const port2 = await old.listen();
  const d2 = cleanup(new RemoteDevice({ driver: 'remote', uid: old.uid, key: key.toString('hex'), host: '127.0.0.1', port: port2 }, () => undefined, 0, { browser: noMdns() }));
  d2.setDim(0);
  await until(() => d2.status.remote.online && d2.status.remote.dimmable === false);
  assert.equal(old.dim, undefined);
  assert.equal(d2.status.remote.firmwareOffer, null, 'no firmware for an unknown board');
  d2.close();
  await old.close();
});

test('ops: OTA, logs and unpairing, with the driver standing aside', async (t) => {
  const cleanup = after(t);
  const key = randomBytes(32);
  const fake = cleanup(new FakeScreen({ key }));
  const port = await fake.listen();
  const d = cleanup(new RemoteDevice({ driver: 'remote', uid: fake.uid, key: key.toString('hex'), host: '127.0.0.1', port }, () => {}, 0, { browser: noMdns(), retryMs: 10 }));
  await until(() => d.status.code === 'remoteOnline');
  const image = Buffer.concat([Buffer.from([0xe9]), randomBytes(50_000)]);
  const seen: number[] = [];
  await d.exclusive((h, p) => otaUpdate(h, p, key, fake.uid, image, (s) => seen.push(s)));
  assert.ok(fake.ota?.equals(image));
  assert.equal(seen.at(-1), image.length);
  await assert.rejects(otaUpdate('127.0.0.1', port, key, fake.uid, Buffer.from('nope')), /not an ESP32 firmware/);
  assert.match(await d.exclusive((h, p) => screenLogs(h, p, key, fake.uid)), /fake: hello/);
  await until(() => d.status.code === 'remoteOnline');
  await d.exclusive((h, p) => unpairScreen(h, p, key, fake.uid));
  assert.equal(fake.key, null);
  await until(() => d.status.code === 'remoteBadKey');
  d.close();
  await fake.close();
});

test('mdns: a screen’s announcement is read into what the driver needs', () => {
  const name = (n: string) => Buffer.concat([...n.split('.').map((p) => Buffer.concat([Buffer.from([p.length]), Buffer.from(p)])), Buffer.from([0])]);
  const rr = (n: string, type: number, data: Buffer, ttl = 120) => {
    const h = Buffer.alloc(10);
    h.writeUInt16BE(type, 0);
    h.writeUInt16BE(0x8001, 2);
    h.writeUInt32BE(ttl, 4);
    h.writeUInt16BE(data.length, 8);
    return Buffer.concat([name(n), h, data]);
  };
  const txt = (kv: Record<string, string>) => Buffer.concat(Object.entries(kv).map(([k, v]) => Buffer.concat([Buffer.from([k.length + v.length + 1]), Buffer.from(`${k}=${v}`)])));
  const srv = Buffer.concat([Buffer.from([0, 0, 0, 0, 0x1d, 0x04]), name('kiosko-desk.local')]);
  const head = Buffer.alloc(12);
  head.writeUInt16BE(0x8400, 2);
  head.writeUInt16BE(4, 6);
  const packet = Buffer.concat([
    head,
    rr('_kiosko-screen._tcp.local', 12, name('desk._kiosko-screen._tcp.local')),
    rr('desk._kiosko-screen._tcp.local', 33, srv),
    rr('desk._kiosko-screen._tcp.local', 16, txt({ id: 'desk', uid: 'a085e3ae92d0', model: 'waveshare-esp32c6-lcd-1.47', w: '172', h: '320', rot: '90', fw: '0.1.0', proto: '1', paired: '0' })),
    rr('kiosko-desk.local', 1, Buffer.from([192, 168, 50, 168])),
  ]);
  assert.equal(parseResponse(packet).length, 4);
  assert.deepEqual(parseResponse(buildQuery('_kiosko-screen._tcp.local', 12)), [], 'a query is not an answer');
  const b = new ScreenBrowser();
  const found: FoundScreen[] = [];
  b.on('found', (s: FoundScreen) => found.push(s));
  (b as unknown as { onMessage: (m: Buffer) => void }).onMessage(packet);
  assert.equal(found.length, 1);
  const { seenAt: _seen, ...s } = found[0]!;
  assert.deepEqual(s, { uid: 'a085e3ae92d0', id: 'desk', model: 'waveshare-esp32c6-lcd-1.47', w: 172, h: 320, rot: 90, fw: '0.1.0', proto: 1, paired: false, address: '192.168.50.168', port: 7428, hostname: 'kiosko-desk.local' });
  assert.equal(b.get('a085e3ae92d0')?.address, '192.168.50.168');
  b.close();
});

test('wire: messages split across packets or glued together come out whole', async (t) => {
  const cleanup = after(t);
  const srv = createServer((s) => {
    const a = Buffer.from([0, 0, 0, 3, T.PONG, 0x7b, 0x7d, 0, 0, 0, 3, T.PONG]);
    s.write(a.subarray(0, 2));
    setTimeout(() => s.write(Buffer.concat([a.subarray(2), Buffer.from([0x7b, 0x7d])])), 10);
  });
  const port = await new Promise<number>((r) => srv.listen(0, '127.0.0.1', () => r((srv.address() as { port: number }).port)));
  const w = await Wire.open('127.0.0.1', port);
  assert.equal((await w.plain(T.PONG)) && 'ok', 'ok');
  assert.deepEqual(await w.plain(T.PONG), {});
  w.close();
  srv.close();
  void sendSealed;
});

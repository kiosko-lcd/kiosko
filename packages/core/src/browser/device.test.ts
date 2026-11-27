import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BrowserDevice } from './device.ts';
import type { BrowserHub, ViewerSession } from './hub.ts';
import { BT } from './protocol.ts';

/** The hub as the device sees it: it registers, asks whether the server is on and says when the viewer resized. */
function fakeHub(serverOn = true) {
  const sinks: unknown[] = [];
  return { sinks, serverOn, register: (s: unknown) => sinks.push(s), unregister: () => {}, emit: () => true } as unknown as BrowserHub & { sinks: unknown[] };
}

/** A viewer session: what it is sent, and whether it was closed. */
function fakeSession() {
  const sent: { type: number; num: number; body: Buffer }[] = [];
  const s = {
    info: { uid: 'abcdefabcdef', id: 'Tablet', w: 800, h: 480, address: '192.0.2.7', since: Date.now() },
    send: (type: number, payload: Buffer) => sent.push({ type, num: payload.readUInt32BE(0), body: payload.subarray(4) }),
    close: () => {},
  };
  return { session: s as unknown as ViewerSession, sent };
}

const KEY = 'ab'.repeat(32);
const cfg = { driver: 'browser' as const, uid: 'abcdefabcdef', key: KEY };
const quiet = () => {};

test('browser presence: absent unpaired, without its server, or while no browser shows it; present while one does', () => {
  assert.equal(new BrowserDevice({ driver: 'browser', uid: 'abcdefabcdef' }, quiet, fakeHub()).presence.state, 'absent');
  assert.equal(new BrowserDevice(cfg, quiet, null).presence.state, 'absent');
  assert.equal(new BrowserDevice(cfg, quiet, fakeHub(false)).presence.state, 'absent');
  const d = new BrowserDevice(cfg, quiet, fakeHub());
  assert.equal(d.presence.state, 'absent');
  assert.match(d.presence.why, /no browser/);
  const { session } = fakeSession();
  d.attach(session);
  assert.equal(d.presence.state, 'present');
  assert.match(d.presence.why, /192\.0\.2\.7/);
  d.detach(session);
  assert.equal(d.presence.state, 'absent');
});

test('a browser back within a tick gets the kept frame at once (an unchanged picture is not painted again)', async () => {
  const d = new BrowserDevice(cfg, quiet, fakeHub());
  const a = fakeSession();
  d.attach(a.session);
  await d.send(Buffer.from('frame-1'));
  assert.deepEqual(a.sent.map((x) => x.body.toString()), ['frame-1']);
  d.message(a.session, BT.ACK, { n: a.sent[0]!.num });
  d.detach(a.session);
  // Not paused (the runtime hasn't looked yet): the frame it has is the current one.
  const b = fakeSession();
  d.attach(b.session);
  assert.deepEqual(b.sent.map((x) => x.body.toString()), ['frame-1']);
});

test('after a pause the kept frame is dropped: the resume brings a fresh one, sent at once', async () => {
  const d = new BrowserDevice(cfg, quiet, fakeHub());
  const a = fakeSession();
  d.attach(a.session);
  await d.send(Buffer.from('old'));
  d.detach(a.session);
  d.pausedChanged(true);
  const b = fakeSession();
  d.attach(b.session);
  assert.equal(b.sent.length, 0, 'an old picture is not shown');
  d.pausedChanged(false);
  await d.send(Buffer.from('fresh'));
  assert.deepEqual(b.sent.map((x) => x.body.toString()), ['fresh']);
});

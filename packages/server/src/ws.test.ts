import assert from 'node:assert/strict';
import { connect, type Socket } from 'node:net';
import { test } from 'node:test';
import { BrowserHub, BROWSER_PROTO, MAX_VIEWER_MESSAGE } from '@kiosko/core';
import { ScreensServer } from './screens-server.ts';

const port = () => 20_000 + Math.floor(Math.random() * 18_000);

/** A raw WebSocket client: the handshake by hand, then frames as given. */
async function raw(p: number, path = '/ws'): Promise<{ sock: Socket; head: string; frames: () => Buffer; closed: Promise<void> }> {
  const sock = connect({ host: '127.0.0.1', port: p });
  await new Promise((ok) => sock.once('connect', ok));
  sock.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${p}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${Buffer.alloc(16, 7).toString('base64')}\r\n\r\n`);
  let buf = Buffer.alloc(0);
  sock.on('data', (d) => (buf = Buffer.concat([buf, d])));
  const closed = new Promise<void>((ok) => sock.once('close', () => ok()));
  sock.on('error', () => undefined);
  await new Promise((r) => setTimeout(r, 100));
  const end = buf.indexOf('\r\n\r\n');
  const head = buf.subarray(0, end).toString();
  buf = buf.subarray(end + 4);
  return { sock, head, frames: () => buf, closed };
}

/** A masked client frame. */
function frame(op: number, payload: Buffer, { fin = true, mask = true } = {}): Buffer {
  const n = payload.length;
  const h = n < 126 ? Buffer.from([(fin ? 0x80 : 0) | op, (mask ? 0x80 : 0) | n]) : n < 65536 ? Buffer.from([(fin ? 0x80 : 0) | op, (mask ? 0x80 : 0) | 126, n >> 8, n & 0xff]) : Buffer.concat([Buffer.from([(fin ? 0x80 : 0) | op, (mask ? 0x80 : 0) | 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; })()]);
  if (!mask) return Buffer.concat([h, payload]);
  const key = Buffer.from([1, 2, 3, 4]);
  return Buffer.concat([h, key, Buffer.from(payload.map((x, i) => x ^ key[i & 3]!))]);
}

const closeCode = (b: Buffer) => {
  const i = b.findIndex((x, k) => x === 0x88 && k + 3 < b.length);
  return i < 0 ? null : b.readUInt16BE(i + 2);
};

function plainMsg(type: number, obj: unknown): Buffer {
  const p = Buffer.from(JSON.stringify(obj));
  const h = Buffer.alloc(5);
  h.writeUInt32BE(p.length + 1);
  h[4] = type;
  return Buffer.concat([h, p]);
}

async function server(t: import('node:test').TestContext, hub = new BrowserHub(() => null)) {
  const s = new ScreensServer({ hub, viewerDir: '/nonexistent', maxPerAddress: 3 });
  const p = port();
  await s.listen('127.0.0.1', p);
  t.after(() => s.close());
  return { s, p, hub };
}

test('ws: a message over the limit, a text one or an unmasked one ends the connection', async (t) => {
  const { p } = await server(t);
  const cases: [Buffer, number][] = [
    [frame(0x2, Buffer.alloc(MAX_VIEWER_MESSAGE + 1)), 1009],
    [frame(0x1, Buffer.from('hello')), 1003],
    [frame(0x2, Buffer.from('x'), { mask: false }), 1002],
    [Buffer.concat([frame(0x2, Buffer.alloc(3000), { fin: false }), frame(0x0, Buffer.alloc(3000))]), 1009],
  ];
  for (const [bytes, code] of cases) {
    const c = await raw(p);
    assert.match(c.head, /^HTTP\/1\.1 101/);
    c.sock.write(bytes);
    await c.closed;
    assert.equal(closeCode(c.frames()), code);
  }
});

test('ws: only /ws upgrades; so many at once from one address', async (t) => {
  const { p } = await server(t);
  const other = await raw(p, '/api/events');
  assert.match(other.head, /^HTTP\/1\.1 404/);
  const open = [await raw(p), await raw(p), await raw(p)];
  for (const c of open) assert.match(c.head, /^HTTP\/1\.1 101/);
  const fourth = await raw(p);
  assert.match(fourth.head, /^HTTP\/1\.1 429/);
  for (const c of open) c.sock.destroy();
});

test('hub: a viewer that says nothing, or nonsense, is dropped; a fragmented INFO is read whole', async (t) => {
  const hub = new BrowserHub(() => null, { helloMs: 200 });
  const { p } = await server(t, hub);
  const silent = await raw(p);
  await silent.closed;
  const junk = await raw(p);
  junk.sock.write(frame(0x2, Buffer.from('not a message')));
  await junk.closed;
  const info = plainMsg(0x02, { proto: BROWSER_PROTO, uid: 'a1b2c3d4e5f6', id: 'Frag', w: 640, h: 480, want: 'pair', nonce: '11'.repeat(32) });
  const frag = await raw(p);
  frag.sock.write(Buffer.concat([frame(0x2, info.subarray(0, 10), { fin: false }), frame(0x9, Buffer.from('hi')), frame(0x0, info.subarray(10))]));
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(hub.waiting().map((w) => [w.uid, w.id, w.w, w.h]), [['a1b2c3d4e5f6', 'Frag', 640, 480]]);
  frag.sock.destroy();
});

test('hub: a wrong code makes the next pairing wait, longer each time', async () => {
  let now = 1_000_000;
  const hub = new BrowserHub(() => null, { waitMs: 5000, maxWaitMs: 60_000, now: () => now });
  const sent: Buffer[] = [];
  const handlers: ((m: Buffer) => void)[] = [];
  const link = { address: '10.0.0.2', send: (m: Uint8Array) => void sent.push(Buffer.from(m)), close: () => undefined, onMessage: (f: (m: Buffer) => void) => void handlers.push(f), onClose: () => undefined };
  const waitingViewer = (uid: string) => {
    sent.length = 0;
    handlers.length = 0;
    hub.accept(link);
    for (const f of handlers) f(plainMsg(0x02, { proto: BROWSER_PROTO, uid, id: 'x', w: 800, h: 600, want: 'pair', nonce: '22'.repeat(32) }));
  };
  const answerWrong = () => {
    // PAIR_X came: answer with a Y and a proof made of nothing.
    for (const f of handlers) f(plainMsg(0x09, { Y: '04' + '00'.repeat(64), c: '00'.repeat(32) }));
  };
  const waits: number[] = [];
  for (let i = 0; i < 5; i++) {
    waitingViewer(`aaaaaaaaaa0${i}`);
    const p = hub.pair(`aaaaaaaaaa0${i}`, '123456');
    await new Promise((r) => setImmediate(r));
    answerWrong();
    await assert.rejects(p, (e: { code?: string }) => e.code === 'badCode');
    waits.push(hub.waitSeconds());
    await assert.rejects(hub.pair(`aaaaaaaaaa0${i}`, '123456'), (e: { code?: string }) => e.code === 'wait' || e.code === 'gone');
    now += hub.waitSeconds() * 1000;
  }
  assert.deepEqual(waits, [5, 10, 20, 40, 60]);
  hub.closeAll();
});

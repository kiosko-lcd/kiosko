/**
 * Kiosko's end of a connection to a remote screen (docs/remote-screen.md):
 * the framing, the handshake (HELLO/INFO, AUTH/AUTH_OK), pairing (SPAKE2 on
 * the code the screen shows) and sealed messages.
 */
import { connect, type Socket } from 'node:net';
import { randomBytes } from 'node:crypto';
import { KEY_LEN, LABEL_AUTH_D, LABEL_AUTH_K, NONCE_LEN, PORT, PROTO, SpakeA, authMac, equal, open, seal, sessionKeys, type Session } from './crypto.ts';

export const T = {
  HELLO: 0x01,
  INFO: 0x02,
  AUTH: 0x03,
  AUTH_OK: 0x04,
  ERROR: 0x05,
  PAIR_START: 0x06,
  PAIR_READY: 0x07,
  PAIR_X: 0x08,
  PAIR_Y: 0x09,
  PAIR_CONFIRM: 0x0a,
  PAIR_OK: 0x0b,
  FRAME: 0x10,
  ACK: 0x11,
  SET: 0x12,
  STATE: 0x13,
  LED: 0x14,
  PING: 0x15,
  PONG: 0x16,
  UNPAIR: 0x17,
  OTA_BEGIN: 0x18,
  OTA_ACK: 0x19,
  OTA_DATA: 0x1a,
  OTA_END: 0x1b,
  OTA_DONE: 0x1c,
  LOGS: 0x1d,
} as const;

/** What a screen says of itself before anything is authenticated (and in its mDNS TXT). */
export interface ScreenInfo {
  proto: number;
  uid: string;
  id: string;
  model: string;
  /** Native size of the glass (portrait for the Waveshare 1.47"). */
  w: number;
  h: number;
  rot: number;
  fw: string;
  paired: boolean;
  /** Whether it takes a pairing now (unpaired, or BOOT was pressed). */
  pairing?: boolean;
  /** Largest message it takes, in bytes. */
  max: number;
}

/** A refusal from the screen: `code` is one of docs/remote-screen.md's. */
export class ScreenError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'ScreenError';
  }
}

const MAX_MSG = 1 << 20;

/** One TCP connection, message by message. */
export class Wire {
  private buf: Buffer = Buffer.alloc(0);
  private waiting: { resolve: (m: { hdr: Buffer; body: Buffer }) => void; reject: (e: Error) => void } | null = null;
  private queue: { hdr: Buffer; body: Buffer }[] = [];
  private ended: Error | null = null;
  readonly sock: Socket;

  constructor(sock: Socket) {
    this.sock = sock;
    sock.setNoDelay(true);
    sock.on('data', (d: Buffer) => this.onData(d));
    const end = (e?: Error) => this.fail(e ?? new Error('connection closed'));
    sock.on('error', end);
    sock.on('close', () => end());
  }

  static open(host: string, port = PORT, timeoutMs = 4000): Promise<Wire> {
    return new Promise((resolve, reject) => {
      const s = connect({ host, port });
      const t = setTimeout(() => {
        s.destroy();
        reject(Object.assign(new Error(`no answer from ${host}:${port}`), { code: 'ETIMEDOUT' }));
      }, timeoutMs);
      s.once('connect', () => {
        clearTimeout(t);
        s.setKeepAlive(true, 10_000);
        resolve(new Wire(s));
      });
      s.once('error', (e) => {
        clearTimeout(t);
        reject(e);
      });
    });
  }

  private onData(d: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32BE(0);
      if (len < 1 || len > MAX_MSG) return this.fail(new Error(`bad message length ${len}`));
      if (this.buf.length < 4 + len) break;
      const m = { hdr: Buffer.from(this.buf.subarray(0, 4)), body: Buffer.from(this.buf.subarray(4, 4 + len)) };
      this.buf = this.buf.subarray(4 + len);
      if (this.waiting) {
        const w = this.waiting;
        this.waiting = null;
        w.resolve(m);
      } else this.queue.push(m);
    }
  }

  private fail(e: Error): void {
    if (this.ended) return;
    this.ended = e;
    this.sock.destroy();
    const w = this.waiting;
    this.waiting = null;
    w?.reject(e);
  }

  get closed(): boolean {
    return !!this.ended;
  }

  /** The next message, raw; rejects on close or after `timeoutMs`. */
  next(timeoutMs = 10_000): Promise<{ hdr: Buffer; body: Buffer }> {
    const q = this.queue.shift();
    if (q) return Promise.resolve(q);
    if (this.ended) return Promise.reject(this.ended);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.waiting = null;
        reject(Object.assign(new Error('the screen stopped answering'), { code: 'ETIMEDOUT' }));
      }, timeoutMs);
      this.waiting = {
        resolve: (m) => {
          clearTimeout(t);
          resolve(m);
        },
        reject: (e) => {
          clearTimeout(t);
          reject(e);
        },
      };
    });
  }

  write(b: Buffer): void {
    if (!this.ended) this.sock.write(b);
  }

  sendPlain(type: number, obj: unknown): void {
    const p = Buffer.from(JSON.stringify(obj));
    const h = Buffer.alloc(5);
    h.writeUInt32BE(p.length + 1);
    h[4] = type;
    this.write(Buffer.concat([h, p]));
  }

  /** A plain message of type `want` (JSON); an ERROR from the screen becomes a ScreenError. */
  async plain<J = Record<string, unknown>>(want: number, timeoutMs = 10_000): Promise<J> {
    const { body } = await this.next(timeoutMs);
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(body.subarray(1).toString('utf8')) as Record<string, unknown>;
    } catch {
      throw new Error('the screen sent something unreadable');
    }
    if (body[0] === T.ERROR) throw new ScreenError(String(j.code ?? 'error'), String(j.msg ?? 'refused'));
    if (body[0] !== want) throw new Error(`unexpected message 0x${body[0]!.toString(16)} from the screen`);
    return j as J;
  }

  close(): void {
    this.fail(new Error('closed'));
  }
}

function toInfo(j: Record<string, unknown>): ScreenInfo {
  const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  return { proto: num(j.proto), uid: String(j.uid ?? ''), id: String(j.id ?? ''), model: String(j.model ?? ''), w: num(j.w), h: num(j.h), rot: num(j.rot), fw: String(j.fw ?? ''), paired: j.paired === true, ...(typeof j.pairing === 'boolean' ? { pairing: j.pairing } : {}), max: num(j.max, 64 * 1024) };
}

/** HELLO → INFO. */
export async function hello(w: Wire, want: 'session' | 'pair' | 'info'): Promise<{ info: ScreenInfo; nk: Buffer; nd: Buffer }> {
  const nk = randomBytes(NONCE_LEN);
  w.sendPlain(T.HELLO, { proto: PROTO, nonce: nk.toString('hex'), want });
  const j = await w.plain(T.INFO);
  const nd = Buffer.from(String(j.nonce ?? ''), 'hex');
  if (nd.length !== NONCE_LEN) throw new Error('the screen sent no nonce');
  const info = toInfo(j);
  if (info.proto !== PROTO) {
    // It also sends an ERROR and closes; say it plainly.
    throw new ScreenError('proto', `the screen speaks protocol ${info.proto}, this Kiosko ${PROTO}: update one of them`);
  }
  return { info, nk, nd };
}

/** What a screen at `host` says of itself (no key needed). */
export async function probe(host: string, port = PORT): Promise<ScreenInfo> {
  const w = await Wire.open(host, port);
  try {
    return (await hello(w, 'info')).info;
  } finally {
    w.close();
  }
}

/** Opens an authenticated session: both sides prove the pairing key over fresh nonces. */
export async function openSession(host: string, port: number, key: Buffer, expectUid?: string): Promise<{ wire: Wire; info: ScreenInfo; session: Session }> {
  if (key.length !== KEY_LEN) throw new ScreenError('notPaired', 'no pairing key for this screen');
  const wire = await Wire.open(host, port);
  try {
    const { info, nk, nd } = await hello(wire, 'session');
    if (expectUid && info.uid !== expectUid) throw new ScreenError('otherScreen', `another screen (${info.id}, ${info.uid}) answers at ${host}`);
    wire.sendPlain(T.AUTH, { mac: authMac(key, LABEL_AUTH_K, nk, nd, info.uid).toString('hex') });
    const ok = await wire.plain<{ mac?: string }>(T.AUTH_OK);
    const want = authMac(key, LABEL_AUTH_D, nk, nd, info.uid);
    if (!equal(Buffer.from(String(ok.mac ?? ''), 'hex'), want)) throw new ScreenError('badScreen', 'the screen could not prove it has the key: not the paired one');
    return { wire, info, session: sessionKeys(key, nk, nd, 'kiosko') };
  } catch (err) {
    wire.close();
    throw err;
  }
}

/** A sealed message on an open session. */
export function sendSealed(wire: Wire, s: Session, type: number, payload: Buffer | object = {}): void {
  wire.write(seal(s.tx, type, Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload))));
}

/** The next sealed message; throws if it doesn't open (tampered, replayed, out of order). */
export async function nextSealed(wire: Wire, s: Session, timeoutMs = 15_000): Promise<{ type: number; payload: Buffer; json: () => Record<string, unknown> }> {
  const { hdr, body } = await wire.next(timeoutMs);
  const m = open(s.rx, hdr, body);
  return { ...m, json: () => JSON.parse(m.payload.toString('utf8') || '{}') as Record<string, unknown> };
}

/**
 * A pairing in progress: the screen shows a code; `finish(code)` runs SPAKE2
 * with it and gives the pairing key. One attempt per code: a wrong one ends
 * this pairing (start another; the screen makes each wait longer).
 */
export class Pairing {
  readonly info: ScreenInfo;
  readonly ttl: number;
  private readonly wire: Wire;
  private done = false;
  constructor(wire: Wire, info: ScreenInfo, ttl: number) {
    this.wire = wire;
    this.info = info;
    this.ttl = ttl;
  }

  static async start(host: string, port: number, name: string): Promise<Pairing> {
    const wire = await Wire.open(host, port);
    try {
      const { info } = await hello(wire, 'pair');
      wire.sendPlain(T.PAIR_START, { name: name.slice(0, 40) });
      const r = await wire.plain<{ ttl?: number }>(T.PAIR_READY);
      return new Pairing(wire, info, typeof r.ttl === 'number' ? r.ttl : 120);
    } catch (err) {
      wire.close();
      throw err;
    }
  }

  async finish(code: string): Promise<Buffer> {
    if (this.done) throw new ScreenError('pairingOver', 'this pairing is over: start again');
    this.done = true;
    try {
      const clean = code.replace(/\D/g, '');
      if (clean.length !== 6) throw new ScreenError('badCode', 'the code has 6 digits');
      const a = new SpakeA(this.info.uid, clean);
      this.wire.sendPlain(T.PAIR_X, { X: a.X.toString('hex') });
      const y = await this.wire.plain<{ Y?: string; c?: string }>(T.PAIR_Y, 15_000);
      const k = a.finish(Buffer.from(String(y.Y ?? ''), 'hex'));
      if (!equal(Buffer.from(String(y.c ?? ''), 'hex'), k.cB)) {
        // Not the code on the screen (or not that screen): say so, and tell it nothing more.
        this.wire.sendPlain(T.PAIR_CONFIRM, { c: '00'.repeat(32) });
        throw new ScreenError('badCode', 'the code does not match the one on the screen');
      }
      this.wire.sendPlain(T.PAIR_CONFIRM, { c: k.cA.toString('hex') });
      await this.wire.plain(T.PAIR_OK, 15_000);
      return k.key;
    } finally {
      this.wire.close();
    }
  }

  cancel(): void {
    this.done = true;
    this.wire.close();
  }
}

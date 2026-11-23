/**
 * Kiosko's end of browser screens (docs/browser-screens.md, protocol.ts): the
 * viewers connected to the network-screens server, by the id each keeps.
 *
 * A viewer that has a key proves it (and Kiosko proves it back) and gets a
 * session, handed to the `browser` driver of the screen with its id
 * (device.ts). One that has none waits to be paired: the editor lists it, and
 * the code someone types there runs SPAKE2 with the one it shows. A wrong code
 * makes the next pairing wait, longer each time. Nothing reaches a viewer that
 * has not proven it has the key of a screen in the config.
 *
 * Transport-free: the server (packages/server/src/screens-server.ts) gives it
 * each WebSocket as a `ViewerLink`.
 */
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { KEY_LEN, LABEL_AUTH_D, LABEL_AUTH_K, NONCE_LEN, SpakeA, authMac, equal, open, seal, sessionKeys, type Session } from '../remote/crypto.ts';
import { BROWSER_PROTO, BT, MAX_SIDE, MAX_VIEWER_MESSAGE, MIN_SIDE, VIEWER_UID } from './protocol.ts';

/** One WebSocket, as the hub needs it. */
export interface ViewerLink {
  /** Who is at the other end (IP), for the editor's list and the per-address limits. */
  readonly address: string;
  send(msg: Uint8Array): void;
  close(): void;
  onMessage(f: (msg: Buffer) => void): void;
  onClose(f: () => void): void;
}

/** A viewer as the editor sees it. */
export interface ViewerInfo {
  uid: string;
  /** What it says it is ("Android", "iPad"…), for telling them apart. */
  id: string;
  /** Its picture: viewport in device pixels. */
  w: number;
  h: number;
  address: string;
  since: number;
}

/** A refusal the editor can say: `code` is `browser.<code>` in its dictionaries. */
export class BrowserError extends Error {
  readonly code: string;
  readonly params: Record<string, string | number> | undefined;
  constructor(code: string, message: string, params?: Record<string, string | number>) {
    super(message);
    this.code = code;
    this.params = params;
    this.name = 'BrowserError';
  }
}

/** What the `browser` driver of a screen does with its viewer's session (device.ts). */
export interface ViewerSink {
  readonly uid: string;
  attach(s: ViewerSession): void;
  detach(s: ViewerSession): void;
  /** A sealed message from the viewer (STATE, ACK…). */
  message(s: ViewerSession, type: number, json: Record<string, unknown>): void;
  /** The hub's server started or stopped. */
  serverChanged(on: boolean): void;
}

export interface HubOptions {
  /** A sealed ping this often; a session that says nothing for 3 of them is dropped. */
  pingMs?: number;
  /** Viewers waiting to be paired, at most (the oldest ones beyond go). */
  maxWaiting?: number;
  /** First wait after a wrong code, ms (doubles each time, up to `maxWaitMs`). */
  waitMs?: number;
  maxWaitMs?: number;
  /** The first message must come within this. */
  helloMs?: number;
  now?: () => number;
}

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const clampSide = (v: unknown) => Math.max(MIN_SIDE, Math.min(MAX_SIDE, Math.round(num(v, MIN_SIDE))));

function plainOf(msg: Buffer): { type: number; json: Record<string, unknown> } | null {
  if (msg.length < 5 || msg.readUInt32BE(0) !== msg.length - 4) return null;
  try {
    const j = JSON.parse(msg.subarray(5).toString('utf8')) as unknown;
    return j && typeof j === 'object' && !Array.isArray(j) ? { type: msg[4]!, json: j as Record<string, unknown> } : null;
  } catch {
    return null;
  }
}

function plain(type: number, obj: unknown): Buffer {
  const p = Buffer.from(JSON.stringify(obj));
  const h = Buffer.alloc(5);
  h.writeUInt32BE(p.length + 1);
  h[4] = type;
  return Buffer.concat([h, p]);
}

/** An authenticated viewer: sealed messages both ways, a ping to know it is still there. */
export class ViewerSession {
  readonly info: ViewerInfo;
  private readonly link: ViewerLink;
  private readonly keys: Session;
  private sink: ViewerSink | null = null;
  private closed = false;
  private lastRx: number;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly onEnd: (s: ViewerSession) => void;
  private readonly now: () => number;

  /** The pairing key it proved: the session ends when the config's is another. */
  readonly key: Buffer;

  constructor(link: ViewerLink, info: ViewerInfo, keys: Session, key: Buffer, pingMs: number, now: () => number, onEnd: (s: ViewerSession) => void) {
    this.link = link;
    this.key = key;
    this.info = info;
    this.keys = keys;
    this.now = now;
    this.onEnd = onEnd;
    this.lastRx = now();
    link.onMessage((m) => this.receive(m));
    link.onClose(() => this.end());
    this.timer = setInterval(() => {
      if (this.now() - this.lastRx > 3 * pingMs + 1000) return this.close();
      this.send(BT.PING, {});
    }, pingMs);
    this.timer.unref?.();
  }

  get uid(): string {
    return this.info.uid;
  }
  get isClosed(): boolean {
    return this.closed;
  }

  send(type: number, payload: Buffer | object): void {
    if (this.closed) return;
    this.link.send(seal(this.keys.tx, type, Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload))));
  }

  setSink(sink: ViewerSink | null): void {
    if (this.sink === sink) return;
    this.sink?.detach(this);
    this.sink = sink;
    sink?.attach(this);
  }

  private receive(m: Buffer): void {
    if (this.closed) return;
    let msg: { type: number; payload: Buffer };
    try {
      if (m.length < 4 || m.readUInt32BE(0) !== m.length - 4) throw new Error('bad length');
      msg = open(this.keys.rx, m.subarray(0, 4), m.subarray(4));
    } catch {
      // Tampered with, replayed or out of order: this session is over.
      return this.close();
    }
    this.lastRx = this.now();
    if (msg.type === BT.PING) return this.send(BT.PONG, {});
    if (msg.type === BT.PONG) return;
    let json: Record<string, unknown> = {};
    try {
      const j = JSON.parse(msg.payload.toString('utf8') || '{}') as unknown;
      if (j && typeof j === 'object' && !Array.isArray(j)) json = j as Record<string, unknown>;
    } catch {
      return;
    }
    if (msg.type === BT.STATE) {
      if (json.w !== undefined) this.info.w = clampSide(json.w);
      if (json.h !== undefined) this.info.h = clampSide(json.h);
    }
    this.sink?.message(this, msg.type, json);
  }

  /** Tells the viewer to forget its key, then closes. */
  unpair(): void {
    this.send(BT.UNPAIR, {});
    this.close();
  }

  close(): void {
    if (this.closed) return;
    this.link.close();
    this.end();
  }

  private end(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    this.sink?.detach(this);
    this.sink = null;
    this.onEnd(this);
  }
}

interface Waiting {
  info: ViewerInfo;
  link: ViewerLink;
  /** When it last said anything (it pings while it shows its code). */
  seen: number;
  /** Messages for a pairing under way. */
  inbox: ((m: { type: number; json: Record<string, unknown> } | null) => void) | null;
  pairing: boolean;
}

export class BrowserHub extends EventEmitter {
  private readonly keyOf: (uid: string) => Buffer | null;
  private o: Required<HubOptions>;
  private readonly waitingByUid = new Map<string, Waiting>();
  private readonly sessions = new Map<string, ViewerSession>();
  private readonly sinks = new Map<string, ViewerSink>();
  private failures = 0;
  private sweeper: ReturnType<typeof setInterval> | null = null;
  private nextPairAt = 0;
  private on_ = false;

  /** `keyOf`: the key of the screen with that viewer id in the config now, if any. */
  constructor(keyOf: (uid: string) => Buffer | null, o: HubOptions = {}) {
    super();
    this.keyOf = keyOf;
    this.o = { pingMs: 5000, maxWaiting: 8, waitMs: 5000, maxWaitMs: 60_000, helloMs: 10_000, now: Date.now, ...o };
  }

  /** Changes its timings and limits (tests). */
  setOptions(o: HubOptions): void {
    Object.assign(this.o, o);
  }

  /** Whether the network-screens server is listening (for the drivers' status). */
  get serverOn(): boolean {
    return this.on_;
  }
  setServer(on: boolean): void {
    if (on === this.on_) return;
    this.on_ = on;
    for (const s of this.sinks.values()) s.serverChanged(on);
  }

  /** A new connection: it says who it is, then proves its key or waits for a pairing. */
  accept(link: ViewerLink): void {
    let stage: 'hello' | 'auth' | 'waiting' | 'done' = 'hello';
    let info: ViewerInfo | null = null;
    let nk: Buffer = Buffer.alloc(0), nd: Buffer = Buffer.alloc(0);
    const timer = setTimeout(() => stage !== 'waiting' && stage !== 'done' && link.close(), this.o.helloMs);
    timer.unref?.();
    const refuse = (code: string) => {
      stage = 'done';
      clearTimeout(timer);
      link.send(plain(BT.ERROR, { code }));
      link.close();
    };
    link.onClose(() => {
      clearTimeout(timer);
      if (info && stage === 'waiting') {
        const w = this.waitingByUid.get(info.uid);
        if (w?.link === link) {
          this.waitingByUid.delete(info.uid);
          w.inbox?.(null);
          this.emit('waiting');
        }
      }
    });
    link.onMessage((m) => {
      if (stage === 'done') return;
      if (m.length > MAX_VIEWER_MESSAGE) return refuse('tooBig');
      const msg = plainOf(m);
      if (stage === 'waiting') {
        const w = info && this.waitingByUid.get(info.uid);
        if (w?.link !== link || !msg) return;
        w.seen = this.o.now();
        if (msg.type === BT.PING) return link.send(plain(BT.PONG, {}));
        if (w.inbox) w.inbox(msg);
        return;
      }
      if (!msg) return refuse('bad');
      if (stage === 'hello') {
        const j = msg.json;
        if (msg.type !== BT.INFO) return refuse('bad');
        if (j.proto !== BROWSER_PROTO) return refuse('proto');
        const uid = String(j.uid ?? '');
        nd = Buffer.from(String(j.nonce ?? ''), 'hex');
        if (!VIEWER_UID.test(uid) || nd.length !== NONCE_LEN) return refuse('bad');
        info = { uid, id: String(j.id ?? '').replace(/[^\p{L}\p{N} ._-]/gu, '').slice(0, 32) || 'Browser', w: clampSide(j.w), h: clampSide(j.h), address: link.address, since: this.o.now() };
        nk = randomBytes(NONCE_LEN);
        link.send(plain(BT.HELLO, { proto: BROWSER_PROTO, nonce: nk.toString('hex') }));
        if (j.want === 'pair') {
          stage = 'waiting';
          clearTimeout(timer);
          return this.addWaiting(info, link, refuse);
        }
        stage = 'auth';
        return;
      }
      if (stage === 'auth' && info) {
        stage = 'done';
        clearTimeout(timer);
        const key = this.keyOf(info.uid);
        const mac = Buffer.from(String(msg.json.mac ?? ''), 'hex');
        // No key here for it (revoked, removed) or a wrong one: it learns only that.
        if (msg.type !== BT.AUTH || !key || key.length !== KEY_LEN || !equal(mac, authMac(key, LABEL_AUTH_D, nk, nd, info.uid))) return refuse('badKey');
        link.send(plain(BT.AUTH_OK, { mac: authMac(key, LABEL_AUTH_K, nk, nd, info.uid).toString('hex') }));
        this.startSession(link, info, sessionKeys(key, nk, nd, 'kiosko'), key);
      }
    });
  }

  private addWaiting(info: ViewerInfo, link: ViewerLink, refuse: (code: string) => void): void {
    const old = this.waitingByUid.get(info.uid);
    // Another connection with the same id waits already: the first one keeps its place (no taking over a pairing).
    if (old) {
      if (old.link.address !== info.address || old.pairing) return refuse('busy');
      // The same browser again (a reload): the new connection takes its place.
      this.waitingByUid.delete(info.uid);
      old.link.close();
    }
    this.waitingByUid.set(info.uid, { info, link, seen: this.o.now(), inbox: null, pairing: false });
    this.sweeper ??= setInterval(() => this.sweep(), this.o.pingMs);
    this.sweeper.unref?.();
    // Too many waiting: the oldest goes.
    while (this.waitingByUid.size > this.o.maxWaiting) {
      const [first] = this.waitingByUid.values();
      this.waitingByUid.delete(first!.info.uid);
      first!.link.close();
    }
    this.emit('waiting');
  }

  /** Viewers waiting that went quiet (a tablet that slept with its code on): gone from the list. */
  private sweep(): void {
    const now = this.o.now();
    for (const w of [...this.waitingByUid.values()]) if (!w.pairing && now - w.seen > 6 * this.o.pingMs) w.link.close();
    if (!this.waitingByUid.size && this.sweeper) {
      clearInterval(this.sweeper);
      this.sweeper = null;
    }
  }

  private startSession(link: ViewerLink, info: ViewerInfo, keys: Session, key: Buffer): void {
    // The same viewer again (it slept, its Wi-Fi came back): the new connection wins.
    this.sessions.get(info.uid)?.close();
    const s = new ViewerSession(link, info, keys, key, this.o.pingMs, this.o.now, (gone) => {
      if (this.sessions.get(gone.uid) === gone) this.sessions.delete(gone.uid);
      this.emit('sessions');
    });
    this.sessions.set(info.uid, s);
    s.setSink(this.sinks.get(info.uid) ?? null);
    this.emit('sessions');
  }

  /** Viewers waiting to be paired, oldest first. */
  waiting(): ViewerInfo[] {
    return [...this.waitingByUid.values()].map((w) => ({ ...w.info }));
  }

  /** The viewer of a screen, if connected now. */
  session(uid: string): ViewerSession | undefined {
    return this.sessions.get(uid);
  }

  /** Seconds until a pairing may be tried again (0: now). */
  waitSeconds(): number {
    return Math.max(0, Math.ceil((this.nextPairAt - this.o.now()) / 1000));
  }

  /**
   * Pairs the waiting viewer `uid` with the code typed in the editor. Gives
   * the key and the viewer; `finish()` tells the viewer it is in (call it once
   * the key is in the config, so its next connection finds it).
   */
  async pair(uid: string, code: string): Promise<{ key: Buffer; info: ViewerInfo; finish: () => void }> {
    const wait = this.waitSeconds();
    if (wait > 0) throw new BrowserError('wait', `too many wrong codes: wait ${wait} s`, { s: wait });
    const w = this.waitingByUid.get(uid);
    if (!w) throw new BrowserError('gone', 'that browser is not waiting to be paired any more');
    if (w.pairing) throw new BrowserError('busy', 'that browser is being paired already');
    const clean = code.replace(/\D/g, '');
    if (clean.length !== 6) throw new BrowserError('badCode', 'the code has 6 digits');
    w.pairing = true;
    const next = (ms: number) =>
      new Promise<{ type: number; json: Record<string, unknown> }>((resolve, reject) => {
        const t = setTimeout(() => {
          w.inbox = null;
          reject(new BrowserError('gone', 'the browser stopped answering'));
        }, ms);
        w.inbox = (m) => {
          clearTimeout(t);
          w.inbox = null;
          if (!m) reject(new BrowserError('gone', 'the browser went away'));
          else if (m.type === BT.ERROR) reject(new BrowserError('gone', `the browser refused: ${String(m.json.code ?? 'error')}`));
          else resolve(m);
        };
      });
    const drop = () => {
      if (this.waitingByUid.get(uid) === w) this.waitingByUid.delete(uid);
      w.link.close();
      this.emit('waiting');
    };
    try {
      const a = new SpakeA(uid, clean);
      const gotY = next(15_000);
      w.link.send(plain(BT.PAIR_X, { X: a.X.toString('hex') }));
      const y = await gotY;
      let k: ReturnType<SpakeA['finish']> | null = null;
      try {
        if (y.type === BT.PAIR_Y) k = a.finish(Buffer.from(String(y.json.Y ?? ''), 'hex'));
      } catch {
        k = null;
      }
      if (!k || !equal(Buffer.from(String(y.json.c ?? ''), 'hex'), k.cB)) {
        // Not the code it shows: it makes a new one; the next try waits.
        this.failures++;
        this.nextPairAt = this.o.now() + Math.min(this.o.maxWaitMs, this.o.waitMs * 2 ** (this.failures - 1));
        w.link.send(plain(BT.ERROR, { code: 'badCode' }));
        drop();
        throw new BrowserError('badCode', 'that is not the code the browser shows');
      }
      const ok = next(15_000);
      w.link.send(plain(BT.PAIR_CONFIRM, { c: k.cA.toString('hex') }));
      const r = await ok;
      if (r.type !== BT.PAIR_OK) {
        drop();
        throw new BrowserError('gone', 'the browser did not take the pairing');
      }
      this.failures = 0;
      this.nextPairAt = 0;
      if (this.waitingByUid.get(uid) === w) this.waitingByUid.delete(uid);
      this.emit('waiting');
      return {
        key: k.key,
        info: { ...w.info },
        finish: () => {
          w.link.send(plain(BT.PAIR_OK, {}));
          w.link.close();
        },
      };
    } catch (err) {
      if (!(err instanceof BrowserError) || err.code !== 'badCode') drop();
      throw err;
    } finally {
      w.pairing = false;
    }
  }

  /** The viewer `uid` forgets its key (if connected) and its session ends. */
  revoke(uid: string): boolean {
    const s = this.sessions.get(uid);
    s?.unpair();
    return !!s;
  }

  /** A `browser` driver for viewer `uid` (one per id: the newest wins). */
  register(sink: ViewerSink): void {
    this.sinks.set(sink.uid, sink);
    sink.serverChanged(this.on_);
    this.sessions.get(sink.uid)?.setSink(sink);
  }

  unregister(sink: ViewerSink): void {
    if (this.sinks.get(sink.uid) !== sink) return;
    this.sinks.delete(sink.uid);
    this.sessions.get(sink.uid)?.setSink(null);
  }

  /** Drops every session whose key is no longer the one in the config (revoked, re-paired, removed). */
  recheck(): void {
    for (const s of [...this.sessions.values()]) {
      const k = this.keyOf(s.uid);
      if (!k || !k.equals(s.key)) s.close();
    }
  }

  /** Every connection closed (the server stops). */
  closeAll(): void {
    for (const s of [...this.sessions.values()]) s.close();
    for (const w of [...this.waitingByUid.values()]) w.link.close();
    this.waitingByUid.clear();
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
    this.emit('waiting');
  }
}

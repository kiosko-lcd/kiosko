/**
 * The viewer's end of a browser screen (docs/browser-screens.md; the messages
 * in @kiosko/core's browser/protocol.ts): it connects to the network-screens
 * server, proves the key it keeps or waits to be paired with a code it shows,
 * then takes frames and ACKs them. No DOM here (viewer.ts draws): the tests
 * run this same code in Node, against a real Kiosko server.
 *
 * Pure-JS crypto (viewer-kit): a page at http://192.168.x.x has no
 * `crypto.subtle`. The key lives in the browser's localStorage.
 */
import { BROWSER_PROTO, BT, authMac, equalBytes, fromHex, open, plain, randomBytes, readPlain, seal, sessionKeys, spakeRespond, toHex, utf8, LABEL_AUTH_D, LABEL_AUTH_K, type Bytes, type Session } from '@kiosko/core/viewer-kit';

/** Where the viewer keeps its id and key (localStorage in a browser). */
export interface KeyStore {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

/** The part of the WebSocket API it uses (the browser's, or Node's in the tests). */
export interface WsLike {
  binaryType: string;
  readonly readyState: number;
  send(data: Uint8Array): void;
  close(): void;
  onopen: ((e: unknown) => void) | null;
  onclose: ((e: unknown) => void) | null;
  onerror: ((e: unknown) => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
}

export type ViewerState =
  | { kind: 'connecting'; tries: number }
  | { kind: 'pairing'; code: string }
  | { kind: 'live' }
  | { kind: 'offline'; tries: number };

export interface ViewerOptions {
  url: string;
  store: KeyStore;
  WebSocket: new (url: string) => WsLike;
  /** What it calls itself in the editor's list ("Android", "iPad"…). */
  id: string;
  /** Its picture now, device pixels. */
  size: () => { w: number; h: number };
  onState: (s: ViewerState) => void;
  /** A frame to draw; call `done` once drawn (or failed), with how long decoding took. */
  onFrame: (n: number, image: Uint8Array, done: (ok: boolean, decodeMs?: number) => void) => void;
  /** Nothing heard for this long: the connection is gone (Kiosko pings every 5 s). */
  silenceMs?: number;
  /** Pauses between tries: from `retryMs`, doubling up to `maxRetryMs`. */
  retryMs?: number;
  maxRetryMs?: number;
}

const UID_KEY = 'kiosko.viewer.uid';
const KEY_KEY = 'kiosko.viewer.key';

/** A 6-digit code, uniformly drawn. */
export function newCode(): string {
  for (;;) {
    const b = randomBytes(4);
    const n = ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0;
    // Rejection sampling: no digit more likely than another.
    if (n < 4_294_000_000) return String(n % 1_000_000).padStart(6, '0');
  }
}

export class ViewerClient {
  private readonly o: Required<Pick<ViewerOptions, 'silenceMs' | 'retryMs' | 'maxRetryMs'>> & ViewerOptions;
  private ws: WsLike | null = null;
  private stopped = true;
  private tries = 0;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  /** While it shows a code: a ping now and then, so both ends know the other is there. */
  private pinger: ReturnType<typeof setInterval> | null = null;
  private session: Session | null = null;
  private lastSize = { w: 0, h: 0 };
  state: ViewerState = { kind: 'connecting', tries: 0 };

  constructor(o: ViewerOptions) {
    this.o = { silenceMs: 20_000, retryMs: 1000, maxRetryMs: 15_000, ...o };
  }

  /** This viewer's id: made once, kept. */
  get uid(): string {
    let uid = this.o.store.getItem(UID_KEY);
    if (!uid || !/^[0-9a-f]{12}$/.test(uid)) {
      uid = toHex(randomBytes(6));
      this.o.store.setItem(UID_KEY, uid);
    }
    return uid;
  }

  get paired(): boolean {
    return /^[0-9a-f]{64}$/.test(this.o.store.getItem(KEY_KEY) ?? '');
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.drop();
  }

  /** Forgets the key (the corner menu): back to showing a code. */
  forget(): void {
    this.o.store.removeItem(KEY_KEY);
    this.reconnect(0);
  }

  /** Its size may have changed: Kiosko hears it if so. */
  sizeChanged(): void {
    const s = this.o.size();
    if (s.w === this.lastSize.w && s.h === this.lastSize.h) return;
    this.lastSize = s;
    this.sendSealed(BT.STATE, { w: s.w, h: s.h });
  }

  /** Back in front (the tab was hidden, the tablet slept): the current picture again, or a new connection if it went. */
  wake(): void {
    if (this.stopped) return;
    if (!this.ws || this.ws.readyState > 1) return this.reconnect(0);
    if (this.session) this.sendSealed(BT.STATE, { ...this.o.size(), resend: true });
  }

  private set(s: ViewerState): void {
    this.state = s;
    this.o.onState(s);
  }

  private drop(): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = null;
    if (this.pinger) clearInterval(this.pinger);
    this.pinger = null;
    const ws = this.ws;
    this.ws = null;
    this.session = null;
    if (ws) {
      ws.onopen = ws.onclose = ws.onerror = ws.onmessage = null;
      try {
        ws.close();
      } catch {
        /* closed already */
      }
    }
  }

  private reconnect(ms?: number): void {
    this.drop();
    if (this.stopped) return;
    if (this.retry) clearTimeout(this.retry);
    const wait = ms ?? Math.min(this.o.maxRetryMs, this.o.retryMs * 2 ** Math.min(this.tries, 6));
    this.retry = setTimeout(() => {
      this.retry = null;
      this.connect();
    }, wait);
  }

  private alive(): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => {
      this.tries++;
      this.set({ kind: 'offline', tries: this.tries });
      this.reconnect();
    }, this.o.silenceMs);
  }

  private sendSealed(type: number, obj: object | Uint8Array): void {
    if (!this.session || !this.ws || this.ws.readyState !== 1) return;
    this.ws.send(seal(this.session.tx, type, obj instanceof Uint8Array ? obj : utf8(JSON.stringify(obj))));
  }

  private connect(): void {
    if (this.stopped) return;
    if (this.state.kind !== 'live' && this.state.kind !== 'pairing') this.set({ kind: this.tries ? 'offline' : 'connecting', tries: this.tries });
    const keyHex = this.o.store.getItem(KEY_KEY);
    const key = keyHex && /^[0-9a-f]{64}$/.test(keyHex) ? fromHex(keyHex) : null;
    const uid = this.uid;
    const nd = randomBytes(32);
    const size = this.o.size();
    let nk: Bytes | null = null;
    let code: string | null = null;
    let pairKeys: { key: Bytes; cA: Bytes } | null = null;
    let ws: WsLike;
    try {
      ws = new this.o.WebSocket(this.o.url);
    } catch {
      this.tries++;
      return this.reconnect();
    }
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      this.alive();
      ws.send(plain(BT.INFO, { proto: BROWSER_PROTO, uid, id: this.o.id, w: size.w, h: size.h, want: key ? 'session' : 'pair', nonce: toHex(nd) }));
    };
    ws.onclose = ws.onerror = () => {
      if (this.ws !== ws) return;
      this.tries++;
      if (this.state.kind !== 'offline') this.set({ kind: 'offline', tries: this.tries });
      this.reconnect();
    };
    ws.onmessage = (e) => {
      if (this.ws !== ws) return;
      this.alive();
      const msg = e.data instanceof ArrayBuffer ? new Uint8Array(e.data) : e.data instanceof Uint8Array ? e.data : null;
      if (!msg) return;
      if (this.session) return this.sealed(msg);
      const p = readPlain(msg);
      if (!p) return this.reconnect();
      const j = p.json;
      if (p.type === BT.ERROR) {
        // Kiosko doesn't know this key (revoked, or its screen was removed): pair again.
        if (j.code === 'badKey') this.o.store.removeItem(KEY_KEY);
        // A wrong code, or a pairing that went wrong: a new code at once.
        return this.reconnect(j.code === 'badKey' || j.code === 'badCode' ? 0 : undefined);
      }
      if (p.type === BT.HELLO) {
        nk = fromHex(String(j.nonce ?? ''));
        if (nk.length !== 32) return this.reconnect();
        if (key) return ws.send(plain(BT.AUTH, { mac: toHex(authMac(key, LABEL_AUTH_D, nk, nd, uid)) }));
        code = newCode();
        this.tries = 0;
        this.pinger = setInterval(() => ws.readyState === 1 && ws.send(plain(BT.PING, {})), Math.max(1000, this.o.silenceMs / 2));
        return this.set({ kind: 'pairing', code });
      }
      if (p.type === BT.AUTH_OK && key && nk) {
        // Kiosko proves it has the key too: frames come only from the Kiosko this viewer was paired with.
        if (!equalBytes(fromHex(String(j.mac ?? '')), authMac(key, LABEL_AUTH_K, nk, nd, uid))) return this.reconnect();
        this.session = sessionKeys(key, nk, nd, 'screen');
        this.tries = 0;
        this.set({ kind: 'live' });
        this.lastSize = this.o.size();
        this.sendSealed(BT.STATE, { w: this.lastSize.w, h: this.lastSize.h });
        return;
      }
      if (p.type === BT.PONG) return;
      if (p.type === BT.PAIR_X && code) {
        try {
          const r = spakeRespond(uid, code, fromHex(String(j.X ?? '')));
          pairKeys = { key: r.key, cA: r.cA };
          ws.send(plain(BT.PAIR_Y, { Y: toHex(r.Y), c: toHex(r.cB) }));
        } catch {
          ws.send(plain(BT.ERROR, { code: 'bad' }));
          this.reconnect(0);
        }
        return;
      }
      if (p.type === BT.PAIR_CONFIRM && pairKeys) {
        if (!equalBytes(fromHex(String(j.c ?? '')), pairKeys.cA)) {
          ws.send(plain(BT.ERROR, { code: 'badConfirm' }));
          return this.reconnect(0);
        }
        this.o.store.setItem(KEY_KEY, toHex(pairKeys.key));
        ws.send(plain(BT.PAIR_OK, {}));
        return;
      }
      // Paired, and the screen is in Kiosko's config: connect with the key.
      if (p.type === BT.PAIR_OK && pairKeys) return this.reconnect(0);
    };
  }

  private sealed(msg: Uint8Array): void {
    let m: { type: number; payload: Uint8Array };
    try {
      m = open(this.session!.rx, msg);
    } catch {
      return this.reconnect();
    }
    if (m.type === BT.FRAME) {
      if (m.payload.length < 4) return;
      const n = ((m.payload[0]! << 24) | (m.payload[1]! << 16) | (m.payload[2]! << 8) | m.payload[3]!) >>> 0;
      const session = this.session;
      this.o.onFrame(n, m.payload.subarray(4), (ok, dec) => {
        if (this.session === session) this.sendSealed(BT.ACK, { n, ok, ...(dec !== undefined ? { dec: Math.round(dec) } : {}) });
      });
    } else if (m.type === BT.PING) this.sendSealed(BT.PONG, {});
    else if (m.type === BT.UNPAIR) {
      // Revoked in the editor: forget the key, show a code again.
      this.o.store.removeItem(KEY_KEY);
      this.reconnect(0);
    }
  }
}

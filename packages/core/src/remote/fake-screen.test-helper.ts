/**
 * A remote screen in Node, for the tests: what firmware/esp32-screen does on
 * the wire (pairing with a known code, sessions, frames with a slow decoder,
 * SET, LED, OTA), and nothing more.
 */
import { createServer, type Server, type Socket } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { LABEL_AUTH_D, LABEL_AUTH_K, authMac, equal, open, seal, sessionKeys, spakeRespond, type Session } from './crypto.ts';
import { T, Wire } from './link.ts';

export interface FakeOptions {
  uid?: string;
  id?: string;
  key?: Buffer | null;
  code?: string;
  /** How long "decoding" a frame takes before its ACK. */
  decodeMs?: number;
  max?: number;
  rot?: number;
}

export class FakeScreen {
  uid: string;
  id: string;
  key: Buffer | null;
  code: string;
  decodeMs: number;
  rot: number;
  max: number;
  readonly frames: { num: number; jpeg: Buffer; at: number }[] = [];
  readonly sets: Record<string, unknown>[] = [];
  readonly leds: Record<string, unknown>[] = [];
  readonly events: string[] = [];
  ota: Buffer | null = null;
  inflightMax = 0;
  sessions = 0;
  /** Drops every connection at once (a screen that is away). */
  away = false;
  private server: Server;
  private current: Socket | null = null;
  private socks = new Set<Socket>();
  port = 0;

  constructor(o: FakeOptions = {}) {
    this.uid = o.uid ?? 'a0b1c2d3e4f5';
    this.id = o.id ?? 'desk';
    this.key = o.key ?? null;
    this.code = o.code ?? '123456';
    this.decodeMs = o.decodeMs ?? 0;
    this.rot = o.rot ?? 0;
    this.max = o.max ?? 98_000;
    this.server = createServer((s) => void this.handle(s));
  }

  listen(port = 0): Promise<number> {
    return new Promise((r) => this.server.listen(port, '127.0.0.1', () => r((this.port = (this.server.address() as { port: number }).port))));
  }

  /** Drops the session, as a screen losing its Wi-Fi would. */
  drop(): void {
    this.current?.destroy();
  }

  async close(): Promise<void> {
    for (const s of this.socks) s.destroy();
    if (this.server.listening) await new Promise((r) => this.server.close(r));
  }

  private info(nd: Buffer) {
    return { proto: 1, uid: this.uid, id: this.id, model: 'fake', w: 172, h: 320, rot: this.rot, fw: '0.0.0', max: this.max, nonce: nd.toString('hex'), paired: !!this.key, pairing: !this.key };
  }

  private async handle(sock: Socket): Promise<void> {
    if (this.away) return void sock.destroy();
    this.socks.add(sock);
    sock.on('close', () => this.socks.delete(sock));
    const w = new Wire(sock);
    try {
      const h = await w.plain<{ nonce: string; want: string }>(T.HELLO);
      const nk = Buffer.from(h.nonce, 'hex');
      const nd = randomBytes(32);
      w.sendPlain(T.INFO, this.info(nd));
      if (h.want === 'pair') return await this.pair(w);
      if (h.want !== 'session') return w.close();
      const a = await w.plain<{ mac: string }>(T.AUTH);
      if (!this.key) return this.refuse(w, 'notPaired');
      if (!equal(Buffer.from(a.mac, 'hex'), authMac(this.key, LABEL_AUTH_K, nk, nd, this.uid))) return this.refuse(w, 'badKey');
      this.current?.destroy();
      this.current = sock;
      this.sessions++;
      this.events.push('session');
      w.sendPlain(T.AUTH_OK, { mac: authMac(this.key, LABEL_AUTH_D, nk, nd, this.uid).toString('hex') });
      await this.session(w, sessionKeys(this.key, nk, nd, 'screen'));
    } catch {
      /* the peer went, or sent garbage: as the firmware, just close */
    } finally {
      w.close();
    }
  }

  private refuse(w: Wire, code: string): void {
    this.events.push(`refused:${code}`);
    w.sendPlain(T.ERROR, { code, msg: code });
    setTimeout(() => w.close(), 20);
  }

  private async pair(w: Wire): Promise<void> {
    await w.plain(T.PAIR_START);
    if (this.key) return this.refuse(w, 'pairingClosed');
    w.sendPlain(T.PAIR_READY, { ttl: 120 });
    const x = await w.plain<{ X: string }>(T.PAIR_X, 120_000);
    const r = spakeRespond(this.uid, this.code, Buffer.from(x.X, 'hex'));
    w.sendPlain(T.PAIR_Y, { Y: r.Y.toString('hex'), c: r.cB.toString('hex') });
    const c = await w.plain<{ c: string }>(T.PAIR_CONFIRM);
    if (!equal(Buffer.from(c.c, 'hex'), r.cA)) return this.refuse(w, 'badCode');
    this.key = r.key;
    this.events.push('paired');
    w.sendPlain(T.PAIR_OK, {});
  }

  private sealed(w: Wire, s: Session, type: number, obj: unknown): void {
    w.write(seal(s.tx, type, Buffer.isBuffer(obj) ? obj : Buffer.from(JSON.stringify(obj))));
  }

  private async session(w: Wire, s: Session): Promise<void> {
    this.sealed(w, s, T.STATE, { id: this.id, rot: this.rot, w: 172, h: 320, fw: '0.0.0', last: this.frames.at(-1)?.num ?? 0 });
    let decoding = 0;
    let ota: { size: number; sha: string; parts: Buffer[]; off: number } | null = null;
    for (;;) {
      const { hdr, body } = await w.next(60_000);
      const m = open(s.rx, hdr, body); // throws on a replayed or forged message: the session ends
      if (m.type === T.FRAME) {
        // Frames waiting behind this one were sent before its ACK: flow control broken.
        const queued = (w as unknown as { queue: { body: Buffer }[] }).queue.length;
        decoding++;
        this.inflightMax = Math.max(this.inflightMax, decoding + queued);
        const num = m.payload.readUInt32BE(0);
        if (this.decodeMs) await new Promise((r) => setTimeout(r, this.decodeMs));
        this.frames.push({ num, jpeg: m.payload.subarray(4), at: Date.now() });
        decoding--;
        this.sealed(w, s, T.ACK, { n: num, ok: true, rx: 1, dec: this.decodeMs });
      } else if (m.type === T.SET) {
        const j = JSON.parse(m.payload.toString());
        this.sets.push(j);
        if (typeof j.rot === 'number') this.rot = j.rot;
        this.sealed(w, s, T.STATE, { id: this.id, rot: this.rot });
      } else if (m.type === T.LED) this.leds.push(JSON.parse(m.payload.toString()));
      else if (m.type === T.PING) this.sealed(w, s, T.PONG, {});
      else if (m.type === T.UNPAIR) {
        this.key = null;
        this.sealed(w, s, T.UNPAIR, {});
        return;
      } else if (m.type === T.LOGS) this.sealed(w, s, T.LOGS, { text: 'I (1) fake: hello\n' });
      else if (m.type === T.OTA_BEGIN) {
        const j = JSON.parse(m.payload.toString());
        ota = { size: j.size, sha: j.sha256, parts: [], off: 0 };
        this.sealed(w, s, T.OTA_ACK, { off: 0 });
      } else if (m.type === T.OTA_DATA && ota) {
        ota.parts.push(Buffer.from(m.payload));
        ota.off += m.payload.length;
        this.sealed(w, s, T.OTA_ACK, { off: ota.off });
      } else if (m.type === T.OTA_END && ota) {
        const img = Buffer.concat(ota.parts);
        const ok = img.length === ota.size && createHash('sha256').update(img).digest('hex') === ota.sha;
        if (ok) this.ota = img;
        this.sealed(w, s, T.OTA_DONE, ok ? { ok } : { ok, err: 'sha256 mismatch' });
      }
    }
  }
}

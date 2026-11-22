/**
 * Finds Kiosko remote screens on the LAN: DNS-SD over multicast DNS
 * (RFC 6762/6763), `_kiosko-screen._tcp.local`, in plain Node (dgram), no
 * native module and no dependency. It only asks and listens; it never
 * answers for anything.
 *
 * It listens on 5353 (shared with Avahi or Bonjour, SO_REUSEADDR) so a
 * screen's own announcement (when it comes online) is heard at once; where
 * that port can't be shared it asks from a port of its own and the screens
 * answer it directly (a "legacy unicast" query).
 */
import { createSocket, type Socket } from 'node:dgram';
import { EventEmitter } from 'node:events';
import { networkInterfaces } from 'node:os';

export const SERVICE = '_kiosko-screen._tcp.local';
/** Tests and tools may browse another service type. */
let service = SERVICE;
export function setServiceForTests(s: string): void {
  service = s;
}
const GROUP = '224.0.0.251';
const MDNS_PORT = 5353;

/** A screen as its announcement describes it. */
export interface FoundScreen {
  /** Stable, from its MAC: what a screen's config keeps. */
  uid: string;
  /** The name its owner gave it. */
  id: string;
  model: string;
  /** Native size of the glass. */
  w: number;
  h: number;
  rot: number;
  fw: string;
  proto: number;
  paired: boolean;
  /** IPv4 address and port to connect to. */
  address: string;
  port: number;
  /** Its .local name. */
  hostname: string;
  seenAt: number;
}

// ---- DNS messages -------------------------------------------------------------------

const TYPE = { A: 1, PTR: 12, TXT: 16, SRV: 33, ANY: 255 } as const;

export interface Record_ {
  name: string;
  type: number;
  ttl: number;
  data: { ptr?: string; txt?: Record<string, string>; srv?: { port: number; target: string }; a?: string };
}

function encodeName(name: string): Buffer {
  const parts = name.replace(/\.$/, '').split('.');
  return Buffer.concat([...parts.map((p) => Buffer.concat([Buffer.from([Buffer.byteLength(p)]), Buffer.from(p)])), Buffer.from([0])]);
}

/** A query for `name` of `type`; `unicast`: ask for the answer straight back (QU). */
export function buildQuery(name: string, type: number, unicast = false): Buffer {
  const h = Buffer.alloc(12);
  h.writeUInt16BE(1, 4); // one question
  const q = Buffer.alloc(4);
  q.writeUInt16BE(type, 0);
  q.writeUInt16BE(unicast ? 0x8001 : 1, 2);
  return Buffer.concat([h, encodeName(name), q]);
}

function readName(b: Buffer, at: number): { name: string; next: number } {
  const labels: string[] = [];
  let next = -1;
  for (let hops = 0; hops < 32; hops++) {
    if (at >= b.length) throw new Error('truncated name');
    const len = b[at]!;
    if (len === 0) {
      if (next < 0) next = at + 1;
      return { name: labels.join('.'), next };
    }
    if ((len & 0xc0) === 0xc0) {
      if (next < 0) next = at + 2;
      at = ((len & 0x3f) << 8) | b[at + 1]!;
      continue;
    }
    labels.push(b.toString('utf8', at + 1, at + 1 + len));
    at += 1 + len;
  }
  throw new Error('name loop');
}

/** The answers and additional records of an mDNS response (questions skipped). */
export function parseResponse(b: Buffer): Record_[] {
  if (b.length < 12) return [];
  const flags = b.readUInt16BE(2);
  if (!(flags & 0x8000)) return []; // a query, not a response
  const qd = b.readUInt16BE(4);
  const total = b.readUInt16BE(6) + b.readUInt16BE(8) + b.readUInt16BE(10);
  let at = 12;
  for (let i = 0; i < qd; i++) at = readName(b, at).next + 4;
  const out: Record_[] = [];
  for (let i = 0; i < total && at < b.length; i++) {
    const { name, next } = readName(b, at);
    at = next;
    if (at + 10 > b.length) break;
    const type = b.readUInt16BE(at);
    const ttl = b.readUInt32BE(at + 4);
    const len = b.readUInt16BE(at + 8);
    const rd = at + 10;
    at = rd + len;
    if (at > b.length) break;
    const r: Record_ = { name: name.toLowerCase(), type, ttl, data: {} };
    if (type === TYPE.PTR) r.data.ptr = readName(b, rd).name;
    else if (type === TYPE.SRV) r.data.srv = { port: b.readUInt16BE(rd + 4), target: readName(b, rd + 6).name.toLowerCase() };
    else if (type === TYPE.A && len === 4) r.data.a = `${b[rd]}.${b[rd + 1]}.${b[rd + 2]}.${b[rd + 3]}`;
    else if (type === TYPE.TXT) {
      const txt: Record<string, string> = {};
      for (let p = rd; p < rd + len; ) {
        const l = b[p]!;
        const s = b.toString('utf8', p + 1, p + 1 + l);
        const eq = s.indexOf('=');
        if (eq > 0) txt[s.slice(0, eq).toLowerCase()] = s.slice(eq + 1);
        p += 1 + l;
      }
      r.data.txt = txt;
    } else continue;
    out.push(r);
  }
  return out;
}

// ---- the browser --------------------------------------------------------------------

interface Partial_ {
  instance: string;
  txt?: Record<string, string>;
  srv?: { port: number; target: string };
}

/**
 * Keeps the screens heard of. One per process (`browser()`), shared by every
 * remote screen and the editor's "Detect panels".
 */
export class ScreenBrowser extends EventEmitter {
  private sock: Socket | null = null;
  private starting: Promise<void> | null = null;
  private readonly instances = new Map<string, Partial_>();
  private readonly hosts = new Map<string, { a: string; at: number }>();
  private readonly found = new Map<string, FoundScreen>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private users = 0;
  private shared = true;

  /** Starts listening (idempotent). */
  start(): Promise<void> {
    this.starting ??= new Promise<void>((resolve) => {
      const s = createSocket({ type: 'udp4', reuseAddr: true });
      let bound = false;
      s.on('message', (m) => this.onMessage(m));
      s.on('error', () => undefined);
      s.once('error', () => {
        if (bound) return;
        s.close();
        // 5353 can't be shared here: a port of our own; the screens answer it directly.
        this.shared = false;
        const e = createSocket({ type: 'udp4' });
        e.on('message', (m) => this.onMessage(m));
        e.on('error', () => undefined);
        e.bind(0, () => {
          e.unref();
          this.sock = e;
          resolve();
        });
      });
      s.bind(MDNS_PORT, () => {
        bound = true;
        s.unref();
        try {
          let joined = false;
          for (const list of Object.values(networkInterfaces())) {
            for (const i of list ?? []) {
              if (i.family !== 'IPv4' || i.internal) continue;
              try {
                s.addMembership(GROUP, i.address);
                joined = true;
              } catch {
                /* already joined there, or no multicast on it */
              }
            }
          }
          if (!joined) s.addMembership(GROUP);
          s.setMulticastTTL(255);
        } catch {
          /* listening on the port still gets answers to our queries */
        }
        this.sock = s;
        resolve();
      });
    });
    return this.starting;
  }

  private send(name: string, type: number): void {
    if (!this.sock) return;
    try {
      this.sock.send(buildQuery(name, type, !this.shared), MDNS_PORT, GROUP);
    } catch {
      /* no network right now */
    }
  }

  /** Asks the LAN for screens now; answers come as `found`. */
  query(): void {
    this.send(service, TYPE.PTR);
  }

  private onMessage(m: Buffer): void {
    let recs: Record_[];
    try {
      recs = parseResponse(m);
    } catch {
      return;
    }
    if (!recs.length) return;
    const now = Date.now();
    const touched = new Set<string>();
    for (const r of recs) {
      if (r.type === TYPE.PTR && r.name === service && r.data.ptr) {
        const inst = r.data.ptr.toLowerCase();
        if (!this.instances.has(inst)) this.instances.set(inst, { instance: inst });
        touched.add(inst);
      } else if (r.type === TYPE.SRV && r.name.endsWith(`.${service}`)) {
        const p = this.instances.get(r.name) ?? { instance: r.name };
        p.srv = r.data.srv;
        this.instances.set(r.name, p);
        touched.add(r.name);
      } else if (r.type === TYPE.TXT && r.name.endsWith(`.${service}`)) {
        const p = this.instances.get(r.name) ?? { instance: r.name };
        p.txt = r.data.txt;
        this.instances.set(r.name, p);
        touched.add(r.name);
      } else if (r.type === TYPE.A && r.data.a) {
        this.hosts.set(r.name, { a: r.data.a, at: now });
        for (const [k, p] of this.instances) if (p.srv?.target === r.name) touched.add(k);
      }
    }
    for (const k of touched) {
      const p = this.instances.get(k);
      if (!p) continue;
      // What is missing is asked for by name.
      if (!p.srv || !p.txt) this.send(k, TYPE.ANY);
      else if (!this.hosts.has(p.srv.target)) this.send(p.srv.target, TYPE.A);
      const s = this.complete(p, now);
      if (!s) continue;
      const before = this.found.get(s.uid);
      this.found.set(s.uid, s);
      this.emit('found', s, before);
    }
  }

  private complete(p: Partial_, now: number): FoundScreen | null {
    const t = p.txt;
    if (!t?.uid || !p.srv) return null;
    const host = this.hosts.get(p.srv.target);
    if (!host) return null;
    const n = (v: string | undefined) => (v && /^\d+$/.test(v) ? Number(v) : 0);
    return { uid: t.uid, id: t.id ?? '', model: t.model ?? '', w: n(t.w), h: n(t.h), rot: n(t.rot), fw: t.fw ?? '', proto: n(t.proto), paired: t.paired === '1', address: host.a, port: p.srv.port, hostname: p.srv.target, seenAt: now };
  }

  /** The screen with this uid, if heard of in the last `maxAgeMs`. */
  get(uid: string, maxAgeMs = 30 * 60_000): FoundScreen | undefined {
    const s = this.found.get(uid);
    return s && Date.now() - s.seenAt <= maxAgeMs ? s : undefined;
  }

  /** Screens heard of recently. */
  list(maxAgeMs = 10 * 60_000): FoundScreen[] {
    const now = Date.now();
    return [...this.found.values()].filter((s) => now - s.seenAt <= maxAgeMs).sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Asks, waits `ms` for answers, and gives what it heard in that time (and before). */
  async browse(ms = 1500): Promise<FoundScreen[]> {
    await this.start();
    const since = Date.now();
    this.query();
    await new Promise((r) => setTimeout(r, ms / 2));
    this.query();
    await new Promise((r) => setTimeout(r, ms / 2));
    return this.list().filter((s) => s.seenAt >= since - 60_000);
  }

  /** A remote screen holds it: asks again every minute while someone does. */
  retain(): void {
    this.users++;
    void this.start().then(() => this.query());
    if (!this.timer) {
      this.timer = setInterval(() => this.query(), 60_000);
      this.timer.unref();
    }
  }

  release(): void {
    if (--this.users > 0) return;
    this.users = 0;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  close(): void {
    this.release();
    this.sock?.close();
    this.sock = null;
    this.starting = null;
  }
}

let shared: ScreenBrowser | null = null;
export function browser(): ScreenBrowser {
  shared ??= new ScreenBrowser();
  shared.setMaxListeners(64);
  return shared;
}

/**
 * A small MQTT 3.1.1 client: what Kiosko needs to talk to Home Assistant and
 * nothing else. Connect (with a last will), publish (QoS 0, retained or not),
 * subscribe (QoS 0), keep-alive pings, and reconnect with a growing pause.
 * Over TCP (`mqtt://`, port 1883) or TLS (`mqtts://`, port 8883).
 *
 * No dependency: the protocol is a handful of packets, and the broker is
 * the user's own (Home Assistant's Mosquitto add-on, usually).
 */
import { EventEmitter } from 'node:events';
import { connect as tcp, type Socket } from 'node:net';
import { connect as tls } from 'node:tls';

export interface MqttOptions {
  /** `mqtt://host:1883` or `mqtts://host:8883`. */
  url: string;
  clientId: string;
  username?: string;
  password?: string;
  /** Seconds. */
  keepalive?: number;
  /** Published by the broker when this client goes away without saying so. */
  will?: { topic: string; payload: string; retain?: boolean };
  /** For tests: how to open the socket. */
  socket?: (host: string, port: number, secure: boolean) => Socket;
}

export type MqttState = 'connecting' | 'connected' | 'error' | 'closed';

const RETRY_MS = [2_000, 5_000, 10_000, 30_000, 60_000];

/** The remaining length of a packet, in MQTT's variable-length encoding. */
export function encodeLength(n: number): Buffer {
  const out: number[] = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return Buffer.from(out);
}

const str = (s: string) => {
  const b = Buffer.from(s, 'utf8');
  const len = Buffer.alloc(2);
  len.writeUInt16BE(b.length);
  return Buffer.concat([len, b]);
};

const packet = (type: number, flags: number, body: Buffer) => Buffer.concat([Buffer.from([(type << 4) | flags]), encodeLength(body.length), body]);

export function connectPacket(o: MqttOptions): Buffer {
  let flags = 0x02; // clean session
  const payload = [str(o.clientId)];
  if (o.will) {
    flags |= 0x04 | (o.will.retain ? 0x20 : 0);
    payload.push(str(o.will.topic), str(o.will.payload));
  }
  if (o.username) {
    flags |= 0x80;
    payload.push(str(o.username));
    if (o.password) {
      flags |= 0x40;
      payload.push(str(o.password));
    }
  }
  const keep = Buffer.alloc(2);
  keep.writeUInt16BE(o.keepalive ?? 30);
  return packet(1, 0, Buffer.concat([str('MQTT'), Buffer.from([4, flags]), keep, ...payload]));
}

export const publishPacket = (topic: string, payload: string, retain = false) => packet(3, retain ? 1 : 0, Buffer.concat([str(topic), Buffer.from(payload, 'utf8')]));

export function subscribePacket(id: number, topics: string[]): Buffer {
  const pid = Buffer.alloc(2);
  pid.writeUInt16BE(id);
  return packet(8, 2, Buffer.concat([pid, ...topics.map((t) => Buffer.concat([str(t), Buffer.from([0])]))]));
}

/** Splits a byte stream into whole packets: `[type, flags, body]`, and what is left over. */
export function readPackets(buf: Buffer): { packets: { type: number; flags: number; body: Buffer }[]; rest: Buffer } {
  const packets: { type: number; flags: number; body: Buffer }[] = [];
  let i = 0;
  for (;;) {
    if (buf.length - i < 2) break;
    let len = 0, mult = 1, j = i + 1, ok = false;
    for (; j < buf.length && j < i + 5; j++) {
      len += (buf[j]! & 0x7f) * mult;
      mult *= 128;
      if (!(buf[j]! & 0x80)) {
        ok = true;
        break;
      }
    }
    if (!ok || buf.length < j + 1 + len) break;
    packets.push({ type: buf[i]! >> 4, flags: buf[i]! & 0x0f, body: buf.subarray(j + 1, j + 1 + len) });
    i = j + 1 + len;
  }
  return { packets, rest: buf.subarray(i) };
}

const CONNACK_ERRORS: Record<number, string> = {
  1: 'the broker refused the protocol version',
  2: 'the broker refused the client id',
  3: 'the broker is unavailable',
  4: 'wrong user name or password',
  5: 'not authorised',
};

/**
 * Keeps a connection to the broker until `close()`. Emits `connect` on every
 * (re)connection (subscribe and announce again then), `message`
 * (topic, payload) and `state`.
 */
export class MqttClient extends EventEmitter {
  state: MqttState = 'connecting';
  error: string | null = null;
  private sock: Socket | null = null;
  private buf = Buffer.alloc(0);
  private timers: ReturnType<typeof setTimeout>[] = [];
  private attempt = 0;
  private closed = false;
  private nextId = 1;
  private awaitingPong = false;

  private readonly o: MqttOptions;

  constructor(o: MqttOptions) {
    super();
    this.o = o;
    this.open();
  }

  get connected(): boolean {
    return this.state === 'connected';
  }

  publish(topic: string, payload: string, retain = false): void {
    if (this.connected) this.sock?.write(publishPacket(topic, payload, retain));
  }

  subscribe(topics: string[]): void {
    if (this.connected && topics.length) this.sock?.write(subscribePacket(this.nextId++ % 65535 || 1, topics));
  }

  /** Goes away cleanly: the will is not published (publish your own "offline" first). */
  close(): void {
    this.closed = true;
    this.clear();
    if (this.sock && this.connected) this.sock.write(Buffer.from([0xe0, 0]));
    this.sock?.end();
    this.sock?.destroy();
    this.sock = null;
    this.set('closed');
  }

  private set(state: MqttState, error: string | null = null) {
    this.state = state;
    this.error = error;
    this.emit('state', state, error);
  }

  private clear() {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  private later(fn: () => void, ms: number) {
    const t = setTimeout(fn, ms);
    t.unref?.();
    this.timers.push(t);
  }

  private open() {
    if (this.closed) return;
    let u: URL;
    try {
      u = new URL(this.o.url);
    } catch {
      this.set('error', `not a broker address: ${this.o.url}`);
      return;
    }
    const secure = u.protocol === 'mqtts:';
    if (!secure && u.protocol !== 'mqtt:') {
      this.set('error', `use mqtt:// or mqtts:// (got ${u.protocol})`);
      return;
    }
    const port = Number(u.port) || (secure ? 8883 : 1883);
    this.set('connecting', this.error);
    const s = this.o.socket ? this.o.socket(u.hostname, port, secure) : secure ? tls({ host: u.hostname, port, servername: u.hostname }) : tcp({ host: u.hostname, port });
    this.sock = s;
    this.buf = Buffer.alloc(0);
    const mine = (fn: (...a: any[]) => void) => (...a: any[]) => this.sock === s && fn(...a);
    s.setNoDelay?.(true);
    s.on(secure ? 'secureConnect' : 'connect', mine(() => s.write(connectPacket(this.o))));
    s.on('data', mine((d: Buffer) => this.onData(d)));
    s.on('error', mine((err: Error) => this.drop(err.message)));
    s.on('close', mine(() => this.drop(this.error ?? 'connection closed')));
  }

  private onData(d: Buffer) {
    const { packets, rest } = readPackets(Buffer.concat([this.buf, d]));
    this.buf = Buffer.from(rest);
    for (const p of packets) {
      if (p.type === 2) {
        const code = p.body[1] ?? 0;
        if (code) {
          this.drop(CONNACK_ERRORS[code] ?? `refused (${code})`, true);
          return;
        }
        this.attempt = 0;
        this.set('connected');
        this.ping();
        this.emit('connect');
      } else if (p.type === 3) {
        const len = p.body.readUInt16BE(0);
        const topic = p.body.subarray(2, 2 + len).toString('utf8');
        const qos = (p.flags >> 1) & 3;
        // QoS 1/2 messages carry a packet id before the payload (we subscribe at 0, but a broker may still send them).
        const payload = p.body.subarray(2 + len + (qos ? 2 : 0)).toString('utf8');
        this.emit('message', topic, payload);
      } else if (p.type === 13) {
        this.awaitingPong = false;
      }
    }
  }

  private ping() {
    const every = (this.o.keepalive ?? 30) * 1000 * 0.8;
    this.later(() => {
      if (!this.connected) return;
      if (this.awaitingPong) {
        this.drop('no answer from the broker');
        return;
      }
      this.awaitingPong = true;
      this.sock?.write(Buffer.from([0xc0, 0]));
      this.ping();
    }, every);
  }

  private drop(why: string, refused = false) {
    if (this.closed) return;
    this.clear();
    const s = this.sock;
    this.sock = null;
    s?.destroy();
    this.awaitingPong = false;
    this.set('error', why);
    // A refused login waits long: a wrong password shouldn't hammer the broker.
    const ms = refused ? 5 * 60_000 : RETRY_MS[Math.min(this.attempt++, RETRY_MS.length - 1)]!;
    this.later(() => this.open(), ms);
  }
}

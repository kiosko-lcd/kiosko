/**
 * A tiny MQTT broker for the tests: CONNECT (with a user check), SUBSCRIBE
 * with + and # wildcards, PUBLISH (retained too), PING, DISCONNECT, and the
 * last will when a client vanishes. QoS 0 only, like the client.
 */
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { encodeLength, readPackets } from './mqtt.ts';

const str = (b: Buffer, at: number) => {
  const len = b.readUInt16BE(at);
  return { s: b.subarray(at + 2, at + 2 + len).toString('utf8'), next: at + 2 + len };
};
const enc = (s: string) => {
  const b = Buffer.from(s);
  const l = Buffer.alloc(2);
  l.writeUInt16BE(b.length);
  return Buffer.concat([l, b]);
};
const publish = (topic: string, payload: string, retain: boolean) => {
  const body = Buffer.concat([enc(topic), Buffer.from(payload)]);
  return Buffer.concat([Buffer.from([0x30 | (retain ? 1 : 0)]), encodeLength(body.length), body]);
};

export function matches(filter: string, topic: string): boolean {
  const f = filter.split('/'), t = topic.split('/');
  for (let i = 0; i < f.length; i++) {
    if (f[i] === '#') return true;
    if (i >= t.length || (f[i] !== '+' && f[i] !== t[i])) return false;
  }
  return f.length === t.length;
}

export interface Broker {
  port: number;
  /** Every PUBLISH received, in order. */
  published: { topic: string; payload: string; retain: boolean; from: string }[];
  retained: Map<string, string>;
  /** Logins seen: client id, user, password. */
  logins: { clientId: string; username?: string; password?: string }[];
  /** Drops every client at once, as a broker restart does. */
  kick(): void;
  close(): Promise<void>;
}

export async function startBroker(o: { users?: Record<string, string> } = {}): Promise<Broker> {
  const subs = new Map<Socket, string[]>();
  const wills = new Map<Socket, { topic: string; payload: string; retain: boolean }>();
  const ids = new Map<Socket, string>();
  const b: Broker = {
    port: 0,
    published: [],
    retained: new Map(),
    logins: [],
    kick: () => {
      for (const s of [...subs.keys()]) s.destroy();
    },
    close: () => new Promise((r) => {
      b.kick();
      server.close(() => r());
    }),
  };
  const route = (topic: string, payload: string, retain: boolean, from: string) => {
    b.published.push({ topic, payload, retain, from });
    if (retain) {
      if (payload === '') b.retained.delete(topic);
      else b.retained.set(topic, payload);
    }
    for (const [s, filters] of subs) if (filters.some((f) => matches(f, topic))) s.write(publish(topic, payload, false));
  };
  const server: Server = createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on('data', (d) => {
      const { packets, rest } = readPackets(Buffer.concat([buf, d]));
      buf = Buffer.from(rest);
      for (const p of packets) {
        if (p.type === 1) {
          const flags = p.body[7]!;
          let at = 10;
          const id = str(p.body, at); at = id.next;
          let will: { topic: string; payload: string; retain: boolean } | undefined;
          if (flags & 0x04) {
            const t = str(p.body, at); at = t.next;
            const m = str(p.body, at); at = m.next;
            will = { topic: t.s, payload: m.s, retain: !!(flags & 0x20) };
          }
          const user = flags & 0x80 ? str(p.body, at) : undefined; if (user) at = user.next;
          const pass = flags & 0x40 ? str(p.body, at) : undefined;
          b.logins.push({ clientId: id.s, ...(user ? { username: user.s } : {}), ...(pass ? { password: pass.s } : {}) });
          if (o.users && (!user || o.users[user.s] !== pass?.s)) {
            sock.write(Buffer.from([0x20, 2, 0, 4]));
            sock.end();
            return;
          }
          ids.set(sock, id.s);
          if (will) wills.set(sock, will);
          subs.set(sock, []);
          sock.write(Buffer.from([0x20, 2, 0, 0]));
        } else if (p.type === 3) {
          const t = str(p.body, 0);
          route(t.s, p.body.subarray(t.next).toString('utf8'), !!(p.flags & 1), ids.get(sock) ?? '?');
        } else if (p.type === 8) {
          const pid = p.body.subarray(0, 2);
          const filters: string[] = [];
          let at = 2;
          while (at < p.body.length) {
            const t = str(p.body, at);
            filters.push(t.s);
            at = t.next + 1;
          }
          subs.get(sock)?.push(...filters);
          sock.write(Buffer.concat([Buffer.from([0x90, 2 + filters.length]), pid, Buffer.alloc(filters.length)]));
          for (const [topic, payload] of b.retained) if (filters.some((f) => matches(f, topic))) sock.write(publish(topic, payload, true));
        } else if (p.type === 12) sock.write(Buffer.from([0xd0, 0]));
        else if (p.type === 14) {
          wills.delete(sock);
          sock.end();
        }
      }
    });
    const gone = () => {
      const w = wills.get(sock);
      wills.delete(sock);
      subs.delete(sock);
      if (w) route(w.topic, w.payload, w.retain, ids.get(sock) ?? '?');
    };
    sock.on('close', gone);
    sock.on('error', () => undefined);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  b.port = (server.address() as AddressInfo).port;
  return b;
}

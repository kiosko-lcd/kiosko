/**
 * Just enough of a WebSocket server (RFC 6455) for the network-screens server:
 * the handshake, binary messages both ways (masked from the client, as the
 * RFC requires), ping/pong and close. No extensions, no text messages, a cap
 * on the size of what a client may send. node:http has no WebSocket server,
 * and a dependency for 150 lines is not worth it.
 */
import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export interface WsOptions {
  /** The largest message a client may send, bytes; a bigger one closes the connection (1009). */
  maxMessage: number;
}

export class WsConn {
  private readonly sock: Duplex;
  private readonly max: number;
  private buf: Buffer = Buffer.alloc(0);
  private parts: Buffer[] = [];
  private partsLen = 0;
  private closed = false;
  private readonly onMsg: ((m: Buffer) => void)[] = [];
  private readonly onEnd: (() => void)[] = [];

  constructor(sock: Duplex, o: WsOptions) {
    this.sock = sock;
    this.max = o.maxMessage;
    sock.on('data', (d: Buffer) => this.data(d));
    sock.on('error', () => this.end());
    sock.on('close', () => this.end());
  }

  onMessage(f: (m: Buffer) => void): void {
    this.onMsg.push(f);
  }
  onClose(f: () => void): void {
    if (this.closed) f();
    else this.onEnd.push(f);
  }
  get isClosed(): boolean {
    return this.closed;
  }
  /** Bytes written but not yet sent. */
  get buffered(): number {
    return (this.sock as Duplex & { writableLength?: number }).writableLength ?? 0;
  }

  private frame(op: number, payload: Uint8Array): Buffer {
    const n = payload.length;
    const head = n < 126 ? Buffer.alloc(2) : n < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
    head[0] = 0x80 | op;
    if (n < 126) head[1] = n;
    else if (n < 65536) {
      head[1] = 126;
      head.writeUInt16BE(n, 2);
    } else {
      head[1] = 127;
      head.writeBigUInt64BE(BigInt(n), 2);
    }
    return Buffer.concat([head, payload]);
  }

  send(msg: Uint8Array): void {
    if (this.closed) return;
    this.sock.write(this.frame(0x2, msg));
  }

  /** Says goodbye (close frame with `code`) and hangs up. */
  close(code = 1000): void {
    if (this.closed) return;
    const p = Buffer.alloc(2);
    p.writeUInt16BE(code);
    try {
      this.sock.write(this.frame(0x8, p));
      this.sock.end();
    } catch {
      /* gone already */
    }
    const t = setTimeout(() => this.sock.destroy(), 2000);
    t.unref?.();
    this.end();
  }

  private end(): void {
    if (this.closed) return;
    this.closed = true;
    this.buf = Buffer.alloc(0);
    this.parts = [];
    for (const f of this.onEnd.splice(0)) f();
  }

  private data(d: Buffer): void {
    if (this.closed) return;
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    while (!this.closed) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = (b[0]! & 0x80) !== 0;
      const rsv = b[0]! & 0x70;
      const op = b[0]! & 0x0f;
      const masked = (b[1]! & 0x80) !== 0;
      let len = b[1]! & 0x7f;
      let off = 2;
      if (rsv || !masked) return this.close(1002);
      if (len === 126) {
        if (b.length < 4) return;
        len = b.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (b.length < 10) return;
        const big = b.readBigUInt64BE(2);
        if (big > BigInt(this.max)) return this.close(1009);
        len = Number(big);
        off = 10;
      }
      if (len > this.max) return this.close(1009);
      if (b.length < off + 4 + len) return;
      const mask = b.subarray(off, off + 4);
      const payload = Buffer.from(b.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i]! ^= mask[i & 3]!;
      this.buf = b.subarray(off + 4 + len);
      if (op >= 0x8) {
        // Control frames: whole, small.
        if (!fin || len > 125) return this.close(1002);
        if (op === 0x8) return this.close(1000);
        if (op === 0x9) this.sock.write(this.frame(0xa, payload));
        continue;
      }
      // Text, or anything but binary and its continuations: not ours.
      if (op === 0x1) return this.close(1003);
      if (op !== 0x2 && op !== 0x0) return this.close(1002);
      if ((op === 0x0) !== this.parts.length > 0) return this.close(1002);
      this.partsLen += payload.length;
      if (this.partsLen > this.max) return this.close(1009);
      this.parts.push(payload);
      if (fin) {
        const msg = this.parts.length === 1 ? this.parts[0]! : Buffer.concat(this.parts);
        this.parts = [];
        this.partsLen = 0;
        // A copy: a listener added by one of them hears the next message, not this one.
        for (const f of [...this.onMsg]) f(msg);
      }
    }
  }
}

/** Answers an upgrade request; null (and the socket closed with a 400) when it is not a WebSocket one. */
export function acceptWebSocket(req: IncomingMessage, sock: Duplex, o: WsOptions): WsConn | null {
  const key = String(req.headers['sec-websocket-key'] ?? '');
  const upgrade = String(req.headers.upgrade ?? '').toLowerCase();
  const connection = String(req.headers.connection ?? '').toLowerCase();
  if (req.method !== 'GET' || upgrade !== 'websocket' || !connection.split(/\s*,\s*/).includes('upgrade') || req.headers['sec-websocket-version'] !== '13' || Buffer.from(key, 'base64').length !== 16) {
    sock.end('HTTP/1.1 400 Bad Request\r\nconnection: close\r\ncontent-length: 0\r\n\r\n');
    return null;
  }
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ${accept}\r\n\r\n`);
  (sock as Duplex & { setNoDelay?: (b: boolean) => void }).setNoDelay?.(true);
  return new WsConn(sock, o);
}

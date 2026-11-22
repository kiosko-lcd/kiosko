/**
 * The crypto of the remote screen protocol, v1 (docs/remote-screen.md), the
 * same as firmware/esp32-screen/main/ks_proto.c: pairing by SPAKE2 (RFC 9382,
 * P-256, SHA-256) on a 6-digit code the screen shows, mutual proof of the
 * pairing key with fresh nonces, and a session sealed with ChaCha20-Poly1305
 * under an implicit sequence number per direction.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { N, G, decodePoint, encodePoint, mul, pointAdd, pointNeg, scalarBytes, scalarFrom, type Point } from './p256.ts';

export const PROTO = 1;
export const PORT = 7428;
export const NONCE_LEN = 32;
export const KEY_LEN = 32;
export const TAG_LEN = 16;
export const ID_A = 'kiosko';

/** RFC 9382's M and N for P-256. */
export const SPAKE_M = decodePoint(Buffer.from('02886e2f97ace46e55ba9dd7242579f2993b64e16ef3dcab95afd497333d8fa12f', 'hex'));
export const SPAKE_N = decodePoint(Buffer.from('03d8bbd6c639c62937b04d997f38c3770719c629d7014d49a24b4f98baa1292b49', 'hex'));

export const LABEL_AUTH_K = 'KSv1 auth kiosko';
export const LABEL_AUTH_D = 'KSv1 auth screen';

const hkdf = (ikm: Buffer, salt: Buffer, info: string, len: number) => Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from(info), len));
const hmac = (key: Buffer, ...parts: (Buffer | string)[]) => {
  const h = createHmac('sha256', key);
  for (const p of parts) h.update(p);
  return h.digest();
};

export function equal(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/** HMAC-SHA256(key, label || nk || nd || uid). */
export function authMac(key: Buffer, label: string, nk: Buffer, nd: Buffer, uid: string): Buffer {
  return hmac(key, label, nk, nd, uid);
}

/** One direction of a session: its key and the number of the next message. */
export interface Direction {
  key: Buffer;
  seq: bigint;
}
export interface Session {
  tx: Direction;
  rx: Direction;
}

/** HKDF(pairing key, nk || nd, "KSv1 session") → Kiosko→screen key, screen→Kiosko key. */
export function sessionKeys(key: Buffer, nk: Buffer, nd: Buffer, side: 'kiosko' | 'screen'): Session {
  const okm = hkdf(key, Buffer.concat([nk, nd]), 'KSv1 session', 64);
  const k2d = okm.subarray(0, 32), d2k = okm.subarray(32);
  return side === 'kiosko' ? { tx: { key: Buffer.from(k2d), seq: 0n }, rx: { key: Buffer.from(d2k), seq: 0n } } : { tx: { key: Buffer.from(d2k), seq: 0n }, rx: { key: Buffer.from(k2d), seq: 0n } };
}

function nonceOf(seq: bigint): Buffer {
  const n = Buffer.alloc(12);
  n.writeBigUInt64BE(seq, 4);
  return n;
}

/** A sealed message as it goes on the wire: u32 BE length, ciphertext, tag. */
export function seal(d: Direction, type: number, payload: Buffer): Buffer {
  const len = 1 + payload.length + TAG_LEN;
  const hdr = Buffer.alloc(4);
  hdr.writeUInt32BE(len);
  const c = createCipheriv('chacha20-poly1305', d.key, nonceOf(d.seq), { authTagLength: TAG_LEN });
  c.setAAD(hdr, { plaintextLength: len - TAG_LEN });
  const out = Buffer.concat([hdr, c.update(Buffer.from([type])), c.update(payload), c.final(), c.getAuthTag()]);
  d.seq++;
  return out;
}

/** Opens a sealed body (what follows the length); throws if it was tampered with, replayed or reordered. */
export function open(d: Direction, hdr: Buffer, body: Buffer): { type: number; payload: Buffer } {
  if (body.length < TAG_LEN + 1) throw new Error('sealed message too short');
  const dc = createDecipheriv('chacha20-poly1305', d.key, nonceOf(d.seq), { authTagLength: TAG_LEN });
  dc.setAAD(hdr, { plaintextLength: body.length - TAG_LEN });
  dc.setAuthTag(body.subarray(body.length - TAG_LEN));
  const pt = Buffer.concat([dc.update(body.subarray(0, body.length - TAG_LEN)), dc.final()]);
  d.seq++;
  return { type: pt[0]!, payload: pt.subarray(1) };
}

// ---- SPAKE2 --------------------------------------------------------------------

/** w = SHA256("KSv1 pake w" || uid || ":" || code) mod n. */
export function spakeW(uid: string, code: string): bigint {
  const h = createHash('sha256').update('KSv1 pake w').update(uid).update(':').update(code).digest();
  return scalarFrom(h) % N;
}

function le64(n: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}

/** RFC 9382's transcript: each piece with its 8-byte little-endian length. */
export function transcript(uid: string, X: Buffer, Y: Buffer, K: Buffer, w: bigint): Buffer {
  const parts = [Buffer.from(ID_A), Buffer.from(uid), X, Y, K, scalarBytes(w)];
  return Buffer.concat(parts.flatMap((p) => [le64(p.length), p]));
}

export interface SpakeKeys {
  /** The pairing key both sides keep. */
  key: Buffer;
  /** Kiosko's confirmation, and the screen's. */
  cA: Buffer;
  cB: Buffer;
}

export function spakeKeys(tt: Buffer): SpakeKeys {
  const h = createHash('sha256').update(tt).digest();
  const kc = hkdf(h, Buffer.alloc(0), 'KSv1 confirm', 64);
  return { key: hkdf(h, Buffer.alloc(0), 'KSv1 pair key', 32), cA: hmac(kc.subarray(0, 32), tt), cB: hmac(kc.subarray(32), tt) };
}

const randomScalar = () => {
  for (;;) {
    const k = scalarFrom(randomBytes(32));
    if (k > 0n && k < N) return k;
  }
};

/** Kiosko's half (A): X = x·G + w·M, then the keys from the screen's Y. */
export class SpakeA {
  readonly X: Buffer;
  private readonly x: bigint;
  private readonly w: bigint;
  private readonly uid: string;
  constructor(uid: string, code: string, x?: bigint) {
    this.uid = uid;
    this.w = spakeW(uid, code);
    this.x = x ?? randomScalar();
    this.X = encodePoint(pointAdd(mul(this.x, G), mul(this.w, SPAKE_M)));
  }
  finish(Yb: Buffer): SpakeKeys & { K: Buffer } {
    const Y = decodePoint(Yb);
    const K = mul(this.x, pointAdd(Y, pointNeg(mul(this.w, SPAKE_N))));
    if (!K) throw new Error('bad Y');
    const Kb = encodePoint(K);
    return { ...spakeKeys(transcript(this.uid, this.X, encodePoint(Y), Kb, this.w)), K: Kb };
  }
}

/** The screen's half (B), for the fake screen of the tests: what the firmware does. */
export function spakeRespond(uid: string, code: string, Xb: Buffer, y?: bigint): SpakeKeys & { Y: Buffer; K: Buffer } {
  const w = spakeW(uid, code);
  const X = decodePoint(Xb);
  const yy = y ?? randomScalar();
  const Y = encodePoint(pointAdd(mul(yy, G), mul(w, SPAKE_N)));
  const K: Point = mul(yy, pointAdd(X, pointNeg(mul(w, SPAKE_M))));
  if (!K) throw new Error('bad X');
  const Kb = encodePoint(K);
  return { ...spakeKeys(transcript(uid, encodePoint(X), Y, Kb, w)), Y, K: Kb };
}

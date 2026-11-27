/**
 * The remote screen protocol's crypto (remote/crypto.ts) without Node: SHA-256,
 * HMAC, HKDF, ChaCha20-Poly1305 (RFC 8439) and the screen's half of SPAKE2,
 * on Uint8Arrays. The browser screen's viewer runs it, and it has to: a page
 * opened at http://192.168.x.x is not a secure context, so it has no
 * `crypto.subtle`, only `crypto.getRandomValues`.
 *
 * Same messages, byte for byte, as crypto.ts: portable.test.ts checks it
 * against Node's crypto and against the firmware's vectors (vectors.ts).
 * Not constant-time; it runs on the viewer, whose key is in its localStorage
 * anyway.
 */
import { G, N, P, mod, mul, onCurve, pointAdd, pointNeg, pow, type Point } from '../remote/curve.ts';

export type Bytes = Uint8Array;

const enc = new TextEncoder();
export const utf8 = (s: string): Bytes => enc.encode(s);

export function concat(...parts: Bytes[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export const toHex = (b: Bytes): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

export function fromHex(h: string): Bytes {
  if (h.length % 2 || /[^0-9a-f]/i.test(h)) throw new Error('bad hex');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return out;
}

/** Compares without stopping at the first difference. */
export function equalBytes(a: Bytes, b: Bytes): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}

// ---- SHA-256, HMAC, HKDF ---------------------------------------------------------

const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export function sha256(...parts: Bytes[]): Bytes {
  const msg = parts.length === 1 ? parts[0]! : concat(...parts);
  const bits = msg.length * 8;
  const padded = new Uint8Array(((msg.length + 9 + 63) >> 6) << 6);
  padded.set(msg);
  padded[msg.length] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, Math.floor(bits / 0x100000000));
  dv.setUint32(padded.length - 4, bits >>> 0);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + 4 * i);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15]!, b = w[i - 2]!;
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) | 0;
    }
    let a = h[0]!, b = h[1]!, c = h[2]!, d = h[3]!, e = h[4]!, f = h[5]!, g = h[6]!, hh = h[7]!;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K256[i]! + w[i]!) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h[0] = (h[0]! + a) | 0;
    h[1] = (h[1]! + b) | 0;
    h[2] = (h[2]! + c) | 0;
    h[3] = (h[3]! + d) | 0;
    h[4] = (h[4]! + e) | 0;
    h[5] = (h[5]! + f) | 0;
    h[6] = (h[6]! + g) | 0;
    h[7] = (h[7]! + hh) | 0;
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) ov.setUint32(4 * i, h[i]!);
  return out;
}

export function hmac(key: Bytes, ...parts: Bytes[]): Bytes {
  const k = new Uint8Array(64);
  k.set(key.length > 64 ? sha256(key) : key);
  const ipad = k.map((x) => x ^ 0x36), opad = k.map((x) => x ^ 0x5c);
  return sha256(opad, sha256(ipad, ...parts));
}

/** HKDF-SHA256 (RFC 5869). */
export function hkdf(ikm: Bytes, salt: Bytes, info: string, len: number): Bytes {
  const prk = hmac(salt.length ? salt : new Uint8Array(32), ikm);
  const out = new Uint8Array(len);
  let t: Bytes = new Uint8Array(0);
  for (let i = 0, o = 0; o < len; i++) {
    t = hmac(prk, t, utf8(info), new Uint8Array([i + 1]));
    out.set(t.subarray(0, Math.min(32, len - o)), o);
    o += 32;
  }
  return out;
}

// ---- ChaCha20-Poly1305 (RFC 8439) --------------------------------------------------

/** One ChaCha20 block of state `s` (key, counter, nonce set) into `out`. */
function chachaBlock(s: Uint32Array, out: Uint32Array): void {
  let x0 = s[0]!, x1 = s[1]!, x2 = s[2]!, x3 = s[3]!, x4 = s[4]!, x5 = s[5]!, x6 = s[6]!, x7 = s[7]!;
  let x8 = s[8]!, x9 = s[9]!, x10 = s[10]!, x11 = s[11]!, x12 = s[12]!, x13 = s[13]!, x14 = s[14]!, x15 = s[15]!;
  for (let i = 0; i < 10; i++) {
    // Columns.
    x0 = (x0 + x4) | 0; x12 ^= x0; x12 = (x12 << 16) | (x12 >>> 16);
    x8 = (x8 + x12) | 0; x4 ^= x8; x4 = (x4 << 12) | (x4 >>> 20);
    x0 = (x0 + x4) | 0; x12 ^= x0; x12 = (x12 << 8) | (x12 >>> 24);
    x8 = (x8 + x12) | 0; x4 ^= x8; x4 = (x4 << 7) | (x4 >>> 25);
    x1 = (x1 + x5) | 0; x13 ^= x1; x13 = (x13 << 16) | (x13 >>> 16);
    x9 = (x9 + x13) | 0; x5 ^= x9; x5 = (x5 << 12) | (x5 >>> 20);
    x1 = (x1 + x5) | 0; x13 ^= x1; x13 = (x13 << 8) | (x13 >>> 24);
    x9 = (x9 + x13) | 0; x5 ^= x9; x5 = (x5 << 7) | (x5 >>> 25);
    x2 = (x2 + x6) | 0; x14 ^= x2; x14 = (x14 << 16) | (x14 >>> 16);
    x10 = (x10 + x14) | 0; x6 ^= x10; x6 = (x6 << 12) | (x6 >>> 20);
    x2 = (x2 + x6) | 0; x14 ^= x2; x14 = (x14 << 8) | (x14 >>> 24);
    x10 = (x10 + x14) | 0; x6 ^= x10; x6 = (x6 << 7) | (x6 >>> 25);
    x3 = (x3 + x7) | 0; x15 ^= x3; x15 = (x15 << 16) | (x15 >>> 16);
    x11 = (x11 + x15) | 0; x7 ^= x11; x7 = (x7 << 12) | (x7 >>> 20);
    x3 = (x3 + x7) | 0; x15 ^= x3; x15 = (x15 << 8) | (x15 >>> 24);
    x11 = (x11 + x15) | 0; x7 ^= x11; x7 = (x7 << 7) | (x7 >>> 25);
    // Diagonals.
    x0 = (x0 + x5) | 0; x15 ^= x0; x15 = (x15 << 16) | (x15 >>> 16);
    x10 = (x10 + x15) | 0; x5 ^= x10; x5 = (x5 << 12) | (x5 >>> 20);
    x0 = (x0 + x5) | 0; x15 ^= x0; x15 = (x15 << 8) | (x15 >>> 24);
    x10 = (x10 + x15) | 0; x5 ^= x10; x5 = (x5 << 7) | (x5 >>> 25);
    x1 = (x1 + x6) | 0; x12 ^= x1; x12 = (x12 << 16) | (x12 >>> 16);
    x11 = (x11 + x12) | 0; x6 ^= x11; x6 = (x6 << 12) | (x6 >>> 20);
    x1 = (x1 + x6) | 0; x12 ^= x1; x12 = (x12 << 8) | (x12 >>> 24);
    x11 = (x11 + x12) | 0; x6 ^= x11; x6 = (x6 << 7) | (x6 >>> 25);
    x2 = (x2 + x7) | 0; x13 ^= x2; x13 = (x13 << 16) | (x13 >>> 16);
    x8 = (x8 + x13) | 0; x7 ^= x8; x7 = (x7 << 12) | (x7 >>> 20);
    x2 = (x2 + x7) | 0; x13 ^= x2; x13 = (x13 << 8) | (x13 >>> 24);
    x8 = (x8 + x13) | 0; x7 ^= x8; x7 = (x7 << 7) | (x7 >>> 25);
    x3 = (x3 + x4) | 0; x14 ^= x3; x14 = (x14 << 16) | (x14 >>> 16);
    x9 = (x9 + x14) | 0; x4 ^= x9; x4 = (x4 << 12) | (x4 >>> 20);
    x3 = (x3 + x4) | 0; x14 ^= x3; x14 = (x14 << 8) | (x14 >>> 24);
    x9 = (x9 + x14) | 0; x4 ^= x9; x4 = (x4 << 7) | (x4 >>> 25);
  }
  out[0] = x0 + s[0]!; out[1] = x1 + s[1]!; out[2] = x2 + s[2]!; out[3] = x3 + s[3]!;
  out[4] = x4 + s[4]!; out[5] = x5 + s[5]!; out[6] = x6 + s[6]!; out[7] = x7 + s[7]!;
  out[8] = x8 + s[8]!; out[9] = x9 + s[9]!; out[10] = x10 + s[10]!; out[11] = x11 + s[11]!;
  out[12] = x12 + s[12]!; out[13] = x13 + s[13]!; out[14] = x14 + s[14]!; out[15] = x15 + s[15]!;
}

const words = (b: Bytes): Uint32Array => {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const w = new Uint32Array(b.length >> 2);
  for (let i = 0; i < w.length; i++) w[i] = dv.getUint32(4 * i, true);
  return w;
};

const LITTLE = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/** ChaCha20 from block `counter` on: XORs `data` in place. */
function chacha20(key: Bytes, nonce: Bytes, counter: number, data: Bytes): void {
  const s = new Uint32Array(16);
  s[0] = 0x61707865;
  s[1] = 0x3320646e;
  s[2] = 0x79622d32;
  s[3] = 0x6b206574;
  s.set(words(key), 4);
  s.set(words(nonce), 13);
  const block = new Uint32Array(16);
  const bytes = new Uint8Array(block.buffer);
  // Whole 32-bit words at a time where the data is aligned (it is when it starts a buffer).
  const aligned = LITTLE && data.byteOffset % 4 === 0;
  const dw = aligned ? new Uint32Array(data.buffer, data.byteOffset, data.length >> 2) : null;
  for (let off = 0; off < data.length; off += 64, counter++) {
    s[12] = counter;
    chachaBlock(s, block);
    if (!LITTLE) for (let i = 0; i < 16; i++) { const v = block[i]!; block[i] = ((v & 0xff) << 24) | ((v & 0xff00) << 8) | ((v >>> 8) & 0xff00) | (v >>> 24); }
    const end = Math.min(64, data.length - off);
    if (dw && end === 64) {
      const w0 = off >> 2;
      for (let i = 0; i < 16; i++) dw[w0 + i]! ^= block[i]!;
    } else for (let i = 0; i < end; i++) data[off + i]! ^= bytes[i]!;
  }
}

/**
 * Poly1305 (RFC 8439 §2.5) with ten 13-bit limbs in plain numbers: every
 * product is under 2^30 and every sum of ten under 2^34, so doubles keep
 * them exact; the final reduction is a BigInt, once per message.
 */
function poly1305(key: Bytes, msg: Bytes): Bytes {
  const rb = new Uint8Array(19);
  rb.set(key.subarray(0, 16));
  for (const i of [3, 7, 11, 15]) rb[i]! &= 15;
  for (const i of [4, 8, 12]) rb[i]! &= 252;
  const r = new Float64Array(20);
  for (let i = 0; i < 10; i++) {
    const bit = 13 * i, o = bit >> 3;
    r[i] = ((rb[o]! | (rb[o + 1]! << 8) | (rb[o + 2]! << 16)) >>> (bit & 7)) & 0x1fff;
    // What goes past 2^130 comes back times 5.
    r[i + 10] = r[i]! * 5;
  }
  const r0 = r[0]!, r1 = r[1]!, r2 = r[2]!, r3 = r[3]!, r4 = r[4]!, r5 = r[5]!, r6 = r[6]!, r7 = r[7]!, r8 = r[8]!, r9 = r[9]!;
  const s1 = r[11]!, s2 = r[12]!, s3 = r[13]!, s4 = r[14]!, s5 = r[15]!, s6 = r[16]!, s7 = r[17]!, s8 = r[18]!, s9 = r[19]!;
  let h0 = 0, h1 = 0, h2 = 0, h3 = 0, h4 = 0, h5 = 0, h6 = 0, h7 = 0, h8 = 0, h9 = 0;
  const block = new Uint8Array(19);
  for (let off = 0; off < msg.length; off += 16) {
    const n = Math.min(16, msg.length - off);
    let m: Bytes = msg, o = off;
    if (n < 16) {
      block.fill(0);
      block.set(msg.subarray(off, off + n));
      block[n] = 1;
      m = block;
      o = 0;
    }
    // A whole block's 2^128 bit is the 1 past its 16 bytes: in the last limb.
    const top = n === 16 ? 1 : m[o + 16]!;
    h0 += ((m[o + 0]! | (m[o + 1]! << 8) | (m[o + 2]! << 16)) >>> 0) & 0x1fff;
    h1 += ((m[o + 1]! | (m[o + 2]! << 8) | (m[o + 3]! << 16)) >>> 5) & 0x1fff;
    h2 += ((m[o + 3]! | (m[o + 4]! << 8) | (m[o + 5]! << 16)) >>> 2) & 0x1fff;
    h3 += ((m[o + 4]! | (m[o + 5]! << 8) | (m[o + 6]! << 16)) >>> 7) & 0x1fff;
    h4 += ((m[o + 6]! | (m[o + 7]! << 8) | (m[o + 8]! << 16)) >>> 4) & 0x1fff;
    h5 += ((m[o + 8]! | (m[o + 9]! << 8) | (m[o + 10]! << 16)) >>> 1) & 0x1fff;
    h6 += ((m[o + 9]! | (m[o + 10]! << 8) | (m[o + 11]! << 16)) >>> 6) & 0x1fff;
    h7 += ((m[o + 11]! | (m[o + 12]! << 8) | (m[o + 13]! << 16)) >>> 3) & 0x1fff;
    h8 += ((m[o + 13]! | (m[o + 14]! << 8) | (m[o + 15]! << 16)) >>> 0) & 0x1fff;
    h9 += ((m[o + 14]! | (m[o + 15]! << 8) | (top << 16)) >>> 5) & 0x1fff;
    const d0 = h0 * r0 + h1 * s9 + h2 * s8 + h3 * s7 + h4 * s6 + h5 * s5 + h6 * s4 + h7 * s3 + h8 * s2 + h9 * s1;
    const d1 = h0 * r1 + h1 * r0 + h2 * s9 + h3 * s8 + h4 * s7 + h5 * s6 + h6 * s5 + h7 * s4 + h8 * s3 + h9 * s2;
    const d2 = h0 * r2 + h1 * r1 + h2 * r0 + h3 * s9 + h4 * s8 + h5 * s7 + h6 * s6 + h7 * s5 + h8 * s4 + h9 * s3;
    const d3 = h0 * r3 + h1 * r2 + h2 * r1 + h3 * r0 + h4 * s9 + h5 * s8 + h6 * s7 + h7 * s6 + h8 * s5 + h9 * s4;
    const d4 = h0 * r4 + h1 * r3 + h2 * r2 + h3 * r1 + h4 * r0 + h5 * s9 + h6 * s8 + h7 * s7 + h8 * s6 + h9 * s5;
    const d5 = h0 * r5 + h1 * r4 + h2 * r3 + h3 * r2 + h4 * r1 + h5 * r0 + h6 * s9 + h7 * s8 + h8 * s7 + h9 * s6;
    const d6 = h0 * r6 + h1 * r5 + h2 * r4 + h3 * r3 + h4 * r2 + h5 * r1 + h6 * r0 + h7 * s9 + h8 * s8 + h9 * s7;
    const d7 = h0 * r7 + h1 * r6 + h2 * r5 + h3 * r4 + h4 * r3 + h5 * r2 + h6 * r1 + h7 * r0 + h8 * s9 + h9 * s8;
    const d8 = h0 * r8 + h1 * r7 + h2 * r6 + h3 * r5 + h4 * r4 + h5 * r3 + h6 * r2 + h7 * r1 + h8 * r0 + h9 * s9;
    const d9 = h0 * r9 + h1 * r8 + h2 * r7 + h3 * r6 + h4 * r5 + h5 * r4 + h6 * r3 + h7 * r2 + h8 * r1 + h9 * r0;
    let c = Math.floor(d0 / 8192);
    h0 = d0 - c * 8192;
    let v = d1 + c;
    c = Math.floor(v / 8192);
    h1 = v - c * 8192;
    v = d2 + c;
    c = Math.floor(v / 8192);
    h2 = v - c * 8192;
    v = d3 + c;
    c = Math.floor(v / 8192);
    h3 = v - c * 8192;
    v = d4 + c;
    c = Math.floor(v / 8192);
    h4 = v - c * 8192;
    v = d5 + c;
    c = Math.floor(v / 8192);
    h5 = v - c * 8192;
    v = d6 + c;
    c = Math.floor(v / 8192);
    h6 = v - c * 8192;
    v = d7 + c;
    c = Math.floor(v / 8192);
    h7 = v - c * 8192;
    v = d8 + c;
    c = Math.floor(v / 8192);
    h8 = v - c * 8192;
    v = d9 + c;
    c = Math.floor(v / 8192);
    h9 = v - c * 8192;
    h0 += c * 5;
    c = Math.floor(h0 / 8192);
    h0 -= c * 8192;
    h1 += c;
  }
  const h = [h0, h1, h2, h3, h4, h5, h6, h7, h8, h9];
  let acc = 0n;
  for (let i = 9; i >= 0; i--) acc = (acc << 13n) + BigInt(h[i]!);
  acc %= (1n << 130n) - 5n;
  let s = 0n;
  for (let i = 31; i >= 16; i--) s = (s << 8n) | BigInt(key[i]!);
  let tag = (acc + s) & ((1n << 128n) - 1n);
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    out[i] = Number(tag & 0xffn);
    tag >>= 8n;
  }
  return out;
}

const le64 = (n: number): Bytes => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setUint32(0, n >>> 0, true);
  new DataView(b.buffer).setUint32(4, Math.floor(n / 0x100000000), true);
  return b;
};
const pad16 = (n: number): Bytes => new Uint8Array((16 - (n % 16)) % 16);

function aeadTag(key: Bytes, nonce: Bytes, aad: Bytes, ct: Bytes): Bytes {
  const otk = new Uint8Array(64);
  chacha20(key, nonce, 0, otk);
  return poly1305(otk.subarray(0, 32), concat(aad, pad16(aad.length), ct, pad16(ct.length), le64(aad.length), le64(ct.length)));
}

/** ChaCha20-Poly1305: ciphertext || 16-byte tag. */
export function aeadSeal(key: Bytes, nonce: Bytes, plaintext: Bytes, aad: Bytes): Bytes {
  const out = new Uint8Array(plaintext.length + 16);
  out.set(plaintext);
  const ct = out.subarray(0, plaintext.length);
  chacha20(key, nonce, 1, ct);
  out.set(aeadTag(key, nonce, aad, ct), plaintext.length);
  return out;
}

/** The plaintext, or null when the tag doesn't match. */
export function aeadOpen(key: Bytes, nonce: Bytes, sealed: Bytes, aad: Bytes): Bytes | null {
  if (sealed.length < 16) return null;
  const ct = sealed.subarray(0, sealed.length - 16);
  if (!equalBytes(aeadTag(key, nonce, aad, ct), sealed.subarray(sealed.length - 16))) return null;
  const pt = ct.slice();
  chacha20(key, nonce, 1, pt);
  return pt;
}

// ---- the protocol: SPAKE2 (the screen's half), proofs, sealed messages ----------------

export const ID_A = 'kiosko';
export const LABEL_AUTH_K = 'KSv1 auth kiosko';
export const LABEL_AUTH_D = 'KSv1 auth screen';
export const TAG_LEN = 16;

const hex64 = (n: bigint) => n.toString(16).padStart(64, '0');
export const scalarBytes = (n: bigint): Bytes => fromHex(hex64(n));
export const scalarOf = (b: Bytes): bigint => (b.length ? BigInt('0x' + toHex(b)) : 0n);

export function encodePoint(p: Point): Bytes {
  if (!p) throw new Error('cannot encode the point at infinity');
  return fromHex('04' + hex64(p.x) + hex64(p.y));
}

export function decodePoint(b: Bytes): Point {
  let p: Point;
  if (b.length === 65 && b[0] === 4) p = { x: scalarOf(b.subarray(1, 33)), y: scalarOf(b.subarray(33)) };
  else if (b.length === 33 && (b[0] === 2 || b[0] === 3)) {
    const x = scalarOf(b.subarray(1));
    const rhs = mod(x * x * x - 3n * x + 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn);
    let y = pow(rhs, (P + 1n) / 4n);
    if (mod(y * y) !== rhs) throw new Error('not a point of P-256');
    if ((y & 1n) !== BigInt(b[0]! - 2)) y = mod(-y);
    p = { x, y };
  } else throw new Error('bad point encoding');
  if (!onCurve(p)) throw new Error('not a point of P-256');
  return p;
}

let mn: { M: Point; N: Point } | null = null;
function spakePoints(): { M: Point; N: Point } {
  mn ??= {
    M: decodePoint(fromHex('02886e2f97ace46e55ba9dd7242579f2993b64e16ef3dcab95afd497333d8fa12f')),
    N: decodePoint(fromHex('03d8bbd6c639c62937b04d997f38c3770719c629d7014d49a24b4f98baa1292b49')),
  };
  return mn;
}

/** w = SHA256("KSv1 pake w" || uid || ":" || code) mod n. */
export function spakeW(uid: string, code: string): bigint {
  return scalarOf(sha256(utf8('KSv1 pake w'), utf8(uid), utf8(':'), utf8(code))) % N;
}

function transcript(uid: string, X: Bytes, Y: Bytes, K: Bytes, w: bigint): Bytes {
  return concat(...[utf8(ID_A), utf8(uid), X, Y, K, scalarBytes(w)].flatMap((p) => [le64(p.length), p]));
}

export interface SpakeKeys {
  key: Bytes;
  cA: Bytes;
  cB: Bytes;
}

function spakeKeys(tt: Bytes): SpakeKeys {
  const h = sha256(tt);
  const kc = hkdf(h, new Uint8Array(0), 'KSv1 confirm', 64);
  return { key: hkdf(h, new Uint8Array(0), 'KSv1 pair key', 32), cA: hmac(kc.subarray(0, 32), tt), cB: hmac(kc.subarray(32), tt) };
}

/** 32 random bytes (crypto.getRandomValues: there even where crypto.subtle is not). */
export function randomBytes(n: number): Bytes {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}

function randomScalar(): bigint {
  for (;;) {
    const k = scalarOf(randomBytes(32));
    if (k > 0n && k < N) return k;
  }
}

/** The screen's half (B) of SPAKE2: Y = y·G + w·N, and the keys from Kiosko's X. */
export function spakeRespond(uid: string, code: string, Xb: Bytes, y?: bigint): SpakeKeys & { Y: Bytes } {
  const w = spakeW(uid, code);
  const X = decodePoint(Xb);
  const yy = y ?? randomScalar();
  const Y = encodePoint(pointAdd(mul(yy, G), mul(w, spakePoints().N)));
  const K = mul(yy, pointAdd(X, pointNeg(mul(w, spakePoints().M))));
  if (!K) throw new Error('bad X');
  return { ...spakeKeys(transcript(uid, encodePoint(X), Y, encodePoint(K), w)), Y };
}

/** HMAC-SHA256(key, label || nk || nd || uid): each side's proof that it has the pairing key. */
export function authMac(key: Bytes, label: string, nk: Bytes, nd: Bytes, uid: string): Bytes {
  return hmac(key, utf8(label), nk, nd, utf8(uid));
}

export interface Direction {
  key: Bytes;
  seq: number;
}
export interface Session {
  tx: Direction;
  rx: Direction;
}

/** HKDF(pairing key, nk || nd, "KSv1 session"): the first 32 bytes Kiosko→screen, the next screen→Kiosko. */
export function sessionKeys(key: Bytes, nk: Bytes, nd: Bytes, side: 'kiosko' | 'screen'): Session {
  const okm = hkdf(key, concat(nk, nd), 'KSv1 session', 64);
  const k2d = okm.slice(0, 32), d2k = okm.slice(32);
  return side === 'kiosko' ? { tx: { key: k2d, seq: 0 }, rx: { key: d2k, seq: 0 } } : { tx: { key: d2k, seq: 0 }, rx: { key: k2d, seq: 0 } };
}

function nonceOf(seq: number): Bytes {
  const n = new Uint8Array(12);
  const dv = new DataView(n.buffer);
  dv.setUint32(4, Math.floor(seq / 0x100000000));
  dv.setUint32(8, seq >>> 0);
  return n;
}

/** A sealed message as it goes on the wire: u32 BE length, then type and payload sealed, then the tag. */
export function seal(d: Direction, type: number, payload: Bytes): Bytes {
  const len = 1 + payload.length + TAG_LEN;
  const hdr = new Uint8Array(4);
  new DataView(hdr.buffer).setUint32(0, len);
  const body = aeadSeal(d.key, nonceOf(d.seq), concat(new Uint8Array([type]), payload), hdr);
  d.seq++;
  return concat(hdr, body);
}

/** Opens a whole sealed message (header included); throws if it was tampered with, replayed or reordered. */
export function open(d: Direction, msg: Bytes): { type: number; payload: Bytes } {
  if (msg.length < 4 + TAG_LEN + 1) throw new Error('sealed message too short');
  const len = new DataView(msg.buffer, msg.byteOffset, 4).getUint32(0);
  if (len !== msg.length - 4) throw new Error('bad length');
  const pt = aeadOpen(d.key, nonceOf(d.seq), msg.subarray(4), msg.subarray(0, 4));
  if (!pt) throw new Error('bad tag');
  d.seq++;
  return { type: pt[0]!, payload: pt.subarray(1) };
}

/** A plain (unsealed) message: u32 BE length, type, JSON. */
export function plain(type: number, obj: unknown): Bytes {
  const p = utf8(JSON.stringify(obj));
  const out = new Uint8Array(5 + p.length);
  new DataView(out.buffer).setUint32(0, p.length + 1);
  out[4] = type;
  out.set(p, 5);
  return out;
}

/** Reads a plain message; null if it is not one. */
export function readPlain(msg: Bytes): { type: number; json: Record<string, unknown> } | null {
  if (msg.length < 5 || new DataView(msg.buffer, msg.byteOffset, 4).getUint32(0) !== msg.length - 4) return null;
  try {
    const j = JSON.parse(new TextDecoder().decode(msg.subarray(5))) as unknown;
    return j && typeof j === 'object' && !Array.isArray(j) ? { type: msg[4]!, json: j as Record<string, unknown> } : null;
  } catch {
    return null;
  }
}

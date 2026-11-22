/**
 * Just enough P-256 for SPAKE2 (RFC 9382): point addition and scalar
 * multiplication, which Node's crypto doesn't expose (its ECDH gives x·G and
 * the x of x·P, not the points SPAKE2 needs). BigInt, Jacobian coordinates;
 * a pairing does four multiplications, a few tens of milliseconds. Not
 * constant-time: the scalars are ephemeral and used once, in a pairing the
 * user starts by hand.
 */
export const P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
export const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;
const GX = 0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n;
const GY = 0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n;

/** An affine point; `null` is the point at infinity. */
export type Point = { x: bigint; y: bigint } | null;
type Jac = { x: bigint; y: bigint; z: bigint };

export const G: Point = { x: GX, y: GY };

const mod = (a: bigint, m = P) => ((a % m) + m) % m;

function pow(a: bigint, e: bigint, m = P): bigint {
  let r = 1n;
  a = mod(a, m);
  while (e > 0n) {
    if (e & 1n) r = (r * a) % m;
    a = (a * a) % m;
    e >>= 1n;
  }
  return r;
}

const inv = (a: bigint, m = P) => pow(a, m - 2n, m);

export function onCurve(p: Point): boolean {
  if (!p) return false;
  if (p.x < 0n || p.x >= P || p.y < 0n || p.y >= P) return false;
  return mod(p.y * p.y - (p.x * p.x * p.x - 3n * p.x + B)) === 0n;
}

const toJac = (p: Point): Jac => (p ? { x: p.x, y: p.y, z: 1n } : { x: 1n, y: 1n, z: 0n });

function toAffine(j: Jac): Point {
  if (j.z === 0n) return null;
  const zi = inv(j.z);
  const zi2 = (zi * zi) % P;
  return { x: mod(j.x * zi2), y: mod(j.y * zi2 * zi) };
}

function dbl(p: Jac): Jac {
  if (p.z === 0n || p.y === 0n) return { x: 1n, y: 1n, z: 0n };
  // a = -3: M = 3(X - Z²)(X + Z²).
  const z2 = mod(p.z * p.z);
  const m = mod(3n * (p.x - z2) * (p.x + z2));
  const y2 = mod(p.y * p.y);
  const s = mod(4n * p.x * y2);
  const x = mod(m * m - 2n * s);
  const y = mod(m * (s - x) - 8n * y2 * y2);
  return { x, y, z: mod(2n * p.y * p.z) };
}

function add(p: Jac, q: Jac): Jac {
  if (p.z === 0n) return q;
  if (q.z === 0n) return p;
  const z1 = mod(p.z * p.z), z2 = mod(q.z * q.z);
  const u1 = mod(p.x * z2), u2 = mod(q.x * z1);
  const s1 = mod(p.y * z2 * q.z), s2 = mod(q.y * z1 * p.z);
  if (u1 === u2) return s1 === s2 ? dbl(p) : { x: 1n, y: 1n, z: 0n };
  const h = mod(u2 - u1), r = mod(s2 - s1);
  const h2 = mod(h * h), h3 = mod(h2 * h);
  const x = mod(r * r - h3 - 2n * u1 * h2);
  const y = mod(r * (u1 * h2 - x) - s1 * h3);
  return { x, y, z: mod(h * p.z * q.z) };
}

export function pointAdd(a: Point, b: Point): Point {
  return toAffine(add(toJac(a), toJac(b)));
}

export function pointNeg(a: Point): Point {
  return a ? { x: a.x, y: mod(-a.y) } : null;
}

export function mul(k: bigint, p: Point): Point {
  k = mod(k, N);
  let r: Jac = { x: 1n, y: 1n, z: 0n };
  let q = toJac(p);
  // Montgomery ladder: the same steps whatever the bits.
  let r1 = q;
  for (let i = 255; i >= 0; i--) {
    if ((k >> BigInt(i)) & 1n) {
      r = add(r, r1);
      r1 = dbl(r1);
    } else {
      r1 = add(r, r1);
      r = dbl(r);
    }
  }
  q = r;
  return toAffine(q);
}

const hex32 = (n: bigint) => n.toString(16).padStart(64, '0');

/** SEC1 uncompressed: 04 || x || y. */
export function encodePoint(p: Point): Buffer {
  if (!p) throw new Error('cannot encode the point at infinity');
  return Buffer.from('04' + hex32(p.x) + hex32(p.y), 'hex');
}

/** SEC1, uncompressed or compressed; throws unless it is a point of the curve. */
export function decodePoint(b: Buffer | Uint8Array): Point {
  const buf = Buffer.from(b);
  let p: Point;
  if (buf.length === 65 && buf[0] === 4) {
    p = { x: BigInt('0x' + buf.subarray(1, 33).toString('hex')), y: BigInt('0x' + buf.subarray(33).toString('hex')) };
  } else if (buf.length === 33 && (buf[0] === 2 || buf[0] === 3)) {
    const x = BigInt('0x' + buf.subarray(1).toString('hex'));
    const rhs = mod(x * x * x - 3n * x + B);
    let y = pow(rhs, (P + 1n) / 4n);
    if (mod(y * y) !== rhs) throw new Error('not a point of P-256');
    if ((y & 1n) !== BigInt(buf[0]! - 2)) y = mod(-y);
    p = { x, y };
  } else throw new Error('bad point encoding');
  if (!onCurve(p)) throw new Error('not a point of P-256');
  return p;
}

export const scalarFrom = (b: Buffer | Uint8Array) => BigInt('0x' + (Buffer.from(b).toString('hex') || '0'));
export const scalarBytes = (n: bigint) => Buffer.from(hex32(n), 'hex');

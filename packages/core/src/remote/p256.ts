/**
 * P-256 for the remote screen protocol: the curve's math (curve.ts, pure) and
 * the SEC1 encodings, as Buffers, Node's side uses.
 */
import { B_COEF as B, P, mod, onCurve, pow, type Point } from './curve.ts';

export { G, N, P, mul, onCurve, pointAdd, pointNeg, type Point } from './curve.ts';

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

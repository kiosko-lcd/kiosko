/**
 * Data on its way to a screen's thread. Messages between threads copy their
 * contents (structured clone), which keeps plain objects, arrays, Map, Set,
 * Date, RegExp, typed arrays and errors, but not what the canvas library
 * makes (a decoded `Image`, a `Canvas` a plugin painted in its `fetch`: they
 * are objects of C++, not of JavaScript), nor functions, nor what a class
 * gives its instances (their methods). So:
 *
 * - images and canvases travel as bytes (their encoded file, or their
 *   pixels) and are made again on the other side, once per object: the same
 *   picture in the next data is the same object there too, as it is here,
 *   so the tile cache, which compares by reference, still works;
 * - a function, or an object of a class, can't travel: `pack` says where it
 *   found one and the screen goes on painting on the main thread.
 */
import { Image, createCanvas, type Canvas } from '@napi-rs/canvas';

/** What a picture becomes for the trip. */
interface PackedPicture {
  [PICTURE]: 'image' | 'canvas';
  id: number;
  width: number;
  height: number;
  /** An image's encoded file (PNG, JPEG…) or a canvas' RGBA pixels. */
  bytes: Uint8Array;
}

const PICTURE = '\u0000kioskoPicture';
/** A Buffer arrives as a plain Uint8Array: this says to make it a Buffer again. */
const BUFFER = '\u0000kioskoBuffer';

export class Unclonable extends Error {}

/** What it is, for the log: `a History (a class)`, `a function`. */
function what(v: object): string {
  if (typeof v === 'function') return 'a function';
  const name = (Object.getPrototypeOf(v) as { constructor?: { name?: string } } | null)?.constructor?.name;
  return name ? `a ${name} (an object of a class)` : 'an object of a class';
}

const CLONED_AS_IS = [Date, RegExp, ArrayBuffer, Error, DataView] as const;

function isCanvas(v: object): v is Canvas {
  return typeof (v as Canvas).getContext === 'function' && typeof (v as Canvas).encode === 'function' && typeof (v as Canvas).width === 'number';
}

/** Identities of pictures, the same for the same object every time it travels. */
const ids = new WeakMap<object, PackedPicture>();
let nextId = 0;

function packPicture(v: Image | Canvas): PackedPicture {
  const known = ids.get(v);
  if (known) return known;
  let p: PackedPicture;
  if (v instanceof Image && v.src instanceof Uint8Array && v.src.length) {
    p = { [PICTURE]: 'image', id: ++nextId, width: v.width, height: v.height, bytes: v.src };
  } else {
    // A canvas, or an image read from a path: its pixels.
    const w = Math.max(1, v.width);
    const h = Math.max(1, v.height);
    let pixels: Uint8ClampedArray;
    if (isCanvas(v)) pixels = v.getContext('2d').getImageData(0, 0, w, h).data;
    else {
      const c = createCanvas(w, h);
      c.getContext('2d').drawImage(v, 0, 0);
      pixels = c.getContext('2d').getImageData(0, 0, w, h).data;
    }
    p = { [PICTURE]: 'canvas', id: ++nextId, width: w, height: h, bytes: new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength) };
  }
  ids.set(v, p);
  return p;
}

/**
 * `value` ready for `postMessage`. Throws `Unclonable` naming the first thing
 * that can't travel and where (`.history`).
 */
export function pack(value: unknown): unknown {
  const seen = new Map<object, unknown>();
  const walk = (v: unknown, path: string): unknown => {
    if (v === null || typeof v !== 'object') {
      if (typeof v === 'function' || typeof v === 'symbol') throw new Unclonable(`${path || 'the data'} is ${typeof v === 'function' ? 'a function' : 'a symbol'}`);
      return v;
    }
    if (seen.has(v)) return seen.get(v);
    if (v instanceof Image || isCanvas(v)) return packPicture(v);
    if (Buffer.isBuffer(v)) return { [BUFFER]: v };
    if (ArrayBuffer.isView(v) || CLONED_AS_IS.some((c) => v instanceof c)) return v;
    if (Array.isArray(v)) {
      const out: unknown[] = [];
      seen.set(v, out);
      v.forEach((x, i) => out.push(walk(x, `${path}[${i}]`)));
      return out;
    }
    if (v instanceof Map) {
      const out = new Map();
      seen.set(v, out);
      for (const [k, x] of v) out.set(walk(k, `${path}.<key>`), walk(x, `${path}.get(${JSON.stringify(String(k))})`));
      return out;
    }
    if (v instanceof Set) {
      const out = new Set();
      seen.set(v, out);
      for (const x of v) out.add(walk(x, `${path}.<item>`));
      return out;
    }
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) throw new Unclonable(`${path || 'the data'} is ${what(v)}`);
    const out: Record<string, unknown> = {};
    seen.set(v, out);
    for (const [k, x] of Object.entries(v)) out[k] = walk(x, `${path}.${k}`);
    return out;
  };
  return walk(value, '');
}

/**
 * The other end: makes pictures again. `pictures` keeps the ones already
 * made by id (the same picture in new data is the same object); it forgets
 * the oldest past `keep`.
 */
export function unpack(value: unknown, pictures: Map<number, Image | Canvas>, keep = 256): unknown {
  const seen = new Map<object, unknown>();
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v)) return seen.get(v);
    if ((v as PackedPicture)[PICTURE]) return picture(v as PackedPicture, pictures, keep);
    const buf = (v as { [BUFFER]?: Uint8Array })[BUFFER];
    if (buf) return Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
    if (ArrayBuffer.isView(v) || CLONED_AS_IS.some((c) => v instanceof c)) return v;
    if (Array.isArray(v)) {
      seen.set(v, v);
      for (let i = 0; i < v.length; i++) v[i] = walk(v[i]);
      return v;
    }
    if (v instanceof Map) {
      seen.set(v, v);
      for (const [k, x] of v) v.set(k, walk(x));
      return v;
    }
    if (v instanceof Set) {
      const items = [...v];
      seen.set(v, v);
      v.clear();
      for (const x of items) v.add(walk(x));
      return v;
    }
    seen.set(v, v);
    for (const [k, x] of Object.entries(v)) (v as Record<string, unknown>)[k] = walk(x);
    return v;
  };
  return walk(value);
}

function picture(p: PackedPicture, pictures: Map<number, Image | Canvas>, keep: number): Image | Canvas {
  const known = pictures.get(p.id);
  if (known) {
    // Most recently used last.
    pictures.delete(p.id);
    pictures.set(p.id, known);
    return known;
  }
  let made: Image | Canvas;
  if (p[PICTURE] === 'image') {
    const img = new Image();
    img.src = Buffer.from(p.bytes.buffer, p.bytes.byteOffset, p.bytes.byteLength);
    made = img;
  } else {
    const c = createCanvas(p.width, p.height);
    const g = c.getContext('2d');
    const data = g.createImageData(p.width, p.height);
    data.data.set(p.bytes);
    g.putImageData(data, 0, 0);
    made = c;
  }
  pictures.set(p.id, made);
  while (pictures.size > keep) pictures.delete(pictures.keys().next().value!);
  return made;
}

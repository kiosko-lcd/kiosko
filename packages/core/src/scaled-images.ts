/**
 * `canvas.loadImageScaled`: images shrunk to the size they are shown at, in
 * a thread of their own.
 *
 * Press photos come at 6 to 14 megapixels. Decoding them is already off the
 * JS thread (`loadImage` runs on libuv's pool), but Skia finishes preparing
 * an image the first time it is drawn, on the JS thread, inside a widget's
 * paint: 31 to 133 ms for one such photo in a 600×462 tile, and every panel
 * waits meanwhile. Here a worker decodes the image, scales it down to what
 * the tile needs and encodes it again (JPEG, or PNG when it has
 * transparency); the JS thread then loads that small image and prepares it
 * once, outside any paint (a few ms).
 *
 * One worker, started the first time it is needed, unref'd (it never keeps
 * Kiosko alive), started again if it dies. Without worker threads (or if
 * the worker can't start) it falls back to a plain `loadImage`.
 */
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { createCanvas, loadImage, type Image } from '@napi-rs/canvas';

export interface ScaleSize {
  width: number;
  height: number;
  fit?: 'cover' | 'contain';
}

/** The size to scale an image of `w`×`h` to for `size`: never larger than it is. */
export function scaledSize(w: number, h: number, size: ScaleSize): { width: number; height: number } {
  const sx = size.width / w, sy = size.height / h;
  const s = Math.min(1, (size.fit ?? 'cover') === 'cover' ? Math.max(sx, sy) : Math.min(sx, sy));
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) };
}

// The worker: CommonJS by eval, with the canvas library resolved from here.
const WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
const { readFile } = require('node:fs/promises');
const { createCanvas, loadImage } = require(workerData.canvas);
const scaledSize = ${scaledSize.toString()};
parentPort.on('message', async (job) => {
  try {
    const src = typeof job.src === 'string' ? await readFile(job.src) : Buffer.from(job.src);
    const img = await loadImage(src);
    const to = scaledSize(img.width, img.height, job.size);
    if (to.width >= img.width && to.height >= img.height) {
      // Already small enough: the bytes as they are.
      parentPort.postMessage({ id: job.id, ok: true, same: true });
      return;
    }
    const c = createCanvas(to.width, to.height);
    const g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, 0, 0, to.width, to.height);
    const png = src[0] === 0x89 && src[1] === 0x50;
    const out = png ? await c.encode('png') : await c.encode('jpeg', 90);
    const ab = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
    parentPort.postMessage({ id: job.id, ok: true, bytes: ab }, [ab]);
  } catch (err) {
    parentPort.postMessage({ id: job.id, ok: false, error: err && err.message ? err.message : String(err) });
  }
});
`;

type Pending = { resolve: (r: { same?: boolean; bytes?: ArrayBuffer }) => void; reject: (e: Error) => void };

let worker: Worker | null = null;
let broken = false;
let nextId = 1;
const pending = new Map<number, Pending>();

function startWorker(): Worker | null {
  if (worker) return worker;
  if (broken) return null;
  try {
    const canvas = createRequire(import.meta.url).resolve('@napi-rs/canvas');
    const w = new Worker(WORKER, { eval: true, workerData: { canvas } });
    w.on('message', (m: { id: number; ok: boolean; same?: boolean; bytes?: ArrayBuffer; error?: string }) => {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      // Idle: it mustn't keep Kiosko (or a test) alive.
      if (!pending.size) w.unref();
      if (m.ok) p.resolve(m);
      else p.reject(new Error(m.error ?? 'could not scale the image'));
    });
    const gone = (err?: Error) => {
      if (worker === w) worker = null;
      for (const [id, p] of pending) {
        pending.delete(id);
        p.reject(err ?? new Error('the image thread stopped'));
      }
    };
    w.on('error', gone);
    w.on('exit', () => gone());
    // Listening re-refs it: unref after the listeners, ref only while there is work.
    w.unref();
    worker = w;
    return w;
  } catch {
    // No worker threads here: plain loadImage from now on.
    broken = true;
    return null;
  }
}

/** Prepares an image for painting now (Skia does it on the first draw), so a widget's paint doesn't. */
function warm(img: Image): Image {
  // Scaled down, as a widget will draw it (and so with the same filtering).
  const w = Math.max(1, Math.round(img.width / 3)), h = Math.max(1, Math.round(img.height / 3));
  createCanvas(w, h).getContext('2d').drawImage(img, 0, 0, w, h);
  return img;
}

export async function loadImageScaled(src: string | Buffer | Uint8Array, size: ScaleSize): Promise<Image> {
  if (!(size.width > 0) || !(size.height > 0)) throw new Error('loadImageScaled: width and height must be over 0');
  const w = startWorker();
  if (!w) return warm(await loadImage(src));
  const id = nextId++;
  const job = typeof src === 'string' ? src : src.buffer.slice(src.byteOffset, src.byteOffset + src.byteLength);
  const r = await new Promise<{ same?: boolean; bytes?: ArrayBuffer }>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.ref();
    // A buffer is copied, not moved: the caller may still use theirs.
    w.postMessage({ id, src: job, size });
  });
  return warm(await loadImage(r.same || !r.bytes ? src : Buffer.from(r.bytes)));
}

/**
 * `@napi-rs/canvas` for the browser demo (the build aliases the package to
 * this file). Skia's binding copies the HTML Canvas 2D API, so the
 * compositor, the drawing kit and every plugin draw on the browser's own 2D
 * context unchanged. What differs is around it, and that's what lives here:
 *
 *   createCanvas       OffscreenCanvas (also inside a worker), or a <canvas>
 *   loadImage          fetch + createImageBitmap (no file paths here)
 *   GlobalFonts        FontFace from URLs, served next to the demo
 *   encode / toBuffer  Skia encodes synchronously; a browser can't, so only
 *                      the asynchronous `encode` exists (and `toBlob` below)
 *
 * Only the subset Kiosko uses is here; anything else is undefined on
 * purpose, so a new dependency on Skia-only API fails loudly in the demo
 * check (scripts/demo-check-docker.sh).
 */

export type Canvas = (OffscreenCanvas | HTMLCanvasElement) & {
  /** Like Skia's `encode`: PNG, JPEG or WebP bytes. */
  encode(format: 'png' | 'jpeg' | 'webp', quality?: number): Promise<Uint8Array>;
  /** Skia encodes synchronously; the browser can't. Throws: use `encode`. */
  toBuffer(): never;
};
export type SKRSContext2D = OffscreenCanvasRenderingContext2D;

const hasOffscreen = typeof OffscreenCanvas !== 'undefined';

/** A canvas as a Blob, in whichever way this kind of canvas offers. */
export function toBlob(c: OffscreenCanvas | HTMLCanvasElement, type = 'image/png', quality?: number): Promise<Blob> {
  if ('convertToBlob' in c) return c.convertToBlob({ type, ...(quality !== undefined ? { quality } : {}) });
  return new Promise((ok, fail) => c.toBlob((b) => (b ? ok(b) : fail(new Error('toBlob failed'))), type, quality));
}

const extras = {
  encode: {
    value(this: OffscreenCanvas | HTMLCanvasElement, format: 'png' | 'jpeg' | 'webp', quality?: number) {
      return toBlob(this, `image/${format}`, quality === undefined ? undefined : quality / 100).then(async (b) => new Uint8Array(await b.arrayBuffer()));
    },
  },
  toBuffer: {
    value() {
      throw new Error('canvas.toBuffer() is synchronous in Skia and has no browser equivalent: use encode()');
    },
  },
};

export function createCanvas(width: number, height: number): Canvas {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  let c: OffscreenCanvas | HTMLCanvasElement;
  if (hasOffscreen) c = new OffscreenCanvas(w, h);
  else {
    c = document.createElement('canvas');
    c.width = w;
    c.height = h;
  }
  return Object.defineProperties(c, extras) as Canvas;
}

type Source = string | URL | Blob | ArrayBuffer | ArrayBufferView;

/** Decodes an image from a URL or from bytes. File paths can't be read here. */
export async function loadImage(src: Source): Promise<ImageBitmap> {
  let blob: Blob;
  if (src instanceof Blob) blob = src;
  else if (typeof src === 'string' || src instanceof URL) {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`loadImage: ${res.status} for ${String(src)}`);
    blob = await res.blob();
  } else {
    // Copy into a plain ArrayBuffer: a Node Buffer view may share a bigger one.
    const bytes = src instanceof ArrayBuffer ? new Uint8Array(src) : new Uint8Array(src.buffer, src.byteOffset, src.byteLength);
    blob = new Blob([bytes.slice()]);
  }
  return createImageBitmap(blob);
}

/** Skia's `Image` class; widgets only ever get images from `loadImage`. */
export class Image {
  constructor() {
    throw new Error('new Image() is not available in the browser demo: use loadImage()');
  }
}

// ---------- Fonts ----------

const faces = new Map<string, Promise<void>>();
type FontSet = { add(f: FontFace): void };
const fontSet = (): FontSet => ((globalThis as { fonts?: FontSet }).fonts ?? document.fonts) as FontSet;

/**
 * Fonts are fetched gzipped (`.gz`, about half the size) and unpacked with
 * DecompressionStream, so the demo doesn't depend on the host compressing
 * them. Without DecompressionStream the plain file is fetched instead.
 */
async function fetchFont(url: string): Promise<ArrayBuffer> {
  const gz = typeof DecompressionStream !== 'undefined';
  const res = await fetch(gz ? `${url}.gz` : url);
  if (!res.ok) throw new Error(`font ${url}: ${res.status}`);
  const buf = await res.arrayBuffer();
  const head = new Uint8Array(buf, 0, 2);
  // A host may already have undone the gzip (Content-Encoding): use as is.
  if (!gz || head[0] !== 0x1f || head[1] !== 0x8b) return buf;
  return new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
}

function add(family: string, data: Promise<ArrayBuffer>): void {
  const job = data.then(async (buf) => {
    const face = new FontFace(family, buf);
    await face.load();
    fontSet().add(face);
  });
  job.catch((err) => console.error(`Kiosko demo: cannot load the font ${family}:`, err));
  faces.set(family, job);
}

export const GlobalFonts = {
  /** In the demo `path` is a URL (see shims/fonts.ts). Loads in the background: await `fontsReady()`. */
  registerFromPath(path: string, family?: string): boolean {
    const name = family ?? path.replace(/^.*\//, '').replace(/\.[^.]+$/, '');
    if (!faces.has(name)) add(name, fetchFont(path));
    return true;
  },
  register(data: ArrayBuffer | ArrayBufferView, family?: string): boolean {
    if (!family) return false;
    add(family, Promise.resolve(data instanceof ArrayBuffer ? data : (new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice().buffer as ArrayBuffer)));
    return true;
  },
  has(family: string): boolean {
    return faces.has(family);
  },
  get families(): { family: string; styles: unknown[] }[] {
    return [...faces.keys()].map((family) => ({ family, styles: [] }));
  },
};

/**
 * Resolves when every font registered so far is loaded or has failed (a
 * failure is logged; text then falls back to a browser font).
 */
export async function fontsReady(): Promise<void> {
  await Promise.allSettled(faces.values());
}

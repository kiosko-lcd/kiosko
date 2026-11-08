/**
 * Downloading photos, with a disk cache and a small in-memory one.
 *
 * The disk cache isn't an optimisation: it's what keeps a network outage from
 * blanking the screen, since the widget keeps rotating over what's stored. So
 * photos are kept by URL and only removed by age, never on start.
 *
 * Decoding goes through the canvas API the runtime hands to `fetch`
 * (`ctx.canvas.loadImage`): an image decoded by another copy of the canvas
 * library couldn't be drawn on the panel.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CanvasApi, Image } from '@tessera/sdk';
import { USER_AGENT } from './feeds.ts';

/** 12 MB: a front-page photo is nowhere near, and it bounds a poisoned link. */
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
/** Smaller than this, a photo can't fill a frame. */
const MIN_PHOTO = { w: 240, h: 135 };

export function cacheName(url: string): string {
  return createHash('sha1').update(url).digest('hex').slice(0, 24);
}

/**
 * Local path of the photo, downloading it if needed. Atomic write (temp file
 * and rename) so a process dying halfway doesn't leave a truncated JPEG that
 * would then fail to decode on every pass without ever being retried.
 */
export async function cacheImage(dir: string, url: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, cacheName(url));
  try {
    if (statSync(path).size > 0) return path;
  } catch {
    /* not cached yet: download it */
  }
  const timeout = AbortSignal.timeout(timeoutMs);
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'image/*' },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new Error('empty response');
  if (buf.length > MAX_IMAGE_BYTES) throw new Error(`image of ${buf.length} bytes, too big`);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, buf);
  renameSync(tmp, path);
  return path;
}

/** Decoded photos by URL (null = it failed): shared by every widget of the plugin. */
const decoded = new Map<string, Image | null>();
const MAX_DECODED = 12;

/** A photo already loaded by `loadPhoto`, for painting. */
export function photoFor(url: string | null | undefined): Image | null {
  return url ? (decoded.get(url) ?? null) : null;
}

/** Downloads (or takes from the cache) and decodes. Null if anything fails. */
export async function loadPhoto(
  dir: string,
  url: string,
  o: { canvas: CanvasApi; timeoutMs: number; signal?: AbortSignal; log?: (msg: string) => void },
): Promise<Image | null> {
  if (decoded.has(url)) {
    const hit = decoded.get(url)!;
    // Refresh its place in the LRU.
    decoded.delete(url);
    decoded.set(url, hit);
    return hit;
  }
  let img: Image | null = null;
  try {
    const path = await cacheImage(dir, url, o.timeoutMs, o.signal);
    img = await o.canvas.loadImage(readFileSync(path));
    // A thumbnail or a pixel that slipped past the feed parser would paint as a blur or a flat colour.
    if (img.width < MIN_PHOTO.w || img.height < MIN_PHOTO.h) throw new Error(`${img.width}×${img.height}, too small for a background`);
  } catch (err) {
    img = null;
    o.log?.(`photo dropped (${err instanceof Error ? err.message : String(err)}): ${url.slice(0, 90)}`);
  }
  decoded.set(url, img);
  while (decoded.size > MAX_DECODED) decoded.delete(decoded.keys().next().value!);
  return img;
}

/** Removes photos untouched for more than `maxAgeHours`. */
export function pruneImageCache(dir: string, maxAgeHours: number, now = Date.now()): number {
  const cutoff = now - maxAgeHours * 3600_000;
  let removed = 0;
  try {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      try {
        if (statSync(p).mtimeMs < cutoff) {
          unlinkSync(p);
          removed += 1;
        }
      } catch {
        /* another process removed it between listing and stat */
      }
    }
  } catch {
    /* the cache doesn't exist yet */
  }
  return removed;
}

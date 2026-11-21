/**
 * Reads files out of an npm tarball (a gzipped tar) without unpacking it
 * and without running anything in it: the store's index builder takes a
 * plugin's kiosko-manifest.json and its docs/ pictures this way. No
 * dependency: node:zlib and a parser of tar headers (ustar, with pax and
 * GNU long names).
 *
 * Refused outright: a path that climbs out (`..`) or starts at the root.
 * Links (symbolic or hard) are never followed: they are skipped. Above
 * `maxBytes` unpacked, it stops.
 */
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

export interface TarFiles {
  /** Wanted files by their path inside the package (`package/kiosko-manifest.json`). */
  files: Map<string, Buffer>;
  /** Entries skipped (links, devices) with why. */
  skipped: { path: string; why: string }[];
}

/** 20 MB unpacked: no plugin's tarball comes close; more is a bomb. */
export const MAX_TARBALL_BYTES = 20 * 1024 * 1024;

const str = (b: Buffer, start: number, len: number) => {
  const s = b.subarray(start, start + len);
  const end = s.indexOf(0);
  return s.subarray(0, end < 0 ? s.length : end).toString('utf8');
};
const octal = (b: Buffer, start: number, len: number) => {
  const s = str(b, start, len).trim();
  if (!s) return 0;
  if (!/^[0-7]+$/.test(s)) throw new Error(`bad number in a tar header: ${JSON.stringify(s)}`);
  return parseInt(s, 8);
};

/** A path as it may be used: no `..`, not absolute, no backslashes or NULs. */
export function safeTarPath(p: string): string {
  const clean = p.replace(/^\.\//, '');
  if (!clean || clean.includes('\0') || clean.includes('\\') || clean.startsWith('/') || /^[A-Za-z]:/.test(clean) || clean.split('/').includes('..')) throw new Error(`unsafe path in the tarball: ${JSON.stringify(p)}`);
  return clean;
}

/** pax extended header records (`27 path=very/long/name\n`). */
function pax(body: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < body.length) {
    const space = body.indexOf(0x20, i);
    if (space < 0) break;
    const len = Number(body.subarray(i, space).toString());
    if (!len) break;
    const rec = body.subarray(space + 1, i + len - 1).toString('utf8');
    const eq = rec.indexOf('=');
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}

/** The wanted regular files of a tar (already gunzipped). */
export function readTar(tar: Buffer, want: (path: string) => boolean): TarFiles {
  const files = new Map<string, Buffer>();
  const skipped: TarFiles['skipped'] = [];
  let off = 0;
  let longName: string | null = null;
  let paxPath: string | null = null;
  while (off + 512 <= tar.length) {
    const h = tar.subarray(off, off + 512);
    if (h.every((x) => x === 0)) break;
    const size = octal(h, 124, 12);
    const type = String.fromCharCode(h[156] || 0x30);
    const magic = str(h, 257, 6);
    const prefix = magic.startsWith('ustar') ? str(h, 345, 155) : '';
    let name = longName ?? paxPath ?? (prefix ? `${prefix}/${str(h, 0, 100)}` : str(h, 0, 100));
    const bodyStart = off + 512;
    const bodyEnd = bodyStart + size;
    if (bodyEnd > tar.length) throw new Error('truncated tarball');
    const body = tar.subarray(bodyStart, bodyEnd);
    off = bodyStart + Math.ceil(size / 512) * 512;
    if (type === 'L') {
      longName = str(body, 0, body.length);
      continue;
    }
    if (type === 'x') {
      paxPath = pax(body).path ?? null;
      continue;
    }
    if (type === 'g') continue;
    longName = null;
    paxPath = null;
    name = safeTarPath(name);
    if (type === '0' || type === '\0' || type === '7') {
      if (want(name)) files.set(name, Buffer.from(body));
    } else if (type === '5') {
      // a folder: nothing to read
    } else skipped.push({ path: name, why: type === '1' ? 'a hard link' : type === '2' ? 'a symbolic link' : `entry type ${JSON.stringify(type)}` });
  }
  return { files, skipped };
}

/** The wanted files of a .tgz, unpacked in memory up to `maxBytes`. */
export function readTarGz(tgz: Buffer, want: (path: string) => boolean, maxBytes = MAX_TARBALL_BYTES): TarFiles {
  let tar: Buffer;
  try {
    tar = gunzipSync(tgz, { maxOutputLength: maxBytes });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE' || /too large|maxOutputLength|Cannot create a Buffer/i.test(String(err))) throw new Error(`the tarball unpacks to more than ${Math.round(maxBytes / 1e6)} MB`);
    throw err;
  }
  return readTar(tar, want);
}

/** Whether bytes are what an npm `integrity` (`sha512-<base64>`) says. */
export function checkIntegrity(bytes: Buffer, integrity: string): boolean {
  const m = /^sha512-([A-Za-z0-9+/=]+)$/.exec(integrity.trim().split(/\s+/)[0] ?? '');
  if (!m) return false;
  return createHash('sha512').update(bytes).digest('base64') === m[1];
}

/** The npm `integrity` of some bytes. */
export const integrityOf = (bytes: Buffer) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;

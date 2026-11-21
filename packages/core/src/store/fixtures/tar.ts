/** Test helper: a tarball made in memory, the way npm packs one (ustar, `package/` prefix). */
import { gzipSync } from 'node:zlib';

export interface Entry {
  path: string;
  body?: string | Buffer;
  /** `0` file, `2` symlink, `1` hard link, `5` folder, `x` pax header. */
  type?: string;
  link?: string;
}

function header(path: string, size: number, type: string, link = ''): Buffer {
  const h = Buffer.alloc(512);
  h.write(path.slice(0, 100), 0, 'utf8');
  h.write('0000644\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  h.write('00000000000\0', 136);
  h.write('        ', 148);
  h.write(type, 156);
  h.write(link.slice(0, 100), 157);
  h.write('ustar\0', 257);
  h.write('00', 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return h;
}

const pad = (b: Buffer) => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)]);

export function makeTar(entries: Entry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const body = Buffer.from(e.body ?? '');
    parts.push(header(e.path, body.length, e.type ?? '0', e.link), pad(body));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

export const makeTgz = (entries: Entry[]) => gzipSync(makeTar(entries));

/** A pax record (`len path=value\n`), its length counting itself. */
export function paxRecord(key: string, value: string): string {
  const rest = ` ${key}=${value}\n`;
  let len = rest.length + 1;
  while (String(len).length + rest.length !== len) len = String(len).length + rest.length;
  return `${len}${rest}`;
}

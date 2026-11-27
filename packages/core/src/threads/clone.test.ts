import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MessageChannel } from 'node:worker_threads';
import { Image, createCanvas, type Canvas } from '@napi-rs/canvas';
import { PictureCache, Unclonable, pack, unpack } from './clone.ts';

/** Through a real message port, as between threads. */
async function trip(v: unknown): Promise<unknown> {
  const { port1, port2 } = new MessageChannel();
  const got = new Promise((r) => port2.once('message', r));
  port1.postMessage(pack(v));
  const out = await got;
  port1.close();
  return out;
}

test('clone: plain data, Map, Set, Date and Buffers arrive as they left, cycles included', async () => {
  const shared = { n: 1 };
  const v: Record<string, unknown> = { a: [1, 'x', null, true], m: new Map([['k', shared]]), s: new Set([2]), d: new Date(5), b: Buffer.from('hi'), shared, nested: { shared } };
  v.self = v;
  const out = unpack(await trip(v), new Map()) as typeof v;
  assert.deepEqual(out.a, [1, 'x', null, true]);
  assert.deepEqual((out.m as Map<string, unknown>).get('k'), { n: 1 });
  assert.ok((out.s as Set<number>).has(2));
  assert.equal((out.d as Date).getTime(), 5);
  assert.ok(Buffer.isBuffer(out.b), 'a Buffer again, not a bare Uint8Array');
  assert.equal((out.b as Buffer).toString(), 'hi');
  assert.equal(out.self, out, 'cycles kept');
  assert.equal((out.nested as { shared: unknown }).shared, out.shared, 'shared references stay shared');
});

test('clone: images and canvases travel as bytes and come back drawable, the same object for the same picture', async () => {
  const c = createCanvas(4, 2);
  const g = c.getContext('2d');
  g.fillStyle = '#ff0000';
  g.fillRect(0, 0, 4, 2);
  const img = new Image();
  img.src = await c.encode('png');
  const pictures = new Map<number, Image | Canvas>();
  const first = unpack(await trip({ img, c }), pictures) as { img: Image; c: Canvas };
  assert.ok(first.img instanceof Image);
  assert.equal(first.img.width, 4);
  const dst = createCanvas(4, 2);
  dst.getContext('2d').drawImage(first.c, 0, 0);
  assert.deepEqual([...dst.getContext('2d').getImageData(1, 1, 1, 1).data], [255, 0, 0, 255], 'the canvas came with its pixels');
  dst.getContext('2d').drawImage(first.img, 0, 0);
  assert.deepEqual([...dst.getContext('2d').getImageData(2, 0, 1, 1).data], [255, 0, 0, 255], 'the image too');
  // New data with the same picture: the same object on the other side (the tile cache compares by reference).
  const again = unpack(await trip({ img, c, more: 1 }), pictures) as { img: Image; c: Canvas };
  assert.equal(again.img, first.img);
  assert.equal(again.c, first.c);
});

test("clone: a function or an object of a class can't travel, and pack says where it is", () => {
  class History {
    has(): boolean {
      return true;
    }
  }
  assert.throws(() => pack({ entities: [], history: new History() }), (e: unknown) => e instanceof Unclonable && /\.history is a History \(an object of a class\)/.test(e.message));
  assert.throws(() => pack({ list: [{ format: () => 'x' }] }), /\.list\[0\]\.format is a function/);
  assert.equal(pack(Object.assign(Object.create(null) as object, { a: 1 })) !== undefined, true, 'objects without a prototype are plain');
});

test('clone: a thread keeps a picture while some data shows it, and lets it go when none does', async () => {
  const pictures = new PictureCache();
  const radar = (n: number) => {
    const c = createCanvas(66, 40);
    c.getContext('2d').fillRect(0, 0, n, n);
    return c;
  };
  const logo = createCanvas(8, 8);
  // A rain radar every ten minutes for a day: only the latest one stays made.
  for (let i = 0; i < 144; i++) {
    const data = pictures.unpack(await trip({ img: radar(i % 40), logo }), ['instance:rain']) as { img: Canvas; logo: Canvas };
    assert.ok(data.img);
    assert.ok(pictures.size <= 2, `${pictures.size} pictures kept after ${i + 1} radars: only the latest one and the logo are shown`);
  }
  assert.equal(pictures.size, 2);
  // The same picture in new data (another key) is still the same object over there.
  const other = pictures.unpack(await trip({ logo }), ['source:brand']) as { logo: Canvas };
  const again = pictures.unpack(await trip({ img: null, logo }), ['instance:rain']) as { logo: Canvas };
  assert.equal(other.logo, again.logo);
  assert.equal(pictures.size, 1, 'the radar went with the data that showed it');
  // Data gone: its pictures too.
  pictures.unpack(undefined, ['instance:rain']);
  pictures.unpack(undefined, ['source:brand']);
  assert.equal(pictures.size, 0);
});

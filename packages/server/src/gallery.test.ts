import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Registry, normalize } from '@kiosko/core';
import { definePlugin, defineWidget } from '@kiosko/sdk';
import { buildGallery, type GalleryData } from './gallery.ts';

const registry = new Registry();
registry.add(
  definePlugin({
    id: 'demo',
    name: { en: 'Demo', es: 'Muestra' },
    description: { en: 'Two widgets to look at.', es: 'Dos widgets que mirar.' },
    version: '1.2.3',
    widgets: [
      defineWidget({ id: 'one', name: { en: 'One', es: 'Uno' }, description: 'The same in both', size: { min: { w: 40, h: 20 }, preferred: { w: 200, h: 80 } }, render: () => undefined, demo: () => ({}) }),
      defineWidget({ id: 'two', name: 'Two', render: () => undefined, demo: () => ({}) }),
    ],
  }),
);

const tile = (type: string) => ({ id: `t-${type}`, x: 0, y: 0, w: 24, h: 6, widgets: [{ id: `w-${type}`, type, options: {} }] });
const sample = normalize({
  screens: [
    { id: 'square', name: 'Square', width: 240, height: 240, device: { driver: 'virtual' }, pages: [{ id: 'q', name: 'Q', tiles: [tile('demo/one')] }] },
    {
      id: 'bar',
      name: 'Bar',
      width: 480,
      height: 116,
      device: { driver: 'virtual' },
      pages: [
        { id: 'a', name: 'First Page', tiles: [tile('demo/one')] },
        { id: 'b', name: 'Off', enabled: false, tiles: [tile('demo/two')] },
      ],
    },
  ],
});

test('gallery: the page, the pictures and the same catalogue as data, in both languages', () => {
  const out = mkdtempSync(join(tmpdir(), 'kiosko-gallery-'));
  try {
    assert.equal(buildGallery(registry, { out, now: 1_700_000_000_000 }), 2);
    const data = JSON.parse(readFileSync(join(out, 'gallery.json'), 'utf8')) as GalleryData;
    assert.equal(data.count, 2);
    assert.deepEqual(data.pages, [], 'no sample pages unless asked');
    assert.equal(data.plugins.length, 1);
    const [p] = data.plugins;
    assert.deepEqual({ id: p!.id, version: p!.version, name: p!.name, description: p!.description }, { id: 'demo', version: '1.2.3', name: { en: 'Demo', es: 'Muestra' }, description: { en: 'Two widgets to look at.', es: 'Dos widgets que mirar.' } });
    assert.deepEqual(p!.widgets.map((w) => [w.type, w.name.en, w.name.es, w.file, w.width, w.height]), [
      ['demo/one', 'One', 'Uno', 'img/demo-one.png', 200, 80],
      ['demo/two', 'Two', 'Two', 'img/demo-two.png', 480, 300],
    ]);
    for (const w of p!.widgets) assert.ok(statSync(join(out, w.file)).size > 0, w.file);
    const page = readFileSync(join(out, 'index.html'), 'utf8');
    assert.match(page, /img\/demo-one\.png/);
    assert.match(page, /href="https:\/\/kioskolcd\.dev\/"/, 'a way back to the front page');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("gallery: with a sample config, the enabled pages of its most bar-shaped screen as pictures", () => {
  const out = mkdtempSync(join(tmpdir(), 'kiosko-gallery-'));
  try {
    buildGallery(registry, { out, pages: sample });
    const data = JSON.parse(readFileSync(join(out, 'gallery.json'), 'utf8')) as GalleryData;
    assert.deepEqual(data.pages, [{ id: 'a', name: 'First Page', file: 'img/page-first-page.jpg', width: 480, height: 116 }]);
    const jpeg = readFileSync(join(out, 'img/page-first-page.jpg'));
    assert.deepEqual([...jpeg.subarray(0, 3)], [0xff, 0xd8, 0xff], 'a JPEG');
    assert.ok(!existsSync(join(out, 'img/page-off.jpg')));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

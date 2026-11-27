import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadImage } from '@napi-rs/canvas';
import { normalize } from '../config/store.ts';
import { Registry } from '../registry.ts';
import { Runtime, type FrameInfo } from '../runtime.ts';
import plugin, { History, feed } from './fixtures/plugin.ts';

process.env.KIOSKO_QUIET = '1';

const MODULE = new URL('./fixtures/plugin.ts', import.meta.url).href;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 8000, what = 'timed out') {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await sleep(20);
  assert.ok(cond(), what);
}

const page = (type: string) => ({ id: 'p', name: 'p', grid: { cols: 1, rows: 1, gap: 0, padding: 0 }, tiles: [{ id: 't', x: 0, y: 0, w: 1, h: 1, chrome: 'bare', widgets: [{ id: `w-${type}`, type, options: {} }] }] });
const screen = (id: string, type: string, extra: Record<string, unknown> = {}) => ({ id, name: id, width: 64, height: 32, maxFps: 20, pixelShift: { enabled: false }, device: { driver: 'virtual' }, pages: [page(type)], interludes: [{ id: 'pad', type: 'tt/pad', enabled: false, everyMs: 3_600_000, maxSeconds: 600 }], ...extra });

function setup(threads: string, screens: Record<string, unknown>[], o: { module?: boolean } = {}) {
  const reg = new Registry();
  reg.add(plugin, 'test', o.module === false ? undefined : MODULE);
  const rt = new Runtime(reg, normalize({ threads, screens }));
  return rt;
}

/** The colour in the middle of a frame, as the editor gets it (asked of the thread that painted it). */
async function middle(f: FrameInfo): Promise<[number, number, number]> {
  const img = await loadImage(await f.image());
  const { createCanvas } = await import('@napi-rs/canvas');
  const c = createCanvas(img.width, img.height);
  c.getContext('2d').drawImage(img, 0, 0);
  const [r, g, b] = c.getContext('2d').getImageData(img.width >> 1, img.height >> 1, 1, 1).data;
  return [r!, g!, b!];
}
const near = (got: number[], want: number[]) => got.every((v, i) => Math.abs(v - want[i]!) < 40);

/** Waits for screen `id`'s last frame to have `rgb` in the middle. */
async function untilColor(rt: Runtime, id: string, rgb: number[], what: string, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    const f = rt.lastFrame(id);
    if (f && near(await middle(f).catch(() => [-99, -99, -99]), rgb)) return;
    if (Date.now() > end) assert.fail(`${what}: timed out`);
    await sleep(30);
  }
}

const screenOf = (rt: Runtime, id: string) => rt.status().screens.find((s) => s.id === id)!;

test('threads: each screen paints in its own thread, with the data as it changes, its logs and paint times back here', async () => {
  const rt = setup('always', [screen('a', 'tt/fill'), screen('b', 'tt/fill')]);
  const frames: FrameInfo[] = [];
  rt.on('frame', (f: FrameInfo) => frames.push(f));
  rt.start();
  try {
    await until(() => !!rt.lastFrame('a') && !!rt.lastFrame('b'), 15_000, 'both screens painted');
    for (const id of ['a', 'b']) assert.equal(screenOf(rt, id).thread.on, true, `${id} in a thread`);
    assert.ok(near(await middle(rt.lastFrame('a')!), [0, 0, 0]), 'no data yet: black');
    await until(() => !!feed.color);
    feed.color!({ color: '#00ff00' });
    await untilColor(rt, 'a', [0, 255, 0], 'painted with the data sent to its thread');
    await untilColor(rt, 'b', [0, 255, 0], 'the other screen too, in its own');
    assert.ok(frames.filter((f) => f.screenId === 'a').length >= 2, 'the editor heard of the frames');
    // Each thread loaded the plugin itself: its module is not the main thread's.
    assert.ok(rt.logs.some((l) => l.scope === 'tt' && l.message === 'green, loaded 1 time(s) here'));
    // The frames reached the panels, which stay on the main thread.
    assert.ok(screenOf(rt, 'a').device.framesSent >= 2);
    await until(() => rt.paintTimes.list().some((p) => p.type === 'tt/fill'), 4000, 'paint times come back');
    await until(() => (screenOf(rt, 'a').thread.heapBytes ?? 0) > 0, 8000, 'each thread says its memory');
    assert.ok(screenOf(rt, 'a').frames.frames >= 2, 'and its frames');
  } finally {
    rt.stop();
  }
});

test('threads: a widget on a source profile gets that profile\'s data in its thread, and moves when its profile changes', async () => {
  const tinted = (id: string, profile?: string) => ({ ...screen(id, 'tt/tinted'), pages: [{ ...page('tt/tinted'), tiles: [{ id: 't', x: 0, y: 0, w: 1, h: 1, chrome: 'bare', widgets: [{ id: `w-${id}`, type: 'tt/tinted', options: {}, ...(profile ? { profile } : {}) }] }] }] });
  const cfg = (bProfile: string | undefined) => normalize({ threads: 'always', sources: { 'tt/tint': { color: '#00ff00' } }, sourceProfiles: { 'tt/tint': { red: { name: 'Red', options: { color: '#ff0000' } }, blue: { name: 'Blue', options: { color: '#0000ff' } } } }, screens: [tinted('a'), tinted('b', bProfile)] });
  const reg = new Registry();
  reg.add(plugin, 'test', MODULE);
  const rt = new Runtime(reg, cfg('red'));
  rt.start();
  try {
    await until(() => !!rt.lastFrame('a') && !!rt.lastFrame('b'), 15_000, 'both screens painted');
    assert.equal(screenOf(rt, 'b').thread.on, true);
    await untilColor(rt, 'a', [0, 255, 0], 'the default profile');
    await untilColor(rt, 'b', [255, 0, 0], 'its own profile, in its thread');
    rt.apply(cfg('blue'));
    await untilColor(rt, 'b', [0, 0, 255], 'another profile: its data goes to the thread');
    await untilColor(rt, 'a', [0, 255, 0], 'the other screen keeps the default one');
  } finally {
    rt.stop();
  }
});

test('threads: an interlude played from the Play page gets the buttons in its thread, and an alert stops it', async () => {
  const rt = setup('always', [screen('a', 'tt/fill'), screen('b', 'tt/fill')]);
  rt.start();
  try {
    await until(() => !!rt.lastFrame('a'), 15_000);
    assert.equal(rt.press('a', { key: 'a', pressed: true }), false, 'nothing being played');
    rt.playInterlude('a', 'pad', true);
    await until(() => screenOf(rt, 'a').playing && rt.lastFrame('a')?.interlude === 'tt/pad');
    await untilColor(rt, 'a', [255, 0, 0], 'the interlude plays');
    assert.equal(rt.press('a', { key: 'a', pressed: true }), true, 'taken by the interlude');
    await untilColor(rt, 'a', [255, 255, 255], 'the button reached the interlude in its thread');
    rt.postAlert({ id: 'smoke', level: 'critical', title: 'Smoke', text: 'Kitchen' });
    await until(() => rt.lastFrame('a')?.alert === 'smoke' && rt.lastFrame('b')?.alert === 'smoke', 8000, 'the alert on both');
    await until(() => screenOf(rt, 'a').interlude === null, 4000, 'the interlude stopped');
    rt.ackAlert('smoke');
    await until(() => !!rt.lastFrame('a') && !rt.lastFrame('a')!.alert, 8000, 'the pages are back');
  } finally {
    rt.stop();
  }
});

test("threads: data that can't go to another thread sends that screen back to the main thread, which goes on painting it", async () => {
  const rt = setup('always', [screen('a', 'tt/classy'), screen('b', 'tt/fill')]);
  rt.start();
  try {
    await until(() => !!rt.lastFrame('a') && !!feed.classy, 15_000);
    feed.classy!({ history: new History() });
    await until(() => !screenOf(rt, 'a').thread.on, 8000, 'back on the main thread');
    const t = screenOf(rt, 'a').thread;
    assert.equal(t.why, 'failed');
    assert.match(t.error ?? '', /\.history is a History \(an object of a class\)/);
    assert.ok(rt.logs.some((l) => l.scope === 'screen:a' && /painting on the main thread/.test(l.message)));
    await untilColor(rt, 'a', [0, 0, 255], 'painted here with the class and its methods');
    assert.equal(screenOf(rt, 'b').thread.on, true, 'the other screen keeps its thread');
  } finally {
    rt.stop();
  }
});

test("threads: a plugin whose code can't be loaded again keeps its screens on the main thread", async () => {
  const rt = setup('always', [screen('a', 'tt/fill'), screen('b', 'tt/fill')], { module: false });
  rt.start();
  try {
    await until(() => !screenOf(rt, 'a').thread.on && !screenOf(rt, 'b').thread.on, 15_000);
    assert.match(screenOf(rt, 'a').thread.error ?? '', /tt: its code can't be loaded again in a thread/);
    await until(() => !!rt.lastFrame('a'));
  } finally {
    rt.stop();
  }
});

test('threads: never keeps every screen on the main thread; a screen can say otherwise, and moving it keeps its panel', async () => {
  const rt = setup('never', [screen('a', 'tt/fill'), screen('b', 'tt/fill')]);
  rt.start();
  try {
    await until(() => !!rt.lastFrame('a') && !!rt.lastFrame('b'));
    assert.deepEqual(rt.status().screens.map((s) => [s.id, s.thread.on, s.thread.why, s.thread.heapBytes]), [['a', false, 'setting', null], ['b', false, 'setting', null]]);
    const sent = screenOf(rt, 'a').device.framesSent;
    rt.pin('a', 'p');
    rt.apply(normalize({ threads: 'never', screens: [screen('a', 'tt/fill', { thread: 'always' }), screen('b', 'tt/fill')] }));
    await until(() => screenOf(rt, 'a').thread.on && screenOf(rt, 'a').device.framesSent > sent, 15_000, 'moved to a thread, same panel');
    assert.equal(screenOf(rt, 'a').thread.why, 'always');
    assert.equal(screenOf(rt, 'a').pinned, 'p', 'what was pinned stays pinned');
    assert.equal(screenOf(rt, 'b').thread.on, false);
  } finally {
    rt.stop();
  }
});

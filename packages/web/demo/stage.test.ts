// The 3D page's panel loop (stage.ts), with a clock that only moves when the
// loop sleeps: what it paints, in which order, and when it stops.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Registry, Runtime, normalize } from '@kiosko/core';
import { defineInterlude, definePlugin, defineWidget } from '@kiosko/sdk';
import type { StageChannel, StageFrame } from './protocol.ts';
import { Stage } from './stage.ts';

const ended: { plan: string; completed: boolean }[] = [];
const registry = new Registry();
registry.add(
  definePlugin({
    id: 't',
    name: 'T',
    version: '1',
    widgets: [
      defineWidget({ id: 'still', name: 'Still', size: { min: { w: 40, h: 20 }, preferred: { w: 150, h: 30 } }, render: () => undefined, demo: () => ({}) }),
      defineWidget({
        id: 'mover',
        name: 'Mover',
        render: () => undefined,
        demo: () => ({}),
        // Six frames: the first and the last are the still picture, so four are painted.
        animation: () => ({ id: 'wave', frames: 6, fps: 10 }),
        animationEnded: ({ plan, completed }) => void ended.push({ plan: plan.id, completed }),
      }),
    ],
    interludes: [defineInterlude({ id: 'show', name: 'Show', fps: 5, prepare: async () => ({ frames: 3, draw: () => undefined }) })],
  }),
);

const tile = (id: string, type: string) => ({ id: `tile-${id}`, x: 0, y: 0, w: 24, h: 6, widgets: [{ id: `w-${id}`, type, options: {} }] });
const config = normalize({
  screens: [
    {
      id: 's',
      name: 'S',
      width: 320,
      height: 80,
      device: { driver: 'virtual' },
      pages: [
        { id: 'a', name: 'Alpha', tiles: [tile('a', 't/still')] },
        { id: 'b', name: 'Beta', tiles: [tile('b', 't/mover')] },
        { id: 'c', name: 'Off', enabled: false, tiles: [tile('c', 't/still')] },
      ],
      interludes: [{ id: 'i', type: 't/show', enabled: true, everyMs: 60_000, maxSeconds: 1, options: {} }],
    },
  ],
});
const runtime = new Runtime(registry, config, { demo: true });
const screen = config.screens[0]!;

type Seen = Omit<StageFrame, 'bitmap'> & { bitmap: string; at: number };

/** Runs a channel until `enough` frames have been seen, on a clock that jumps to each sleep's end. */
async function play(channel: StageChannel, enough: (seen: Seen[]) => boolean): Promise<Seen[]> {
  let t = 1_700_000_000_000;
  const seen: Seen[] = [];
  let done!: () => void;
  const finished = new Promise<void>((r) => (done = r));
  const stage: Stage<string> = new Stage({
    runtime: () => runtime,
    snap: (canvas, reused) => `${canvas.width}x${canvas.height}${reused ? ' copy' : ''}`,
    emit: (f) => {
      seen.push({ ...f, at: t });
      if (enough(seen) || seen.length > 400) {
        stage.stop();
        done();
      }
    },
    now: () => t,
    sleep: async (ms) => {
      t += Math.max(1, Math.ceil(ms));
    },
    rnd: () => 0.5,
  });
  stage.start([channel]);
  await finished;
  return seen;
}

test('stage: which pages a channel shows', () => {
  const stage = new Stage<string>({ runtime: () => runtime, snap: () => '', emit: () => undefined });
  const names = (ch: StageChannel) => stage.pagesOf(ch, screen).map((p) => p.name);
  assert.deepEqual(names({ id: 'p' }), ['Alpha', 'Beta'], 'every enabled page');
  assert.deepEqual(names({ id: 'p', pages: ['beta', 'a'] }), ['Beta', 'Alpha'], 'by name or id, in the order asked');
  assert.deepEqual(names({ id: 'p', pages: ['nope'] }), ['Alpha', 'Beta'], 'unknown names: all of them rather than none');

  const [alone] = stage.pagesOf({ id: 'p', widget: { type: 't/still' } }, screen);
  assert.equal(alone!.tiles.length, 1);
  const widget = alone!.tiles[0]!.widgets[0]!;
  assert.equal(widget.type, 't/still');
  // 150×30 preferred on a 320×80 screen: twice as big fills it (2 is the most).
  assert.equal(widget.zoom, 2);
  assert.equal(stage.pagesOf({ id: 'p', widget: { type: 't/still', zoom: 1.5 } }, screen)[0]!.tiles[0]!.widgets[0]!.zoom, 1.5);
});

test('stage: a still page is painted once a second, and pages take turns', async () => {
  const seen = await play({ id: 'p0', screenId: 's', pages: ['Alpha', 'Beta'], pageMs: 3000, firstAnimationMs: 60_000 }, (s) => s.some((f) => f.page === 'Beta'));
  assert.ok(seen.every((f) => f.channel === 'p0' && f.kind === 'page'));
  assert.deepEqual(seen.map((f) => f.seq), seen.map((_, i) => i + 1));
  assert.equal(seen[0]!.bitmap, '320x80');
  const alpha = seen.filter((f) => f.page === 'Alpha');
  assert.ok(alpha.length >= 3 && alpha.length <= 4, `Alpha for about three seconds (${alpha.length} frames)`);
  for (let i = 1; i < alpha.length; i++) assert.ok(alpha[i]!.at - alpha[i - 1]!.at <= 1010, 'never more than a second apart');
  assert.equal(seen.at(-1)!.page, 'Beta');
});

test("stage: a widget's animation plays in between, at its own pace, and the widget is told it ended", async () => {
  ended.length = 0;
  const seen = await play({ id: 'p0', screenId: 's', pages: ['Beta'], firstAnimationMs: 1500, animateMs: [60_000, 60_000] }, (s) => s.filter((f) => f.kind === 'page').length >= 4 && s.some((f) => f.kind === 'animation'));
  const moving = seen.filter((f) => f.kind === 'animation');
  assert.equal(moving.length, 4, 'frames 1 to 4 of 6');
  assert.ok(moving.every((f) => f.what === 't/mover · wave' && f.page === 'Beta'));
  for (let i = 1; i < moving.length; i++) assert.equal(moving[i]!.at - moving[i - 1]!.at, 100, '10 fps');
  assert.deepEqual(ended, [{ plan: 'wave', completed: true }]);
  // Before it and after it, the page as usual; and no second animation before its time.
  assert.equal(seen[0]!.kind, 'page');
  assert.equal(seen.at(-1)!.kind, 'page');
});

test("stage: the screen's interludes play whole, from a canvas that is painted on again", async () => {
  const seen = await play({ id: 'p0', screenId: 's', pages: ['Alpha'], interludeMs: 2000, firstAnimationMs: 60_000 }, (s) => s.filter((f) => f.kind === 'interlude').length >= 3 && s.at(-1)!.kind === 'page');
  const show = seen.filter((f) => f.kind === 'interlude');
  assert.equal(show.length, 3);
  assert.ok(show.every((f) => f.what === 't/show' && f.bitmap === '320x80 copy'));
  for (let i = 1; i < show.length; i++) assert.equal(show[i]!.at - show[i - 1]!.at, 200, '5 fps');
  assert.equal(seen.filter((f) => f.kind === 'page')[0]!.bitmap, '320x80', 'pages give their canvas away');
});

test('stage: stopping it stops the frames, and a new start replaces the old one', async () => {
  const seen: string[] = [];
  const stage = new Stage<string>({ runtime: () => runtime, snap: () => 'x', emit: (f) => void seen.push(f.channel), sleep: () => new Promise((r) => setTimeout(r, 5)) });
  stage.start([{ id: 'old', screenId: 's' }]);
  await new Promise((r) => setTimeout(r, 20));
  stage.start([{ id: 'new', screenId: 's' }]);
  await new Promise((r) => setTimeout(r, 30));
  const olds = seen.filter((c) => c === 'old').length;
  assert.ok(olds >= 1 && seen.includes('new'));
  stage.stop();
  await new Promise((r) => setTimeout(r, 20));
  const count = seen.length;
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(seen.length, count, 'nothing after stop');
  assert.equal(seen.filter((c) => c === 'old').length, olds, 'the old channel stopped when the new one started');
  runtime.stop();
});

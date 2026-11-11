import assert from 'node:assert/strict';
import { test } from 'node:test';
import { definePlugin, defineWidget } from '@kiosko/sdk';
import { normalize as norm } from './config/store.ts';
import { Registry } from './registry.ts';
import { Runtime, type FrameInfo } from './runtime.ts';

process.env.KIOSKO_QUIET = '1';

const drawn: { anim: boolean; frame?: number; data: unknown }[] = [];

function setup(widget: Parameters<typeof defineWidget>[0]) {
  const reg = new Registry();
  reg.add(definePlugin({ id: 't', name: 'T', version: '1', widgets: [defineWidget(widget)] }));
  const cfg = norm({
    screens: [
      {
        id: 's1',
        name: 'S',
        width: 160,
        height: 80,
        maxFps: 30,
        device: { driver: 'virtual' },
        pages: [{ id: 'p', name: 'p', grid: { cols: 1, rows: 1, gap: 0, padding: 0 }, tiles: [{ id: 'tile', x: 0, y: 0, w: 1, h: 1, chrome: 'bare', widgets: [{ id: 'w', type: 't/anim', options: {} }] }] }],
      },
    ],
  });
  const rt = new Runtime(reg, cfg);
  rt.rnd = () => 0;
  return rt;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 4000) {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await sleep(20);
  assert.ok(cond(), 'timed out');
}
const sent = (rt: Runtime) => rt.status().screens[0]!.device.framesSent;

let played = 0;

test('runtime: a widget animates by itself, only the frames between the two stills are sent, and the still comes back', async () => {
  drawn.length = 0;
  const rt = setup({
    id: 'anim',
    name: 'Anim',
    chrome: 'bare',
    render: (g, ctx) => {
      drawn.push({ anim: !!ctx.anim, ...(ctx.frame !== undefined ? { frame: ctx.frame } : {}), data: ctx.data });
      g.fillStyle = ctx.anim ? '#00f' : '#0f0';
      g.fillRect(ctx.box.x, ctx.box.y, ctx.box.w * (ctx.anim?.t ?? 0.5), ctx.box.h);
    },
    animationGap: { minMs: 0, maxMs: 0 },
    // Once: with a zero gap it would start again at once.
    animation: ({ trigger }) => (trigger === 'idle' && !played++ ? { id: 'slide', frames: 6, fps: 30 } : null),
  });
  const animFrames: FrameInfo[] = [];
  rt.on('frame', (f: FrameInfo) => f.animation && animFrames.push(f));
  rt.start();
  try {
    await until(() => drawn.filter((d) => d.anim).length >= 4);
    // 6 frames: the first and the last are the still picture, not painted as animation.
    assert.deepEqual(drawn.filter((d) => d.anim).slice(0, 4).map((d) => d.frame), [1, 2, 3, 4]);
    // The still picture, the 4 frames between the stills, and the still again (it comes from the tile cache, but is sent anew).
    await until(() => rt.status().screens[0]!.animation === null && sent(rt) >= 6);
    await sleep(300);
    assert.equal(sent(rt), 6, 'nothing more is sent once it is over');
    assert.ok(animFrames.length >= 1, 'the editor is told about frames of the animation');
    assert.equal(animFrames[0]!.animation, 't/anim');
  } finally {
    rt.stop();
  }
});

let longPlayed = 0;

test('runtime: new data cuts an interruptible animation short and the screen repaints with it', async () => {
  drawn.length = 0;
  let version = 0;
  const rt = setup({
    id: 'anim',
    name: 'Anim',
    chrome: 'bare',
    fetch: async () => ({ version: ++version }),
    intervalMs: 5000,
    render: (g, ctx) => {
      drawn.push({ anim: !!ctx.anim, ...(ctx.frame !== undefined ? { frame: ctx.frame } : {}), data: ctx.data });
      g.fillStyle = '#0f0';
      g.fillRect(ctx.box.x, ctx.box.y, 10, 10);
    },
    animationGap: { minMs: 0, maxMs: 0 },
    // Long enough to be cut: 60 frames at 30 fps = 2 s.
    animation: ({ trigger }) => (trigger === 'idle' && !longPlayed++ ? { id: 'long', frames: 60, fps: 30 } : null),
  });
  rt.start();
  try {
    await until(() => rt.status().screens[0]!.animation === 't/anim');
    const before = sent(rt);
    rt.refreshWidget('w');
    await until(() => drawn.some((d) => !d.anim && (d.data as { version: number } | undefined)?.version === 2));
    await until(() => rt.status().screens[0]!.animation === null);
    assert.ok(sent(rt) - before < 58, 'it did not play to the end');
  } finally {
    rt.stop();
  }
});

let urgentPlayed = 0;

test('runtime: an animation that is not interruptible plays to the end with the data it started with', async () => {
  drawn.length = 0;
  let version = 0;
  const rt = setup({
    id: 'anim',
    name: 'Anim',
    chrome: 'bare',
    fetch: async () => ({ version: ++version }),
    intervalMs: 5000,
    render: (g, ctx) => {
      drawn.push({ anim: !!ctx.anim, ...(ctx.frame !== undefined ? { frame: ctx.frame } : {}), data: ctx.data });
      g.fillStyle = '#0f0';
      g.fillRect(ctx.box.x, ctx.box.y, 10, 10);
    },
    animationGap: { minMs: 0, maxMs: 0 },
    animation: ({ trigger }) => (trigger === 'idle' && !urgentPlayed++ ? { id: 'urgent', frames: 20, fps: 30, interruptible: false } : null),
  });
  rt.start();
  try {
    await until(() => rt.status().screens[0]!.animation === 't/anim');
    rt.refreshWidget('w'); // new data while it plays
    await until(() => rt.status().screens[0]!.animation === null && sent(rt) >= 20);
    const during = drawn.filter((d) => d.anim);
    assert.equal(during.length, 18, 'every frame between the stills was painted');
    assert.equal(new Set(during.map((d) => (d.data as { version: number }).version)).size, 1, 'always the same data');
    // Afterwards the screen is repainted with the new data.
    await until(() => drawn.some((d) => !d.anim && (d.data as { version: number } | undefined)?.version === 2));
  } finally {
    rt.stop();
  }
});

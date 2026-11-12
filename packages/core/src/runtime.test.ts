import assert from 'node:assert/strict';
import { test } from 'node:test';
import { definePlugin, defineWidget, t } from '@kiosko/sdk';
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

// ---------- two widgets that both want to animate ----------
const asked: Record<string, number> = {};

function setupTwo(maxConcurrent: number) {
  const reg = new Registry();
  const seen: { tag: string; i: number }[] = [];
  reg.add(
    definePlugin({
      id: 't',
      name: 'T',
      version: '1',
      widgets: [
        defineWidget({
          id: 'anim',
          name: 'Anim',
          chrome: 'bare',
          options: t.object({ tag: t.string({ default: 'x' }), frames: t.number({ default: 6 }) }),
          render: (g, ctx) => {
            if (ctx.anim) seen.push({ tag: ctx.options.tag, i: ctx.anim.i });
            g.fillStyle = '#0f0';
            g.fillRect(ctx.box.x, ctx.box.y, 10, 10);
          },
          animationGap: { minMs: 0, maxMs: 0 },
          animation: ({ options }) => (asked[options.tag] === undefined ? ((asked[options.tag] = 1), { id: options.tag, frames: options.frames, fps: 30 }) : null),
        }),
      ],
    }),
  );
  const tile = (id: string, x: number, tag: string, frames: number) => ({ id, x, y: 0, w: 1, h: 1, chrome: 'bare', widgets: [{ id: `w-${tag}`, type: 't/anim', options: { tag, frames } }] });
  const cfg = norm({
    screens: [{ id: 's1', name: 'S', width: 160, height: 80, maxFps: 30, device: { driver: 'virtual' }, pages: [{ id: 'p', name: 'p', grid: { cols: 2, rows: 1, gap: 0, padding: 0 }, tiles: [tile('ta', 0, 'a', 6), tile('tb', 1, 'b', 10)] }] }],
  });
  const rt = new Runtime(reg, cfg);
  rt.rnd = () => 0;
  rt.maxConcurrent = maxConcurrent;
  const statuses = new Set<string>();
  rt.on('frame', (f: FrameInfo) => f.animation && statuses.add(f.animation));
  return { rt, seen, statuses };
}

test('runtime: two widgets animate one after the other by default', async () => {
  for (const k of Object.keys(asked)) delete asked[k];
  const { rt, seen } = setupTwo(1);
  rt.start();
  try {
    await until(() => asked.a === 1 && asked.b === 1 && rt.status().screens[0]!.animation === null && seen.some((x) => x.tag === 'a') && seen.some((x) => x.tag === 'b'), 6000);
    // Never both in the same moment: all of a's frames come before b's (or the other way round).
    const order = seen.map((x) => x.tag).join('');
    assert.match(order, /^(a+b+|b+a+)$/);
  } finally {
    rt.stop();
  }
});

test('runtime: with a higher limit they play together, each at its own length, on one timeline', async () => {
  for (const k of Object.keys(asked)) delete asked[k];
  const { rt, seen, statuses } = setupTwo(2);
  rt.start();
  try {
    await until(() => seen.some((x) => x.tag === 'a') && seen.some((x) => x.tag === 'b') && rt.status().screens[0]!.animation === null, 6000);
    assert.ok([...statuses].some((s) => s.includes(',')), 'both reported as playing');
    // Fast and slow share the timeline: a (6 frames) has finished by the time b (10) has, and both start at once.
    const a = seen.filter((x) => x.tag === 'a').map((x) => x.i), b = seen.filter((x) => x.tag === 'b').map((x) => x.i);
    assert.deepEqual(a, [1, 2, 3, 4]);
    assert.deepEqual(b, [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.ok(seen.findIndex((x) => x.tag === 'b') < seen.findLastIndex((x) => x.tag === 'a'), 'interleaved, not one after the other');
  } finally {
    rt.stop();
  }
});

const endings: { id: string; completed: boolean; version: unknown }[] = [];
let endedPlayed = 0;

test('runtime: the widget is told how its animation ended, played through or cut short', async () => {
  endings.length = 0;
  let version = 0;
  const rt = setup({
    id: 'anim',
    name: 'Anim',
    chrome: 'bare',
    fetch: async () => ({ version: ++version }),
    intervalMs: 5000,
    render: (g, ctx) => {
      g.fillStyle = '#0f0';
      g.fillRect(ctx.box.x, ctx.box.y, 10, 10);
    },
    animationGap: { minMs: 0, maxMs: 0 },
    animation: ({ trigger }) => (trigger === 'idle' && endedPlayed++ < 2 ? { id: `p${endedPlayed}`, frames: endedPlayed === 1 ? 5 : 60, fps: 30 } : null),
    animationEnded: ({ plan, completed, data }) => void endings.push({ id: plan.id, completed, version: (data as { version: number } | undefined)?.version }),
  });
  rt.start();
  try {
    // The first, short one plays through.
    await until(() => endings.length >= 1);
    assert.deepEqual(endings[0], { id: 'p1', completed: true, version: 1 });
    // The second, long one is cut by new data.
    await until(() => rt.status().screens[0]!.animation !== null);
    rt.refreshWidget('w');
    await until(() => endings.length >= 2);
    assert.equal(endings[1]!.id, 'p2');
    assert.equal(endings[1]!.completed, false);
  } finally {
    rt.stop();
  }
});

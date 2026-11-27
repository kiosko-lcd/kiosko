import assert from 'node:assert/strict';
import { test } from 'node:test';
import { definePlugin, defineWidget, t } from '@kiosko/sdk';
import { normalize } from './config/store.ts';
import type { Screen } from './config/model.ts';
import type { Device, DeviceStatus } from './devices.ts';
import type { PresenceInfo } from './presence.ts';
import { Registry } from './registry.ts';
import { Runtime, type FrameInfo } from './runtime.ts';
import fixture, { feed } from './threads/fixtures/plugin.ts';

process.env.KIOSKO_QUIET = '1';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 6000, what = 'timed out') {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await sleep(15);
  assert.ok(cond(), what);
}

/** A panel whose presence the test sets; it counts the frames it gets. */
class FakePanel implements Device {
  status: DeviceStatus = { driver: 'file', ok: true, message: 'fake', framesSent: 0, lastSentAt: null };
  presence: PresenceInfo;
  frames: Buffer[] = [];
  closed = false;
  constructor(state: PresenceInfo['state']) {
    this.presence = { state, why: `fake ${state}` };
  }
  set(state: PresenceInfo['state']): void {
    this.presence = { state, why: `fake ${state}` };
  }
  async send(frame: Buffer): Promise<void> {
    this.frames.push(frame);
    this.status.framesSent++;
  }
  close(): void {
    this.closed = true;
  }
}

/** The runtime with the test's panels in place of the configured drivers. */
class PanelRuntime extends Runtime {
  panels = new Map<string, FakePanel>();
  override openDevice(screen: Screen): Device {
    return this.panels.get(screen.id) ?? new FakePanel('present');
  }
}

/** What each widget instance painted, each source started, each fetch ran, each interlude prepared. */
const counts = { paint: new Map<string, number>(), started: new Map<string, number>(), stopped: new Map<string, number>(), fetched: new Map<string, number>(), prepared: 0 };
const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
const n = (m: Map<string, number>, k: string) => m.get(k) ?? 0;

function registry(): Registry {
  const reg = new Registry();
  const source = (id: string) => ({
    id,
    name: id,
    watch: (_ctx: unknown, emit: (d: unknown) => void) => {
      bump(counts.started, `p/${id}`);
      emit({ v: 1 });
      return () => bump(counts.stopped, `p/${id}`);
    },
  });
  reg.add(
    definePlugin({
      id: 'p',
      name: 'P',
      version: '1',
      sources: [source('only1'), source('shared')],
      widgets: [
        defineWidget({
          id: 'w',
          name: 'W',
          chrome: 'bare',
          sources: ['p/only1', 'p/shared'],
          options: t.object({ tag: t.string({ default: '' }) }),
          fetch: async (ctx) => (bump(counts.fetched, ctx.options.tag as string), { ok: true }),
          intervalMs: 60_000,
          render: (g, ctx) => {
            bump(counts.paint, ctx.options.tag as string);
            g.fillStyle = '#0a0';
            g.fillRect(ctx.box.x, ctx.box.y, ctx.box.w, ctx.box.h);
          },
        }),
        defineWidget({
          id: 'v',
          name: 'V',
          chrome: 'bare',
          sources: ['p/shared'],
          options: t.object({ tag: t.string({ default: '' }) }),
          render: (g, ctx) => {
            bump(counts.paint, ctx.options.tag as string);
            g.fillStyle = '#00a';
            g.fillRect(ctx.box.x, ctx.box.y, ctx.box.w, ctx.box.h);
          },
        }),
      ],
      interludes: [{ id: 'i', name: 'I', fps: 30, prepare: async () => (counts.prepared++, { frames: 3, draw: () => undefined }) }],
    }),
  );
  return reg;
}

const page = (type: string, tag: string) => ({ id: 'p', name: 'p', grid: { cols: 1, rows: 1, gap: 0, padding: 0 }, tiles: [{ id: 't', x: 0, y: 0, w: 1, h: 1, chrome: 'bare', widgets: [{ id: `w-${tag}`, type, options: { tag } }] }] });
const screen = (id: string, type: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  width: 64,
  height: 32,
  maxFps: 20,
  pixelShift: { enabled: false },
  device: { driver: 'file', dir: `/tmp/kiosko-presence-test/${id}` },
  pages: [page(type, id)],
  interludes: [{ id: `${id}-i`, type: 'p/i', enabled: false, everyMs: 3_600_000, maxSeconds: 10 }],
  ...extra,
});

function setup(threads: 'never' | 'always', a: FakePanel, b: FakePanel, o: { disabledA?: boolean } = {}) {
  for (const m of [counts.paint, counts.started, counts.stopped, counts.fetched]) m.clear();
  counts.prepared = 0;
  const cfg = normalize({ threads, screens: [screen('a', 'p/w', o.disabledA ? { enabled: false } : {}), screen('b', 'p/v')] });
  const rt = new PanelRuntime(registry(), cfg);
  rt.panels.set('a', a);
  rt.panels.set('b', b);
  return rt;
}

const st = (rt: Runtime, id: string) => rt.status().screens.find((s) => s.id === id)!;
const running = (rt: Runtime) => rt.hub.running().map((r) => r.key).sort();
const fetching = (rt: Runtime) => rt.status().fetches.map((f: { id: string }) => f.id).sort();

test('presence: a screen whose panel is absent is never composed, painted nor encoded; only its own data stops, the shared stays', async (t) => {
  const a = new FakePanel('absent');
  const b = new FakePanel('present');
  const rt = setup('never', a, b);
  const frames: FrameInfo[] = [];
  rt.on('frame', (f: FrameInfo) => frames.push(f));
  rt.start();
  t.after(() => rt.stop());
  await until(() => b.frames.length >= 1 && n(counts.paint, 'b') >= 1);
  await sleep(500);
  assert.equal(st(rt, 'a').paused, true);
  assert.equal(st(rt, 'a').presence?.state, 'absent');
  assert.equal(st(rt, 'b').paused, false);
  assert.equal(n(counts.paint, 'a'), 0, 'no widget painted for it');
  assert.equal(a.frames.length, 0, 'no frame encoded nor sent');
  assert.equal(frames.filter((f) => f.screenId === 'a').length, 0, 'no page composed');
  assert.equal(st(rt, 'a').frames.frames, 0);
  assert.deepEqual(running(rt), ['p/shared'], 'the source only it shows does not run; the shared one does');
  assert.equal(n(counts.started, 'p/only1'), 0);
  assert.deepEqual(fetching(rt), [], 'nor its widget\'s fetch');
  assert.equal(n(counts.fetched, 'a'), 0);
  assert.ok(rt.logs.some((l) => l.scope === 'screen:a' && /panel not connected \(fake absent\): paused/.test(l.message)));
});

test('presence: back, it resumes at once with a full frame; gone again, it stops and lets its data go', async (t) => {
  const a = new FakePanel('present');
  const b = new FakePanel('present');
  const rt = setup('never', a, b);
  rt.start();
  t.after(() => rt.stop());
  await until(() => a.frames.length >= 1 && running(rt).length === 2);
  assert.equal(n(counts.started, 'p/only1'), 1);
  // Unplugged.
  a.set('absent');
  await until(() => st(rt, 'a').paused);
  const painted = n(counts.paint, 'a');
  const sent = a.frames.length;
  await until(() => !running(rt).includes('p/only1'), 2000, 'its own source stops');
  assert.equal(n(counts.stopped, 'p/only1'), 1);
  assert.deepEqual(running(rt), ['p/shared']);
  // Things that would repaint it: data, a pinned page, a config edit.
  rt.pin('a', 'p');
  rt.apply(rt.config);
  await sleep(600);
  assert.equal(n(counts.paint, 'a'), painted, 'nothing painted while paused');
  assert.equal(a.frames.length, sent, 'nothing sent');
  // Plugged in again: the same picture as before, but sent anyway (the panel shows its logo now).
  a.set('present');
  await until(() => a.frames.length > sent, 2000, 'a fresh frame');
  assert.equal(st(rt, 'a').paused, false);
  assert.ok(n(counts.paint, 'a') > painted, 'painted from scratch, not from the tile cache');
  assert.ok(a.frames.at(-1)!.equals(a.frames[sent - 1]!), 'the same picture, sent again in full');
  await until(() => running(rt).includes('p/only1'), 2000, 'its source runs again');
  assert.equal(n(counts.started, 'p/only1'), 2);
  assert.ok(rt.logs.some((l) => l.scope === 'screen:a' && /panel connected .*painting again/.test(l.message)));
});

test('presence: unknown is painted as always; a disabled screen stays disabled whatever its panel says', async (t) => {
  const a = new FakePanel('absent');
  const b = new FakePanel('unknown');
  const rt = setup('never', a, b, { disabledA: true });
  rt.start();
  t.after(() => rt.stop());
  await until(() => b.frames.length >= 1);
  assert.equal(st(rt, 'b').paused, false);
  assert.equal(st(rt, 'a').paused, false, 'paused is for enabled screens: this one the user switched off');
  a.set('present');
  await sleep(400);
  assert.equal(a.frames.length, 0, 'still disabled');
});

test('presence: interludes, alerts and pinned pages wait while paused; the alert shows when the panel is back', async (t) => {
  const a = new FakePanel('present');
  const b = new FakePanel('present');
  const rt = setup('never', a, b);
  const frames: FrameInfo[] = [];
  rt.on('frame', (f: FrameInfo) => frames.push(f));
  rt.start();
  t.after(() => rt.stop());
  await until(() => a.frames.length >= 1);
  a.set('absent');
  await until(() => st(rt, 'a').paused);
  rt.playInterlude('a', 'a-i');
  const alert = rt.testAlert('a', 'critical');
  assert.ok(alert);
  await sleep(500);
  assert.equal(counts.prepared, 0, 'no interlude prepared');
  assert.equal(frames.filter((f) => f.screenId === 'a' && f.alert).length, 0, 'no alert painted');
  assert.equal(st(rt, 'a').alert, alert!.id, 'the alert is there, waiting');
  a.set('present');
  await until(() => frames.some((f) => f.screenId === 'a' && f.alert === alert!.id), 3000, 'the alert painted once back');
});

test('presence: an interlude playing when the panel goes stops at its next frame', async (t) => {
  const a = new FakePanel('present');
  const b = new FakePanel('present');
  const rt = setup('never', a, b);
  // A long one this time.
  rt.registry.interlude('p/i')!.prepare = async () => (counts.prepared++, { frames: 10_000, draw: () => undefined });
  rt.start();
  t.after(() => rt.stop());
  await until(() => a.frames.length >= 1);
  rt.playInterlude('a', 'a-i');
  await until(() => st(rt, 'a').interlude === 'p/i');
  a.set('absent');
  await until(() => st(rt, 'a').interlude === null, 2000, 'stopped');
  const sent = a.frames.length;
  await sleep(300);
  assert.ok(a.frames.length - sent <= 1, 'no more frames');
});

/** Threads load their plugins from modules: these use the threads' fixture plugin (its sources fed by the test). */
const MODULE = new URL('./threads/fixtures/plugin.ts', import.meta.url).href;
function threaded(a: FakePanel, b: FakePanel) {
  const reg = new Registry();
  reg.add(fixture, 'test', MODULE);
  const scr = (id: string, type: string) => ({ ...screen(id, type), interludes: [] });
  const rt = new PanelRuntime(reg, normalize({ threads: 'always', screens: [scr('a', 'tt/fill'), scr('b', 'tt/tinted')] }));
  rt.panels.set('a', a);
  rt.panels.set('b', b);
  return rt;
}

test('presence: a screen painted in a thread of its own pauses (its source stops) and resumes with the data it missed', async (t) => {
  const a = new FakePanel('present');
  const b = new FakePanel('present');
  const rt = threaded(a, b);
  rt.start();
  t.after(() => rt.stop());
  await until(() => a.frames.length >= 1 && b.frames.length >= 1 && !!feed.color, 15_000, 'both painted in their threads');
  assert.equal(st(rt, 'a').thread.on, true);
  a.set('absent');
  await until(() => st(rt, 'a').paused);
  await until(() => !feed.color, 2000, 'the source only it shows stops');
  await sleep(300);
  const sent = a.frames.length;
  const painted = st(rt, 'a').frames.frames;
  rt.apply(rt.config);
  await sleep(800);
  assert.equal(a.frames.length, sent, 'its thread sends nothing');
  assert.equal(st(rt, 'a').frames.frames, painted, 'nor paints');
  a.set('present');
  await until(() => a.frames.length > sent, 4000, 'a fresh frame from its thread');
  assert.equal(st(rt, 'a').paused, false);
  await until(() => !!feed.color, 2000, 'its source runs again');
  const before = a.frames.length;
  feed.color!({ color: '#00ff00' });
  await until(() => a.frames.length > before, 4000, 'and its data reaches the thread');
});

test('presence: a thread started for a screen whose panel is already missing paints nothing at all', async (t) => {
  const a = new FakePanel('absent');
  const b = new FakePanel('present');
  const rt = threaded(a, b);
  rt.start();
  t.after(() => rt.stop());
  await until(() => b.frames.length >= 1, 15_000);
  await sleep(500);
  assert.equal(st(rt, 'a').paused, true);
  assert.equal(st(rt, 'a').thread.on, true);
  assert.equal(a.frames.length, 0);
  a.set('present');
  await until(() => a.frames.length >= 1, 4000);
});

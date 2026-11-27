import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { definePlugin, defineSource, defineWidget, t } from '@kiosko/sdk';
import { normalize } from './config/normalize.ts';
import { FetchHost, SourceHub, deadline, same } from './data.ts';
import { Registry } from './registry.ts';

const reads: { intervalMs: number; timeoutMs: number; label: unknown; extra: unknown }[] = [];
const reg = new Registry();
reg.add(
  definePlugin({
    id: 't',
    name: 'T',
    version: '1',
    sources: [
      defineSource({
        id: 'poll',
        name: 'Poll',
        options: t.object({ label: t.string({ default: 'x' }) }),
        intervalMs: 60_000,
        minIntervalMs: 30_000,
        read: async (ctx) => {
          reads.push({ intervalMs: ctx.intervalMs, timeoutMs: ctx.timeoutMs, label: ctx.options.label, extra: (ctx.options as Record<string, unknown>).intervalMs });
          return { n: reads.length };
        },
      }),
      defineSource({
        id: 'own',
        name: 'Own',
        // An option of its own with Kiosko's name keeps its plugin meaning.
        options: t.object({ timeoutMs: t.duration({ default: 2000 }) }),
        intervalMs: 10_000,
        read: async (ctx) => ({ own: ctx.options.timeoutMs, kiosko: ctx.timeoutMs, interval: ctx.intervalMs }),
      }),
      defineSource({
        id: 'stuck',
        name: 'Stuck',
        read: (ctx) => new Promise((_resolve, reject) => ctx.signal.addEventListener('abort', () => reject(new Error('aborted')))),
      }),
    ],
    widgets: [
      defineWidget({
        id: 'paced',
        name: 'Paced',
        options: t.object({ everyMs: t.duration({ default: 0 }) }),
        intervalMs: 60_000,
        // The data says how often to come back; an option can too.
        intervalOf: ({ options, data }) => options.everyMs || (data as { nextMs?: number } | undefined)?.nextMs,
        fetch: async () => ({ nextMs: 1000 }),
        render() {},
      }),
      defineWidget({
        id: 'slow',
        name: 'Slow',
        timeoutMs: 30,
        fetch: (ctx) => new Promise((_resolve, reject) => ctx.signal.addEventListener('abort', () => reject(new Error(`gave up after ${ctx.timeoutMs}`)))),
        render() {},
      }),
    ],
  }),
);
const flush = () => sleep(5);
const quiet = () => undefined;

test('deadline: aborts after ms, follows its parent, and says which', async () => {
  const parent = new AbortController();
  const d = deadline(parent.signal, 20);
  assert.equal(d.signal.aborted, false);
  await sleep(40);
  assert.equal(d.signal.aborted, true);
  assert.equal(d.timedOut(), true);
  assert.equal((d.signal.reason as Error).name, 'TimeoutError');
  d.done();
  const p2 = new AbortController();
  const d2 = deadline(p2.signal, 10_000);
  p2.abort();
  assert.equal(d2.signal.aborted, true);
  assert.equal(d2.timedOut(), false);
  d2.done();
});

test('a source is read every intervalMs from its options, never under its minimum', async () => {
  reads.length = 0;
  const cfg = normalize({ sources: { 't/poll': { intervalMs: 1000, label: 'mine' } } });
  const hub = new SourceHub(reg, quiet, () => undefined);
  hub.retain(new Set(['t/poll']), cfg);
  hub.tick(cfg, Date.now());
  await flush();
  assert.deepEqual(reads, [{ intervalMs: 30_000, timeoutMs: 120_000, label: 'mine', extra: 30_000 }]);
  assert.deepEqual(hub.data('t/poll'), { n: 1 });
  hub.tick(cfg, Date.now() + 20_000);
  await flush();
  assert.equal(reads.length, 1, 'not before its (clamped) interval');
  hub.tick(cfg, Date.now() + 31_000);
  await flush();
  assert.equal(reads.length, 2);
  assert.equal(hub.status()[0]!.intervalMs, 30_000);
  // New options: the source starts over with them.
  const slower = normalize({ sources: { 't/poll': { intervalMs: 600_000 } } });
  hub.retain(new Set(['t/poll']), slower);
  hub.tick(slower, Date.now());
  await flush();
  assert.equal(reads[2]!.intervalMs, 600_000);
  hub.stop();
});

test('without intervalMs a source keeps its own default', async () => {
  reads.length = 0;
  const cfg = normalize({});
  const hub = new SourceHub(reg, quiet, () => undefined);
  hub.retain(new Set(['t/poll']), cfg);
  hub.tick(cfg, Date.now());
  await flush();
  assert.equal(reads[0]!.intervalMs, 60_000);
  hub.stop();
});

test('a read that outlives timeoutMs is aborted and reported', async () => {
  const cfg = normalize({ sources: { 't/stuck': { timeoutMs: 1000 } } });
  const logs: string[] = [];
  const hub = new SourceHub(reg, (_s, m) => logs.push(m), () => undefined);
  hub.retain(new Set(['t/stuck']), cfg);
  hub.tick(cfg, Date.now());
  await sleep(1100);
  const st = hub.status()[0]!;
  assert.equal(st.ok, false);
  assert.equal(st.error, 'timed out after 1 s');
  assert.deepEqual(logs, ['read failed: timed out after 1 s']);
  hub.stop();
});

test('a widget fetch is aborted after the widget\'s timeoutMs', async () => {
  const hub = new SourceHub(reg, quiet, () => undefined);
  const host = new FetchHost(hub, quiet, () => undefined);
  host.retain([{ inst: { id: 'w', type: 't/slow', options: {} }, def: reg.widget('t/slow')! }]);
  host.tick(normalize({}), Date.now());
  await sleep(80);
  assert.deepEqual(host.status().map((s) => s.error), ['timed out after 30 ms']);
  host.stop();
});

test('a source\'s own option named like Kiosko\'s keeps its meaning; Kiosko uses the definition\'s value', async () => {
  const cfg = normalize({ sources: { 't/own': { timeoutMs: 500, intervalMs: 20_000 } } });
  const hub = new SourceHub(reg, quiet, () => undefined);
  hub.retain(new Set(['t/own']), cfg);
  hub.tick(cfg, Date.now());
  await flush();
  assert.deepEqual(hub.data('t/own'), { own: 500, kiosko: 120_000, interval: 20_000 });
  hub.stop();
});

test('a widget can set its own fetch interval from its options or data; the user\'s wins', async () => {
  const hub = new SourceHub(reg, quiet, () => undefined);
  const host = new FetchHost(hub, quiet, () => undefined);
  const def = reg.widget('t/paced')!;
  const next = async (inst: { id: string; type: string; options: Record<string, unknown>; intervalMs?: number }) => {
    host.retain([{ inst, def }]);
    const t0 = Date.now();
    host.tick(normalize({}), t0);
    await flush();
    return (host as unknown as { of(id: string): { nextAt: number } }).of(inst.id)!.nextAt - t0;
  };
  // From the data (1 s), raised to the 5 s floor.
  assert.ok(Math.abs((await next({ id: 'a', type: 't/paced', options: {} })) - 5_000) < 50);
  // From an option.
  assert.ok(Math.abs((await next({ id: 'b', type: 't/paced', options: { everyMs: 30_000 } })) - 30_000) < 50);
  // The instance's interval wins.
  assert.ok(Math.abs((await next({ id: 'c', type: 't/paced', options: { everyMs: 30_000 }, intervalMs: 120_000 })) - 120_000) < 50);
  host.stop();
});

test('same: decoded images and other opaque objects compare by identity, not as {}', () => {
  class Picture {
    width = 10;
  }
  const a = new Picture();
  assert.equal(same({ img: a }, { img: a }), true);
  assert.equal(same({ img: a }, { img: new Picture() }), false, 'a new picture is new data');
  assert.equal(same({ n: 1, list: [1, { x: 2 }] }, { n: 1, list: [1, { x: 2 }] }), true, 'plain data still compares by value');
  assert.equal(same({ at: new Date(5) }, { at: new Date(5) }), true, 'toJSON values compare by value');
});

test('a widget whose every fetch brings a new image is repainted every time', async () => {
  class Picture {}
  const changes: string[] = [];
  const r = new Registry();
  r.add(
    definePlugin({
      id: 'cam',
      name: 'Cam',
      version: '1',
      widgets: [defineWidget({ id: 'shot', name: 'Shot', fetch: async () => ({ img: new Picture() }), intervalMs: 60_000, render: () => undefined })],
    }),
  );
  const hub = new SourceHub(r, quiet, () => undefined);
  const host = new FetchHost(hub, quiet, (id) => changes.push(id));
  host.retain([{ inst: { id: 'w', type: 'cam/shot', options: {} }, def: r.widget('cam/shot')! }]);
  host.tick(normalize({}), Date.now());
  await flush();
  host.refresh('w');
  host.tick(normalize({}), Date.now());
  await flush();
  assert.deepEqual(changes, ['w', 'w']);
  host.stop();
});

test('instances of a widget with the same options share one fetch, and each is told when its data changes', async () => {
  let calls = 0;
  const changes: string[] = [];
  const r = new Registry();
  r.add(
    definePlugin({
      id: 'n',
      name: 'N',
      version: '1',
      widgets: [defineWidget({ id: 'col', name: 'Col', options: t.object({ offset: t.integer({ default: 0 }) }), fetch: async ({ options }) => ({ call: ++calls, offset: options.offset }), intervalMs: 60_000, render: () => undefined })],
    }),
  );
  const def = r.widget('n/col')!;
  const hub = new SourceHub(r, quiet, () => undefined);
  const host = new FetchHost(hub, quiet, (id) => changes.push(id));
  // The same column on two screens, and one with other options.
  host.retain([
    { inst: { id: 'left', type: 'n/col', options: {} }, def },
    { inst: { id: 'right', type: 'n/col', options: {} }, def },
    { inst: { id: 'other', type: 'n/col', options: { offset: 2 } }, def },
  ]);
  host.tick(normalize({}), Date.now());
  await flush();
  assert.equal(calls, 2, 'one fetch for the two alike, one for the other');
  assert.deepEqual(host.data('left'), host.data('right'));
  assert.deepEqual((host.data('other') as { offset: number }).offset, 2);
  assert.deepEqual(changes.sort(), ['left', 'other', 'right']);
  // Refreshing one refreshes what both show.
  changes.length = 0;
  host.refresh('right');
  host.tick(normalize({}), Date.now());
  await flush();
  assert.equal(calls, 3);
  assert.deepEqual(changes.sort(), ['left', 'right']);
  assert.deepEqual(host.status().map((x) => x.id).sort(), ['left', 'other', 'right']);
  // One goes away: the other keeps the fetch and its data, with no new request.
  host.retain([{ inst: { id: 'left', type: 'n/col', options: {} }, def }]);
  host.tick(normalize({}), Date.now());
  await flush();
  assert.equal(calls, 3);
  assert.equal((host.data('left') as { call: number }).call, 3);
  assert.equal(host.data('right'), undefined);
  host.stop();
});

test('failed: a fetch or read that fails is told once, and again when it recovers with the same data', async () => {
  let fail = false;
  const changes: string[] = [];
  const r = new Registry();
  r.add(
    definePlugin({
      id: 'f',
      name: 'F',
      version: '1',
      sources: [defineSource({ id: 'src', name: 'Src', intervalMs: 60_000, read: async () => { if (fail) throw new Error('down'); return 1; } })],
      widgets: [defineWidget({ id: 'w', name: 'W', intervalMs: 60_000, fetch: async () => { if (fail) throw new Error('down'); return 1; }, render: () => undefined })],
    }),
  );
  const cfg = normalize({});
  const hub = new SourceHub(r, quiet, (k) => changes.push(k));
  const host = new FetchHost(hub, quiet, (id) => changes.push(id));
  hub.retain(new Set(['f/src']), cfg);
  host.retain([{ inst: { id: 'i', type: 'f/w', options: {} }, def: r.widget('f/w')! }]);
  const round = async () => {
    host.refresh('i');
    host.tick(cfg, Date.now());
    hub.tick(cfg, Date.now() + 120_000);
    await flush();
  };
  await round();
  assert.deepEqual([host.failed('i'), hub.failed('f/src')], [false, false]);
  assert.deepEqual(changes.sort(), ['f/src', 'i']);
  fail = true;
  changes.length = 0;
  await round();
  assert.deepEqual([host.failed('i'), hub.failed('f/src')], [true, true]);
  assert.deepEqual(changes.sort(), ['f/src', 'i'], 'failing is told');
  changes.length = 0;
  await round();
  assert.deepEqual(changes, [], 'still failing: nothing new');
  fail = false;
  await round();
  assert.deepEqual([host.failed('i'), hub.failed('f/src')], [false, false]);
  assert.deepEqual(changes.sort(), ['f/src', 'i'], 'recovered with the same data: told too');
  host.stop();
  hub.stop();
});

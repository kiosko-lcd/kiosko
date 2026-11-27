import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { definePlugin, defineWidget } from '@kiosko/sdk';
import { normalize } from './config/store.ts';
import { whenMatches, type Page, type Screen, type ShowWhenRule } from './config/model.ts';
import { ContextEngine, choosePage, compareValue, evalRule, inTimeWindow, matchApp, matchingPages, needsApps, ruleSources, valueAt, type ContextEnv } from './context.ts';
import { pickPage } from './layout/stack.ts';
import { Registry } from './registry.ts';
import { Runtime } from './runtime.ts';

process.env.KIOSKO_QUIET = '1';

const at = (hhmm: string, day = 3) => {
  // 2026-11-25 is a Wednesday (3); day picks another weekday of that week.
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(2026, 10, 22 + day, h, m).getTime();
};

function screenOf(pages: Partial<Page>[], extra: Partial<Screen> = {}): Screen {
  return normalize({ screens: [{ id: 's', name: 'S', width: 320, height: 240, pages, ...extra }] }).screens[0]!;
}

const env = (o: Partial<ContextEnv> = {}): ContextEnv => ({ now: at('12:00'), apps: [], source: () => undefined, urgent: () => null, ...o });

test('context: values at a path, and comparisons, with missing data never matching', () => {
  const data = { active: true, items: [{ price: '0.21' }, { price: 0.1 }], name: 'Zoom Meeting', tags: ['a', 'b'] };
  assert.equal(valueAt(data, 'active'), true);
  assert.equal(valueAt(data, 'items[0].price'), '0.21');
  assert.equal(valueAt(data, 'items.1.price'), 0.1);
  assert.equal(valueAt(data, "items['1'].price"), 0.1);
  assert.equal(valueAt(data, ''), data);
  assert.equal(valueAt(data, 'nope.deeper'), undefined);
  assert.equal(valueAt(undefined, 'a'), undefined);

  assert.equal(compareValue(true, undefined, undefined), true, 'no op, no value: truthy');
  assert.equal(compareValue(true, undefined, true), true, 'a value: eq');
  assert.equal(compareValue('false', 'truthy', undefined), false);
  assert.equal(compareValue(0, 'falsy', undefined), true);
  assert.equal(compareValue([], 'truthy', undefined), false, 'an empty list is nothing');
  assert.equal(compareValue('0.21', 'gt', 0.2), true, 'numbers in strings are numbers');
  assert.equal(compareValue('0.21', 'lte', '0.2'), false);
  assert.equal(compareValue(5, 'gte', 5), true);
  assert.equal(compareValue(4, 'lt', 5), true);
  assert.equal(compareValue('abc', 'gt', 1), false, 'not a number: no order');
  assert.equal(compareValue('Zoom Meeting', 'contains', 'zoom'), true);
  assert.equal(compareValue(['a', 'b'], 'contains', 'B'), true);
  assert.equal(compareValue('ON', 'eq', 'on'), true, 'text compares without case');
  assert.equal(compareValue('on', 'ne', 'off'), true);
  assert.equal(compareValue(null, 'falsy', undefined), true, 'null is a value');
  for (const op of ['truthy', 'falsy', 'eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains'] as const) assert.equal(compareValue(undefined, op, 1), false, `${op} on no data`);
});

test('context: program globs, alternatives and case', () => {
  const names = ['systemd', 'Steam.exe', 'steamwebhelper', 'obs', 'zoom.us'];
  assert.equal(matchApp('steam*', names), 'Steam.exe');
  assert.equal(matchApp('steamweb?elper', names), 'steamwebhelper');
  assert.equal(matchApp('obs*', names), 'obs');
  assert.equal(matchApp('vlc, zoom*', names), 'zoom.us');
  assert.equal(matchApp('zoom', names), null, 'a glob matches the whole name');
  assert.equal(matchApp('zoom.us', names), 'zoom.us', 'a dot is a dot');
  assert.equal(matchApp(' , ', names), null);
});

test('context: time windows, across midnight and on some days', () => {
  const work = { start: '09:00', end: '17:00' };
  assert.equal(inTimeWindow(work, at('09:00')), true, 'start included');
  assert.equal(inTimeWindow(work, at('17:00')), false, 'end not');
  const night = { start: '22:00', end: '07:00', days: [5] }; // Friday night
  assert.equal(inTimeWindow(night, at('23:00', 5)), true);
  assert.equal(inTimeWindow(night, at('03:00', 6)), true, 'Saturday small hours belong to Friday night');
  assert.equal(inTimeWindow(night, at('03:00', 5)), false, 'Friday small hours belong to Thursday');
  assert.equal(inTimeWindow(night, at('12:00', 5)), false);
  assert.equal(inTimeWindow({ start: '10:00', end: '10:00' }, at('10:00')), false, 'an empty window');
  assert.equal(inTimeWindow({ start: '00:00', end: '23:59', days: [0, 6] }, at('12:00', 3)), false);
});

test('context: a rule needs every condition it has; the reason says what held', () => {
  const page = { id: 'p' } as Page;
  const rule: ShowWhenRule = { label: 'Game', app: 'steam*', time: { start: '18:00', end: '23:00' } };
  assert.equal(evalRule(rule, page, env({ apps: ['steam'], now: at('12:00') })), null, 'the time does not hold');
  assert.deepEqual(evalRule(rule, page, env({ apps: ['steam'], now: at('19:00') })), { label: 'Game', app: 'steam', time: '18:00–23:00' });
  assert.equal(evalRule(rule, page, env({ apps: null, now: at('19:00') })), null, 'no process list yet: no match');
  assert.equal(evalRule({}, page, env()), null, 'nothing to check never holds');
  const src: ShowWhenRule = { source: 'calls/active', path: 'active', op: 'eq', value: true };
  assert.deepEqual(evalRule(src, page, env({ source: (t) => (t === 'calls/active' ? { active: true } : undefined) })), { source: 'calls/active', path: 'active', value: 'true' });
  assert.equal(evalRule(src, page, env({ source: () => undefined })), null, 'no data yet');
  const onProfile: ShowWhenRule = { ...src, profile: 'work' };
  const byProfile = (t: string, profile?: string) => (t === 'calls/active' ? { active: profile === 'work' } : undefined);
  assert.deepEqual(evalRule(onProfile, page, env({ source: byProfile })), { source: 'calls/active', profile: 'work', path: 'active', value: 'true' }, 'a rule on a profile reads that profile');
  assert.equal(evalRule(src, page, env({ source: byProfile })), null, 'without one: the default profile');
  assert.equal(evalRule(src, page, env({ source: () => ({}) })), null, 'no such path');
  assert.deepEqual(evalRule({ urgent: true }, page, env({ urgent: () => 'cal/next' })), { urgent: 'cal/next' });
  assert.equal(evalRule({ urgent: true }, page, env()), null);
});

test('context: matching pages, with their best rule; switched off, out of hours and ruleless pages left out', () => {
  const s = screenOf([
    { id: 'main' },
    { id: 'game', showWhen: [{ app: 'steam*' }, { app: 'obs', priority: 3, label: 'streaming' }] },
    { id: 'call', showWhen: [{ source: 'calls/active', priority: 9 }] },
    { id: 'off', enabled: false, showWhen: [{ app: 'steam*' }] },
    { id: 'work', when: 'work', showWhen: [{ app: 'steam*' }] },
  ]);
  const m = matchingPages(s, env({ apps: ['steam', 'obs'] }), false);
  assert.deepEqual(m.map((x) => [x.page.id, x.priority, x.reason]), [['game', 3, { label: 'streaming', app: 'obs' }]]);
  const both = matchingPages(s, env({ apps: ['steam'], source: () => ({ n: 1 }) }), false);
  assert.deepEqual(both.map((x) => [x.page.id, x.priority]), [['game', 0], ['call', 9]]);
  assert.equal(needsApps({ screens: [s] }), true);
  assert.deepEqual([...ruleSources({ screens: [s] })], ['calls/active']);
  assert.equal(needsApps({ screens: [screenOf([{ id: 'a' }])] }), false);
});

test('context: priority wins, equals take turns, a higher one comes at once, and anti-flicker holds on the way out', () => {
  const s = screenOf(
    [
      { id: 'main' },
      { id: 'a', durationMs: 60_000, showWhen: [{ app: 'a' }] },
      { id: 'b', durationMs: 60_000, showWhen: [{ app: 'b' }] },
      { id: 'hi', showWhen: [{ app: 'hi', priority: 5 }] },
    ],
    { context: { minMs: 20_000, holdMs: 10_000 } },
  );
  const eng = new ContextEngine();
  let now = 1_000_000_000_000 - (1_000_000_000_000 % 120_000); // a cycle of a + b starts here
  const step = (apps: string[]) => eng.step(s, matchingPages(s, env({ apps, now }), false), now);

  assert.equal(step([]), null);
  assert.equal(step(['a'])?.page, 'a');
  assert.equal(step(['a', 'b'])?.page, 'a', 'equals: a has its turn first');
  now += 61_000;
  assert.equal(step(['a', 'b'])?.page, 'b', 'then b');
  now += 1_000;
  const hi = step(['a', 'b', 'hi']);
  assert.equal(hi?.page, 'hi', 'a higher priority comes at once');
  assert.equal(hi?.since, now);
  now += 2_000;
  // hi stops holding: it stays for minMs since it came, and holdMs since it last held.
  let p = step(['a']);
  assert.deepEqual([p?.page, p?.leaving], ['hi', true]);
  now += 12_000; // 14 s since it came: minMs not over yet
  assert.equal(step(['a'])?.page, 'hi');
  now += 7_000; // 21 s since it came, 19 s since it held
  assert.equal(step(['a'])?.page, 'a', 'then the lower one');
  now += 1_000;
  // a stops: 10 s of hold, but minMs counts from when a came (1 s ago).
  assert.deepEqual([step([])?.page, step([])?.leaving], ['a', true]);
  now += 5_000;
  assert.equal(step(['a'])?.leaving, false, 'it held again within the margin: it stays, without flicker');
  now += 25_000;
  step(['a']);
  now += 1_000;
  assert.equal(step([])?.page, 'a', 'just stopped: held for holdMs');
  now += 10_000;
  assert.equal(step([]), null, 'then back to the rotation');
});

test('context: zero margins let go at once; a page removed from the config is let go too', () => {
  let s = screenOf([{ id: 'main' }, { id: 'g', showWhen: [{ app: 'g' }] }], { context: { minMs: 0, holdMs: 0 } });
  const eng = new ContextEngine();
  assert.equal(eng.step(s, matchingPages(s, env({ apps: ['g'] }), false), 1)?.page, 'g');
  assert.equal(eng.step(s, [], 2), null);
  s = screenOf([{ id: 'main' }, { id: 'g', showWhen: [{ app: 'g' }] }]);
  assert.equal(eng.step(s, matchingPages(s, env({ apps: ['g'] }), false), 3)?.page, 'g');
  s = screenOf([{ id: 'main' }]);
  assert.equal(eng.step(s, [], 4), null, 'the default margins do not keep a page that is gone');
});

test('context: choosePage keeps pinned first, then the context page, and context-only pages out of the rotation', () => {
  const s = screenOf([
    { id: 'a', durationMs: 60_000 },
    { id: 'b', durationMs: 60_000 },
    { id: 'g', durationMs: 60_000, showWhen: [{ app: 'g' }] },
    { id: 'r', durationMs: 60_000, showWhen: [{ app: 'r' }], inRotation: true },
  ]);
  const seen = new Set<string>();
  for (let t = 0; t < 240_000; t += 30_000) seen.add(choosePage(s, t, false, null, null)!.id);
  assert.deepEqual([...seen].sort(), ['a', 'b', 'r']);
  assert.equal(choosePage(s, 0, false, null, 'g')!.id, 'g');
  assert.equal(choosePage(s, 0, false, 'b', 'g')!.id, 'b', 'a pin wins');
  assert.equal(choosePage(s, 0, false, null, 'gone')!.id, 'a');
  // Every page with rules and none holding: they all rotate rather than a black panel.
  const only = screenOf([{ id: 'x', showWhen: [{ app: 'x' }] }]);
  assert.equal(choosePage(only, 0, false, null, null)!.id, 'x');
});

test('context: configs without rules rotate exactly as before (the example and the fixtures)', () => {
  const old = (s: Screen, now: number, working: boolean, pinned: string | null) => pickPage(s.pages.filter((p) => whenMatches(p.when, working)), now, pinned);
  const files = ['../../../examples/showcase.json'];
  const configs = files.map((f) => normalize(JSON.parse(readFileSync(new URL(f, import.meta.url), 'utf8'))));
  configs.push(
    normalize({
      screens: [
        { id: 'x', pages: [{ id: '1', durationMs: 15_000 }, { id: '2', when: 'work' }, { id: '3', when: 'off', durationMs: 45_000 }, { id: '4', enabled: false }] },
        { id: 'y', pinnedPage: '2', pages: [{ id: '1' }, { id: '2', when: 'work' }] },
      ],
    }),
  );
  let checked = 0;
  for (const cfg of configs) {
    for (const s of cfg.screens) {
      assert.equal(s.pages.some((p) => p.showWhen), false, 'normalize adds no rules');
      assert.equal(s.context, undefined);
      for (const working of [true, false]) {
        for (const pinned of [null, s.pinnedPage ?? null, s.pages[1]?.id ?? null]) {
          for (let t = 1_700_000_000_000; t < 1_700_000_000_000 + 3 * 3_600_000; t += 7_000) {
            assert.equal(choosePage(s, t, working, pinned, null)?.id, old(s, t, working, pinned)?.id);
            checked++;
          }
        }
      }
    }
  }
  assert.ok(checked > 5000);
});

test('context: normalize keeps good rules, drops empty ones, and leaves pages without rules untouched', () => {
  const s = screenOf([
    {
      id: 'p',
      showWhen: [
        {},
        { app: '  ' },
        { label: ' Game ', priority: 2.4, app: ' steam* ' },
        { source: 'calls/active', path: 'active', op: 'nope' as never, value: true },
        { time: { start: '25:00', end: '08:00' } },
        { time: { start: '22:00', end: '07:00', days: [5, 5, 9, 1] } },
        { time: { start: '08:00', end: '09:00', days: [0, 1, 2, 3, 4, 5, 6] } },
        { urgent: true, priority: 0 },
      ] as ShowWhenRule[],
      inRotation: 'yes' as never,
    },
    { id: 'q', showWhen: [{}], inRotation: true },
  ], { context: { minMs: -1, holdMs: 1234.4 } });
  assert.deepEqual(s.pages[0]!.showWhen, [
    { label: 'Game', priority: 2, app: 'steam*' },
    { source: 'calls/active', path: 'active', value: true },
    { time: { start: '22:00', end: '07:00', days: [1, 5] } },
    { time: { start: '08:00', end: '09:00' } },
    { urgent: true },
  ]);
  assert.equal(s.pages[0]!.inRotation, undefined);
  assert.equal('showWhen' in s.pages[1]!, false, 'no rule left: no showWhen');
  assert.equal('inRotation' in s.pages[1]!, false);
  assert.deepEqual(s.context, { holdMs: 1234 });
});

// ---------------------------------------------------------------- with the runtime

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await sleep(20);
  assert.ok(cond(), 'timed out');
}

test('runtime: a running program and a source value bring their pages up, and the rotation comes back', async (t) => {
  let emit: ((d: unknown) => void) | null = null;
  const reg = new Registry();
  reg.add(definePlugin({
    id: 'calls', name: 'Calls', version: '1',
    sources: [{ id: 'active', name: 'Active', watch: (_ctx, e) => ((emit = e), () => undefined) }],
    widgets: [defineWidget({ id: 'box', name: 'Box', render: (g, ctx) => {
      g.fillStyle = '#888';
      g.fillRect(ctx.box.x, ctx.box.y, ctx.box.w, ctx.box.h);
    } })],
  }));
  const tiles = [{ id: 't', x: 0, y: 0, w: 1, h: 1, widgets: [{ id: '', type: 'calls/box', options: {} }] }];
  const page = (id: string, extra: Partial<Page> = {}) => ({ id, name: id, grid: { cols: 1, rows: 1, gap: 0, padding: 0 }, tiles: tiles.map((x) => ({ ...x, widgets: x.widgets.map((w) => ({ ...w, id: `w-${id}` })) })), ...extra });
  const cfg = normalize({
    threads: 'never',
    screens: [{
      id: 's', name: 'S', width: 64, height: 32, device: { driver: 'virtual' }, context: { minMs: 0, holdMs: 0 },
      pages: [page('main'), page('game', { showWhen: [{ app: 'fakegame*', label: 'game open' }] }), page('call', { showWhen: [{ source: 'calls/active', path: 'active', priority: 5 }] })],
    }],
  });
  let apps: string[] = ['bash'];
  let listed = 0;
  const rt = new Runtime(reg, cfg, { processes: { list: async () => (listed++, apps) }, appsEveryMs: 100 });
  rt.start();
  t.after(() => rt.stop());
  const shown = () => rt.status().screens[0]!;
  await until(() => shown().page === 'main');
  assert.equal(shown().context, null);
  apps = ['bash', 'fakegame'];
  await until(() => shown().page === 'game');
  assert.deepEqual(shown().context?.reason, { label: 'game open', app: 'fakegame' });
  await until(() => emit !== null);
  emit!({ active: true });
  await until(() => shown().page === 'call');
  assert.equal(shown().context?.priority, 5);
  emit!({ active: false });
  await until(() => shown().page === 'game');
  apps = ['bash'];
  await until(() => shown().page === 'main');
  assert.equal(shown().context, null);
  assert.ok(listed >= 2, 'the processes were listed');
  // No rule on a program: nobody lists them.
  rt.apply(normalize({ ...cfg, screens: [{ ...cfg.screens[0]!, pages: [cfg.screens[0]!.pages[0]!] }] }));
  const before = listed;
  await sleep(500);
  assert.equal(listed, before);
});

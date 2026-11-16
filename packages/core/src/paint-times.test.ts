import assert from 'node:assert/strict';
import { test } from 'node:test';
import { definePlugin, themeById } from '@kiosko/sdk';
import { composePage, type TileCache } from './compositor.ts';
import { newPage, newTile, newWidget } from './config/model.ts';
import { normalize } from './config/normalize.ts';
import { Registry } from './registry.ts';
import { PaintTimes, SLOW_PAINT_MS } from './runtime.ts';

test('the compositor times a widget when it paints, not when the tile comes from the cache', () => {
  const r = new Registry();
  const busy = (ms: number) => {
    const end = performance.now() + ms;
    while (performance.now() < end) {
      /* a slow render */
    }
  };
  r.add(definePlugin({ id: 'slow', name: 'Slow', version: '1.0.0', widgets: [{ id: 'w', name: 'W', render: () => busy(15) }] }));
  const w = newWidget('slow/w');
  const page = newPage('p', 400, 200, [newTile({ x: 0, y: 0, w: 6, h: 3 }, [w])]);
  const cache: TileCache = new Map();
  const input = { cfg: normalize({}), screen: { width: 400, height: 200, pixelShift: { enabled: false, amplitude: 0, periodMs: 1 } }, page, theme: themeById('midnight'), registry: r, now: 1000, working: true, cache, dataOf: () => undefined, sourcesOf: () => ({}) };
  const first = composePage(input as never).tiles[0]!;
  assert.equal(first.shown, w.id);
  assert.ok(first.renderMs! >= 14, `measured ${first.renderMs}`);
  const cached = composePage(input as never).tiles[0]!;
  assert.equal(cached.renderMs, undefined);
});

test('PaintTimes: last, average and slowest; one warning per slow widget every ten minutes', () => {
  const p = new PaintTimes();
  const logs: string[] = [];
  const log = (scope: string, m: string) => logs.push(`${scope}: ${m}`);
  p.record('a', 'x/fast', 4, 0, log);
  p.record('a', 'x/fast', 6, 1000, log);
  p.record('b', 'x/slow', SLOW_PAINT_MS + 30, 2000, log);
  p.record('b', 'x/slow', SLOW_PAINT_MS + 40, 3000, log);
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /^x\/slow: painting took 80 ms/);
  p.record('b', 'x/slow', SLOW_PAINT_MS + 40, 3000 + 10 * 60_000, log);
  assert.equal(logs.length, 2);
  const [slow, fast] = p.list();
  assert.equal(slow!.instance, 'b');
  assert.equal(slow!.maxMs, 90);
  assert.equal(fast!.lastMs, 6);
  assert.equal(fast!.avgMs, 4.4);
  assert.equal(fast!.paints, 2);
  p.retain(new Set(['a']));
  assert.deepEqual(p.list().map((t) => t.instance), ['a']);
});

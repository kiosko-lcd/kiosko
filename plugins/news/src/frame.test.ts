import { test } from 'node:test';
import assert from 'node:assert';
import { localize } from '@tessera/sdk';
import { coverRect, outletsLabel, relativeAge } from './frame.ts';
import { demoDeck } from './demo.ts';
import { contrastPair } from './cluster.ts';

test('frame: relative age in both languages', () => {
  const now = Date.UTC(2026, 8, 2, 12);
  const es = (ms: number) => {
    const a = relativeAge(ms, now);
    return a ? localize(a, 'es') : '';
  };
  assert.strictEqual(es(0), '', 'no date, no age');
  assert.strictEqual(es(now - 30_000), 'ahora mismo');
  assert.strictEqual(es(now - 12 * 60_000), 'hace 12 min');
  assert.strictEqual(es(now - 3 * 3600_000), 'hace 3 h');
  assert.strictEqual(es(now - 26 * 3600_000), 'ayer');
  assert.strictEqual(es(now - 3 * 86_400_000), 'hace 3 días');
  assert.strictEqual(es(now + 60_000), '', 'a feed clock in the future does not say "-5 min ago"');
  assert.strictEqual(localize(relativeAge(now - 12 * 60_000, now)!, 'en'), '12 min ago');
  assert.strictEqual(localize(outletsLabel(3), 'en'), '3 outlets');
});

test('frame: the crop covers the whole box, biased upwards', () => {
  const r = coverRect(1200, 675, 1920, 462);
  assert.ok(r.dw >= 1920 - 0.001 && r.dh >= 462 - 0.001);
  assert.strictEqual(Math.round(r.dx), 0);
  assert.ok(r.dy > coverRect(1200, 675, 1920, 462, 0.5).dy, 'shows more of the top than centring');
  const wide = coverRect(4000, 500, 1920, 462);
  assert.ok(wide.dw >= 1920 && wide.dh >= 462 && wide.dx < 0, 'a very wide photo is cropped at the sides');
});

test('frame: the demo deck shows each layout', () => {
  const d = demoDeck(Date.UTC(2026, 10, 5, 10));
  assert.strictEqual(d.stories[0]?.consensus, 3, 'a story carried by three outlets opens');
  assert.ok(d.stories.some((s) => contrastPair(s)), 'and one with two versions to contrast');
  assert.ok(d.stories.every((s) => s.lead.image?.startsWith('demo:')), 'no network in the demo');
});

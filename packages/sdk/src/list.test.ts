import assert from 'node:assert/strict';
import { test } from 'node:test';
import { localize, type Localized } from './i18n.ts';
import { drawEmpty, drawMore, listLayout, listOptions, moreLabel, type ListSpec } from './list.ts';
import type { Graphics, RenderContext } from './plugin.ts';
import { defaultsOf, t, toJsonSchema, validate } from './schema.ts';
import { DEFAULT_THEME } from './theme.ts';

const box = (h: number, w = 400) => ({ x: 10, y: 20, w, h });
/** Like gitlab/pipelines: one line of 22–46 px, sized for at least 3; two lines on tall tiles. */
const CI: ListSpec<'one-line' | 'detailed'> = {
  sizes: { 'one-line': { min: 22, max: 46 }, detailed: { min: 50, max: 80 } },
  auto: (b, n) => (b.h >= b.w * 0.7 && b.h / n >= 50 ? 'detailed' : 'one-line'),
  minRows: 3,
};
const ONE: ListSpec<'one-line'> = { sizes: { 'one-line': { min: 22, max: 46 } } };

test('listOptions: rows always, layout only for widgets with two layouts', () => {
  const plain = t.object({ ...listOptions() });
  assert.deepEqual(defaultsOf(plain), { rows: 0 });
  assert.deepEqual(Object.keys(plain.props), ['rows']);
  const both = t.object({ ...listOptions({ rows: 4, layouts: ['one-line', 'detailed'] }) });
  assert.deepEqual(defaultsOf(both), { rows: 4, layout: 'auto' });
  assert.deepEqual(both.props.layout.values, ['auto', 'one-line', 'detailed']);
  assert.equal(validate(both, { rows: 99, layout: 'grid' }).value.rows, 30);
  assert.equal(validate(both, { rows: -2 }).value.rows, 0);
  assert.equal(validate(both, { layout: 'grid' }).value.layout, 'auto');
  const js = toJsonSchema(both) as { properties: Record<string, any> };
  assert.equal(js.properties.rows.type, 'integer');
  assert.deepEqual([js.properties.rows.minimum, js.properties.rows.maximum], [0, 30]);
  assert.match(js.properties.rows.description, /^0 = as many as fit/);
  assert.equal(js.properties.layout['x-ui'].labels.detailed.es, 'Detallado');
});

test('rows = 0 keeps the automatic fit: rows between min and max', () => {
  const p = listLayout(box(200), 3, { rows: 0 }, CI);
  assert.equal(p.layout, 'one-line');
  assert.equal(p.rowH, 46);
  assert.deepEqual([p.shown, p.hidden, p.more], [3, 0, null]);
  assert.deepEqual(p.rows[1], { x: 10, y: 66, w: 400, h: 46 });
  // One item doesn't get a giant row (minRows); `max` caps it anyway.
  assert.equal(listLayout(box(200), 1, {}, ONE).rowH, 46);
  assert.equal(listLayout(box(200), 1, {}, CI).rowH, 200 / 3 > 46 ? 46 : 200 / 3);
});

test('overflow: as many rows as fit over a compact "+N more" line', () => {
  const p = listLayout(box(200), 10, {}, CI);
  assert.equal(p.rowH, 22);
  assert.equal(p.shown, 8);
  assert.equal(p.hidden, 2);
  // 60 % of a row, at least 18 px: right under the last row.
  assert.deepEqual(p.more, { x: 10, y: 20 + 8 * 22, w: 400, h: 18 });
  assert.ok(p.more!.y + p.more!.h <= 20 + 200);
  // Taller rows, a taller line, up to 28 px.
  const big = listLayout(box(450), 12, {}, { sizes: { detailed: { min: 60, max: 80 } } });
  assert.deepEqual([big.rowH, big.shown, big.more!.h, big.more!.y], [60, 7, 28, 20 + 7 * 60]);
});

test('rows = N shows N items, in rows never taller than max', () => {
  // The user's case: rows 2, 4 items, a 600×220 tile. Two rows of `max`, then "+2 more"; the rest stays empty.
  const p = listLayout(box(190, 600), 4, { rows: 2 }, CI);
  assert.equal(p.layout, 'one-line');
  assert.deepEqual([p.rowH, p.shown, p.hidden], [46, 2, 2]);
  assert.deepEqual(p.more, { x: 10, y: 20 + 92, w: 600, h: 28 });
  // Fewer items than N: rows sized for N, no "+N more".
  const few = listLayout(box(300), 2, { rows: 3 }, ONE);
  assert.deepEqual([few.rowH, few.shown, few.hidden, few.more], [46, 2, 0, null]);
  const exact = listLayout(box(120), 3, { rows: 3 }, ONE);
  assert.deepEqual([exact.rowH, exact.shown, exact.hidden, exact.more], [40, 3, 0, null]);
  // One more than N: N rows and the line under them (the line doesn't take a row).
  const over = listLayout(box(150), 4, { rows: 3 }, ONE);
  assert.deepEqual([over.shown, over.hidden], [3, 1]);
  assert.equal(over.rowH, (150 - 28) / 3);
  assert.deepEqual(over.more, { x: 10, y: 20 + 122, w: 400, h: 28 });
});

test('rows = N that do not fit at the minimum: the rows that do, and "+N more"', () => {
  const p = listLayout(box(100), 10, { rows: 10 }, ONE);
  assert.equal(p.rowH, 22);
  assert.equal(p.shown, 3);
  assert.equal(p.hidden, 7);
  assert.deepEqual(p.more, { x: 10, y: 20 + 66, w: 400, h: 18 });
  // N above the item count, but they don't all fit either.
  const q = listLayout(box(100), 6, { rows: 8 }, ONE);
  assert.deepEqual([q.shown, q.hidden, q.rowH], [3, 3, 22]);
});

test('never zero rows when one fits: the "+N more" line is squeezed or left out', () => {
  // Room for one row and a squeezed line.
  const a = listLayout(box(36), 3, {}, { sizes: { 'one-line': { min: 18, max: 48 } } });
  assert.deepEqual([a.shown, a.hidden, a.rowH], [1, 2, 18]);
  assert.deepEqual(a.more, { x: 10, y: 38, w: 400, h: 18 });
  const b = listLayout(box(30), 3, {}, { sizes: { 'one-line': { min: 22, max: 48 } } });
  assert.deepEqual([b.shown, b.hidden, b.rowH], [1, 2, 22]);
  assert.equal(b.more, null);
  const c = listLayout(box(40), 5, { rows: 2 }, { sizes: { detailed: { min: 30, max: 90 } } });
  assert.deepEqual([c.shown, c.hidden, c.rowH, c.more?.h], [1, 4, 30, undefined]);
  // A box shorter than a row: the one row, squeezed.
  const d = listLayout(box(14), 3, {}, ONE);
  assert.deepEqual([d.shown, d.rowH, d.more], [1, 14, null]);
});

test('textSize and detailSize follow the row, so they stop growing with it', () => {
  const one = listLayout(box(400, 600), 2, { rows: 2 }, CI);
  assert.deepEqual([one.layout, one.rowH, one.textSize, one.detailSize], ['one-line', 46, 28, 22]);
  const det = listLayout(box(400, 300), 2, { rows: 2 }, CI);
  assert.deepEqual([det.layout, det.rowH, det.textSize, det.detailSize], ['detailed', 80, 34, 24]);
});

test('layout: auto follows the widget\'s rule, a fixed one wins, an unknown one is auto', () => {
  assert.equal(listLayout(box(400, 300), 4, { layout: 'auto' }, CI).layout, 'detailed');
  assert.equal(listLayout(box(400, 300), 4, { layout: 'one-line' }, CI).layout, 'one-line');
  assert.equal(listLayout(box(100, 600), 4, { layout: 'detailed' }, CI).layout, 'detailed');
  assert.equal(listLayout(box(400, 300), 4, { layout: 'grid' }, CI).layout, 'detailed');
  // Without an auto rule: the first layout declared.
  assert.equal(listLayout(box(400, 300), 4, {}, { sizes: { detailed: { min: 40, max: 84 } } }).layout, 'detailed');
  const d = listLayout(box(400, 300), 4, { layout: 'detailed' }, CI);
  assert.equal(d.rowH, 80);
  // The rule sees the rows the box is sized for: 3 of 12 leave room for two lines.
  assert.equal(listLayout(box(400, 300), 12, {}, CI).layout, 'one-line');
  assert.equal(listLayout(box(400, 300), 12, { rows: 3 }, CI).layout, 'detailed');
});

test('degenerate boxes never throw nor go negative', () => {
  assert.deepEqual(listLayout(box(200), 0, {}, CI).rows, []);
  const tiny = listLayout(box(30), 5, {}, ONE);
  assert.ok(tiny.shown <= 1 && tiny.shown >= 0);
  assert.equal(tiny.shown + tiny.hidden, 5);
  const zero = listLayout(box(0), 3, { rows: 4 }, ONE);
  assert.equal(zero.shown + zero.hidden, 3);
  assert.equal(zero.more, null);
  // Every combination keeps its rows and line inside the box (within the descenders' tolerance).
  for (let h = 1; h <= 300; h += 7) {
    for (const n of [1, 2, 5, 20]) {
      for (const rows of [0, 1, 2, 6, 30]) {
        const p = listLayout(box(h), n, { rows }, CI);
        assert.equal(p.shown + p.hidden, n);
        assert.ok(p.shown >= 1, `h ${h} n ${n} rows ${rows}`);
        assert.ok(p.shown <= (rows || n));
        const { min, max } = CI.sizes[p.layout];
        assert.ok(p.rowH <= max && (p.rowH >= min || p.rowH === h), `rowH ${p.rowH}`);
        const bottom = p.more ? p.more.y + p.more.h : 20 + p.shown * p.rowH;
        assert.ok(bottom <= 20 + h + p.rowH * 0.1 + 1e-9, `h ${h} n ${n} rows ${rows}: ${bottom}`);
        if (p.hidden && p.shown > 1) assert.ok(p.more);
      }
    }
  }
});

test('drawMore and drawEmpty paint one dim, localized line', () => {
  const calls: { text: string; x: number; y: number; o: Record<string, unknown> }[] = [];
  const kit = { truncate: (_g: unknown, s: string) => s, drawTracked: (_g: unknown, text: string, x: number, y: number, o: Record<string, unknown>) => calls.push({ text, x, y, o }) };
  const ctx = { kit, theme: DEFAULT_THEME, t: (x: Localized) => localize(x, 'es'), box: box(100) } as unknown as Pick<RenderContext<unknown, unknown>, 'kit' | 'theme' | 't' | 'box'>;
  const g = {} as Graphics;
  drawMore(g, ctx, { hidden: 0, more: null });
  assert.equal(calls.length, 0);
  drawMore(g, ctx, { hidden: 3, more: { x: 10, y: 80, w: 200, h: 20 } }, { indent: 6 });
  assert.equal(calls[0]!.text, '+3 más');
  assert.equal(calls[0]!.x, 16);
  assert.equal(calls[0]!.o.color, DEFAULT_THEME.colors.inkDim);
  drawMore(g, ctx, { hidden: 1, more: { x: 10, y: 80, w: 200, h: 20 } }, { align: 'right' });
  assert.deepEqual([calls[1]!.x, calls[1]!.o.align], [210, 'right']);
  drawEmpty(g, ctx, 'Nada que revisar');
  assert.equal(calls[2]!.text, 'Nada que revisar');
  assert.equal(moreLabel(2, (x) => localize(x, 'en')), '+2 more');
});

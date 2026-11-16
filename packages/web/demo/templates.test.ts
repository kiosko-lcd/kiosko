import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TEMPLATES, pageFromTemplate } from '../src/editor/templates.ts';

const has = () => true;
const sizes = [[1920, 462], [1280, 480], [480, 480], [462, 1920], [480, 1280]] as const;

test('every template fits its grid at every shape, without overlaps or holes left by rounding', () => {
  for (const t of TEMPLATES.filter((x) => x.id !== 'blank')) {
    for (const [w, h] of sizes) {
      const p = pageFromTemplate(t, t.id, w, h, has, () => undefined);
      const { cols, rows } = p.grid;
      const cells = new Set<string>();
      for (const tile of p.tiles) {
        assert.ok(tile.x >= 0 && tile.y >= 0 && tile.x + tile.w <= cols && tile.y + tile.h <= rows, `${t.id} ${w}×${h}: tile out of the grid`);
        for (let x = tile.x; x < tile.x + tile.w; x++) for (let y = tile.y; y < tile.y + tile.h; y++) {
          assert.ok(!cells.has(`${x},${y}`), `${t.id} ${w}×${h}: tiles overlap at ${x},${y}`);
          cells.add(`${x},${y}`);
        }
      }
      assert.equal(cells.size, cols * rows, `${t.id} ${w}×${h}: the page is covered`);
    }
  }
});

test('on a portrait panel the templates are stacked bands, across the whole width where they were columns', () => {
  const agents = pageFromTemplate(TEMPLATES.find((t) => t.id === 'agents')!, 'a', 462, 1920, has, () => undefined);
  assert.deepEqual([agents.grid.cols, agents.grid.rows], [6, 24]);
  assert.deepEqual(agents.tiles.map((t) => [t.widgets[0]!.type, t.x, t.y, t.w, t.h]), [
    ['agents/summary', 0, 0, 6, 1],
    ['agents/sessions', 0, 1, 6, 13],
    ['vitals/vitals', 0, 14, 6, 5],
    ['usage/rail', 0, 19, 6, 5],
  ]);
  // A template without its own portrait version is its landscape layout turned a quarter.
  const cats = pageFromTemplate(TEMPLATES.find((t) => t.id === 'cats')!, 'c', 462, 1920, has, () => undefined);
  assert.deepEqual(cats.tiles.map((t) => [t.widgets[0]!.type, t.x, t.y, t.w, t.h]), [['cats/room', 0, 0, 6, 17], ['weather/forecast', 0, 17, 6, 7]]);
});

test("plugins' templates join the menu, and a built-in one steps aside once its plugin brings its own", async () => {
  const { allTemplates } = await import('../src/editor/templates.ts');
  const catsOwn = { id: 'cats/room', name: 'Cats room', icon: 'cat', wide: [{ x: 0, y: 0, w: 1, h: 1, widgets: ['cats/room'] as (string | [string, Record<string, unknown>])[] }] };
  const ids = (catalog: { id: string; templates: typeof catsOwn[] }[]) => allTemplates(catalog, () => true).map((t) => t.id);
  assert.deepEqual(ids([]), ['blank', 'agents', 'cats', 'news', 'clock', 'system']);
  assert.deepEqual(ids([{ id: 'cats', templates: [catsOwn] }]), ['blank', 'cats/room', 'agents', 'news', 'clock', 'system']);
  const t = allTemplates([{ id: 'cats', templates: [catsOwn] }], () => true)[1]!;
  assert.equal(t.name, 'Cats room');
  const page = pageFromTemplate(t, 'x', 1920, 462, has, () => undefined);
  assert.deepEqual(page.tiles.map((x) => [x.widgets[0]!.type, x.w, x.h]), [['cats/room', 24, 6]]);
});

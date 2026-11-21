import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Registry } from '@kiosko/core';
import core from '@kiosko/plugin-core';
import { starterConfig } from './starter.ts';

const reg = new Registry();
reg.add(core);

test('the first page fits the screen it is made for: a strip, a square, a panel on its side', () => {
  const tilesOf = (w: number, h: number) => {
    const p = starterConfig(reg, { width: w, height: h }).screens[0]!.pages[0]!;
    return { grid: [p.grid.cols, p.grid.rows], tiles: p.tiles.map((t) => [t.x, t.y, t.w, t.h]) };
  };
  assert.deepEqual(tilesOf(1920, 462), { grid: [24, 6], tiles: [[0, 0, 11, 6], [11, 0, 5, 4]] });
  // On its side the columns become bands, top to bottom.
  assert.deepEqual(tilesOf(462, 1920), { grid: [6, 24], tiles: [[0, 0, 6, 11], [0, 11, 4, 5]] });
  const square = tilesOf(480, 480);
  assert.deepEqual(square.grid, [6, 6]);
  for (const [x, y, w, h] of square.tiles) assert.ok(x! + w! <= 6 && y! + h! <= 6);
});

test('in mainland China the first page leaves out the AI agents and Claude usage (languages.ts): a welcome instead', async () => {
  const { definePlugin } = await import('@kiosko/sdk');
  const r = new Registry();
  r.add(core);
  const w = (id: string) => ({ id, name: id, render() {} });
  for (const [id, widgets] of [['agents', ['sessions', 'summary']], ['usage', ['rail']], ['llm', ['models', 'status']], ['system', ['health']]] as const) {
    r.add(definePlugin({ id, name: id, version: '1', widgets: widgets.map(w) }));
  }
  const types = (locale: string) => starterConfig(r, { locale }).screens[0]!.pages[0]!.tiles.flatMap((t) => t.widgets.map((x) => x.type));
  assert.deepEqual(types('zh-CN'), ['core/text', 'core/clock', 'system/health']);
  assert.deepEqual(types('zh-TW'), ['agents/sessions', 'core/clock', 'usage/rail', 'system/health']);
});

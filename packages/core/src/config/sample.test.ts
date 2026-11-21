import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { Config } from './model.ts';
import { localizeSample } from './sample.ts';

const showcase = JSON.parse(readFileSync(new URL('../../../../examples/showcase.json', import.meta.url), 'utf8')) as Config;
const titles = (c: Config) => c.screens.flatMap((s) => s.pages.flatMap((p) => p.tiles.flatMap((t) => t.widgets.map((w) => w.title)))).filter(Boolean);

test('the sample in English is the showcase itself', () => {
  assert.equal(localizeSample(showcase, 'en-US'), showcase);
});

test('in Chinese: the widgets’ own names instead of English titles, pages and place in the language', () => {
  const tw = localizeSample(showcase, 'zh-TW');
  assert.deepEqual(titles(tw), []);
  assert.ok(titles(showcase).length > 0, 'the showcase has titles to drop');
  assert.ok(tw.screens.some((s) => s.pages.some((p) => p.name === '新聞')));
  assert.equal(tw.location?.name, '台北');
  assert.equal(localizeSample(showcase, 'zh-CN').location?.name, '上海');
  assert.equal(localizeSample(showcase, 'fr').screens[0]!.pages[0]!.name, showcase.screens[0]!.pages[0]!.name, 'other languages keep the names they have no table for');
});

test('in mainland China: the agents and cats stay (they read the agents used there), Claude’s usage bar gives way', () => {
  const types = (c: Config) => c.screens.flatMap((s) => s.pages.flatMap((p) => p.tiles.flatMap((t) => t.widgets.map((w) => w.type))));
  const cn = localizeSample(showcase, 'zh-CN');
  // The Claude-only usage widgets give way to the ones that read DeepSeek or Kimi and the agents (usage 0.3).
  assert.deepEqual(types(cn).filter((t) => t === 'usage/rail' || t === 'usage/blocks'), []);
  if (types(showcase).includes('cats/room')) assert.ok(types(cn).includes('cats/room'), 'the cats room stays');
  assert.deepEqual(cn.plugins?.disabled ?? [], showcase.plugins?.disabled ?? [], 'nothing disabled for the market');
  // Same tiles, same places: only what is painted in them changes.
  assert.equal(types(cn).length, types(showcase).length);
  assert.deepEqual(types(localizeSample(showcase, 'zh-TW')), types(showcase), 'Taiwan: the sample as it is');
});

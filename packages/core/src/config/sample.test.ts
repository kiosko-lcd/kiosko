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

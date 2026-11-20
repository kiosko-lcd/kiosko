import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas } from '@napi-rs/canvas';
import { clearTextCache, measureTracked, registerFontFiles, wrapLines } from './text.ts';

/** Widths depend on real fonts; without them there is nothing to test. */
const MONO = 'TestMono';
const ready = registerFontFiles({ [MONO]: '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf' }).length === 0;
const skip = ready ? false : 'DejaVu fonts missing (fonts-dejavu-core)';

const ctx = createCanvas(100, 100).getContext('2d');
const opts = { size: 17, family: MONO } as const;
/** Usable width of a 430 px tile minus its inner margins. */
const W = 430 - 18 - 18;

test('wrapLines: a short text stays on one line', { skip }, () => {
  assert.deepEqual(wrapLines(ctx, 'Stop', W, 3, opts), ['Stop']);
});

test('wrapLines: spreads a long message and no line overflows', { skip }, () => {
  const msg = 'Your Thermalright panel is working and the dashboard is now live with the adaptive vitals column';
  const lines = wrapLines(ctx, msg, W, 3, opts);
  assert.ok(lines.length > 1, 'it should be spread over several lines');
  assert.ok(lines.length <= 3, 'and respect the maximum');
  for (const l of lines) {
    assert.ok(measureTracked(ctx, l, opts) <= W, `"${l}" does not fit in ${W}px`);
  }
});

test('wrapLines: does not split words if it can avoid it', { skip }, () => {
  const lines = wrapLines(ctx, 'alpha bravo charlie delta echo foxtrot golf hotel india', W, 3, opts);
  // Rejoined, it must still be the same text, word for word.
  assert.ok(lines.join(' ').startsWith('alpha bravo'));
  for (const l of lines) assert.ok(!l.startsWith(' ') && !l.endsWith(' '));
});

test('wrapLines: the last line gets an ellipsis if text is left over', { skip }, () => {
  const long = 'word '.repeat(80).trim();
  const lines = wrapLines(ctx, long, W, 2, opts);
  assert.equal(lines.length, 2);
  assert.ok(lines[1]!.endsWith('…'), 'signals that there is more');
  assert.ok(measureTracked(ctx, lines[1]!, opts) <= W);
});

test('wrapLines: a single word wider than the line is cut hard', { skip }, () => {
  // A path or a URL without spaces: better to split it than leave the line empty.
  const lines = wrapLines(ctx, '/etc/systemd/system/aimonitor-with-an-extremely-long-name.service', W, 3, opts);
  assert.ok(lines.length >= 1);
  for (const l of lines) assert.ok(measureTracked(ctx, l, opts) <= W);
});

test('wrapLines: degenerate cases', { skip }, () => {
  assert.deepEqual(wrapLines(ctx, '', W, 3, opts), []);
  assert.deepEqual(wrapLines(ctx, '   ', W, 3, opts), []);
  assert.deepEqual(wrapLines(ctx, 'text', W, 0, opts), []);
  assert.deepEqual(wrapLines(ctx, 'text', 0, 3, opts), []);
});

test('wrapLines: collapses line breaks and repeated spaces', { skip }, () => {
  assert.deepEqual(wrapLines(ctx, 'one\n\ntwo   three', W, 3, opts), ['one two three']);
});

test('measuring is cached by font and character: the same widths, without asking the canvas again', () => {
  const c = createCanvas(10, 10).getContext('2d');
  clearTextCache();
  let asked = 0;
  const measure = c.measureText.bind(c);
  (c as unknown as { measureText: typeof measure }).measureText = (t: string) => (asked++, measure(t));
  const o = { size: 18 };
  const w1 = measureTracked(c, 'banana', o);
  const first = asked;
  assert.equal(first, 3, 'b, a, n: one each');
  assert.equal(measureTracked(c, 'banana', o), w1);
  assert.equal(asked, first, 'nothing measured again');
  measureTracked(c, 'banana', { size: 19 });
  assert.equal(asked, first + 3, 'another size is another font');
});

test('wrapLines: Chinese breaks between characters, never before 「，。」 nor after 「（」', { skip }, () => {
  const text = '一二三四五六七八九十甲乙丙丁，戊己庚辛壬癸。子丑寅卯（辰巳午未）申酉戌亥，天地玄黃宇宙洪荒。';
  for (const w of [120, 150, 180, 210, 250]) {
    const lines = wrapLines(ctx, text, w, 20, opts);
    assert.equal(lines.join(''), text, `${w}: nothing lost`);
    for (const [i, l] of lines.entries()) {
      assert.ok(!/^[，。、）」]/.test(l), `${w}: line ${i} starts with a closing mark: ${l}`);
      assert.ok(!/[（「]$/.test(l), `${w}: line ${i} ends with an opening mark: ${l}`);
      assert.ok(measureTracked(ctx, l, opts) <= w, `${w}: line ${i} overflows`);
    }
  }
});

test('wrapLines: mixed Latin and Chinese keeps the line full instead of backing off to a far space', { skip }, () => {
  const lines = wrapLines(ctx, 'AI 模型在程式設計任務上追平大型模型，團隊公開了權重與評測資料', 260, 5, opts);
  assert.notEqual(lines[0], 'AI', lines.join(' | '));
  assert.ok(lines[0]!.length > 4, lines.join(' | '));
});

test('wrapLines: never splits a character made of two UTF-16 units', { skip }, () => {
  const lines = wrapLines(ctx, '😀'.repeat(40), 120, 10, opts);
  for (const l of lines) assert.doesNotMatch(l, /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u);
});

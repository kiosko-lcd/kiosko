import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCanvas } from '@napi-rs/canvas';
import { FONT_FAMILIES } from '@kiosko/sdk';
import { cjkFonts, hasFontFamily, registerFonts, setFontLocale, withFallback } from './fonts.ts';

registerFonts();
/** Tests that draw need a CJK font on this machine (Noto Sans CJK on Linux). */
const cjk = cjkFonts('zh-TW').families.length > 0;

function pixels(text: string, font: string): string {
  const c = createCanvas(80, 40);
  const g = c.getContext('2d');
  g.font = font;
  g.fillStyle = '#000';
  g.textBaseline = 'top';
  g.fillText(text, 2, 2);
  return Buffer.from(g.getImageData(0, 0, 80, 40).data.buffer).toString('base64');
}

test('a family that does not exist is not available', () => {
  assert.equal(hasFontFamily('Kiosko No Such Font'), false);
});

test('without CJK fonts, font strings are left alone', () => {
  setFontLocale('en');
  if (cjk) return;
  assert.equal(withFallback('12px "KioskoSans"'), '12px "KioskoSans"');
});

test('the fallback follows the language: Traditional, Hong Kong, Simplified', { skip: !cjk && 'no CJK font on this machine' }, () => {
  assert.equal(cjkFonts('zh-TW').script, 'Hant');
  assert.equal(cjkFonts('zh-HK').script, 'Hant-HK');
  assert.equal(cjkFonts('zh-CN').script, 'Hans');
  const tw = cjkFonts('zh-TW').families;
  const cn = cjkFonts('zh-CN').families;
  assert.notEqual(tw[0], cn[0], 'Taiwan and mainland China get different first families');
  assert.match(tw[0]!, /TC|TW|JhengHei/);
  assert.match(cn[0]!, /SC|CN|YaHei/);
  // Everyone is covered, not only Chinese speakers.
  assert.ok(cjkFonts('en').families.length > 0);
});

test('withFallback appends once, and asks for bold with the bold families', { skip: !cjk && 'no CJK font on this machine' }, () => {
  setFontLocale('zh-TW');
  const plain = withFallback(`12px "${FONT_FAMILIES.sans}"`);
  assert.ok(plain.startsWith(`12px "${FONT_FAMILIES.sans}", "`));
  assert.equal(withFallback(plain), plain);
  assert.ok(withFallback(`20px "${FONT_FAMILIES.sansBold}"`).startsWith('bold 20px'));
  assert.ok(withFallback(`600 20px "${FONT_FAMILIES.sansBold}"`).startsWith('600 20px'));
  assert.ok(!withFallback('bold 20px sans-serif').startsWith('bold bold'));
});

test('Chinese is drawn, not as boxes, in every Kiosko family and in plain sans-serif', { skip: !cjk && 'no CJK font on this machine' }, () => {
  setFontLocale('zh-TW');
  const box = pixels('體', '24px "Kiosko Missing Font"');
  for (const family of [...Object.values(FONT_FAMILIES), 'sans-serif']) {
    const font = family === 'sans-serif' ? '24px sans-serif' : `24px "${family}"`;
    const drawn = pixels('體', font);
    assert.notEqual(drawn, box, `${family} draws a box`);
    assert.notEqual(drawn, pixels('', font), `${family} draws nothing`);
  }
});

test('Latin text still comes from DejaVu', { skip: !cjk && 'no CJK font on this machine' }, () => {
  setFontLocale('en');
  const before = pixels('CPU 42°', `20px "${FONT_FAMILIES.sans}"`);
  setFontLocale('zh-TW');
  assert.equal(pixels('CPU 42°', `20px "${FONT_FAMILIES.sans}"`), before);
});

test('reading font back gives what was set, so callers can compare cheaply', () => {
  setFontLocale('zh-TW');
  const g = createCanvas(4, 4).getContext('2d');
  g.font = `14px "${FONT_FAMILIES.mono}"`;
  assert.equal(g.font, `14px "${FONT_FAMILIES.mono}"`);
  g.save();
  g.font = '30px sans-serif';
  g.restore();
  // After restore the context has its old font again; reading it must not lie about it.
  assert.match(g.font, /14px/);
});

test('Traditional and Simplified glyphs differ for the same character', { skip: !cjk && 'no CJK font on this machine' }, () => {
  setFontLocale('zh-TW');
  const tw = pixels('骨', `32px "${FONT_FAMILIES.sans}"`);
  setFontLocale('zh-CN');
  const cn = pixels('骨', `32px "${FONT_FAMILIES.sans}"`);
  assert.notEqual(tw, cn);
});

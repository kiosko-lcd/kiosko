import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hanScript, localize, pickLocale, plural } from './i18n.ts';

test('hanScript goes by script, not by region code', () => {
  for (const tag of ['zh-TW', 'zh-Hant', 'zh-Hant-TW', 'zh_TW']) assert.equal(hanScript(tag), 'Hant', tag);
  for (const tag of ['zh-HK', 'zh-MO', 'zh-Hant-HK']) assert.equal(hanScript(tag), 'Hant-HK', tag);
  for (const tag of ['zh', 'zh-CN', 'zh-SG', 'zh-Hans', 'zh-Hans-CN']) assert.equal(hanScript(tag), 'Hans', tag);
  assert.equal(hanScript('ja-JP'), 'Jpan');
  assert.equal(hanScript('ko'), 'Kore');
  for (const tag of ['en', 'es-ES', '', undefined, 'not a locale!']) assert.equal(hanScript(tag), null, String(tag));
});

test('localize still picks the exact tag, then the language, then English', () => {
  assert.equal(localize({ en: 'Hi', es: 'Hola' }, 'es-ES'), 'Hola');
  assert.equal(localize({ en: 'Hi' }, 'zh-TW'), 'Hi');
});

test('pickLocale: Chinese by script, Taiwan never gets Simplified', () => {
  const both = ['en', 'zh-Hant', 'zh-Hans'];
  for (const l of ['zh-TW', 'zh-Hant-TW', 'zh_TW', 'zh-HK', 'zh-MO']) assert.equal(pickLocale(both, l), 'zh-Hant', l);
  for (const l of ['zh', 'zh-CN', 'zh-SG', 'zh-Hans-CN']) assert.equal(pickLocale(both, l), 'zh-Hans', l);
  // Region-coded keys work too.
  assert.equal(pickLocale(['en', 'zh-TW', 'zh-CN'], 'zh-Hant'), 'zh-TW');
  assert.equal(pickLocale(['en', 'zh-TW', 'zh-CN'], 'zh-HK'), 'zh-TW');
  assert.equal(pickLocale(['en', 'zh-tw'], 'zh-TW'), 'zh-tw');
  // A bare zh is Simplified: English for Taiwan rather than the other script.
  assert.equal(pickLocale(['en', 'zh'], 'zh-TW'), undefined);
  assert.equal(pickLocale(['en', 'zh'], 'zh-CN'), 'zh');
  // Hong Kong prefers its own over Taiwan's.
  assert.equal(pickLocale(['zh-TW', 'zh-HK'], 'zh-HK'), 'zh-HK');
});

test('pickLocale: other languages by language, then another region', () => {
  assert.equal(pickLocale(['en', 'es'], 'es-MX'), 'es');
  assert.equal(pickLocale(['en', 'pt-BR'], 'pt-PT'), 'pt-BR');
  assert.equal(pickLocale(['en', 'es'], 'fr'), undefined);
  assert.equal(pickLocale(['en', 'en-GB'], 'en-GB'), 'en-GB');
});

test('localize uses pickLocale and falls back to English', () => {
  const t = { en: 'Settings', 'zh-Hant': '設定', 'zh-Hans': '设置' };
  assert.equal(localize(t, 'zh-TW'), '設定');
  assert.equal(localize(t, 'zh-CN'), '设置');
  assert.equal(localize({ en: 'URL', zh: '网址' }, 'zh-TW'), 'URL');
});

test('pickLocale: regions, scripts and old codes, for any language', () => {
  assert.equal(pickLocale(['es-ES', 'es-MX'], 'es-AR'), 'es-MX', 'Latin America reads the Mexican variant');
  assert.equal(pickLocale(['es-ES', 'es-419'], 'es-CL'), 'es-419');
  assert.equal(pickLocale(['es-ES', 'es-MX'], 'es-MX'), 'es-MX');
  assert.equal(pickLocale(['es', 'es-MX'], 'es-ES'), 'es', 'the least specific before another region');
  assert.equal(pickLocale(['pt-BR', 'pt-PT'], 'pt-AO'), 'pt-PT');
  assert.equal(pickLocale(['sr'], 'sr-Latn'), undefined, 'never another script');
  assert.equal(pickLocale(['sr-Cyrl', 'sr-Latn'], 'sr'), 'sr-Cyrl');
  assert.equal(pickLocale(['en', 'he'], 'iw'), 'he');
  assert.equal(pickLocale(['en', 'nb'], 'no'), 'nb');
  assert.equal(pickLocale(['en', 'zh-Hant', 'zh-Hans'], 'zh_TW.UTF-8'), 'zh-Hant');
  assert.equal(pickLocale(['en', 'zh-Hant', 'zh-Hans'], 'yue-HK'), 'zh-Hant', 'Cantonese reads Traditional Chinese');
  assert.equal(pickLocale(['en', 'zh-Hant', 'zh-Hans'], 'cmn-TW'), 'zh-Hant');
  assert.equal(hanScript('zh_TW.UTF-8'), 'Hant');
  assert.equal(hanScript('yue'), 'Hant-HK');
  assert.equal(hanScript('C'), null);
});

test('plural: the forms the language has, and its digits', () => {
  const files = { en: { one: '{n} file', other: '{n} files' }, pl: { one: '{n} plik', few: '{n} pliki', many: '{n} plików', other: '{n} pliku' }, 'zh-Hant': { other: '{n} 個檔案' } };
  assert.equal(plural(1, files, 'en'), '1 file');
  assert.equal(plural(1500, files, 'en-US'), '1,500 files');
  assert.equal(plural(22, files, 'pl'), '22 pliki');
  assert.equal(plural(25, files, 'pl'), '25 plików');
  assert.equal(plural(1, files, 'zh-TW'), '1 個檔案');
  assert.equal(plural(3, files, 'fr'), '3 files');
});

test('plural: each language\'s rules and number format are made once, not on every call', () => {
  const forms = { en: { one: '{n} file', other: '{n} files' }, pl: { one: '{n} plik', few: '{n} pliki', many: '{n} plików', other: '{n} pliku' }, 'x-bad': { other: '{n} x' } };
  const RealRules = Intl.PluralRules;
  const RealNumbers = Intl.NumberFormat;
  let made = 0;
  // Counted from here on (a language asked before this test is already made).
  const Rules = function (this: unknown, ...a: ConstructorParameters<typeof Intl.PluralRules>) {
    made++;
    return new RealRules(...a);
  } as unknown as typeof Intl.PluralRules;
  const Numbers = function (this: unknown, ...a: ConstructorParameters<typeof Intl.NumberFormat>) {
    made++;
    return new RealNumbers(...a);
  } as unknown as typeof Intl.NumberFormat;
  Object.assign(Intl, { PluralRules: Rules, NumberFormat: Numbers });
  try {
    const once = [plural(1, forms, 'pl'), plural(3, forms, 'pl'), plural(5, forms, 'pl'), plural(1234.5, forms, 'pl')];
    assert.deepEqual(once, ['1 plik', '3 pliki', '5 plików', `${new RealNumbers('pl').format(1234.5)} pliku`]);
    const after = made;
    assert.ok(after <= 2);
    for (let i = 0; i < 50; i++) plural(i, forms, 'pl');
    assert.equal(made, after, 'no new Intl objects');
    // A tag Intl refuses: `other`, the number as is, and asked once.
    assert.equal(plural(2, { 'x-bad': forms['x-bad'] }, 'x-bad'), '2 x');
  } finally {
    Object.assign(Intl, { PluralRules: RealRules, NumberFormat: RealNumbers });
  }
});

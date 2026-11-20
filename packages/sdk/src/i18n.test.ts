import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hanScript, localize } from './i18n.ts';

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

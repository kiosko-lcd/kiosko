import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readConfig, screensToShow, stackFor } from './config.ts';

const screen = (id: string, pages: { id: string; enabled?: boolean }[] = [{ id: 'a' }]) => ({ id, width: 1920, height: 462, pages });

test("front page, your config: a config.json, a screen exported from the editor, or the demo's saved layout", () => {
  assert.deepEqual(readConfig(JSON.stringify({ theme: 'aurora', screens: [screen('s')] })), { config: { theme: 'aurora', screens: [screen('s')] } });
  assert.deepEqual(readConfig(JSON.stringify({ kiosko: 'screen', version: 1, screen: screen('one') })), { config: { screens: [screen('one')] } });
  assert.deepEqual(readConfig(JSON.stringify({ rev: 7, config: { screens: [screen('kept')] } })), { config: { screens: [screen('kept')] } });
});

test('front page, your config: why a file is not one', () => {
  assert.deepEqual(readConfig('{ not json'), { problem: 'json' });
  assert.deepEqual(readConfig('[1, 2]'), { problem: 'shape' });
  assert.deepEqual(readConfig('"text"'), { problem: 'shape' });
  assert.deepEqual(readConfig(JSON.stringify({ name: 'package', version: '1.0.0' })), { problem: 'shape' });
  assert.deepEqual(readConfig(JSON.stringify({ screens: [] })), { problem: 'empty' });
});

test('front page, your config: a panel for each screen with a page to show, three at most', () => {
  const config = { screens: [screen('a'), screen('off', [{ id: 'x', enabled: false }]), screen('b'), screen('c'), screen('d')] };
  assert.deepEqual(screensToShow(config).map((s) => s.id), ['a', 'b', 'c']);
  assert.deepEqual(screensToShow({ screens: [screen('none', [])] }), []);
  assert.deepEqual([1, 2, 3, 5].map(stackFor), [0, 0.5, 1, 1]);
});

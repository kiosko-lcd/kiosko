import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inline, linkText, parseNotes } from './release-notes-md.ts';

test('parseNotes: GitHub\'s generated notes as headings, items and links', () => {
  const b = parseNotes("## What's Changed\n* Open my editor: `kiosko editor` by @Loksly in https://github.com/kiosko-lcd/kiosko/pull/51\n\n**Full Changelog**: https://github.com/kiosko-lcd/kiosko/compare/v0.2.7...v0.2.8");
  assert.deepEqual(b.map((x) => x.t), ['h', 'li', 'p']);
  assert.deepEqual(b[1]!.parts, [
    { t: 'text', text: 'Open my editor: ' },
    { t: 'code', text: 'kiosko editor' },
    { t: 'text', text: ' by @Loksly in ' },
    { t: 'a', text: '#51', href: 'https://github.com/kiosko-lcd/kiosko/pull/51' },
  ]);
  assert.deepEqual(b[2]!.parts, [{ t: 'b', text: 'Full Changelog' }, { t: 'text', text: ': ' }, { t: 'a', text: 'v0.2.7…v0.2.8', href: 'https://github.com/kiosko-lcd/kiosko/compare/v0.2.7...v0.2.8' }]);
});

test('parseNotes: HTML is never markup, and only http(s) links are links', () => {
  const b = parseNotes('<img src=x onerror=alert(1)>Hi <script>alert(1)</script>\n* [click](javascript:alert(1)) and [ok](https://kioskolcd.dev/x)');
  assert.deepEqual(b[0]!.parts, [{ t: 'text', text: 'Hi alert(1)' }]);
  assert.deepEqual(b[1]!.parts, [{ t: 'text', text: 'click and ' }, { t: 'a', text: 'ok', href: 'https://kioskolcd.dev/x' }]);
  assert.ok(inline('see https://example.com/a.').some((p) => p.t === 'a' && p.href === 'https://example.com/a'), 'a trailing full stop is not part of the URL');
  assert.equal(linkText('https://kioskolcd.dev/store/'), 'kioskolcd.dev/store/');
});

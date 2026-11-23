import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
// @ts-expect-error: a plain ES module of the site's build
import { guidePath, renderMarkdown, slug } from './docs.mjs';

const docs = fileURLToPath(new URL('../../../docs/', import.meta.url));

test('guides: the Markdown they use, Chinese lines joined without a space', () => {
  const { title, html } = renderMarkdown(
    '# 快速入门\n\n第一行，\n第二行。Kiosko\nis here.\n\n- a `<b>` **b**\n- [usb](usb.md#x) <https://x.dev/>\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```sh\nnpm i -g kiosko\n```\n\n> 想先看看？\n',
    (h: string) => (h.startsWith('usb.md') ? '../usb/#x' : h),
  );
  assert.equal(title, '快速入门');
  assert.match(html, /<h1 id="快速入门">快速入门<\/h1>/);
  assert.match(html, /<p>第一行，第二行。Kiosko is here\.<\/p>/);
  assert.match(html, /<li>a <code>&lt;b&gt;<\/code> <strong>b<\/strong><\/li>/);
  assert.match(html, /<a href="\.\.\/usb\/#x">usb<\/a> <a href="https:\/\/x\.dev\/">/);
  assert.match(html, /<th>a<\/th><th>b<\/th>.*<td>1<\/td><td>2<\/td>/);
  assert.match(html, /<pre><code class="language-sh">npm i -g kiosko<\/code><\/pre>/);
  assert.match(html, /<blockquote><p>想先看看？<\/p><\/blockquote>/);
});

test('guides: anchors as GitHub makes them, so the guides\' own links land', () => {
  assert.equal(slug('国内网络'), '国内网络');
  assert.equal(slug('Windows：使用安装程序'), 'windows使用安装程序');
  assert.equal(slug('Linux 和 macOS：使用 npm'), 'linux-和-macos使用-npm');
});

test('guides: each language links to its own guides on the site, where they exist', () => {
  assert.equal(guidePath(docs, 'zh-Hans', 'install'), 'zh-Hans/docs/install/');
  assert.equal(guidePath(docs, 'zh-Hant', 'usb'), 'zh-Hant/docs/usb/');
  // The USB guide in every language: English from docs/usb.md, at /docs/usb/.
  assert.equal(guidePath(docs, 'en', 'usb'), 'docs/usb/');
  assert.equal(guidePath(docs, 'es', 'usb'), 'es/docs/usb/');
  assert.equal(guidePath(docs, 'de', 'usb'), 'de/docs/usb/');
  // The Wi-Fi screens guide in every language.
  for (const [l, path] of [['en', 'docs/remote-screens/'], ['es', 'es/docs/remote-screens/'], ['de', 'de/docs/remote-screens/'], ['zh-Hant', 'zh-Hant/docs/remote-screens/'], ['zh-Hans', 'zh-Hans/docs/remote-screens/']]) assert.equal(guidePath(docs, l!, 'remote-screens'), path);
  // The browser screens guide too.
  for (const [l, path] of [['en', 'docs/browser-screens/'], ['es', 'es/docs/browser-screens/'], ['de', 'de/docs/browser-screens/'], ['zh-Hant', 'zh-Hant/docs/browser-screens/'], ['zh-Hans', 'zh-Hans/docs/browser-screens/']]) assert.equal(guidePath(docs, l!, 'browser-screens'), path);
  // The install guide is the README in English (and not translated yet into Spanish or German).
  assert.equal(guidePath(docs, 'en', 'install'), null);
  assert.equal(guidePath(docs, 'es', 'install'), null);
});

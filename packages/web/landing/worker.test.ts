import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accepted, choose, chosen } from './worker/choose.ts';
import worker from './worker/index.ts';

const visit = (acceptLanguage: string | null, country: string | null = null, cookie: string | null = null) => choose({ acceptLanguage, country, cookie });

test('the browser decides first: the same language and writing', () => {
  assert.equal(visit('es-ES,es;q=0.9,en;q=0.8', 'US'), 'es');
  assert.equal(visit('zh-TW,zh;q=0.9', 'US'), 'zh-Hant');
  assert.equal(visit('zh-HK', 'CN'), 'zh-Hant');
  assert.equal(visit('zh-CN,zh;q=0.9', 'TW'), 'zh-Hans');
  assert.equal(visit('de-AT', 'ES'), 'de');
  // English (the root) wanted: stay, wherever the visit comes from.
  assert.equal(visit('en-US,en;q=0.9', 'TW'), null);
  assert.equal(visit('en-GB', 'ES'), null);
});

test('preference order: q-values, then the order written', () => {
  assert.equal(visit('fr;q=0.9,de;q=0.95,es;q=0.5', 'FR'), 'de');
  assert.equal(visit('ja, zh-TW;q=0.8, en;q=0.7', 'JP'), 'zh-Hant');
  assert.deepEqual(accepted('en;q=0, *;q=0.5, es'), ['es']);
});

test('the country only when the browser asks for none of the site\'s languages', () => {
  assert.equal(visit('ca-ES,ca;q=0.9', 'ES'), 'es');
  assert.equal(visit('eu', 'ES'), 'es');
  assert.equal(visit('ja', 'TW'), 'zh-Hant');
  assert.equal(visit(null, 'MX'), 'es');
  assert.equal(visit(null, 'CN'), 'zh-Hans');
  assert.equal(visit('fr-CH', 'CH'), null);
  assert.equal(visit(null, 'US'), null);
  assert.equal(visit(null, null), null);
});

test('the menu\'s choice wins, English included', () => {
  assert.equal(visit('es-ES', 'ES', 'a=1; kiosko_lang=en'), null);
  assert.equal(visit('en-US', 'US', 'kiosko_lang=zh-Hant'), 'zh-Hant');
  assert.equal(visit('es', 'ES', 'kiosko_lang=klingon'), 'es');
  assert.equal(chosen('x=1;kiosko_lang=zh-Hans; y=2'), 'zh-Hans');
});

test('the Worker: redirects the front page only, uncached, keeping the query', async () => {
  const origin: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (r: Request) => (origin.push(new URL(r.url).pathname), new Response('page'))) as typeof fetch;
  try {
    const req = (path: string, headers: Record<string, string> = {}, country?: string) => Object.assign(new Request(`https://kioskolcd.dev${path}`, { headers }), { cf: { country } });
    const r = await worker.fetch(req('/?utm=x', { 'accept-language': 'es-ES' }));
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), 'https://kioskolcd.dev/es/?utm=x');
    assert.match(r.headers.get('cache-control')!, /no-store/);
    assert.equal((await worker.fetch(req('/', {}, 'TW'))).headers.get('location'), 'https://kioskolcd.dev/zh-Hant/');
    // Passed through untouched: other pages, English, crawlers, the share picture.
    for (const [path, headers] of [['/es/', { 'accept-language': 'zh-TW' }], ['/', { 'accept-language': 'en' }], ['/', { 'accept-language': 'es', 'user-agent': 'Googlebot/2.1' }], ['/?card', { 'accept-language': 'es' }]] as const) {
      assert.equal((await worker.fetch(req(path, headers))).status, 200, `${path} ${JSON.stringify(headers)}`);
    }
    assert.deepEqual(origin, ['/es/', '/', '/', '/']);
  } finally {
    globalThis.fetch = real;
  }
});

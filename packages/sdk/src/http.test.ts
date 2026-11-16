import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpError, createHttp, retryAtOf } from './http.ts';

function fakeServer(routes: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const f = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, headers: (init.headers ?? {}) as Record<string, string> });
    return routes(url, init);
  }) as typeof fetch;
  return { calls, fetch: f };
}

test('json: names the plugin and Kiosko, never the person; asks for JSON', async () => {
  const s = fakeServer(() => new Response('{"a":1}', { status: 200 }));
  const http = createHttp({ agent: 'kiosko-plugin-x/1.0.0', fetch: s.fetch });
  const r = await http.json<{ a: number }>('https://api.example.com/v1');
  assert.deepEqual(r.data, { a: 1 });
  assert.equal(r.fresh, true);
  assert.equal(s.calls[0]!.headers['User-Agent'], 'kiosko-plugin-x/1.0.0 Kiosko (+https://kioskolcd.dev)');
  assert.equal(s.calls[0]!.headers.Accept, 'application/json');
  await assert.rejects(createHttp({ fetch: fakeServer(() => new Response('<html>')).fetch }).json('https://x.dev'), /not JSON/);
});

test('conditional requests: an ETag is sent back and a 304 returns the remembered body', async () => {
  const s = fakeServer((_, init) => {
    const h = init.headers as Record<string, string>;
    return h['If-None-Match'] === 'W/"v1"' ? new Response(null, { status: 304 }) : new Response('[1,2]', { status: 200, headers: { ETag: 'W/"v1"' } });
  });
  const http = createHttp({ fetch: s.fetch });
  assert.deepEqual((await http.json('https://a.dev/x')).data, [1, 2]);
  const again = await http.json('https://a.dev/x');
  assert.deepEqual(again.data, [1, 2]);
  assert.equal(again.fresh, false);
  assert.equal(s.calls[1]!.headers['If-None-Match'], 'W/"v1"');
  // noCache: neither sent nor kept.
  await http.json('https://a.dev/x', { noCache: true });
  assert.equal(s.calls[2]!.headers['If-None-Match'], undefined);
});

test('rate limits: Retry-After is honoured, and the host is left alone until then', async () => {
  let clock = 1_000_000;
  let n = 0;
  const s = fakeServer(() => (++n === 1 ? new Response('slow down', { status: 429, headers: { 'Retry-After': '30' } }) : new Response('{}', { status: 200 })));
  const http = createHttp({ fetch: s.fetch, now: () => clock });
  const err = await http.json('https://api.b.dev/1').catch((e: unknown) => e);
  assert.ok(err instanceof HttpError);
  assert.equal(err.status, 429);
  assert.equal(err.retryAt, clock + 30_000);
  assert.equal(http.resting('https://api.b.dev/other'), clock + 30_000);
  // Another URL of the same host: refused without a call.
  await assert.rejects(http.json('https://api.b.dev/2'), /asked to wait/);
  assert.equal(s.calls.length, 1);
  clock += 31_000;
  assert.deepEqual((await http.json('https://api.b.dev/2')).data, {});
  assert.equal(http.resting('https://api.b.dev/2'), undefined);
});

test('errors: the status and the host, no body; GitHub-style reset headers', async () => {
  const http = createHttp({ fetch: fakeServer(() => new Response('secret details', { status: 500 })).fetch });
  await assert.rejects(http.text('https://c.dev/x'), (e: unknown) => e instanceof HttpError && e.status === 500 && e.message === 'HTTP 500 from c.dev');
  const h = new Headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '2000' });
  assert.equal(retryAtOf(h, 0), 2_000_000);
  assert.equal(retryAtOf(new Headers({ 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' }), 0), Date.parse('Wed, 21 Oct 2026 07:28:00 GMT'));
  assert.equal(retryAtOf(new Headers(), 0), undefined);
});

import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createFormatters, DEFAULT_THEME, DEFAULT_WORKDAY, localize, validate, type Graphics, type Localized, type RenderContext, type WidgetDefinition } from '@kiosko/sdk';
import { formatValue, meets, toNumber, toneFor, valueText } from './json-format.ts';
import { leafPaths, MAX_PATH_RESULTS, parsePath, PathError, readPath } from './json-path.ts';
import { addPoint, fillTemplate, jsonList, jsonText, jsonValue, pick, requestJson, requestOf, rowsOf } from './json.ts';
import { push, viewOf } from './push.ts';
import { PUSH_LIMITS, PushStore, type PushData } from './push-store.ts';

/* Paths. */

const doc = { current: { temperature_2m: 7.3, 'wind speed': 12 }, items: [{ name: 'a', price: 1 }, { name: 'b', price: 2.5 }], empty: [], 'a.b': 'dotted' };

test('paths: keys, indexes (negative too), quoted keys, wildcards, $ optional', () => {
  assert.equal(readPath(doc, '$.current.temperature_2m').value, 7.3);
  assert.equal(readPath(doc, 'current.temperature_2m').value, 7.3);
  assert.equal(readPath(doc, "$.current['wind speed']").value, 12);
  assert.equal(readPath(doc, '$["a.b"]').value, 'dotted');
  assert.equal(readPath(doc, 'items[1].price').value, 2.5);
  assert.equal(readPath(doc, 'items[-1].name').value, 'b');
  assert.deepEqual(readPath(doc, '$.items[*].name').value, ['a', 'b']);
  assert.deepEqual(readPath(doc, '$.current.*').value, [7.3, 12]);
  assert.equal(readPath(doc, 'items.length').value, 2);
  assert.deepEqual(readPath(doc, '$'), { found: true, value: doc });
  assert.deepEqual(readPath('plain text', '$'), { found: true, value: 'plain text' });
  assert.equal(readPath(doc, 'items[5]').found, false);
  assert.equal(readPath(doc, 'nope.deeper').found, false);
  assert.equal(readPath(doc, 'empty[*]').found, false);
  assert.equal(readPath(null, 'a').found, false);
});

test('paths: hostile input finds nothing it should not, and malformed paths say where', () => {
  // Only own keys: nothing of the prototype chain.
  for (const p of ['constructor', '__proto__', 'items.map', 'current.toString', 'current.hasOwnProperty', "['constructor']['prototype']", 'items[0].__proto__.polluted']) assert.equal(readPath(doc, p).found, false, p);
  // A JSON that has them as real keys reads them as data (and pollutes nothing).
  const sneaky = JSON.parse('{"__proto__": {"polluted": 1}, "constructor": "c"}');
  assert.deepEqual(readPath(sneaky, '__proto__').value, { polluted: 1 });
  assert.equal(readPath(sneaky, 'constructor').value, 'c');
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  // No code runs: these are just keys that aren't there, or errors.
  for (const p of ['items[?(@.price>1)]', '$..name', 'a[', 'a]', "a['x", 'a.', '$x', 'items[1:2]', 'a b', '(process.exit())', 'a[0x10]']) assert.throws(() => parsePath(p), PathError, p);
  // Size limits.
  assert.throws(() => parsePath('a'.repeat(301)), /longer than 300/);
  assert.throws(() => parsePath(Array.from({ length: 40 }, () => 'a').join('.')), /more than 32 steps/);
  const wide = { xs: Array.from({ length: 2000 }, (_, i) => ({ ys: [i, i] })) };
  assert.equal((readPath(wide, 'xs[*].ys[*]').value as unknown[]).length, MAX_PATH_RESULTS);
  // Deep documents don't overflow anything: the path is what's walked.
  let deep: unknown = 1;
  for (let i = 0; i < 10_000; i++) deep = { a: deep };
  assert.equal(readPath(deep, 'a.a.a').found, true);
  assert.ok(leafPaths(deep).length >= 1);
});

test('leafPaths: what to suggest when a path finds nothing', () => {
  assert.deepEqual(leafPaths(doc, 4).map((l) => l.path), ['$.current.temperature_2m', "$.current['wind speed']", '$.items[0].name', '$.items[0].price']);
  const p = pick(doc, 'current.temp');
  assert.equal(p.found, false);
  assert.match(p.hints![0]!, /^\$\.current\.temperature_2m = 7\.3$/);
  assert.match(pick(doc, 'a[').error!, /not closed|expected/);
});

/* Formatting and thresholds. */

test('formatting: decimals in the user\'s way of writing numbers, units, prefixes, nothing as —', () => {
  const f = { decimals: 1, prefix: '', unit: '°C', locale: 'en' };
  assert.equal(formatValue(21.456, f), '21.5°C');
  assert.equal(formatValue(21.456, { ...f, locale: 'es' }), '21,5°C');
  assert.equal(formatValue(1234.5, { decimals: 2, prefix: '$', unit: '', locale: 'en' }), '$1,234.50');
  assert.equal(formatValue(50, { decimals: -1, prefix: '', unit: '%', locale: 'en' }), '50%');
  assert.equal(formatValue(12.6, { decimals: -1, prefix: '', unit: 'km/h', locale: 'en' }), '12.6 km/h');
  assert.equal(formatValue('21.25', { decimals: 1, prefix: '', unit: '', locale: 'en' }), '21.3', 'numeric text with decimals set is a number');
  assert.equal(formatValue(null, f), '—');
  assert.equal(valueText({ a: [1, 2] }, { decimals: -1, locale: 'en' }), '{"a":[1,2]}');
  assert.equal(valueText('x'.repeat(500), { decimals: -1, locale: 'en' }).length, 200);
  assert.equal(valueText(1 / 3, { decimals: -1, locale: 'en' }), '0.33');
  assert.equal(toNumber(' 3 '), 3);
  assert.equal(toNumber('3 apples'), undefined);
  assert.equal(toNumber(Infinity), undefined);
});

test('thresholds: comparisons, a bare number is >=, texts ignore case, first match wins', () => {
  assert.ok(meets(30, '>= 30'));
  assert.ok(!meets(30, '> 30'));
  assert.ok(meets(-1, '<0'));
  assert.ok(meets('31', '30'));
  assert.ok(meets('FAILED', '= failed'));
  assert.ok(meets('ok', '!= failed'));
  assert.ok(!meets('warm', '> 20'), 'text never compares as a number');
  assert.ok(meets(5, '= 5.0'));
  const rules = [{ when: '>= 30', tone: 'alert' as const }, { when: '>= 25', tone: 'warn' as const }, { when: '', tone: 'ok' as const }];
  assert.equal(toneFor(31, rules), 'alert');
  assert.equal(toneFor(26, rules), 'warn');
  assert.equal(toneFor(20, rules), undefined, 'an empty rule never holds');
});

test('templates and lists', () => {
  assert.equal(fillTemplate('Now {$.current.temperature_2m} · {items[*].name} · {{x}} · {nope}', doc, { decimals: -1, locale: 'en' }), 'Now 7.3 · a, b · {x} · —');
  assert.equal(fillTemplate('{a[}', doc, { decimals: -1, locale: 'en' }), '{a[}', 'a bad path is left as written');
  assert.deepEqual(rowsOf(doc, { items: 'items', itemLabel: 'name', itemValue: 'price', fields: [] }).rows, [{ label: 'a', value: 1 }, { label: 'b', value: 2.5 }]);
  assert.deepEqual(rowsOf(doc, { items: 'current', itemLabel: 'key', itemValue: 'value', fields: [] }).rows?.map((r) => r.label), ['temperature_2m', 'wind speed']);
  assert.deepEqual(rowsOf(doc, { items: '', itemLabel: '', itemValue: '', fields: [{ label: 'T', select: '$.current.temperature_2m', unit: '°C' }] }).rows, [{ label: 'T', value: 7.3, unit: '°C' }]);
  assert.ok(rowsOf(doc, { items: 'missing', itemLabel: '', itemValue: '', fields: [] }).hints!.length > 0);
});

/* The request. */

test('requestOf: the secret goes in its header, or where {secret} is', () => {
  const base = { url: 'https://api.x.dev/v1', push: '', secret: 'Bearer s3cr3t', authHeader: 'Authorization', headers: {}, method: 'GET' as const, body: '', timeoutMs: 1000, maxKb: 10 };
  assert.deepEqual(requestOf(base).headers, { Authorization: 'Bearer s3cr3t' });
  const inUrl = requestOf({ ...base, secret: 'a&b', url: 'https://api.x.dev/v1?key={secret}' });
  assert.equal(inUrl.url, 'https://api.x.dev/v1?key=a%26b');
  assert.deepEqual(inUrl.headers, {}, 'placed in the URL: not also in a header');
  const post = requestOf({ ...base, method: 'POST', body: '{"k":"{secret}"}', authHeader: '' });
  assert.equal(post.body, '{"k":"Bearer s3cr3t"}');
  assert.equal(post.headers['Content-Type'], 'application/json');
  assert.equal(requestOf({ ...base, body: 'ignored' }).body, undefined, 'GET sends no body');
});

test('requestJson: polls a real server with the secret, refuses big answers, gives up on slow ones, reads text', async (t) => {
  const seen: IncomingMessage[] = [];
  const srv = createServer((req, res) => {
    seen.push(req);
    if (req.url === '/big') return void res.end(JSON.stringify({ x: 'y'.repeat(4096) }));
    if (req.url === '/slow') return void setTimeout(() => res.end('{}'), 3000).unref();
    if (req.url === '/text') return void res.end('all good\n');
    if (req.url === '/500') {
      res.statusCode = 500;
      return void res.end('oops');
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ current: { temperature_2m: 21.4 }, auth: req.headers.authorization ?? null }));
  });
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
  t.after(() => {
    srv.closeAllConnections();
    srv.close();
  });
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const o = { url: `${base}/data`, push: '', secret: 'Bearer abc', authHeader: 'Authorization', headers: { 'X-Extra': '1' }, method: 'GET' as const, body: '', timeoutMs: 1000, maxKb: 1 };
  const signal = new AbortController().signal;
  const got = (await requestJson(o, signal)) as { current: { temperature_2m: number }; auth: string };
  assert.equal(got.current.temperature_2m, 21.4);
  assert.equal(got.auth, 'Bearer abc');
  assert.match(String(seen[0]!.headers['user-agent']), /^kiosko-core Kiosko \(\+https:\/\/kioskolcd\.dev\)$/);
  assert.equal(seen[0]!.headers['x-extra'], '1');
  // Asked again at once: the same answer, one request.
  await requestJson(o, signal);
  assert.equal(seen.length, 1);
  await assert.rejects(requestJson({ ...o, url: `${base}/big` }, signal), /larger than 1024 bytes/);
  await assert.rejects(requestJson({ ...o, url: `${base}/slow` }, signal), (e: unknown) => e instanceof Error && /TimeoutError|aborted|timeout/i.test(`${e.name} ${e.message}`));
  await assert.rejects(requestJson({ ...o, url: `${base}/500` }, signal), /HTTP 500/);
  assert.equal(await requestJson({ ...o, url: `${base}/text` }, signal), 'all good');
  await assert.rejects(requestJson({ ...o, url: 'file:///etc/passwd' }, signal), /must start with http/);
});

test('core/json fetch: the value, and its history kept across instances in the cache folder', async (t) => {
  let temp = 20;
  const srv = createServer((_req, res) => res.end(JSON.stringify({ t: temp++ })));
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
  const cacheDir = mkdtempSync(join(tmpdir(), 'kiosko-json-'));
  t.after(() => {
    srv.closeAllConnections();
    srv.close();
    rmSync(cacheDir, { recursive: true, force: true });
  });
  const options = validate(jsonValue.options!, { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/`, select: '$.t' }).value;
  const ctx = { options, signal: new AbortController().signal, cacheDir } as Parameters<NonNullable<typeof jsonValue.fetch>>[0];
  const a = await jsonValue.fetch!(ctx);
  await new Promise((r) => setTimeout(r, 2100));
  const b = await jsonValue.fetch!(ctx);
  assert.deepEqual(a?.picked, { found: true, value: 20 });
  assert.deepEqual(b?.series.map((p) => p[1]), [20, 21]);
  assert.equal(await jsonValue.fetch!({ ...ctx, options: { ...options, push: 'garage' } }), null, 'a push name: nothing to ask');
  assert.deepEqual(addPoint([[0, 1]], 1000, 2, 10), [[1000, 2]], 'two points at the same moment are one');
  assert.equal(addPoint(Array.from({ length: 10 }, (_, i) => [i * 5000, i] as [number, number]), 60_000, 9, 5).length, 5);
});

/* Pushes. */

test('PushStore: names from the config, ttl, bounded history, dump and load', () => {
  const s = new PushStore();
  const seen: PushData[] = [];
  s.subscribe((d) => seen.push(d));
  s.configure(['backup', 'Bad Name', 'garage', 'backup']);
  assert.deepEqual(Object.keys(s.snapshot().hooks), ['backup', 'garage']);
  assert.throws(() => s.set('attic', {}), /unknown push name/);
  const e = s.set('backup', { value: 'OK', ttlMs: 1000 }, 5000);
  assert.equal(e.expiresAt, 6000);
  assert.equal(s.set('backup', { ttlMs: 1e15 }, 0).expiresAt, PUSH_LIMITS.maxTtlMs, 'ttl capped');
  for (let i = 0; i < 300; i++) s.set('garage', { t: i }, i);
  assert.equal(s.get('garage')!.history.length, PUSH_LIMITS.historyItems);
  assert.deepEqual(s.get('garage')!.history.at(-1)!.payload, { t: 299 });
  for (let i = 0; i < 5; i++) s.set('garage', { blob: 'x'.repeat(30_000) }, 1000 + i);
  assert.ok(JSON.stringify(s.get('garage')!.history).length < PUSH_LIMITS.historyBytes + 1000);
  const copy = new PushStore();
  copy.configure(['garage']);
  copy.load(JSON.parse(JSON.stringify(s.dump())));
  assert.deepEqual(copy.get('garage')?.payload, s.get('garage')?.payload);
  assert.equal(copy.get('backup'), undefined, 'not set up there');
  s.configure(['garage']);
  assert.equal(s.get('backup'), undefined, 'a name taken away forgets its payloads');
  assert.ok(seen.length > 5);
});

/** A context whose canvas and kit record the text drawn and its colour. */
function recorder(widget: WidgetDefinition<any, any>, options: Record<string, unknown>, o: { data?: unknown; sources?: Record<string, unknown>; now?: number } = {}) {
  const texts: string[] = [];
  const colors: string[] = [];
  const state: Record<string, unknown> = {};
  const g = new Proxy(state, {
    get: (target, k) => (k === 'measureText' ? () => ({ width: 10 }) : k === 'fillText' ? (s: string) => (texts.push(s), colors.push(String(state.fillStyle))) : k in target ? target[k as string] : () => undefined),
    set: (target, k, v) => ((target[k as string] = v), true),
  }) as unknown as Graphics;
  const kit = { truncate: (_g: unknown, s: string) => s, measureTracked: () => 10, drawTracked: (_g: unknown, s: string, _x: number, _y: number, f: { color?: string }) => (texts.push(s), colors.push(f.color ?? ''), 10), wrapLines: (_g: unknown, s: string) => [s], css: () => 'rgba(0,0,0,0)', hex: () => [0, 0, 0] };
  const now = o.now ?? Date.now();
  const ctx = {
    box: { x: 0, y: 0, w: 400, h: 200 },
    options: validate(widget.options!, options).value,
    theme: DEFAULT_THEME,
    fonts: DEFAULT_THEME.fonts,
    kit,
    locale: 'en',
    now,
    t: (x: Localized) => localize(x, 'en'),
    fmt: createFormatters({ locale: 'en', timeFormat: 'auto', now }),
    workday: DEFAULT_WORKDAY,
    data: o.data,
    sources: o.sources ?? {},
  } as unknown as RenderContext<never, never>;
  return { g, ctx, texts, colors, state: ctx as unknown as { options: never; sources: Record<string, unknown>; now: number; data: unknown; workday: never; working: boolean } };
}

test('a pushed payload reaches the widgets: Push, and the JSON ones by push name', () => {
  const now = 1_000_000;
  const store = new PushStore();
  store.configure(['garage', 'backup']);
  store.set('garage', { temp: 21.4, humidity: 48 }, now - 120_000);
  store.set('garage', { temp: 23.9, humidity: 47 }, now - 60_000);
  store.set('backup', { title: 'Backup', value: 'FAILED', text: 'disk full', level: 'alert', ttlMs: 3600_000 }, now - 60_000);
  const sources = { 'core/push': store.snapshot() };

  const v = recorder(jsonValue, { push: 'garage', select: '$.temp', unit: '°C', thresholds: [{ when: '> 23', tone: 'warn' }] }, { sources, now });
  jsonValue.render(v.g, v.ctx as never);
  const i = v.texts.indexOf('23.9');
  assert.ok(i >= 0, v.texts.join('|'));
  assert.equal(v.colors[i], DEFAULT_THEME.colors.warn);
  assert.ok(v.texts.includes('°C'));

  const l = recorder(jsonList, { push: 'garage', fields: [{ label: 'Hum', select: 'humidity', unit: '%' }] }, { sources, now });
  jsonList.render(l.g, l.ctx as never);
  assert.ok(l.texts.includes('47%') && l.texts.includes('Hum'), l.texts.join('|'));

  const tx = recorder(jsonText, { push: 'garage', template: 'Garage {temp} °C' }, { sources, now });
  jsonText.render(tx.g, tx.ctx as never);
  assert.ok(tx.texts.includes('Garage 23.9 °C'), tx.texts.join('|'));

  const p = recorder(push, { name: 'backup' }, { sources, now });
  push.render(p.g, p.ctx as never);
  assert.ok(p.texts.includes('FAILED') && p.texts.includes('disk full'), p.texts.join('|'));
  assert.equal(p.colors[p.texts.indexOf('FAILED')], DEFAULT_THEME.colors.alert);
  assert.equal(push.urgent!(p.state as never), true, 'level alert keeps the tile');
  assert.equal(push.visible!(p.state as never), true);
  assert.deepEqual(push.alerts!(p.state as never), [], 'only critical goes full-screen');
  // Run out: hidden, not urgent.
  const later = { ...p.state, now: now + 3600_000 };
  assert.equal(push.visible!(later as never), false);
  assert.equal(push.urgent!(later as never), false);
  // Critical: a full-screen alert too.
  store.set('backup', { title: 'Smoke', text: 'Kitchen', level: 'critical' }, now);
  const crit = { ...p.state, sources: { 'core/push': store.snapshot() } };
  const alerts = push.alerts!(crit as never);
  assert.equal(alerts.length, 1);
  assert.deepEqual([alerts[0]!.level, alerts[0]!.title, alerts[0]!.text], ['critical', 'Smoke', 'Kitchen']);
  // Nothing yet: shown, with how to send it.
  const wait = recorder(push, { name: 'attic' }, { sources, now });
  push.render(wait.g, wait.ctx as never);
  assert.ok(wait.texts.includes('POST /api/push/attic'));
});

test('viewOf: what the Push widget reads of a payload', () => {
  assert.deepEqual(viewOf('hello'), { text: 'hello' });
  assert.deepEqual(viewOf(42), { value: 42 });
  assert.deepEqual(viewOf({ message: 'm', level: 'WARN', value: 0 }), { value: 0, text: 'm', level: 'warn' });
  assert.deepEqual(viewOf({ level: 'loud' }), {});
  assert.deepEqual(viewOf([1, 2]), {});
});

test('every new widget renders its demo and an empty config without throwing', () => {
  for (const w of [jsonValue, jsonList, jsonText, push] as WidgetDefinition<any, any>[]) {
    const demo = w.demo!({ options: validate(w.options!, {}).value, now: Date.now(), locale: 'en' });
    const r = recorder(w, { ...(demo.options ?? {}) }, { data: demo.data, sources: demo.sources ?? {} });
    w.render(r.g, r.ctx as never);
    assert.ok(r.texts.length > 0, w.id);
    const empty = recorder(w, {});
    w.render(empty.g, empty.ctx as never);
    assert.ok(empty.texts.length > 0, `${w.id} empty`);
  }
});

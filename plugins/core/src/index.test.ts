import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFormatters, DEFAULT_THEME, DEFAULT_WORKDAY, localize, validate, type Graphics, type Localized, type RenderContext } from '@kiosko/sdk';
import { composeWidget, normalize, Registry } from '@kiosko/core';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import plugin, { clock, date, image, imageUrl, isoWeek, list, nextInFolder, parseItems, placeImage, text, wallClock } from './index.ts';

/** A context whose canvas and kit only record the text drawn. */
function recorder(widget: { options?: unknown }, options: Record<string, unknown>, o: { box?: RenderContext<unknown, unknown>['box']; locale?: string; timeFormat?: '24h' | '12h' | 'auto'; now?: number; data?: unknown } = {}) {
  const texts: string[] = [];
  const colors: string[] = [];
  const g = new Proxy({} as Record<string, unknown>, {
    get: (target, k) => (k === 'measureText' ? () => ({ width: 10 }) : k === 'fillText' ? (s: string) => texts.push(s) : k in target ? target[k as string] : () => undefined),
    set: (target, k, v) => ((target[k as string] = v), true),
  }) as unknown as Graphics;
  const kit = { truncate: (_g: unknown, s: string) => s, drawTracked: (_g: unknown, s: string, _x: number, _y: number, f: { color?: string }) => (texts.push(s), colors.push(f.color ?? ''), 10), wrapLines: (_g: unknown, s: string) => [s] };
  const locale = o.locale ?? 'en';
  const now = o.now ?? Date.now();
  const ctx = {
    box: o.box ?? { x: 0, y: 0, w: 400, h: 200 },
    options: validate((widget as { options: Parameters<typeof validate>[0] }).options, options).value,
    theme: DEFAULT_THEME,
    fonts: DEFAULT_THEME.fonts,
    kit,
    locale,
    now,
    t: (x: Localized) => localize(x, locale),
    fmt: createFormatters({ locale, timeFormat: o.timeFormat ?? 'auto', now }),
    workday: DEFAULT_WORKDAY,
    data: o.data,
  } as unknown as RenderContext<never, never>;
  return { g, ctx, texts, colors };
}

const six = 'one\ntwo\nthree\nfour\nfive\nsix';

test('parseItems: one per line, detail after "|", blank lines dropped', () => {
  assert.deepEqual(parseItems('a\n\n b | c | d \n|x'), [{ text: 'a', detail: '' }, { text: 'b', detail: 'c | d' }]);
});

test('list: rows = 0 fits everything it can, rows = N shows N and counts the rest', () => {
  const auto = recorder(list, { items: six });
  list.render(auto.g, auto.ctx as never);
  assert.deepEqual(auto.texts, ['one', 'two', 'three', 'four', 'five', 'six']);
  const three = recorder(list, { items: six, rows: 3 });
  list.render(three.g, three.ctx as never);
  assert.deepEqual(three.texts, ['one', 'two', 'three', '+3 more']);
  const es = recorder(list, { items: six, rows: 6 }, { box: { x: 0, y: 0, w: 400, h: 60 }, locale: 'es' });
  list.render(es.g, es.ctx as never);
  assert.equal(es.texts.at(-1), '+4 más', 'six rows of 10 px are too small: the ones that fit at the minimum');
});

test('list: the detailed layout adds the details; one-line leaves them out', () => {
  const items = 'Call the bank | before 14:00\nBuy coffee';
  const d = recorder(list, { items, layout: 'detailed' });
  list.render(d.g, d.ctx as never);
  assert.deepEqual(d.texts, ['Call the bank', 'before 14:00', 'Buy coffee']);
  const one = recorder(list, { items, layout: 'one-line' });
  list.render(one.g, one.ctx as never);
  assert.deepEqual(one.texts, ['Call the bank', 'Buy coffee']);
});

test('list: empty says so, and can be hidden by the user', () => {
  const r = recorder(list, { items: ' \n ' }, { locale: 'es' });
  list.render(r.g, r.ctx as never);
  assert.deepEqual(r.texts, ['Nada en la lista']);
  const state = { options: validate(list.options!, { items: '' }).value, data: undefined, sources: {}, now: 0, working: true, workday: DEFAULT_WORKDAY };
  assert.equal(list.empty!(state), true);
});

test('list: paints through the compositor in every mode, zoomed too', () => {
  const reg = new Registry();
  reg.add(plugin);
  const cfg = normalize({ locale: 'es' });
  for (const options of [{}, { rows: 3 }, { rows: 30 }, { layout: 'detailed' }, { layout: 'one-line', rows: 2 }, { items: '' }]) {
    for (const zoom of [0.5, 1, 1.5, 2]) {
      const r = composeWidget({ cfg, registry: reg, theme: DEFAULT_THEME, type: 'core/list', width: 360, height: 240, options, zoom, title: 'Lista' });
      assert.equal(r.tiles[0]!.error, undefined, `${JSON.stringify(options)} at ${zoom}`);
    }
  }
});

test('clock: follows the config time format unless it has its own', () => {
  const now = new Date(2026, 10, 10, 21, 5).getTime();
  const draw = (timeFormat: string, cfg: '24h' | '12h') => {
    const r = recorder(clock, { timeFormat, showDate: false, showSeconds: true }, { now, timeFormat: cfg, locale: 'en-GB' });
    clock.render(r.g, r.ctx as never);
    return r.texts[0];
  };
  assert.equal(draw('inherit', '24h'), '21:05:00');
  assert.equal(draw('inherit', '12h'), '9:05:00');
  assert.equal(draw('24h', '12h'), '21:05:00');
  assert.equal(draw('12h', '24h'), '9:05:00');
});

test('clock: another time zone, and the date in three formats', () => {
  const now = Date.UTC(2026, 10, 10, 21, 5);
  const draw = (options: Record<string, unknown>) => {
    const r = recorder(clock, { timeFormat: '24h', ...options }, { now, locale: 'es' });
    clock.render(r.g, r.ctx as never);
    return r.texts;
  };
  assert.equal(draw({ timeZone: 'Asia/Tokyo', showDate: false })[0], '06:05', 'Tokyo is UTC+9, already the 11th');
  assert.equal(draw({ timeZone: 'America/New_York', showDate: false })[0], '16:05');
  assert.equal(draw({ timeZone: 'Mars/Olympus', showDate: false })[0], draw({ showDate: false })[0], 'an unknown zone is the local one');
  assert.match(draw({ timeZone: 'Asia/Tokyo', dateFormat: 'long' })[1]!, /^miércoles, 11 de noviembre$/);
  assert.match(draw({ timeZone: 'Asia/Tokyo', dateFormat: 'short' })[1]!, /^mié,? 11 nov/);
  assert.equal(draw({ timeZone: 'Asia/Tokyo', dateFormat: 'numeric' })[1], '11/11/2026');
  assert.equal(wallClock(now, ''), now);
});

test('date: the weekday is not red unless asked; the week label follows the language', () => {
  const now = new Date(2026, 10, 10, 12).getTime();
  const draw = (options: Record<string, unknown>, locale = 'en') => {
    const r = recorder(date, options, { now, locale });
    date.render(r.g, r.ctx as never);
    return r;
  };
  assert.equal(draw({}).colors[0], DEFAULT_THEME.colors.accent);
  assert.equal(draw({ weekdayColor: 'alert' }).colors[0], DEFAULT_THEME.colors.alert);
  assert.equal(isoWeek(new Date(2026, 10, 10)), 46);
  assert.equal(isoWeek(new Date(2027, 0, 1)), 53, '1 January 2027 is a Friday: still week 53 of 2026');
  const es = draw({}, 'es-ES');
  assert.ok(es.texts.includes('noviembre · sem 46'), es.texts.join('|'));
  assert.ok(draw({ showWeekNumber: false }).texts.includes('November'));
});

test('text: a file wins over the text once read; empty when both are', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'core-text-'));
  try {
    const file = join(dir, 'status.txt');
    writeFileSync(file, 'On call: Ana\n\n');
    const options = validate(text.options!, { file, text: 'no status' }).value;
    const ctx = { options, signal: new AbortController().signal } as never;
    const data = await text.fetch!(ctx);
    assert.deepEqual(data, { text: 'On call: Ana' });
    const before = recorder(text, { file, text: 'no status' });
    text.render(before.g, before.ctx as never);
    assert.deepEqual(before.texts, ['no status'], 'until the file is read');
    const after = recorder(text, { file, text: 'no status' }, { data });
    text.render(after.g, after.ctx as never);
    assert.deepEqual(after.texts, ['On call: Ana']);
    const state = (o: Record<string, unknown>, d?: unknown) => ({ options: validate(text.options!, o).value, data: d, sources: {}, now: 0, working: true }) as never;
    assert.equal(text.empty!(state({ file, text: 'x' }, { text: '' })), true);
    assert.equal(text.empty!(state({ text: 'Hello' })), false);
    assert.deepEqual(await text.fetch!({ options: validate(text.options!, { text: 'x' }).value, signal: new AbortController().signal } as never), { text: null });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('image: a folder goes round its pictures; position decides what cover keeps', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'core-image-'));
  try {
    for (const f of ['b.png', 'a.jpg', 'notes.txt']) writeFileSync(join(dir, f), '');
    const seen = [await nextInFolder(dir), await nextInFolder(dir), await nextInFolder(dir)];
    assert.deepEqual(seen, [join(dir, 'a.jpg'), join(dir, 'b.png'), join(dir, 'a.jpg')]);
    assert.equal(await nextInFolder(mkdtempSync(join(tmpdir(), 'core-image-empty-'))), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const box = { x: 0, y: 0, w: 400, h: 200 };
  assert.deepEqual(placeImage(box, 400, 400, 'cover', 'center'), { x: 0, y: -100, w: 400, h: 400 });
  assert.deepEqual(placeImage(box, 400, 400, 'cover', 'top'), { x: 0, y: 0, w: 400, h: 400 });
  assert.deepEqual(placeImage(box, 400, 400, 'cover', 'bottom'), { x: 0, y: -200, w: 400, h: 400 });
  assert.deepEqual(placeImage(box, 400, 400, 'contain', 'left'), { x: 0, y: 0, w: 200, h: 200 });
  const r = recorder(image, {}, { locale: 'es' });
  image.render(r.g, r.ctx as never);
  assert.deepEqual(r.texts, ['Sin imagen']);
});

test('image: webcam URLs get the time, so no cache answers them', () => {
  const now = 1794311987430;
  const cam = 'https://etraffic.dgt.es/camarasEtraffic/1228.jpg';
  assert.equal(imageUrl(cam, now), cam);
  assert.equal(imageUrl(cam, now, true), `${cam}?t=${now}`);
  assert.equal(imageUrl(`${cam}?size=big`, now, true), `${cam}?size=big&t=${now}`);
  assert.equal(imageUrl(`${cam}?ts={unix}`, now), `${cam}?ts=1794311987`);
  // A URL with its own placeholder is left as written, even with the switch on.
  assert.equal(imageUrl(`${cam}?_={now}`, now, true), `${cam}?_=${now}`);
});

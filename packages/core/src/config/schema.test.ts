import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { GridSpec } from '../layout/grid.ts';
import { validateConfig } from './check.ts';
import { plugins } from './fixtures.test.ts';
import { validateJson } from './jsonschema.ts';
import { CONFIG_SCHEMA_ID, type Config, type InterludeSlot, type Page, type Screen, type Tile, type WidgetInstance } from './model.ts';
import { normalize } from './normalize.ts';
import { configSchema } from './schema.ts';
import { saveConfig } from './store.ts';

type S = Record<string, any>;
const schema = configSchema(plugins) as S;
const keysOf = (s: S) => Object.keys(s.properties).sort();
const branch = (union: S, tag: string) => union.oneOf.find((b: S) => (b.properties.type ?? b.properties.driver).const === tag);

// The keys of each type, checked by the compiler: adding a field to model.ts
// without listing it here fails `npm run check`; the test below then fails
// until the schema describes it too.
const CONFIG_KEYS = { $schema: 1, version: 1, locale: 1, timeFormat: 1, theme: 1, location: 1, workday: 1, sources: 1, plugins: 1, screens: 1, server: 1 } satisfies Record<keyof Config, 1>;
const SCREEN_KEYS = { id: 1, name: 1, enabled: 1, width: 1, height: 1, rotate: 1, device: 1, pages: 1, pinnedPage: 1, interludes: 1, pixelShift: 1, sleepWhenIdle: 1, jpegQuality: 1, maxFps: 1 } satisfies Record<keyof Screen, 1>;
const PAGE_KEYS = { id: 1, name: 1, enabled: 1, durationMs: 1, when: 1, grid: 1, gravity: 1, background: 1, tiles: 1 } satisfies Record<keyof Page, 1>;
const TILE_KEYS = { id: 1, x: 1, y: 1, w: 1, h: 1, locked: 1, widgets: 1, rotateMs: 1, chrome: 1 } satisfies Record<keyof Tile, 1>;
const WIDGET_KEYS = { id: 1, type: 1, title: 1, options: 1, intervalMs: 1, when: 1, disabled: 1, zoom: 1, takeOver: 1, hideWhenEmpty: 1 } satisfies Record<keyof WidgetInstance, 1>;
const INTERLUDE_KEYS = { id: 1, type: 1, enabled: 1, everyMs: 1, maxSeconds: 1, options: 1 } satisfies Record<keyof InterludeSlot, 1>;
const GRID_KEYS = { cols: 1, rows: 1, gap: 1, padding: 1 } satisfies Record<keyof GridSpec, 1>;

/** Every field set, none to its default: normalize must give it back unchanged. */
const FULL: Config = {
  $schema: CONFIG_SCHEMA_ID,
  version: 1,
  locale: 'en',
  timeFormat: '12h',
  theme: 'paper',
  location: { latitude: 40.4, longitude: -3.7, name: 'Madrid' },
  workday: { days: [1, 2, 3, 4], start: '08:00', end: '15:30', hours: 7, holidays: ['2026-12-25'], byDay: { '4': { end: '14:00', hours: 6 } } },
  sources: { 'demo/remote': { host: 'example.org', intervalMs: 120_000, timeoutMs: 20_000 } },
  plugins: { disabled: ['demo'] },
  server: { host: '127.0.0.1', port: 7421 },
  screens: [
    {
      id: 's1',
      name: 'Main',
      enabled: false,
      width: 1280,
      height: 480,
      rotate: 180,
      device: { driver: 'trcc', url: 'http://127.0.0.1:8099', tokenFile: '~/token', deviceKey: 'k1', serial: 'ABC', keepalive: false },
      pages: [
        {
          id: 'p1',
          name: 'Home',
          enabled: false,
          durationMs: 60_000,
          when: 'work',
          grid: { cols: 16, rows: 6, gap: 8, padding: 8 },
          gravity: 'left',
          background: { color: '#101010', image: '/tmp/bg.png' },
          tiles: [{ id: 't1', x: 1, y: 1, w: 6, h: 3, locked: true, rotateMs: 20_000, chrome: 'card', widgets: [
            { id: 'w1', type: 'demo/clock', title: 'Clock', options: { format: '12h' }, intervalMs: 60_000, when: 'off', disabled: true, zoom: 1.2 },
            { id: 'w2', type: 'demo/list', options: { rows: 4, layout: 'detailed', projects: ['acme/*', '!*-old'] }, zoom: 0.8, takeOver: true, hideWhenEmpty: false },
          ] }],
        },
      ],
      pinnedPage: 'p1',
      interludes: [{ id: 'i1', type: 'demo/blink', enabled: false, everyMs: 30 * 60_000, maxSeconds: 20, options: { color: '#ff0000' } }],
      pixelShift: { enabled: false, amplitude: 1, periodMs: 60_000 },
      sleepWhenIdle: true,
      jpegQuality: 80,
      maxFps: 10,
    },
  ],
};

test('config schema: identity, tagged unions and plugin options', () => {
  assert.equal(schema.$id, CONFIG_SCHEMA_ID);
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  const clock = branch(schema.$defs.widget, 'demo/clock');
  assert.equal(clock.title, 'Clock (demo/clock)');
  assert.match(clock.description, /A clock\. Needs a tile of at least 200×100 px, looks best around 400×200 px\./);
  assert.deepEqual(clock['x-size'], { min: { w: 200, h: 100 }, preferred: { w: 400, h: 200 } });
  assert.deepEqual(clock.properties.options.properties.format.enum, ['24h', '12h']);
  assert.equal(clock.additionalProperties, false);
  const feed = branch(schema.$defs.widget, 'demo/feed');
  assert.deepEqual(feed['x-sources'], ['demo/remote']);
  assert.equal(feed.properties.options.properties.cmd['x-risk'], 'exec');
  assert.equal(feed.properties.options.properties.token['x-secret'], true);
  assert.match(feed.properties.options.properties.token.description, /leave it empty/);
  const remote = schema.properties.sources.properties['demo/remote'];
  assert.match(remote.description, /Used by demo\/feed/);
  assert.equal(remote.properties.urls.items['x-risk'], 'network');
  assert.equal(branch(schema.$defs.interlude, 'demo/blink').properties.options.properties.color.type, 'string');
  assert.equal(branch(schema.$defs.device, 'trcc').properties.url['x-risk'], 'network');
});

test('config schema stays in sync with the types and with normalize', () => {
  const d = schema.$defs;
  const keys = (o: object) => Object.keys(o).sort();
  assert.deepEqual(keysOf(schema), keys(CONFIG_KEYS));
  assert.deepEqual(keysOf(d.screen), keys(SCREEN_KEYS));
  assert.deepEqual(keysOf(d.page), keys(PAGE_KEYS));
  assert.deepEqual(keysOf(d.tile), keys(TILE_KEYS));
  assert.deepEqual(keysOf(branch(d.widget, 'demo/list')), keys(WIDGET_KEYS));
  // The switches only where the widget has the hooks behind them.
  assert.deepEqual(keysOf(branch(d.widget, 'demo/clock')), keys(WIDGET_KEYS).filter((k) => k !== 'takeOver' && k !== 'hideWhenEmpty'));
  assert.deepEqual(keysOf(branch(d.interlude, 'demo/blink')), keys(INTERLUDE_KEYS));
  assert.deepEqual(keysOf(d.grid), keys(GRID_KEYS));
  // Every described field survives normalize, and normalize adds nothing undescribed.
  assert.deepEqual(validateJson(schema, FULL), []);
  assert.deepEqual(normalize(FULL), FULL);
  // What normalize makes of nothing, or of a sparse hand-written file, is valid too.
  assert.deepEqual(validateJson(schema, normalize({})), []);
  const sparse = { screens: [{ pages: [{ tiles: [{ widgets: [{ type: 'demo/clock' }] }] }], interludes: [{ type: 'demo/blink' }] }] };
  assert.deepEqual(validateJson(schema, sparse), []);
  assert.deepEqual(validateJson(schema, normalize(sparse)), []);
});

test('normalize keeps $schema and saveConfig writes it first', () => {
  assert.equal(normalize({ $schema: './mine.json' }).$schema, './mine.json');
  assert.equal(normalize({}).$schema, undefined);
  const dir = mkdtempSync(join(tmpdir(), 'kiosko-schema-'));
  try {
    const file = join(dir, 'config.json');
    saveConfig(normalize({}), file);
    const text = readFileSync(file, 'utf8');
    assert.match(text, /^\{\n {2}"\$schema": "https:\/\/kioskolcd\.dev\/schema\/v1\/config\.json",\n {2}"version": 1,/);
    saveConfig(normalize({ $schema: './mine.json', theme: 'paper' }), file);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).$schema, './mine.json');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('normalize gives widgets without ids ids that are unique across pages', () => {
  const cfg = normalize({ screens: [{ pages: [{ tiles: [{ widgets: [{ type: 'demo/clock' }] }] }, { tiles: [{ widgets: [{ type: 'demo/clock' }] }] }] }] });
  const ids = cfg.screens[0]!.pages.map((p) => p.tiles[0]!.widgets[0]!.id);
  assert.notEqual(ids[0], ids[1]);
});

const tileWith = (widget: object, extra: object = {}) => ({ screens: [{ id: 's', pages: [{ id: 'p', tiles: [{ id: 't', x: 0, y: 0, w: 6, h: 3, widgets: [widget], ...extra }] }] }] });

test('an invalid widget option is a readable error with its JSON path', () => {
  const r = validateConfig(tileWith({ id: 'w', type: 'demo/clock', options: { format: '25h' } }), plugins);
  assert.equal(r.errors.length, 1);
  const [e] = r.errors;
  assert.equal(e!.path, 'screens[0].pages[0].tiles[0].widgets[0].options.format');
  assert.equal(e!.pointer, '/screens/0/pages/0/tiles/0/widgets/0/options/format');
  assert.equal(e!.context, 'demo/clock');
  assert.equal(e!.message, 'must be one of "24h", "12h"; got the text "25h" (did you mean "24h"?)');
  const wrongType = validateConfig(tileWith({ type: 'demo/clock', options: { seconds: 'yes' } }), plugins).errors[0]!;
  assert.equal(wrongType.message, 'must be true or false; got the text "yes"');
});

test('typos get a "did you mean", in types, properties and option names', () => {
  const type = validateConfig(tileWith({ type: 'demo/clok' }), plugins).errors;
  assert.deepEqual(
    type.map((e) => [e.path, e.message]),
    [['screens[0].pages[0].tiles[0].widgets[0].type', 'unknown type "demo/clok" (did you mean "demo/clock"?)']],
  );
  const plugin = validateConfig(tileWith({ type: 'nope/clock' }), plugins).errors[0]!;
  assert.match(plugin.message, /no installed plugin is called "nope"\. Installed: demo/);
  const prop = validateConfig({ screens: [{ pages: [{ tile: [] }] }] }, plugins).errors[0]!;
  assert.equal(prop.path, 'screens[0].pages[0].tile');
  assert.match(prop.message, /^is not a known property here \(did you mean "tiles"\?\)\. Allowed: id, name/);
  const opt = validateConfig(tileWith({ type: 'demo/clock', options: { secconds: true } }), plugins);
  assert.equal(opt.errors.length, 0);
  assert.match(opt.warnings[0]!.message, /is not an option of demo\/clock \(did you mean "seconds"\?\), so it is ignored/);
  const required = validateConfig({ screens: [{ device: { driver: 'trcc' } }] }, plugins).errors[0]!;
  assert.deepEqual([required.path, required.message, required.context], ['screens[0].device.url', 'is required but missing', 'trcc']);
});

test('what only normalize reveals: grid bounds, overlaps, repeated ids, sizes', () => {
  const cfg = {
    screens: [
      {
        width: 1920,
        height: 462,
        pinnedPage: 'nope',
        pages: [
          {
            grid: { cols: 24, rows: 6, gap: 10, padding: 10 },
            tiles: [
              { x: 20, y: 0, w: 6, h: 2, widgets: [{ id: 'a', type: 'demo/clock' }] },
              { x: 0, y: 0, w: 4, h: 4, widgets: [{ id: 'a', type: 'demo/clock' }] },
              { x: 2, y: 2, w: 1, h: 1, widgets: [{ id: 'b', type: 'demo/clock' }] },
            ],
          },
        ],
      },
    ],
  };
  const r = validateConfig(cfg, plugins);
  assert.deepEqual(
    r.errors.map((e) => e.path),
    ['screens[0].pinnedPage', 'screens[0].pages[0].tiles[0]', 'screens[0].pages[0].tiles[1].widgets[0].id'],
  );
  assert.match(r.errors[1]!.message, /does not fit the 24×6 grid: x \+ w = 26 but the grid has 24 columns/);
  assert.match(r.errors[2]!.message, /repeats the id "a" of screens\[0\]\.pages\[0\]\.tiles\[0\]\.widgets\[0\]/);
  assert.ok(r.warnings.some((w) => w.path === 'screens[0].pages[0].tiles[1]' && /overlaps screens\[0\]\.pages\[0\]\.tiles\[2\]/.test(w.message)));
  assert.ok(r.warnings.some((w) => w.path === 'screens[0].pages[0].tiles[2]' && /needs at least 200×100 px: make it at least 3×2 cells/.test(w.message)));
});

test('sources and plugins: unknown ones are warnings', () => {
  const r = validateConfig({ sources: { 'demo/remot': {}, 'demo/remote': { hots: 'x' } }, plugins: { disabled: ['dmeo'] } }, plugins);
  assert.equal(r.errors.length, 0);
  assert.deepEqual(
    r.warnings.map((w) => w.path),
    ['sources["demo/remot"]', 'sources["demo/remote"].hots', 'plugins.disabled[0]'],
  );
  assert.match(r.warnings[0]!.message, /did you mean "demo\/remote"/);
});

test('garbage never throws', () => {
  for (const raw of [null, 3, 'x', [], { screens: 'x' }, { screens: [{ pages: {} }] }, { screens: [{ pages: [{ tiles: [{ widgets: 'x' }] }] }] }]) {
    const r = validateConfig(raw, plugins);
    assert.ok(r.errors.length > 0, JSON.stringify(raw));
  }
});

test('shared settings: time format, zoom, the widget switches and source timing', () => {
  assert.deepEqual(schema.properties.timeFormat.enum, ['auto', '24h', '12h']);
  assert.equal(schema.properties.timeFormat['x-ui'].labels['24h'].es, '24 horas');
  assert.deepEqual(Object.keys(schema.properties.workday.properties), ['days', 'start', 'end', 'hours', 'holidays', 'byDay']);
  const list = branch(schema.$defs.widget, 'demo/list');
  assert.equal(list.properties.zoom.$ref, '#/$defs/zoom');
  assert.deepEqual([schema.$defs.zoom.minimum, schema.$defs.zoom.maximum, schema.$defs.zoom['x-ui'].step], [0.5, 2, 0.1]);
  assert.equal(list.properties.takeOver.default, false, 'the widget declares takeOver: false');
  assert.equal(list.properties.hideWhenEmpty.default, false);
  assert.equal(list.properties.takeOver['x-ui'].label.es, 'Quedarse la tesela mientras sea urgente');
  assert.equal(list.properties.options.properties.projects['x-filter'], true);
  assert.deepEqual(list.properties.options.properties.layout.enum, ['auto', 'one-line', 'detailed']);
  // A polled source gets intervalMs (with its floor) and timeoutMs; a push-only one doesn't.
  const remote = schema.properties.sources.properties['demo/remote'];
  assert.deepEqual([remote.properties.intervalMs.default, remote.properties.intervalMs.minimum], [60_000, 30_000]);
  assert.equal(remote.properties.intervalMs['x-ui'].unit, 'ms');
  assert.equal(remote.properties.timeoutMs['x-ui'].advanced, true);
  assert.equal(schema.properties.sources.properties['demo/push'].properties, undefined);
  const r = validateConfig({ sources: { 'demo/remote': { intervalMs: 1000, timeoutMs: 5000 } } }, plugins);
  assert.deepEqual(r.warnings, []);
  assert.match(r.errors[0]!.message, /at least 30000/);
  const z = validateConfig(tileWith({ type: 'demo/clock', zoom: 3, takeOver: false }), plugins).errors.map((e) => e.path);
  assert.deepEqual(z, ['screens[0].pages[0].tiles[0].widgets[0].zoom', 'screens[0].pages[0].tiles[0].widgets[0].takeOver']);
});

test('the minimum size of a zoomed widget grows with its zoom', () => {
  const at = (zoom: number) => validateConfig({ screens: [{ width: 1920, height: 462, pages: [{ grid: { cols: 24, rows: 6, gap: 10, padding: 10 }, tiles: [{ x: 0, y: 0, w: 3, h: 2, widgets: [{ type: 'demo/clock', zoom }] }] }] }] }, plugins).warnings;
  assert.deepEqual(at(1), []);
  assert.match(at(1.5)[0]!.message, /needs at least 300×150 px at zoom 1\.5/);
});

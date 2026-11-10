/**
 * The JSON Schema of config.json (draft 2020-12), published at
 * `CONFIG_SCHEMA_ID` and printed by `kiosko config schema` with the plugins
 * installed on the machine.
 *
 * The top-level shape (screens → pages → tiles → widgets, devices, grid…) is
 * written here once, next to the types in model.ts, and must describe what
 * `normalize` (store.ts) accepts and keeps: the tests feed the starter config,
 * the examples and normalize's own output through it, and check that every
 * key normalize writes is described here and every key described here
 * survives normalize. Widgets and interludes are tagged unions on `type`,
 * one branch per installed widget, with the options taken from the plugin's
 * own schema (`toJsonSchema`); `sources` has one property per source type.
 *
 * Written for two readers: editors that validate and complete the file, and
 * an AI asked to write a config. Hence the descriptions, the defaults, and
 * `x-` hints: `x-size` (panel pixels a widget needs), `x-sources`,
 * `x-secret` and `x-risk` (values that run programs, contact hosts or read
 * paths, which `kiosko config import` lists before applying a config),
 * `x-filter` (lists of `matchFilter` patterns) and `x-ui` (labels in every
 * language, units, steps, sliders: what the editor builds its forms from).
 *
 * Pure (no Node).
 */
import { localize, THEMES, TIME_FORMATS, toJsonSchema, type Field, type Localized, type PluginDefinition } from '@kiosko/sdk';
import { CONFIG_SCHEMA_ID, CONFIG_VERSION, DEFAULT_CONFIG, ZOOM } from './model.ts';
import { sourceOptionsField } from './sources.ts';

type S = Record<string, unknown>;

const en = (x: Localized | undefined) => (x === undefined ? '' : localize(x, 'en'));
/** Joins sentences, each with its final stop. */
const sentences = (...parts: (string | number | false | undefined)[]) =>
  parts
    .filter((p): p is string => typeof p === 'string' && !!p.trim())
    .map((p) => p.trim())
    .map((p) => (/[.!?:)]$/.test(p) ? p : `${p}.`))
    .join(' ');

/** `plugin/thing`, as widgets, sources and interludes are addressed. */
export const TYPE_PATTERN = '^[a-z0-9][a-z0-9-]*/[A-Za-z0-9_.-]+$';
const ID_PATTERN = '^[A-Za-z0-9_.-]{1,80}$';

/** Instance switches over the widget's `urgent` and `empty` hooks, described only where the widget has them. */
const TAKE_OVER = {
  type: 'boolean',
  description: 'Keep the tile while the widget is urgent (a meeting about to start, a permission waiting), even if others share it. Off: it takes its turn like the rest.',
  'x-ui': { label: { en: 'Keep the tile while urgent', es: 'Quedarse la tesela mientras sea urgente' } },
};
const HIDE_WHEN_EMPTY = {
  type: 'boolean',
  description: 'Skip the widget in its tile\'s rotation while it has nothing to list, instead of showing its empty message.',
  'x-ui': { label: { en: 'Hide when empty', es: 'Ocultar si está vacío' } },
};
const TIME_PATTERN = '^([01][0-9]|2[0-3]):[0-5][0-9]$';

function options(f: Field | undefined, what: string): S {
  if (!f) return { type: 'object', description: `This ${what} has no options.`, default: {} };
  return { ...toJsonSchema(f), description: `Options of this ${what}. Leave out any option to use its default.` };
}

/** `x-size` and a sentence about it, from the widget's sizes in panel pixels. */
function sizeHint(size: { min?: { w: number; h: number }; preferred?: { w: number; h: number }; max?: { w: number; h: number } } | undefined): string {
  if (!size) return '';
  const px = (s: { w: number; h: number }) => `${s.w}×${s.h} px`;
  return [size.min && `Needs a tile of at least ${px(size.min)}`, size.preferred && `looks best around ${px(size.preferred)}`, size.max && `at most ${px(size.max)}`].filter(Boolean).join(', ');
}

/** Builds the schema of the whole config from the plugins' definitions (`registry.list().map(p => p.def)`). */
export function configSchema(plugins: readonly PluginDefinition[]): S {
  const sourceUsers = new Map<string, string[]>();
  for (const p of plugins) for (const w of p.widgets ?? []) for (const s of w.sources ?? []) sourceUsers.set(s, [...(sourceUsers.get(s) ?? []), `${p.id}/${w.id}`]);
  for (const p of plugins) for (const i of p.interludes ?? []) for (const s of i.sources ?? []) sourceUsers.set(s, [...(sourceUsers.get(s) ?? []), `${p.id}/${i.id}`]);

  const widgets: S[] = plugins.flatMap((p) =>
    (p.widgets ?? []).map((w) => {
      const type = `${p.id}/${w.id}`;
      return {
        title: `${en(w.name)} (${type})`,
        description: sentences(en(w.description), sizeHint(w.size), w.sources?.length && `Reads the shared source${w.sources.length > 1 ? 's' : ''} ${w.sources.join(', ')} (options under "sources")`),
        type: 'object',
        required: ['type'],
        additionalProperties: false,
        properties: {
          type: { const: type, description: `Widget "${en(w.name)}" of the plugin "${en(p.name)}".` },
          id: { $ref: '#/$defs/id' },
          title: { type: 'string', description: 'Card title. Missing or empty: no title bar.' },
          options: options(w.options, 'widget'),
          intervalMs: { type: 'integer', minimum: 5000, description: `How often this widget fetches its own data, in ms${w.fetch ? ` (default ${w.intervalMs ?? 600_000})` : '. This widget fetches nothing: leave it out'}.` },
          when: { $ref: '#/$defs/when' },
          disabled: { type: 'boolean', default: false, description: 'Kept in the tile but never shown.' },
          zoom: { $ref: '#/$defs/zoom' },
          ...(w.urgent ? { takeOver: { ...TAKE_OVER, default: w.takeOver ?? true } } : {}),
          ...(w.empty ? { hideWhenEmpty: { ...HIDE_WHEN_EMPTY, default: w.hideWhenEmpty ?? false } } : {}),
        },
        'x-plugin': p.id,
        'x-category': w.category ?? 'info',
        'x-chrome': w.chrome ?? 'card',
        ...(w.size ? { 'x-size': w.size } : {}),
        ...(w.sources?.length ? { 'x-sources': w.sources } : {}),
      };
    }),
  );

  const interludes: S[] = plugins.flatMap((p) =>
    (p.interludes ?? []).map((i) => {
      const type = `${p.id}/${i.id}`;
      return {
        title: `${en(i.name)} (${type})`,
        description: sentences(en(i.description), `Full-screen animation at ${i.fps} fps`),
        type: 'object',
        required: ['type'],
        additionalProperties: false,
        properties: {
          type: { const: type, description: `Interlude "${en(i.name)}" of the plugin "${en(p.name)}".` },
          id: { $ref: '#/$defs/id' },
          enabled: { type: 'boolean', default: true },
          everyMs: { type: 'integer', minimum: 60_000, default: 15 * 60_000, description: 'Plays every this many ms, against the wall clock: 900000 plays at :00, :15, :30 and :45.' },
          maxSeconds: { type: 'integer', minimum: 1, maximum: 600, default: 30, description: 'Longest it may play, in seconds.' },
          options: options(i.options, 'interlude'),
        },
        'x-plugin': p.id,
        ...(i.sources?.length ? { 'x-sources': i.sources } : {}),
      };
    }),
  );

  const sources: S = Object.fromEntries(
    plugins.flatMap((p) =>
      (p.sources ?? []).map((s) => {
        const type = `${p.id}/${s.id}`;
        const users = sourceUsers.get(type) ?? [];
        return [
          type,
          {
            ...options(sourceOptionsField(s), 'source'),
            title: `${en(s.name)} (${type})`,
            description: sentences(en(s.description), users.length && `Used by ${users.join(', ')}`, 'Runs only while some enabled widget uses it; set only the options that differ from the defaults'),
            'x-plugin': p.id,
            ...(users.length ? { 'x-used-by': users } : {}),
          },
        ];
      }),
    ),
  );

  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: CONFIG_SCHEMA_ID,
    title: 'Kiosko configuration (config.json)',
    description: sentences(
      'Configuration of Kiosko, a widget mosaic for small always-on USB LCD panels',
      'A screen is one panel; it shows pages in turn; a page is a fixed grid of cells covered by tiles; a tile shows a stack of widgets that take turns',
      'Every field is optional unless marked required: Kiosko fills in the defaults',
      'Secrets (x-secret) can be left empty: Kiosko keeps the value it already has or asks for it in the editor',
      'Values marked x-risk run programs (exec), contact hosts (network) or read local paths (path), and are listed for review when the file is imported',
    ),
    type: 'object',
    additionalProperties: false,
    properties: {
      $schema: { type: 'string', default: CONFIG_SCHEMA_ID, description: `The address of this schema, ${CONFIG_SCHEMA_ID}, so editors validate the file.` },
      version: { const: CONFIG_VERSION, default: CONFIG_VERSION, description: 'Version of the config format.' },
      locale: { type: 'string', default: DEFAULT_CONFIG.locale, examples: ['auto', 'en', 'en-GB', 'es'], description: 'Language of the panels and the editor, as a BCP-47 tag; "auto" follows the operating system.' },
      timeFormat: {
        enum: [...TIME_FORMATS],
        default: DEFAULT_CONFIG.timeFormat,
        description: 'How widgets write clock times: "24h" (14:05), "12h" (2:05 PM), or "auto", the habit of the language (24 h in Spanish and British English, 12 h in US English).',
        'x-ui': { label: { en: 'Time format', es: 'Formato de hora' }, labels: { auto: { en: 'As the language', es: 'Según el idioma' }, '24h': { en: '24 hours', es: '24 horas' }, '12h': { en: '12 hours', es: '12 horas' } } },
      },
      theme: { enum: THEMES.map((t) => t.id), default: DEFAULT_CONFIG.theme, description: `Colour theme: ${THEMES.map((t) => `${t.id} (${t.name})`).join(', ')}.` },
      location: { $ref: '#/$defs/location' },
      workday: {
        type: 'object',
        additionalProperties: false,
        description: 'Work schedule, for widgets and pages with "when": "work" or "off".',
        default: DEFAULT_CONFIG.workday,
        properties: {
          days: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 6 }, uniqueItems: true, default: DEFAULT_CONFIG.workday.days, description: 'Working days, 0 = Sunday … 6 = Saturday.' },
          start: { $ref: '#/$defs/time', default: DEFAULT_CONFIG.workday.start },
          end: { $ref: '#/$defs/time', default: DEFAULT_CONFIG.workday.end },
          hours: { type: 'number', minimum: 0, maximum: 24, default: DEFAULT_CONFIG.workday.hours, description: 'Hours due on a working day (what a timesheet expects), not the span from start to end.', 'x-ui': { unit: 'h', step: 0.25 } },
          holidays: { type: 'array', items: { type: 'string', format: 'date', 'x-pattern-hint': 'a day as YYYY-MM-DD' }, uniqueItems: true, default: [], description: 'Days off, as YYYY-MM-DD: no work hours and nothing due.' },
          byDay: {
            type: 'object',
            default: {},
            description: 'Days with other hours, by weekday ("5" = Friday): { "5": { "end": "15:00", "hours": 6 } }. Fields left out are those of the week.',
            propertyNames: { pattern: '^[0-6]$', 'x-pattern-hint': 'a weekday, "0" (Sunday) to "6" (Saturday)' },
            additionalProperties: {
              type: 'object',
              additionalProperties: false,
              properties: { start: { $ref: '#/$defs/time' }, end: { $ref: '#/$defs/time' }, hours: { type: 'number', minimum: 0, maximum: 24 } },
            },
          },
        },
      },
      sources: {
        type: 'object',
        description: 'Options of the shared data sources, by "plugin/source". A source is read once for every widget that uses it. Only needed to change a default (a folder, a host, a list of feeds…).',
        default: {},
        properties: sources,
        propertyNames: { pattern: TYPE_PATTERN, 'x-pattern-hint': 'a source type such as "weather/current"' },
        additionalProperties: { type: 'object' },
      },
      plugins: {
        type: 'object',
        additionalProperties: false,
        default: DEFAULT_CONFIG.plugins,
        properties: { disabled: { type: 'array', items: { type: 'string' }, uniqueItems: true, default: [], description: `Ids of installed plugins that are switched off: ${plugins.map((p) => p.id).join(', ')}.` } },
      },
      screens: { type: 'array', items: { $ref: '#/$defs/screen' }, default: [], description: 'One per physical panel (or a virtual one, shown only in the editor).' },
      server: {
        type: 'object',
        additionalProperties: false,
        description: 'Where the editor listens. Takes effect after a restart.',
        default: DEFAULT_CONFIG.server,
        properties: {
          host: { type: 'string', default: DEFAULT_CONFIG.server.host, description: 'Keep 127.0.0.1 unless you know why: the editor can install plugins.' },
          port: { type: 'integer', minimum: 1, maximum: 65535, default: DEFAULT_CONFIG.server.port },
        },
      },
    },
    $defs: {
      id: { type: 'string', pattern: ID_PATTERN, 'x-pattern-hint': 'an id of letters, digits, ".", "_" or "-" (no spaces, at most 80)', description: 'Stable id, unique among its siblings (widget ids: unique in the whole config). Generated when missing.' },
      time: { type: 'string', pattern: TIME_PATTERN, 'x-pattern-hint': 'a time as HH:MM (24 h)' },
      when: { enum: ['always', 'work', 'off'], default: 'always', description: 'When it shows: always, only in work hours, or only outside them (see "workday").' },
      zoom: {
        type: 'number',
        minimum: ZOOM.min,
        maximum: ZOOM.max,
        default: 1,
        description: `Text density: the widget is painted this many times bigger, in the same tile: 1.25 gives bigger letters and fewer rows, 0.8 a denser widget. From ${ZOOM.min} to ${ZOOM.max} (the editor moves in steps of ${ZOOM.step}). The tile must be at least the widget's minimum size times the zoom.`,
        'x-ui': { label: { en: 'Zoom', es: 'Zoom' }, unit: '×', step: ZOOM.step, slider: true },
      },
      location: {
        type: 'object',
        additionalProperties: false,
        required: ['latitude', 'longitude'],
        description: 'Your place, for weather, sunrise and sunset, air quality, earthquakes… Widgets that need it show a hint until it is set.',
        properties: {
          latitude: { type: 'number', minimum: -90, maximum: 90 },
          longitude: { type: 'number', minimum: -180, maximum: 180 },
          name: { type: 'string', description: 'Shown by some widgets, e.g. "Madrid".' },
        },
      },
      device: {
        description: 'How frames get to the glass. Start with "virtual"; the editor finds the panel for the others.',
        default: { driver: 'virtual' },
        oneOf: [
          { title: 'Virtual', description: 'No hardware: shown only in the editor.', type: 'object', additionalProperties: false, required: ['driver'], properties: { driver: { const: 'virtual' } } },
          {
            title: 'trcc serve',
            description: 'The REST API of `trcc serve` (thermalright-trcc-linux), for Thermalright panels on Linux.',
            type: 'object',
            additionalProperties: false,
            required: ['driver', 'url'],
            properties: {
              driver: { const: 'trcc' },
              url: { type: 'string', default: 'http://127.0.0.1:8099', description: 'Address of trcc serve.', 'x-risk': 'network' },
              tokenFile: { type: 'string', description: 'File with the API token of trcc serve, if it uses one.', 'x-risk': 'path' },
              deviceKey: { type: 'string', description: 'Which panel, when trcc sees several. Empty: the first one.' },
              serial: { type: 'string', description: 'USB serial number of the panel, to tell identical panels apart.' },
              keepalive: { type: 'boolean', default: true, description: 'Re-send the last frame now and then so the panel keeps it.' },
            },
          },
          {
            title: 'Frame file',
            description: 'Writes frame.jpg atomically into a folder; an external sender takes it to the panel.',
            type: 'object',
            additionalProperties: false,
            required: ['driver', 'dir'],
            properties: {
              driver: { const: 'file' },
              dir: { type: 'string', description: 'Folder where frame.jpg is written (created if missing).', 'x-risk': 'path' },
              format: { enum: ['jpeg', 'png'], default: 'jpeg' },
              quality: { type: 'integer', minimum: 1, maximum: 100, default: 90 },
            },
          },
        ],
      },
      grid: {
        type: 'object',
        additionalProperties: false,
        required: ['cols', 'rows', 'gap', 'padding'],
        description: 'The fixed grid of a page: cols × rows cells over the whole panel, which never scrolls. A cell is (width − 2·padding + gap) / cols px wide and (height − 2·padding + gap) / rows px high. Usual grids: 24×6 on 1920×462, 16×6 on 1280×480, 6×6 on 480×480, 4×3 on 320×240.',
        properties: {
          cols: { type: 'integer', minimum: 1, maximum: 96 },
          rows: { type: 'integer', minimum: 1, maximum: 96 },
          gap: { type: 'integer', minimum: 0, description: 'Space between tiles, in panel px.' },
          padding: { type: 'integer', minimum: 0, description: 'Space around the grid, in panel px.' },
        },
      },
      widget: {
        description: 'A widget placed in a tile, chosen by "type"; "options" depend on the type.',
        oneOf: widgets,
      },
      interlude: interludes.length
        ? { description: 'A full-screen animation that plays every so often, chosen by "type".', oneOf: interludes }
        : { description: 'No installed plugin provides interludes.', not: {} },
      tile: {
        type: 'object',
        additionalProperties: false,
        description: 'A rectangle of grid cells: x, y are its top-left cell (0-based), w, h its size in cells. It must fit the grid (x + w ≤ cols, y + h ≤ rows) and not overlap other tiles. Its widgets take turns; one that has nothing to show is skipped, an urgent one keeps the tile.',
        properties: {
          id: { $ref: '#/$defs/id' },
          x: { type: 'integer', minimum: 0, default: 0 },
          y: { type: 'integer', minimum: 0, default: 0 },
          w: { type: 'integer', minimum: 1, default: 1 },
          h: { type: 'integer', minimum: 1, default: 1 },
          locked: { type: 'boolean', default: false, description: 'Never pushed by other tiles nor by auto-arrange.' },
          widgets: { type: 'array', items: { $ref: '#/$defs/widget' }, default: [] },
          rotateMs: { type: 'integer', minimum: 2000, default: 30_000, description: 'Turn of each widget when several have something to show, in ms.' },
          chrome: { enum: ['auto', 'card', 'bare'], default: 'auto', description: 'card: framed with an optional title; bare: edge to edge; auto: what the shown widget prefers.' },
        },
      },
      page: {
        type: 'object',
        additionalProperties: false,
        description: 'A layout of tiles. The enabled pages of a screen take turns (or one is pinned).',
        properties: {
          id: { $ref: '#/$defs/id' },
          name: { type: 'string', description: 'Shown in the editor.' },
          enabled: { type: 'boolean', default: true },
          durationMs: { type: 'integer', minimum: 10_000, default: 10 * 60_000, description: 'Time on screen when pages take turns, in ms.' },
          when: { $ref: '#/$defs/when' },
          grid: { $ref: '#/$defs/grid', description: 'Missing: a grid of square-ish cells of about 80 px for the screen size.' },
          gravity: { enum: ['none', 'up', 'left'], default: 'none', description: 'How the editor closes gaps after a move: none (free placement), up (masonry), left (wide strips).' },
          background: {
            type: 'object',
            additionalProperties: false,
            default: {},
            properties: {
              color: { type: 'string', description: 'CSS colour; missing: the theme background.' },
              image: { type: 'string', description: 'Image file (or URL) under the tiles.', 'x-risk': ['network', 'path'] },
            },
          },
          tiles: { type: 'array', items: { $ref: '#/$defs/tile' }, default: [] },
        },
      },
      screen: {
        type: 'object',
        additionalProperties: false,
        description: 'One physical panel (or a virtual one). width × height are the panel pixels as the panel reports them, before rotation: 1920×462 (Thermalright Trofeo Vision 9.16″), 1920×480, 1280×480, 1600×720, 480×480, 320×320, 320×240.',
        properties: {
          id: { $ref: '#/$defs/id' },
          name: { type: 'string' },
          enabled: { type: 'boolean', default: true },
          width: { type: 'integer', minimum: 16, maximum: 8192, default: 1920 },
          height: { type: 'integer', minimum: 16, maximum: 8192, default: 462 },
          rotate: { enum: [0, 90, 180, 270], default: 0, description: 'Panels are often mounted upside down: 180.' },
          device: { $ref: '#/$defs/device' },
          pages: { type: 'array', items: { $ref: '#/$defs/page' }, default: [] },
          pinnedPage: { type: 'string', description: 'Id of a page to show all the time (no turns).' },
          interludes: { type: 'array', items: { $ref: '#/$defs/interlude' }, default: [] },
          pixelShift: {
            type: 'object',
            additionalProperties: false,
            description: 'Against burn-in: moves everything 1-2 px in a slow cycle.',
            default: { enabled: true, amplitude: 2, periodMs: 8 * 60_000 },
            properties: { enabled: { type: 'boolean', default: true }, amplitude: { type: 'integer', minimum: 0, maximum: 8, default: 2 }, periodMs: { type: 'integer', minimum: 10_000, default: 8 * 60_000 } },
          },
          sleepWhenIdle: { type: 'boolean', default: false, description: 'Black panel while every widget of the page has nothing worth showing.' },
          jpegQuality: { type: 'integer', minimum: 0, maximum: 100, default: 90, description: 'JPEG quality of the frames; 0 = PNG.' },
          maxFps: { type: 'integer', minimum: 1, maximum: 30, default: 12, description: 'Frames per second ceiling for animations.' },
        },
      },
    },
    'x-generated-from': plugins.map((p) => ({ id: p.id, version: p.version })),
  };
}

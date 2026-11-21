# Writing Kiosko plugins

A plugin is one ES module whose default export is `definePlugin({...})`. It can
contribute **widgets** (paint inside a tile), **sources** (shared data),
**interludes** (full-screen animations) and **page templates**. Built-in
plugins use exactly the same contract, so `plugins/*` in this repository are
the best examples.

The quickest start:

```sh
kiosko plugins new solar-meter     # a widget, a source, tests and a build, ready to run
cd kiosko-plugin-solar-meter && npm install && npm test
npm run kiosko:check               # Kiosko's conventions; every widget at several sizes, themes and languages
npm run build && npm run dev       # link it into your Kiosko and reload it on every build
```

## Where plugins live

| OS | Folder |
|---|---|
| Linux | `~/.config/kiosko/plugins/` (or `$XDG_CONFIG_HOME/kiosko/plugins`) |
| macOS | `~/Library/Application Support/Kiosko/plugins/` |
| Windows | `%APPDATA%\Kiosko\plugins\` |

Each plugin is a folder with an `index.js` (or a `package.json` whose
`"kiosko": { "plugin": "./entry.js" }` or `main` points at it), or a package
installed there with npm named `kiosko-plugin-*`. Plugins installed from the
editor (**Plugins → Install from npm**) load at once; a folder you copy there by
hand loads on the next start, or with **Reload** once it is there. `import … from '@kiosko/sdk'` (and `@loksly/lcd-canvas-kit`,
`@loksly/weather-astro`, `@napi-rs/canvas`) resolve to Kiosko's own copies, so
a plugin needs no `npm install` of its own.

## The plugin

```js
export default definePlugin({
  id: 'crypto',                       // lowercase, digits, dashes; configs refer to it
  name: { en: 'Crypto', es: 'Cripto' },
  version: '1.0.0',
  description: { en: 'Coin prices.', es: 'Cotizaciones.' },
  sdk: '^0.2.0',                      // the plugin API it is written for
  permissions: { network: ['api.coingecko.com'] },
  requires: [],                       // other plugins' sources/widgets it needs: ['agents/sessions']
  optional: ['weather/current'],      // …and the ones it uses when they are there
  platforms: ['linux', 'darwin', 'win32'],
  languages: ['en', 'es'],            // the languages its texts come in
  widgets: [price],
  sources: [],
  templates: [],                      // page layouts, see Page templates
});
```

| Field | |
|---|---|
| `sdk` | The plugin API range it works with, as npm writes ranges. A Kiosko outside it doesn't load the plugin and says why. Put the same in package.json (`"kiosko": { "sdk": "^0.2.0" }`): that one is read **before** the plugin's code runs. |
| `permissions` | What it does on the machine, shown on the Plugins page and in the store before anyone installs it: `network` (hosts it contacts; `user` for the ones the user types, `lan` for the local network), `exec` (programs it runs), `files` (files or folders it reads besides its own `dataDir`/`cacheDir`), `devices` (`usb`, `audio`, `mpris`…). A promise, not yet a fence: plugins run with the user's rights. Keep it honest. |
| `requires`, `optional` | Types of other plugins (`plugin/source`). The editor says what `requires` is missing and offers to install it. |
| `platforms` | Operating systems it works on (`linux`, `darwin`, `win32`); omitted, all. npm's `os` in package.json says the same before running. |
| `languages` | The languages its texts come in, as BCP 47 tags, English first: `['en', 'es', 'zh-Hant', 'zh-Hans']`. Chinese by script: `zh-Hant` (Taiwan, Hong Kong) and `zh-Hans` (mainland China), never a bare `zh`. Every text then comes in all of them: the linter names the ones that don't, and the ones in a language it doesn't list. `kiosko plugins check` paints every widget in each. Put the same in package.json (`"kiosko": { "languages": [...] }`), so a catalogue knows without running it. Omitted, the ones its texts use. |
| `templates` | Starting page layouts the editor offers under **New page** (see below). |
| `repository`, `homepage`, `author`, `license` | Shown on the Plugins page and in the store. |

### Page templates

```js
templates: [{
  id: 'dashboard',
  name: { en: 'Prices', es: 'Cotizaciones' },
  icon: 'bitcoin',
  wide: [                                          // fractions of the page, 0..1
    { x: 0, y: 0, w: 0.6, h: 1, widgets: ['price'], chrome: 'bare' },
    { x: 0.6, y: 0, w: 0.4, h: 1, widgets: [['core/clock', { showDate: true }], 'weather/forecast'] },
  ],
  square: [ /* … */ ],   // for square-ish panels; defaults to wide
  tall: [ /* … */ ],     // for portrait panels; defaults to wide turned a quarter
}],
```

Bare ids are the plugin's own (`price` → `crypto/price`). Widgets of plugins
that aren't installed are left out, and so is a tile left empty.

### The manifest

`kiosko plugins manifest` writes `kiosko-manifest.json` next to package.json
(`"kiosko": { "manifest": "./kiosko-manifest.json" }`): the record a plugin
store reads without running anything. Identity and authorship, versions and
the plugin API, platforms, the languages it declares (`languages`), categories and
tags, permissions, the options that run, connect or read (`risk`) and the
secret ones, what it needs, and every widget with its sizes, options (as JSON
Schema) and screenshot (`docs/<widget>.png`, painted with its demo data).
Ratings and reviews belong to the store, not to the manifest.

Besides, for the store (all optional; `kiosko plugins check` validates them):

```ts
definePlugin({
  // …
  markets: { only: ['ES'], note: { en: 'Needs a Red Eléctrica account' } }, // ISO 3166-1 alpha-2 codes or 'EU'
  support: { issues: 'https://…', discussions: 'https://…', docs: 'https://…' }, // default: package.json's bugs and homepage
  pricing: { model: 'free' },           // the only model for now
  funding: 'https://github.com/sponsors/you',  // also package.json's `funding`
  resources: { memoryMb: 40, cpu: 'low' },
  category: 'fun',                      // only for plugins without widgets (interludes only)
  interludes: [{ /* … */ preview: { poster: 'docs/show.jpg', video: 'docs/show.webm' } }],
});
```

The licence is read as an SPDX expression (`MIT`, `GPL-3.0-or-later`,
`MIT OR Apache-2.0`). The manifest's JSON Schema is
`packages/core/schema/manifest.json`, published at
https://kioskolcd.dev/store/v1/schema/manifest.json.

## A widget

```js
import { definePlugin, defineWidget, t } from '@kiosko/sdk';

const bitcoin = defineWidget({
  id: 'price',                                   // type becomes `crypto/price`
  name: { en: 'Price', es: 'Cotización' },
  description: { en: 'A coin price with its 24 h change.' },
  icon: 'bitcoin',                               // any https://lucide.dev icon
  category: 'info',                              // agents|system|time|productivity|dev|info|media|scene|fun
  size: { min: { w: 200, h: 100 }, preferred: { w: 400, h: 200 } },  // panel pixels
  options: t.object({
    coin: t.string({ default: 'bitcoin', label: 'Coin id (CoinGecko)' }),
    currency: t.enum(['usd', 'eur'], { label: 'Currency' }),
  }),
  intervalMs: 5 * 60_000,                        // how often fetch runs (the user can change it)
  async fetch({ options, signal }) {
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${options.coin}&vs_currencies=${options.currency}&include_24hr_change=true`;
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    return { price: j[options.coin][options.currency], change: j[options.coin][`${options.currency}_24h_change`] };
  },
  render(g, { box, data, options, theme, kit }) {
    if (!data) return;                           // first frame before fetch: draw nothing (or a hint)
    const color = data.change >= 0 ? theme.colors.ok : theme.colors.alert;
    const text = `${Math.round(data.price)} ${options.currency.toUpperCase()}`;
    const size = kit.fitSize(g, text, box.w, { size: box.h * 0.55, family: theme.fonts.sansBold }, 12);
    kit.drawTracked(g, text, box.x, box.y + size, { size, family: theme.fonts.sansBold, color: theme.colors.ink });
    kit.drawTracked(g, `${data.change.toFixed(1)}% 24h`, box.x, box.y + size * 1.6, { size: size * 0.35, family: theme.fonts.sans, color });
  },
  urgent: ({ data }) => !!data && Math.abs(data.change) > 10,  // takes its tile over on a big move
  demo: () => ({ data: { price: 64250, change: 2.4 } }),       // gallery and editor without network
});

export default definePlugin({ id: 'crypto', name: 'Crypto', version: '1.0.0', widgets: [bitcoin] });
```

### The contract

| Field | |
|---|---|
| `id`, `name`, `description`, `icon`, `category`, `tags` | Identity and how it appears in the library. Texts can be `{ en, es, … }`. |
| `size` | `min` is enforced by the editor; `preferred` is the size it's dropped at. Panel pixels. |
| `chrome` | `'card'` (default: surface, edge and optional title) or `'bare'` (edge to edge: scenes, photos). |
| `options` | A schema built with `t` (see below). Validated, typed, and turned into the editor form. |
| `sources` | Ids of shared sources (`'system/vitals'`, `'agents/sessions'`, `'weather/current'`…) whose data arrives in `ctx.sources`. |
| `fetch(ctx)` | Async, in Node, per widget instance, every `intervalMs`. Never blocks a frame. Throw on failure: the last good data stays. `ctx.signal` aborts after `timeoutMs` (default 2 min). |
| `intervalOf({ options, data })` | Only when the interval depends on the options or the data (a module that declares its own): asked after every fetch, `undefined` keeps `intervalMs`, never under 5 s. An interval the user sets on the instance wins. Declare it after `fetch`. |
| `render(g, ctx)` | Synchronous and fast. Paint inside `ctx.box`; the tile is clipped for you. |
| `redraw` | `'never'` (default: only when data changes), `'minute'`, `'second'` or `{ everyMs }`, or a function of `{ options, data, now }` returning one of those. Fewer frames are fewer USB transfers; `{ everyMs: 250 }` is a cheap way to animate, but it repaints the whole page each time (for real animations see `animation`). |
| `visible(ctx)` | `false` when there's nothing to show: the widget is skipped in its tile's rotation. |
| `urgent(ctx)` | `true` while it needs the user: it keeps its tile, unless the user turns the widget's **Keep the tile while urgent** switch off (`takeOver` on the instance). `takeOver: false` on the definition makes off the default. |
| `empty(ctx)` | `true` when the list has nothing to show. Gives the widget a **Hide when empty** switch (`hideWhenEmpty` on the instance): on, an empty widget is skipped like `visible: false`; off, it paints its empty message (`drawEmpty`). `hideWhenEmpty: true` on the definition makes on the default. |
| `alerts(ctx)` | Alerts to show **full-screen**, from the data like `urgent`: `[]` when there is nothing. See *Alerts* below. |
| `idle(ctx)` | `true` when there's nothing worth lighting the panel for (with *sleep when idle*, the panel goes black when every widget agrees). |
| `animation(ctx)` | A short animation inside the tile, or `null`. Returns a plan `{ id, frames, fps, params?, interruptible?, hold? }`; the runtime paints every frame by calling `render` with `ctx.anim = { plan, i, t }` (`t` is 0..1; the first and last frame are the still picture and are not sent), then plays them at `min(fps, screen maxFps)` and ends with a real still repaint. Any widget on show may ask, as if it were alone; how many play together on a screen is the runtime's decision (one for now: the others wait their turn, longest wait first). Asked with `ctx.trigger`: `'idle'` now and then (see `animationGap`, default 20-60 s, random in the range) or `'data'` when the instance's data or one of its sources changed (`ctx.prev` has the old ones; see `animationCooldownMs`). Use `ctx.rnd()` instead of `Math.random`. See *Animations* below. |
| `animationGap`, `animationCooldownMs` | `{ minMs, maxMs }` between the `idle` questions; and the least time from the end of an animation to a `data` one. |
| `demo(ctx)` | `{ data?, sources?, options? }` sample content. Make it look real; it's what people see first. |

### The render context

`ctx.box` `{x,y,w,h}` · `ctx.options` · `ctx.data` · `ctx.sources` · `ctx.now` ·
`ctx.theme.colors` (`bg surface surfaceEdge ink inkDim inkFaint accent alert
warn info ok`) · `ctx.theme.fonts` (`sans sansBold mono monoBold`) ·
`ctx.kit` (text with tracking and small caps, `truncate`, `fitSize`,
`wrapLines`, `sparkBars`, weather and moon icons…) · `ctx.canvas`
(`createCanvas`, `loadImage`) · `ctx.locale` and `ctx.t({ en, es })` ·
`ctx.fmt` (times and ages, below) · `ctx.location` (the user's place, if
set) · `ctx.workday` (the user's working week) · `ctx.preview` (true in the
editor) · `ctx.working` (work hours). `visible`, `urgent`, `idle`, `empty` and
`redraw` get `options`, `data`, `sources`, `now`, `working`, `workday` and
`location`.

**Times and ages.** `ctx.fmt` writes them the same way in every widget, in
the user's language and with the clock of Settings → Time format:

```js
ctx.fmt.time(meeting.start)                 // "09:05" or "9:05 AM" ("9:05 a. m.")
ctx.fmt.time(now, { seconds: true })        // "09:05:07"
ctx.fmt.ago(mr.createdAt)                   // "5 min ago", "3 h ago", "2 wk ago" ("hace 5 min")
ctx.fmt.ago(mr.createdAt, { suffix: false })// "5 min", "3 h": for a meta line
ctx.fmt.duration(now - call.since)          // "12 min", "1 h 05", "2 d 3 h"
ctx.fmt.duration(start - now, { round: 'up' }) // countdowns: never "0 min" before it starts
ctx.fmt.hour12                              // true on a 12-hour clock
```

`ago` takes a time (epoch ms, `Date` or ISO string) and measures from
`ctx.now`. Outside a context (tests), `createFormatters({ locale, timeFormat,
now })` builds the same object.

**Place and schedule.** `ctx.location` (`{ latitude, longitude, name? }`) is
the place of Settings; use it by default and offer a place of your own only
where a second one makes sense, with `...locationOptions()` (advanced
`latitude`, `longitude`, `placeName`; 0,0 means "Settings") and
`placeOf(options, ctx.location)` to pick. `ctx.workday` is the
working week of Settings: `days`, `start`, `end`, `hours` due per day,
`holidays` and `byDay` (other hours on some weekdays, a short Friday).
`scheduleOn(ctx.workday, now)` gives one day's (`working`, `holiday`,
`start`, `end`, `hours`), `isWorkingAt` and `weeklyHours` the rest.

**Zoom.** The user can paint any widget bigger or smaller (Inspector → Text
size, `zoom` on the instance, 0.5–2). The compositor hands the widget a box
`zoom` times smaller and scales the drawing, so there is nothing to do but
size everything from `ctx.box`, which every widget should do anyway.

Rules of thumb that come from running these panels 24/7:

- **Darkness is the normal state.** Use `ink`/`inkDim` for information and spend
  `alert`/`warn` only on what needs the user.
- **Decode images in `fetch`**, keep them in a module-level cache, paint them
  in `render`. Use `ctx.canvas.loadImage`, never your own `@napi-rs/canvas`.
- **Fit text, don't overflow it**: `kit.fitSize`, `kit.truncate`,
  `kit.wrapLines`. Test the smallest size you declare.
- **Fonts have no emoji.** Draw icons with `kit` or canvas paths.
- **Chinese, Japanese and Korean just work.** Kiosko puts a CJK font behind
  every font you set (`ctx.font`, `kit`, any canvas), picked for the user's
  language: Traditional for Taiwan and Hong Kong, Simplified for mainland
  China, since the same character is drawn differently. Use
  `ctx.theme.fonts`; don't register CJK fonts of your own. Bold CJK comes
  out bold with `sansBold`/`monoBold`.

## Options schema (`t`)

```js
t.string({ default, label, help, placeholder, multiline, secret, format: 'url'|'path'|'time'|'date', risk })
t.number({ default, min, max, step, unit, slider })   t.integer({...})
t.duration({ default })            // milliseconds, edited as s/min/h
t.boolean({ default })
t.enum(['a', 'b'], { labels: { a: 'First' } })
t.color({ default: '#ff8800' })
t.list(item, { max })              t.object({ ...fields })      t.map()   // string → string
t.filter({ label })                // patterns for matchFilter: ["web", "acme/*", "!*-old"]
...listOptions({ layouts })        // rows and layout, see Lists
```

A text field or a filter can offer values from a source's live data, so the
user picks instead of typing ids: `t.string({ choices: { source:
'homeassistant/states', list: 'entities' } })`, `t.filter({ choices })`. The
source makes the list (see Shared sources); the field stays free text.

Every field takes `label`, `help` and `advanced` (hidden behind "Advanced").
`secret: true` masks the value in the editor. Unknown keys in the user's config
are kept, wrong types fall back to the default; `validate` never throws.

Mark with `risk` the options whose value makes Kiosko act on the user's
behalf: `'exec'` runs a program or loads code (a command, an ssh host),
`'network'` contacts a host (a URL, an API host, a feed), `'path'` reads a
local file or folder; a list such as `['network', 'path']` when it depends on
the value (an image path or URL). They become `x-risk` in the
[config schema](config-schema.md), and `kiosko config import` lists every such
value before applying a config someone else (or an AI) wrote. Switches that
turn on a fixed tool (read git status) don't need it.

## Lists

A widget that lists things (pipelines, reviews, tasks, disks…) uses the
shared list options, so every list behaves and looks the same:

```js
import { defineWidget, drawEmpty, drawMore, listLayout, listOptions, matchFilter, t } from '@kiosko/sdk';

export const reviews = defineWidget({
  id: 'reviews',
  options: t.object({
    ...listOptions({ layouts: ['one-line', 'detailed'] }),  // rows (0 = auto), layout (auto | one-line | detailed)
    projects: t.filter({ label: { en: 'Projects', es: 'Proyectos' } }),
  }),
  empty: ({ options, sources }) => !itemsOf(sources, options).length,  // a "Hide when empty" switch for free
  render(g, ctx) {
    const items = itemsOf(ctx.sources, ctx.options);       // filtered with matchFilter(item.project, options.projects)
    if (!items.length) return drawEmpty(g, ctx, ctx.t({ en: 'Nothing to review', es: 'Nada que revisar' }));
    const plan = listLayout(ctx.box, items.length, ctx.options, {
      sizes: { 'one-line': { min: 22, max: 46 }, detailed: { min: 40, max: 84 } },  // row heights in px of the box
      auto: (box, n) => (box.h / n >= 50 ? 'detailed' : 'one-line'),               // what `auto` picks
    });
    plan.rows.forEach((row, i) => drawItem(g, ctx, items[i], row, plan));           // row = { x, y, w, h: plan.rowH }; plan.textSize
    drawMore(g, ctx, plan, { indent: 12 });                                         // "+3 more" / "+3 más", if any
  },
});
```

- `listOptions({ rows, layouts, layout })` adds `rows` (integer 0–30, 0 =
  as many as fit; `rows` is its default) and, when `layouts` names two,
  `layout` (`auto` plus those). One layout: no `layout` option.
- `listLayout(box, count, options, spec)` returns `{ layout, rowH, rows,
  shown, hidden, more, textSize, detailSize }`. Rows are never taller than
  the layout's `max` nor shorter than its `min`; they start at the top of
  the box and whatever is left stays empty below them. With `rows` 0 they
  are `box.h / count` (`minRows` sizes for at least that many), as many as
  fit. With `rows` N, N items in rows of `box.h / N`; fewer when N don't fit
  at `min`. Items left out are counted in a compact "+N more" line (`more`,
  `moreHeight(rowH)` tall) right under the last row, reserved only then; a
  box with room for one row always gets it, with the line squeezed or left
  out. `textSize` and `detailSize` are suggested font sizes for the row's
  main and secondary text, from `rowH`, so they stop growing with it.
- `drawMore(g, ctx, plan, { indent, align })` paints "+N more" there;
  `drawEmpty(g, ctx, message)` paints an empty list's message. Use them
  rather than your own, so overflow and empty lists look the same everywhere.
- `plugins/core` `list` is the reference implementation.

## Filters

`t.filter({ label })` is a list of patterns, edited in one line ("web,
acme/*, !*-old"); `matchFilter(value, filter)` applies it: empty lets
everything through, names match by their full path or their last `/`
segment without case, `*` matches anything (`/` too), `?` one character, and
a leading `!` leaves out. `value` can be several names of one item (a repo
and its alias): `matchFilter([repo.fullName, alias], options.repos)`.

## Shared sources

```js
import { defineSource } from '@kiosko/sdk';

export const queue = defineSource({
  id: 'queue',
  name: 'Build queue',
  options: t.object({ url: t.string({ format: 'url' }) }),   // edited once, in Settings → Data sources
  intervalMs: 15_000,                                       // default; the user can change it
  minIntervalMs: 5_000,                                     // the floor the user can't go under (API limits, CPU)
  timeoutMs: 20_000,                                        // default; one read longer than this is aborted
  async read({ options, signal, timeoutMs }) { /* return data; pass `signal` to fetch and child processes */ },
  // or push-based: watch(ctx, emit) { const w = fs.watch(…, () => emit(…)); return () => w.close(); }
  demo: () => ({ jobs: [] }),
});
```

A source runs only while some enabled widget declares it, once for all of
them (or always, if it may run in the background and the user turned that
on: see *Alerts*). Every polled source (one with `read`) also accepts `intervalMs` and
`timeoutMs` in `sources["plugin/source"]`, shown in Settings → Data sources
and in the config schema: Kiosko clamps the interval to `minIntervalMs`
(default 5 s, or `intervalMs` if shorter), and aborts `ctx.signal` when a
read takes longer than `timeoutMs` (default 2 min); the read then counts as
failed and is retried within a minute. Don't add options of your own for
either; `ctx.intervalMs` and `ctx.timeoutMs` tell you the values in use. (A
source that still has an option with one of these names keeps it, with its
own meaning, and Kiosko uses the definition's value instead: drop the option
to hand it over.)

A source can also make **lists of values** for options, from its latest data
(or its demo data before there is any):

```js
choices: {
  entities: (data) => Object.values(data.entities).map((e) => ({ value: e.id, label: e.name, group: e.domain })),
},
```

Fields ask for one with `choices: { source: 'homeassistant/states', list:
'entities' }`. Keep them quick: they run when the editor opens a form.

### Talking to APIs

`createHttp` gives every plugin the same polite client:

```js
import { createHttp } from '@kiosko/sdk';
const http = createHttp({ agent: 'kiosko-plugin-crypto/1.0.0' });
// in read() or fetch():
const { data } = await http.json(url, { signal: ctx.signal });
```

It sends back each URL's ETag / Last-Modified and returns the remembered body
on a 304; on a 429 or 503 it throws an `HttpError` with `retryAt` (from
`Retry-After`, or GitHub's rate-limit headers) and leaves that host alone
until then; it passes the signal on; and it names your plugin and Kiosko in
the User-Agent, never the person.

## Option conventions

Rules for every plugin, so the same idea has the same name, unit and control
everywhere: a user who learns one widget knows them all, and an AI writing a
config guesses right. Kiosko has no compatibility layer for options: follow
these when you add or rename one.

- **Thresholds** come in pairs: `…Warn` paints amber (`colors.warn`) and
  `…Alert` red (`colors.alert`), named after what they measure (`tempWarn`,
  `tempAlert`, `diskWarn`, `diskAlert`); bare `warn`/`alert` only for a
  widget's single measure. Never `Crit`, `Critical` or `Max` for a colour
  change, and never a level derived in code ("warn − 15"): if it colours, it's
  an option.
  - **Percentages are integers 0–100**, `t.integer({ min: 0, max: 100, unit: '%' })`,
    never ratios 0–1, even when the source gives a ratio.
  - **Temperatures are °C** (`unit: '°C'`), integers.
  - Durations used as thresholds follow the duration rule (`warnMs`, `alertMs`).
- **Durations** are milliseconds with `t.duration()` and a name ending in
  `Ms` (`rotateMs`, `staleMs`, `holdMs`, `historyMs`, `maxAgeMs`). The editor
  shows them in s, min or h, so there is no reason for `…Min`, `…Minutes` or
  `…Hours`. 0 means "off" or "no limit" where that makes sense (say so in
  `help`). Calendar spans counted in whole days are counts, not durations:
  integers named `days` or `…Days` (`horizonDays`, `lookbackDays`).
- **Counts**: `rows` is the length of a list, always through `listOptions`.
  Any other cap is `max<Things>` (`maxProcesses`, `maxTiles`, `maxMentions`),
  and an amount to show is a plain count (`hours`, `days` in a forecast)
  where 0 hides it. Never a boolean for what is really a number (`tomorrow`
  → `days`).
- **Booleans**: `show<Part>` shows or hides a part of the widget
  (`showSeconds`, `showDate`, `showMoon`), `hide<Items>` / `include<Items>`
  drop or add kinds of items (`hideApproved`, `hidePassing`,
  `includeDrafts`), and `only<Condition>` limits when the widget shows at all
  (`onlyWhenRaining`, `onlyDuringCall`). No bare nouns (`seconds`, `moon`,
  `cores`) and no `…Only` suffix (`latestOnly` → `onlyLatest`).
- **`takeOver`** (keep the tile while urgent) is not a plugin option: it is
  the instance's switch, shown for any widget with `urgent`. Declare
  `takeOver: false` on the definition if the widget should not keep the tile
  by default, and don't test an option inside `urgent`.
- **`hideWhenEmpty`** is not a plugin option either: declare `empty(ctx)`
  and the instance gets the switch; `hideWhenEmpty: true` on the definition
  for widgets that hide when empty by default. Leave in `visible` only the
  conditions that are not "the list is empty".
- **Lists** use `listOptions`, `listLayout`, `drawMore` and `drawEmpty`
  (see Lists), with the widget's current row heights as `min`/`max` and
  `rows` defaulting to 0, unless the widget had a fixed count (then that).
  Overflow is always "+N more", never a silent cut nor a bare "+N".
- **Filters** are `t.filter()` options named after what they filter, in
  the plural (`projects`, `repos`, `calendars`, `servers`, `gpus`,
  `outlets`, `people`), applied with `matchFilter`.
- **Zoom** needs nothing: size everything from `ctx.box`, never from the
  panel or a constant, and draw offscreen canvases at `box` size.
- **Refresh and timeouts** are not options: declare `intervalMs`,
  `minIntervalMs` and `timeoutMs` on the source (or `intervalMs` and
  `timeoutMs` on a widget with `fetch`), and pass `ctx.signal` on.
- **Time, language, place and schedule**: `ctx.fmt.time`, `ctx.fmt.ago` and
  `ctx.fmt.duration` (no `hhmm` helpers, `toLocaleTimeString` or "ago"
  functions of your own); `ctx.t` for every text (never
  `locale.startsWith('es')`); `ctx.location` and `ctx.workday` by default,
  with a place or schedule of your own only as an advanced override where a
  second one makes sense.
- **Texts** are `{ en, es }`, plus any language you can offer, and the
  plugin lists them all in `languages`. Chinese goes by script: `zh-Hant`
  (Taiwan, Hong Kong) and `zh-Hans` (mainland China), never a bare `zh`,
  which is read as Simplified and so never shown in Taiwan. `align` offers `left`, `center` and `right`.

| Today | Convention |
|---|---|
| `tempCrit`, `vramCrit` | `tempAlert`, `vramAlert` |
| `warn: 0.85`, `alert: 0.95` (ratios) | `warn: 85`, `alert: 95` (`%`) |
| `tempWarn` alone, amber at `tempWarn − 15` | `tempWarn` and `tempAlert` |
| `greyMin`, `warnMin`, `alertMin`, `holdMin` | `greyMs`, `warnMs`, `alertMs`, `holdMs` |
| `zombieMinutes`, `historyMinutes`, `minutes`, `maxAgeHours` | `zombieMs`, `historyMs`, `historyMs`, `maxAgeMs` |
| `max` (countdown), `rows` 1–8 | `rows` via `listOptions({ rows: 4 })` |
| `seconds`, `moon`, `cores`, `latestOnly` | `showSeconds`, `showMoon`, `showCores`, `onlyLatest` |
| `takeOver` option, `urgent: ({ options }) => options.takeOver && …` | instance switch; `takeOver: false` on the definition if off by default |
| `visible: () => list.length > 0` | `empty: () => !list.length`, `hideWhenEmpty: true` |
| a source's own `intervalMs` or `timeoutMs` option | `intervalMs`, `minIntervalMs`, `timeoutMs` on the definition |
| `hhmm(ms)`, `age(iso, now, locale)`, `elapsed(ms)` | `ctx.fmt.time`, `ctx.fmt.ago`, `ctx.fmt.duration` |
| `start`, `end`, `hours`, `holidays` per widget | `ctx.workday`, `scheduleOn(ctx.workday, now)` |
| `latitude`, `longitude` per widget | `ctx.location`; an override only via `locationOptions()` + `placeOf` |
| a list of repos as free text | `repos: t.filter({ label })` + `matchFilter` |

## Interludes

```js
import { defineInterlude } from '@kiosko/sdk';

export const fireworks = defineInterlude({
  id: 'fireworks',
  name: 'Fireworks',
  fps: 12,
  async prepare({ width, height, seed, theme }) {
    // Heavy work here, before playing.
    return { frames: 120, draw(g, i) { /* paint frame i on a width×height canvas */ } };
  },
  skip: ({ sources }) => false,   // true to stay out of the way (someone waits for a permission…)
});
```

Screens schedule interludes against the wall clock (every 15 min = at :00,
:15, :30, :45), once per slot, capped at `maxSeconds`.

### Interludes you can play

An interlude with `input: true` is offered on the editor's **Play** page
(Kiosko 0.2.7 and later): someone picks a screen and plays it with the
keyboard, a game controller or a phone's touch pad. Started from there,
`prepare` gets `ctx.input`, and the interlude lasts while they play: no
`maxSeconds`, `frames` may be `Infinity`, and a minute without a button
ends it. At its time slot it plays as any other, without `ctx.input`.

```js
defineInterlude({
  id: 'game',
  name: 'A game',
  fps: 30,
  input: true,
  async prepare(ctx) {
    const game = startGame({ demo: !ctx.input });
    ctx.input?.on(({ key, pressed }) => game.key(key, pressed)); // 'up' 'down' 'left' 'right' 'a' 'b' 'x' 'y' 'l' 'r' 'start' 'select'
    return { frames: ctx.input ? Infinity : 30 * 60, draw: (g, i) => game.paint(g) };
  },
});
```

The buttons are a game controller's (`PadKey`): the page maps the keyboard
(arrows or W S, A D, Space or Ctrl, E, Shift, Esc, Enter, Tab) and a
controller in the standard mapping to them. `kiosko-plugin-doom` is the
example.

## Alerts

What must be seen from across the room (the panel has no sound): smoke, a
leak, the doorbell, a call, `main` broken, a typhoon warning. A widget or a
source returns alerts from its data (Kiosko 0.2.7 and later; older ones
ignore `alerts`); Kiosko decides how they are shown:

```js
defineWidget({
  id: 'smoke',
  // …
  alerts: ({ data, now }) => data?.smoke
    ? [{ id: `smoke-${data.since}`, level: 'critical', title: { en: 'Smoke in the kitchen', es: 'Humo en la cocina' }, text: data.sensor, icon: 'flame' }]
    : [],
});

defineSource({
  id: 'quakes',
  // …
  background: true,   // may run with no widget, if the user turns it on
  alerts: ({ data, options, now }) => (data?.reports ?? []).filter((r) => r.magnitude >= options.minMagnitude)
    .map((r) => ({ id: r.id, level: 'warn', title: r.place, text: `M${r.magnitude}`, source: 'IGN', icon: 'activity', ttlMs: 30 * 60_000 })),
});
```

| Field | |
|---|---|
| `id` | Stable while it is the same event, new for a new one (`smoke-<since>`, `pipeline-4711`). Once the user has seen it, it stays hidden while you keep returning that id. Kiosko puts the widget's or source's type in front (`home/smoke:smoke-…`): two instances returning the same id are one alert. |
| `level` | `info` (blue, pulses), `warn` (amber) or `critical` (red): these two flash for a few seconds, then pulse. Each screen says from which level an alert takes it over, and its quiet hours let only `critical` through. |
| `title` | A few words, `Localized`: painted as big as the panel allows. |
| `text` | One short line under it. |
| `source` | Who published it, a few letters (`IGN`, `NWS`, `AEMET`, `气象署`), painted small in the corner with the time. Name the authority when the alert is someone else's: their licences ask for it, and the user must know where it comes from. Optional. |
| `detail` | A second line under `text`, in the level's colour: the authority's own instruction as it is ("Move away from the coast and go to high ground"). Painted as far as it fits, after `text`. Optional. |
| `icon` | A Lucide name the panel draws: `triangle-alert`, `octagon-alert`, `info`, `bell`, `bell-ring`, `flame`, `droplet`, `phone`, `phone-incoming`, `activity`, `zap`, `cloud-lightning`, `wind`, `waves`, `thermometer`, `siren`, `shield-alert`, `door-open`, `git-branch`, `circle-x`, `bug`, `mail`; or one or two characters (`震`). Anything else: the level's. |
| `expiresAt` / `ttlMs` | When it stops on its own: a time, or how long from when Kiosko first sees it. |
| `dismissible` | Default `true`. `false`: "Seen" and snooze can't hide it; it stays while you return it. |

`alerts` is asked for every instance on any page of an enabled screen (not
only the page shown), whenever its data changes and every few seconds; a
source's while the source runs (while some widget uses it). Keep it cheap
and decide from the data alone. Nothing runs in demo mode.

**With no widget.** Alerts that matter whether or not a tile shows them
(official warnings, earthquake reports) come from a source that declares
`background: true` next to its `alerts`. Settings → Data sources then
offers that source a switch, **Watch for alerts without a widget**
(`sources["plugin/source"].background`), off by default: while it is on and
the plugin is enabled, Kiosko reads (or watches) the source at its interval
and asks its `alerts` even if no tile uses it. Without `alerts`, or with an
option of its own named `background`, there is no switch (`kiosko plugins
check` says so). Older Kiosko ignores `background`: the source runs only
while a widget uses it.

An alert goes over everything: pages, interludes (a game too), animations,
and a panel asleep. The frame flashes at most once a second (WCAG 2.3.1)
and the text stands still; several at once show the highest and `+N`. The
user dismisses it from the editor's band (**Seen** or **Snooze**), Home
Assistant (**Acknowledge alerts**), or the API:

| | |
|---|---|
| `GET /api/alerts` | The active ones, highest first (snoozed ones with `snoozedUntil`). |
| `POST /api/alerts` | One from outside (a webhook, a script, a Home Assistant automation): the same fields, `id` optional (letters, digits, `.`, `_`, `-`), plus `screens: ["id"]` to show it only there; `source` and `detail`, if given, must be text (or texts by language). Posting the same id again replaces it. |
| `DELETE /api/alerts/<id>` | Takes away one posted from outside (its cause is over). |
| `POST /api/alerts/<id>/ack` | "Seen". 409 if it isn't `dismissible`. |
| `POST /api/alerts/<id>/snooze` | Hidden for `{ "minutes": 10 }` (1 to 1440), then back if it's still there. |
| `POST /api/screens/<id>/test-alert` | `{ "level": "critical" }`: how one looks on that screen, for 20 s, whatever its settings. |

Mutating requests need the `X-Kiosko: 1` header, as everywhere in the API:

```sh
curl -X POST -H 'X-Kiosko: 1' -H 'content-type: application/json' \
  -d '{"id":"door","level":"info","title":"Someone at the door","icon":"bell-ring","ttlMs":60000}' \
  http://127.0.0.1:7420/api/alerts
```

In tests, `widgetAlerts(widget, { data, options })` and
`sourceAlerts(source, { data, options, now })` from `@kiosko/sdk/testing` ask
`alerts` the way Kiosko does (with the demo data when `data` isn't given):

```js
import { sourceAlerts } from '@kiosko/sdk/testing';

const [a] = sourceAlerts(quakes, { data: { reports: [{ id: 'es2026abc', place: 'Alborán Sur', magnitude: 5.2 }] }, options: { minMagnitude: 4 } });
assert.equal(a.source, 'IGN');
assert.deepEqual(sourceAlerts(quakes, { data: { reports: [] } }), []);
```

## Screens in threads of their own

Kiosko may paint each screen in a thread of its own (Settings → *Paint each
screen in its own thread*: automatic with two or more screens on and a core
to spare for each, always or never; each screen can say otherwise in
Screens), so a slow widget on one screen doesn't slow the others. What runs
where:

- **On the main thread**, as always: sources (`read`, `watch`), `fetch`,
  `alerts`, `choices`, and the editor's previews and thumbnails.
- **In a screen's thread**: `render`, `visible`, `urgent`, `empty`, `idle`,
  `redraw`, `animation`, `animationEnded`, and interludes (`skip`,
  `prepare`, `draw`, `input`).

What that means for a plugin:

- **Your module is loaded once per thread.** Module-level state (a cache, a
  counter, "what I saw last") is not shared between the screens' threads,
  nor with the main thread where `fetch` and the sources run. Keep what
  `render` needs in the data, and anything that must be shared in a file
  under `ctx.dataDir` or `ctx.cacheDir`. Loading also costs memory and time
  once per thread: keep heavy work out of the module's top level.
- **Data crosses between threads by copy** (structured clone). Plain
  objects, arrays, numbers, strings, `Map`, `Set`, `Date`, `Buffer` and
  typed arrays arrive as they left. Images (`loadImage`) and canvases
  painted in `fetch` arrive too: Kiosko sends their bytes and makes them
  again on the other side, once per picture. **Functions and objects of a
  class can't**: their methods would be lost. When a screen's data has one,
  Kiosko paints that screen on the main thread and says why in Activity
  and in Screens. Return plain data from `fetch` and your sources, and put
  the logic in functions that take it.
- The editor paints its previews on the main thread with the same data and
  the same code, so they match what the panel shows, as long as `render`
  depends only on its context.
- `ctx.log` and paint times come back to the main thread; logs say which
  plugin as usual.

## Testing your plugin

`@kiosko/sdk/testing` paints widgets the way Kiosko does, with their demo data
unless you give other:

```js
import { checkPlugin, renderWidget, widgetState } from '@kiosko/sdk/testing';

const r = renderWidget(price, { size: { w: 400, h: 200 }, locale: 'es', theme: 'paper' });
assert.deepEqual(r.texts.slice(0, 2), ['64 250', '+2,4 %']);   // every text drawn, in order
assert.equal(r.outside, 0);                                    // pixels painted outside its box
assert.equal(widgetState(price, 'urgent', { data: { change: 12 } }), true);
assert.deepEqual(checkPlugin(plugin), []);                     // every widget, several sizes, themes, languages
```

`kiosko plugins check [folder]` runs the same painting check plus the
conventions of this guide (option names and units, threshold pairs, risks,
languages missing from texts, demos, sizes, what it uses from other plugins)
and exits with an error when something throws. `createBaseContext({ now,
locale })` builds the host-independent part of a context for other unit tests.

While Kiosko runs: `kiosko plugins dev [folder]` links your checkout and
reloads it on every build, without restarting. The Plugins page lists load
problems (and plugins refused for another plugin API or system), and a widget
that throws shows its error in its tile without breaking the rest of the frame.
Activity names a widget that takes over 50 ms to paint, and the inspector shows
its paint time: keep heavy work in `fetch` or a source, `render` only paints.

## Publishing

Name the package `kiosko-plugin-<name>`. Its package.json says
`"kiosko": { "plugin": "./dist/index.js", "sdk": "^0.2.0", "manifest":
"./kiosko-manifest.json" }`, lists `@kiosko/sdk` as a peer dependency, and
publishes one bundled file (what `kiosko plugins new` sets up; Kiosko provides
the SDK, the drawing kit and the canvas). Run `kiosko plugins check` and
`kiosko plugins manifest` before `npm publish`. Users install it from
the store or from **Plugins → Install from npm** (with `--ignore-scripts`): it loads at once, and
installing a newer version replaces it in place.

Once a day Kiosko asks npm for newer versions of the plugins it got from npm
(and of itself) and the Plugins page offers **Update**. It only offers a
version whose package.json says it fits this Kiosko (`kiosko.sdk`, or the
`@kiosko/sdk` peer range, and `os`); a newer one that doesn't is shown with
why. If the new version doesn't load, the previous one comes back, and if it
declares more permissions than the old one, the editor says which. Publish a
fix as a patch within the same range and every Kiosko it fits will offer it.
`KIOSKO_NO_UPDATE_CHECK=1` turns the daily check off.

### In the store

The plugin store, at https://kioskolcd.dev/store/ and in the editor's
**Plugins → Store**, lists every package on npm with the `kiosko-plugin`
keyword (`kiosko plugins new` puts it there) within a day of publishing.
It reads your `kiosko-manifest.json` out of the tarball, never running your
code, so publish the manifest (`files` in package.json, `kiosko plugins
manifest` before `npm publish`) and the `docs/` pictures it names: without
it the store only knows what package.json says. Official plugins
(kiosko-lcd) are marked so; everyone else's are listed as **Unreviewed**,
never featured, and installing one asks the person to confirm they
understand the risk. Before installing, the editor shows what the manifest
declares (`permissions`, risky options) and which of their screens each
widget fits (`size.min` and `size.preferred`). An install from the store
takes the exact version and checks npm's integrity for it against the
catalogue's.

The catalogue is data too: https://kioskolcd.dev/store/v1/index.json (its
schema at /store/v1/schema/index.json), one file per plugin at
/store/v1/plugins/<id>.json and the withdrawn versions at
/store/v1/withdrawn.json. It is built by `scripts/store/build-index.ts`; the
design and the phases ahead (listing by PR, verified publishers, signed
catalogue, ratings) are in docs/es/tienda.md.

Publish from CI with npm's *trusted publishing* (the release workflow
`kiosko plugins new` writes): your releases get provenance, which the store
will show.


## Animations

A widget can ask for short animations inside its own tile (a tail flick, a
cat walking to a new spot) with `animation`. The page does not move: the other
tiles come from the cache, and what is sent are full-screen frames.

```ts
defineWidget({
  id: 'cat',
  // ...
  animationGap: { minMs: 15_000, maxMs: 40_000 },
  animationCooldownMs: 10_000,
  animation: ({ trigger, data, prev, rnd }) =>
    trigger === 'idle' ? { id: 'tail', frames: 13, fps: 12, params: { who: pick(data, rnd) } }
    : moved(prev, data) ? { id: 'walk', frames: 15, fps: 12, params: { from: prev } }
    : null,
  render(g, ctx) {
    const a = ctx.anim;           // undefined: paint the widget at rest
    // a.plan.id / a.plan.params say what, a.t (0..1) says how far.
  },
});
```

- **`render` must be a pure function of its context**, and at `t = 0` and `t = 1` it must give exactly the still picture. No `Math.random` (use `ctx.rnd` in `animation` and put the result in `params`).
- **Frames are painted before the first is sent**, with the clock, data and sources the page had when it started. The editor's preview never animates.
- **`interruptible`** (default `true`): new data cancels the animation and the screen repaints with it. `false` plays it to the end (something urgent). **`hold: { at, ms }`** stays still at that point, until interrupted.
- **Budget.** Every frame is a full-screen image over USB (and a copy on disk with `trcc serve`). The screen's `maxFps` caps the rate; late frames are skipped, not queued. At most 600 frames. An invalid plan is logged and ignored.
- **Several widgets can want to animate.** You don't have to know: ask as if yours were the only one. The runtime plays them one after another today (the limit is `Runtime.maxConcurrent`; with a higher one they share one timeline at the fastest `fps`, each advancing at its own rate, and a `hold` is ignored). Don't rely on either.
- An interlude and an animation never overlap: the screen does one thing at a time.

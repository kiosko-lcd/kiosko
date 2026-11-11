# Writing Kiosko plugins

A plugin is one ES module whose default export is `definePlugin({...})`. It can
contribute **widgets** (paint inside a tile), **sources** (shared data) and
**interludes** (full-screen animations). Built-in plugins use exactly the same
contract, so `plugins/*` in this repository are the best examples.

## Where plugins live

| OS | Folder |
|---|---|
| Linux | `~/.config/kiosko/plugins/` (or `$XDG_CONFIG_HOME/kiosko/plugins`) |
| macOS | `~/Library/Application Support/Kiosko/plugins/` |
| Windows | `%APPDATA%\Kiosko\plugins\` |

Each plugin is a folder with an `index.js` (or a `package.json` whose
`"kiosko": { "plugin": "./entry.js" }` or `main` points at it), or a package
installed there with npm named `kiosko-plugin-*`. Restart Kiosko after adding
one. `import … from '@kiosko/sdk'` (and `@loksly/lcd-canvas-kit`,
`@loksly/weather-astro`, `@napi-rs/canvas`) resolve to Kiosko's own copies, so
a plugin needs no `npm install` of its own.

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
them. Every polled source (one with `read`) also accepts `intervalMs` and
`timeoutMs` in `sources["plugin/source"]`, shown in Settings → Data sources
and in the config schema: Kiosko clamps the interval to `minIntervalMs`
(default 5 s, or `intervalMs` if shorter), and aborts `ctx.signal` when a
read takes longer than `timeoutMs` (default 2 min); the read then counts as
failed and is retried within a minute. Don't add options of your own for
either; `ctx.intervalMs` and `ctx.timeoutMs` tell you the values in use. (A
source that still has an option with one of these names keeps it, with its
own meaning, and Kiosko uses the definition's value instead: drop the option
to hand it over.)

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
- **Texts** are `{ en, es }`; `align` offers `left`, `center` and `right`.

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

## Testing your plugin

```sh
node --conditions=source scripts/render-widgets.ts --entry path/to/plugin/index.js --out tmp/w --size 600x300
```

renders every widget with its demo data and reports errors. In unit tests,
`createBaseContext({ now, locale })` builds the host-independent part of a
context (`t`, `fmt`, `workday`, `location`…), so a hand-made context only adds
what the test is about. In the editor,
**Plugins** lists load problems, and a widget that throws shows its error in
its tile without breaking the rest of the frame.

## Publishing

Name the package `kiosko-plugin-<name>`, add `"kiosko": { "plugin": "./index.js" }`
to its `package.json`, and list `@kiosko/sdk` as a peer dependency. Users
install it from **Plugins → Install from npm** (installed with
`--ignore-scripts`).


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

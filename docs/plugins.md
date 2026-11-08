# Writing Tessera plugins

A plugin is one ES module whose default export is `definePlugin({...})`. It can
contribute **widgets** (paint inside a tile), **sources** (shared data) and
**interludes** (full-screen animations). Built-in plugins use exactly the same
contract, so `plugins/*` in this repository are the best examples.

## Where plugins live

| OS | Folder |
|---|---|
| Linux | `~/.config/tessera/plugins/` (or `$XDG_CONFIG_HOME/tessera/plugins`) |
| macOS | `~/Library/Application Support/Tessera/plugins/` |
| Windows | `%APPDATA%\Tessera\plugins\` |

Each plugin is a folder with an `index.js` (or a `package.json` whose
`"tessera": { "plugin": "./entry.js" }` or `main` points at it), or a package
installed there with npm named `tessera-plugin-*`. Restart Tessera after adding
one. `import … from '@tessera/sdk'` (and `@loksly/lcd-canvas-kit`,
`@loksly/weather-astro`, `@napi-rs/canvas`) resolve to Tessera's own copies, so
a plugin needs no `npm install` of its own.

## A widget

```js
import { definePlugin, defineWidget, t } from '@tessera/sdk';

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
| `fetch(ctx)` | Async, in Node, per widget instance, every `intervalMs`. Never blocks a frame. Throw on failure: the last good data stays. |
| `render(g, ctx)` | Synchronous and fast. Paint inside `ctx.box`; the tile is clipped for you. |
| `redraw` | `'never'` (default: only when data changes), `'minute'`, `'second'` or `{ everyMs }`. Fewer frames are fewer USB transfers. |
| `visible(ctx)` | `false` when there's nothing to show: the widget is skipped in its tile's rotation. |
| `urgent(ctx)` | `true` while it needs the user: it keeps its tile. |
| `idle(ctx)` | `true` when there's nothing worth lighting the panel for (with *sleep when idle*, the panel goes black when every widget agrees). |
| `demo(ctx)` | `{ data?, sources?, options? }` sample content. Make it look real; it's what people see first. |

### The render context

`ctx.box` `{x,y,w,h}` · `ctx.options` · `ctx.data` · `ctx.sources` · `ctx.now` ·
`ctx.theme.colors` (`bg surface surfaceEdge ink inkDim inkFaint accent alert
warn info ok`) · `ctx.theme.fonts` (`sans sansBold mono monoBold`) ·
`ctx.kit` (text with tracking and small caps, `truncate`, `fitSize`,
`wrapLines`, `sparkBars`, weather and moon icons…) · `ctx.canvas`
(`createCanvas`, `loadImage`) · `ctx.locale` and `ctx.t({ en, es })` ·
`ctx.preview` (true in the editor) · `ctx.working` (work hours).

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
t.string({ default, label, help, placeholder, multiline, secret, format: 'url'|'path'|'time'|'date' })
t.number({ default, min, max, step, unit, slider })   t.integer({...})
t.duration({ default })            // milliseconds, edited as s/min/h
t.boolean({ default })
t.enum(['a', 'b'], { labels: { a: 'First' } })
t.color({ default: '#ff8800' })
t.list(item, { max })              t.object({ ...fields })      t.map()   // string → string
```

Every field takes `label`, `help` and `advanced` (hidden behind "Advanced").
`secret: true` masks the value in the editor. Unknown keys in the user's config
are kept, wrong types fall back to the default; `validate` never throws.

## Shared sources

```js
import { defineSource } from '@tessera/sdk';

export const queue = defineSource({
  id: 'queue',
  name: 'Build queue',
  options: t.object({ url: t.string({ format: 'url' }) }),   // edited once, in Settings → Data sources
  intervalMs: 15_000,
  async read({ options, signal }) { /* return data */ },
  // or push-based: watch(ctx, emit) { const w = fs.watch(…, () => emit(…)); return () => w.close(); }
  demo: () => ({ jobs: [] }),
});
```

A source runs only while some enabled widget declares it, once for all of them.

## Interludes

```js
import { defineInterlude } from '@tessera/sdk';

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

renders every widget with its demo data and reports errors. In the editor,
**Plugins** lists load problems, and a widget that throws shows its error in
its tile without breaking the rest of the frame.

## Publishing

Name the package `tessera-plugin-<name>`, add `"tessera": { "plugin": "./index.js" }`
to its `package.json`, and list `@tessera/sdk` as a peer dependency. Users
install it from **Plugins → Install from npm** (installed with
`--ignore-scripts`).

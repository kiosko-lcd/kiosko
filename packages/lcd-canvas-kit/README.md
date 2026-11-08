# @loksly/lcd-canvas-kit

Drawing helpers for small, always-on LCD panels, on top of
[`@napi-rs/canvas`](https://github.com/Brooooooklyn/canvas). Extracted from a
dashboard that has been running 24/7 on a 1920×462 Thermalright panel.

- **Text**: tracked (letter-spaced) text and small caps drawn glyph by glyph,
  truncation with an ellipsis, fitting a size to a width, and word-wrapped
  paragraphs with a hard line limit (`drawTracked`, `measureTracked`,
  `truncate`, `fitSize`, `drawClipped`, `wrapLines`). Register fonts by path
  under your own family names with `registerFontFiles`.
- **Paint primitives**: colour mixing, a seeded RNG (mulberry32), a stable
  string hash (FNV-1a), ellipses and gradients. Deterministic, so rendered
  sprites can be cached and previews are reproducible.
- **Sparkline geometry** (`sparkBars`): pure maths, no canvas, easy to test.
- **Pixel shift** against image retention (`pixelShift`): moves the layout a
  pixel or two on a slow cycle, invisible from a metre away.
- **Weather and moon icons** drawn with paths (`drawWeatherIcon`,
  `drawMoonPhase`), for the icon kinds of
  [`@loksly/weather-astro`](../weather-astro): system fonts rarely have reliable
  weather glyphs, and an empty box on a panel is worse than no icon.
- **Frame sinks**: a `FrameSink` interface and `FileSink`, which writes each
  frame atomically for another process to forward to a device.

## Install

```sh
npm install @loksly/lcd-canvas-kit @napi-rs/canvas
```

`@napi-rs/canvas` is a peer dependency, so your app controls its version.
Node.js 20 or newer. ESM only.

## Usage

```ts
import { createCanvas } from '@napi-rs/canvas';
import { drawTracked, registerFontFiles, setDefaultFamily, wrapLines, pixelShift, drawWeatherIcon } from '@loksly/lcd-canvas-kit';

const missing = registerFontFiles({ Cond: '/usr/share/fonts/truetype/dejavu/DejaVuSansCondensed-Bold.ttf' });
if (missing.length) throw new Error(`missing fonts: ${missing}`);
setDefaultFamily('Cond');

const canvas = createCanvas(1920, 462);
const ctx = canvas.getContext('2d');
const shift = pixelShift(Date.now(), { enabled: true, amplitude: 2, periodMs: 8 * 60_000 });
ctx.translate(shift.x, shift.y);

drawTracked(ctx, 'Waiting', 40, 80, { size: 28, smallCaps: true, tracking: 2, color: '#FFB020' });
for (const [i, line] of wrapLines(ctx, longMessage, 400, 3, { size: 20 }).entries()) {
  drawTracked(ctx, line, 40, 130 + i * 26, { size: 20, color: '#D3DFEA' });
}
drawWeatherIcon(ctx, 'sun-cloud', 1800, 80, 64, '#FFD08A');
```

## Contributing

This package lives in the [aimonitor](https://github.com/Loksly/aimonitor)
repository under `packages/lcd-canvas-kit`. Issues and pull requests are
welcome there. Run `npm test` from the package directory (the text tests need
the DejaVu fonts: `fonts-dejavu-core` on Debian/Ubuntu).

## License

MIT

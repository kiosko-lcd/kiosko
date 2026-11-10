# Contributing

Thanks for wanting to make Kiosko better.

- **New widget?** Most ideas fit in a plugin, and plugins don't need to live in
  this repository: publish it as `kiosko-plugin-<name>` (see
  [docs/plugins.md](docs/plugins.md)). Built-in plugins are for things most
  panel owners want.
- **Bug?** Open an issue with the output of `kiosko doctor`.
- **Code:** `npm install`, then `npm run dev`. Before a pull request:
  `npm run check && npm test`. For widgets, render them with
  `node --conditions=source scripts/render-widgets.ts --plugin <id>` and look
  at the PNGs at their smallest declared size; `--widget`, `--size WxH`,
  `--options '{"rows":2}'`, `--empty` and `--data`/`--sources` files try
  other sizes, options and data (see the script's header).
- **README screenshots:** `scripts/screenshots-docker.sh` retakes
  `docs/img/*.jpg` from the showcase config in demo mode, inside the official
  Playwright container (needs Docker; nothing is installed on your machine).
- **Browser demo** (`https://kioskolcd.dev/demo/`): after touching the editor,
  the core or a plugin, `scripts/demo-check-docker.sh` builds it and drives it
  in Chromium, Firefox and WebKit, the same way. A plugin must not do Node
  work (files, processes, sockets) when it is imported or when it paints its
  demo data: the demo runs it in a browser.

Conventions: TypeScript run directly by Node (type stripping, so no enums,
namespaces or constructor parameter properties), ESM only, `.ts` extensions
in imports, comments in English, user-facing texts in English and Spanish.

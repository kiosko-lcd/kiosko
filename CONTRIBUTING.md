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
- **The site** (`https://kioskolcd.dev/`): `npm run web:site` builds all of
  it into `site/` (the front page from `packages/web/landing`, the gallery,
  the demo, the 3D page and the config schema); serve that folder to look
  at it (`python3 -m http.server -d site`). The front page tells its story
  as it is scrolled, over the 3D panel; one of its sections frames the
  demo's editor driving itself (`packages/web/src/demo/tour.ts`,
  `demo/?tour=1`). Its texts are in the page in English and Spanish: change
  both. `scripts/demo-check-docker.sh` checks it too, without WebGL (the
  panel is then a picture); look at the 3D itself on a machine with a GPU.
  Two pictures of the 3D panel are kept in the repository, because taking
  them needs that GPU: the one shown with the site's link when it is shared
  (`packages/web/landing/card.jpg`, retaken with
  `node scripts/panel3d-film.mjs --card`) and the README's moving one
  (`docs/img/panel-3d.webp`; the same script's header says how). Retake them
  when the panel or the front page's headline changes.
- **The panel in 3D** (`https://kioskolcd.dev/demo/3d/`, `packages/web/panel3d`):
  built with the demo. A software renderer is far too slow for it, so it is
  checked with a Chrome on your own machine and its GPU:
  `node scripts/panel3d-film.mjs hero= stack="panels=3"` takes pictures into
  `out/`, and `--seconds 10 cats="widget=cats/room"` films. Look at them.

Conventions: TypeScript run directly by Node (type stripping, so no enums,
namespaces or constructor parameter properties), ESM only, `.ts` extensions
in imports, comments in English, user-facing texts in English and Spanish.

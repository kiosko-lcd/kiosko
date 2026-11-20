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
  `demo/?tour=1`). It is built once per language (`/`, `/es/`, `/zh-Hant/`,
  `/zh-Hans/`, see `packages/web/landing/pages.mjs`); its words are in
  `packages/web/landing/i18n/<language>.json`, one file per language with the
  keys of `en.json`: change every file, and the test
  (`packages/web/landing/pages.test.ts`) says which one lacks a text or
  mixes Traditional and Simplified Chinese. `scripts/demo-check-docker.sh`
  checks it too, without WebGL (the panel is then a picture); look at the 3D
  itself on a machine with a GPU.
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

## Translations

Kiosko speaks English, Spanish, Traditional Chinese (`zh-Hant`) and
Simplified Chinese (`zh-Hans`). Adding a language, or fixing one, is welcome
and needs no knowledge of the code beyond finding the texts. A few rules
first:

- **Language tags are BCP 47:** `fr`, `pt-BR`, `de`. Chinese goes by script,
  not by country: `zh-Hant` (Taiwan, Hong Kong) and `zh-Hans` (mainland
  China), never a bare `zh`. Kiosko picks the closest one a text has
  (`pickLocale` in `packages/sdk/src/i18n.ts`) and falls back to English, so
  English must always be complete.
- **Translate, don't convert.** Two variants of a language are two
  translations: Taiwan and the mainland use different words (設定/设置,
  螢幕/屏幕, 外掛/插件), so converting one script into the other is not
  enough. Use the words people there see in their own software.
- **Keep what the code fills in**: `${...}` in template literals (their
  order may change), `{name}` placeholders, `\n`, and the quotes of the
  original string.
- **Panel labels are tiny**: keep them as short as the English. Help texts
  and descriptions are normal prose. For Chinese, Japanese and Korean,
  full-width punctuation and a space between CJK and Latin letters or digits
  (`5 分鐘`).
- **Ask a native speaker to review** before it ships, and say in the pull
  request whether you are one.
- **Other writing systems**: the panel draws Latin, Greek, Cyrillic and CJK
  (CJK with the system's font, see `kiosko doctor`). Arabic, Hebrew (right
  to left), Thai or Devanagari need font and layout work first: open an
  issue before translating.

### The editor (the administration page)

1. **Its words** are in `packages/web/src/i18n.ts`: copy the `es`
   dictionary as a new `const` typed `Record<Key, string>`, translate it,
   and add a line to `UI_LANGUAGES` with its tag and its name in itself
   (`{ id: 'fr', name: 'Français', texts: fr }`). The language picker in
   Settings comes from that list, and `npm run check` names every key you
   haven't translated yet. `err.*` and `device.*` are what the server and
   the panels report (failed requests, connection status): the server
   sends a code and its params, the editor words them.
2. **Times on the panel and in the editor** ("5 min ago", "1 h 05",
   AM/PM): the `WORDS` table in `packages/sdk/src/format.ts`, with its own
   units and whether AM/PM goes before the time. Add a case to
   `format.test.ts`.
3. **Option labels and help every plugin shows** (lists, filters, place,
   refresh…), the settings' schema and the first screen: the `{ en, es, … }`
   texts in `packages/sdk/src`, `packages/core/src/config` and
   `packages/server/src/starter.ts`.
4. **The built-in plugins** (`plugins/core`, `plugins/legacy`): as any
   plugin, below.
5. **The browser demo's banner** (`packages/web/src/demo/ui.tsx`, `TEXTS`)
   and the **3D page** (`packages/web/panel3d/main.ts`, `TEXTS`).
6. **The site**: see "The site" above (`packages/web/landing/i18n/`, plus a
   line in `LANGS` in `packages/web/landing/pages.mjs`).

### A plugin

Each official plugin lives in its own repository
(`kiosko-lcd/kiosko-plugin-<id>`); a pull request there for each plugin.
Third-party plugins work the same way.

1. **Declare the language** in `definePlugin` (`languages: ['en', 'es',
   'fr']`) and in package.json (`"kiosko": { "languages": [...] }`).
2. **Find what to translate**: every text is a `{ en: '…', es: '…' }`
   object in `src/` (`grep -rn "es: " src`); add your tag next to the
   others, `fr: '…'`. `kiosko plugins check --src` in the plugin's folder
   names the ones of its definition (names, descriptions, options) that
   still lack it; the ones painted on the panel are found by that search.
3. **Tables picked by language**: a few plugins keep longer texts in one
   table per language (the cats' words in `src/words.ts` and
   `src/prop-texts.ts`, mirror's compliments, the news plugin's sample
   headlines, Home Assistant's sample home). Add a table and pick it with
   `ctx.t({ en: 'en', es: 'es', fr: 'fr' })` as the others do.
4. **Check it**: `npm test`, `npm run check`, and `kiosko plugins check
   --src` again, which also paints every widget in every declared language
   and says if one throws or paints outside its box. Then `kiosko plugins
   manifest --src` to update `kiosko-manifest.json`.

### Seeing it

`kiosko gallery --locale fr --out tmp/gallery-fr` paints every widget of
the installed plugins in your language: look at the pictures, since no check
sees a text that is cut, too small to read or still in English.
In the editor, pick the language in Settings, or set `"locale": "fr"` in
the config.

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
in imports, comments in English, user-facing texts in every language Kiosko
speaks (see Translations).

## Translations

Kiosko speaks the languages listed in `packages/sdk/src/languages.ts`:
English, Spanish, Traditional Chinese (`zh-Hant`) and Simplified Chinese
(`zh-Hans`) today. Adding a language, or fixing one, is welcome and needs no
knowledge of the code beyond finding the texts.

### Rules

- **Language tags are BCP 47:** `fr`, `pt-BR`, `de`. A language written in
  two scripts goes by script, not by country: `zh-Hant` (Taiwan, Hong Kong)
  and `zh-Hans` (mainland China), never a bare `zh`; `sr-Latn`/`sr-Cyrl`.
  Kiosko picks the closest one a text has (`pickLocale` in
  `packages/sdk/src/i18n.ts`: same language and script, then region) and
  falls back to English, so English must always be complete.
- **Translate, don't convert.** Two variants of a language are two
  translations: Taiwan and the mainland use different words (設定/设置,
  螢幕/屏幕, 外掛/插件), so converting one script into the other is not
  enough. Use the words people there see in their own software;
  `docs/i18n-glossary.md` lists the ones Kiosko's Chinese uses.
- **Keep what the code fills in**: `${...}` in template literals (their
  order may change), `{name}` placeholders, `\n`, and the quotes of the
  original string.
- **Counts** have a form per plural rule: `.one`/`.other` in the editor's
  dictionaries and `-one`/`-other` in the site's, plus `zero`, `two`,
  `few`, `many` where your language's rules have them (Polish, Russian,
  Arabic); in plugins, `ctx.plural(n, { en: { one, other }, pl: { one, few,
  many, other } })`. Never `n === 1 ? … : …`.
- **Panel labels are tiny**: keep them as short as the English. Help texts
  and descriptions are normal prose. For Chinese, Japanese and Korean,
  full-width punctuation and a space between CJK and Latin letters or digits
  (`5 分鐘`). Kiosko never paints CJK smaller than can be read on the panel
  (Screens → Read from), so a long label may need a bigger tile.
- **Ask a native speaker to review** before it ships, and say in the pull
  request whether you are one.
- **Writing systems**: the panel draws Latin, Greek, Cyrillic, CJK, Thai,
  Indic, Georgian, Armenian and Ethiopic with the system's fonts (`kiosko
  doctor` says which); right-to-left languages (Arabic, Hebrew) get `dir` in
  the editor and the site, but the panel does not lay them out right to
  left yet: open an issue first.

### Adding a language

1. **Add it to `packages/sdk/src/languages.ts`**: its tag, its name in
   itself, the locale the site's samples are painted in, its Open Graph
   locale, `hreflang` and direction. Everything that lists languages reads
   this: the editor's picker, the site's pages and redirect, the gallery.
2. **Run `npm test`.** `packages/web/landing/languages.test.ts` then lists
   everything the language still lacks, and the steps below fill it in:
   - the editor's dictionary: copy `packages/web/src/lang/en.ts` to
     `lang/<tag>.ts`, translate it, and add it to `lang/index.ts`
     (`npm run check` names the keys still missing);
   - the browser demo's banner (`packages/web/src/demo/texts.ts`) and the 3D
     page's words (`packages/web/panel3d/texts.ts`);
   - the panel's words for times (`WORDS` in `packages/sdk/src/format.ts`:
     "5 min ago", "1 h 05", AM/PM and where it goes);
   - the site: `packages/web/landing/i18n/<tag>.json` with the keys of
     `en.json` (`pages.test.ts` checks them);
   - every `{ en, es, … }` text in `packages/sdk/src`, `packages/core/src`,
     `packages/server/src`, `packages/web` and the built-in plugins
     (`plugins/core`, `plugins/legacy`, which also declare it in
     `languages`): the test names each file and line.
3. **The installer** (`installer/kiosko.iss`): an Inno Setup language file
   and the `[CustomMessages]` in it; and, if you like, the guides in
   `docs/<tag>/` (install.md, usb.md: the site links them when they exist).
4. **The official plugins**, each in its own repository
   (`kiosko-lcd/kiosko-plugin-<id>`), as below.

### A plugin

1. **Declare the language** in `definePlugin` (`languages: ['en', 'es',
   'fr']`) and in package.json (`"kiosko": { "languages": [...] }`).
2. **Find what to translate**: every text is a `{ en: '…', es: '…' }`
   object in `src/` (`grep -rn "es: " src`); add your tag next to the
   others, `fr: '…'`. `kiosko plugins check --src` in the plugin's folder
   names the ones of its definition (names, descriptions, option labels,
   help and choices) that still lack it; the ones painted on the panel are
   found by that search. Errors a user can act on are
   `throw new PluginError({ en, es, fr })`.
3. **Tables picked by language**: a few plugins keep longer texts in one
   table per language (the cats' words in `src/words.ts` and
   `src/prop-texts.ts`, mirror's compliments, the news plugin's sample
   headlines and default feeds, Home Assistant's sample home). Add a table;
   they are picked with `ctx.pickLanguage(Object.keys(TABLES))`.
4. **Check it**: `npm test` (the plugin's own check paints every widget in
   every language it declares; tests that compare whole `{ en, es }`
   objects need your key too), `npm run check`, and `kiosko plugins check
   --src`, which also says if a widget throws or paints outside its box.
   Then `kiosko plugins manifest --src` to update `kiosko-manifest.json`.

### Seeing it

`kiosko gallery --locale fr --out tmp/gallery-fr` paints every widget of
the installed plugins in your language (a plugin you are translating must
be built, `npm run build`, and linked, `kiosko plugins link`, or the
gallery shows its published version). Look at the pictures: no check sees
a text that is cut, crowded or still in English. In the editor, pick the
language in Settings, or set `"locale": "fr"` in the config; **Real size**
on the stage shows the panel as big as it is.

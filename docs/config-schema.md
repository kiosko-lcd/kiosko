# The config schema, `validate` and `import`

Kiosko keeps everything in one file, `config.json` (`~/.config/kiosko` on
Linux, `~/Library/Application Support/Kiosko` on macOS, `%APPDATA%\Kiosko` on
Windows). Its shape is described by a JSON Schema, so an editor can check and
complete it, and an AI assistant can write one for you. Kiosko then reviews
that file before using it.

## The schema

The stable address is **<https://kioskolcd.dev/schema/v1/config.json>**
(JSON Schema draft 2020-12, with the official plugins). Kiosko writes it at
the top of every config it saves:

```json
{
  "$schema": "https://kioskolcd.dev/schema/v1/config.json",
  "version": 1,
  …
}
```

so VS Code and other editors validate and complete the file on their own.

What it describes:

- the structure: `screens` → `pages` → `tiles` → `widgets`, plus `devices`,
  `grid`, `interludes`, `sources`, `plugins`, `theme`, `locale`, `location`,
  `workday` and `server`, with defaults and descriptions;
- one branch per widget type (`"type": "core/clock"`), whose `options` come
  from the plugin's own option schema, with titles, descriptions and the
  panel size the widget needs (`x-size`, in pixels);
- one property per shared source under `sources`, and one branch per
  interlude;
- `x-secret: true` on secrets (tokens, private calendar addresses): leave them
  empty or as a placeholder such as `"<token>"`; Kiosko keeps the value it has
  or asks for it in the editor;
- `x-risk` on values that **run programs** (`exec`), **contact hosts**
  (`network`) or **read local paths** (`path`).

`kiosko config schema` prints the same schema with the plugins installed on
your machine, third-party ones included. If you use plugins of your own,
save it and point `$schema` at that file instead:

```sh
kiosko config schema --out ~/.config/kiosko/config.schema.json
```

## Checking a config: `kiosko config validate`

```sh
kiosko config validate ai-config.json          # or - to read stdin
kiosko config validate ai-config.json --json   # for tools
```

It checks the file against the schema and against what Kiosko would make of
it (tiles that don't fit the grid or overlap, repeated ids, tiles too small
for their widget, option names no plugin knows). Errors exit with status 1;
warnings don't. Each line is a JSON path and what to change, so it can be
pasted back to the AI that wrote the file:

```
ai-config.json: 3 errors, 1 warning

Errors (Kiosko would misread these):
  screens[0].width: must be a whole number; got the text "1920"
  screens[0].pages[0].tiles[0].widgets[0].type: unknown type "core/clok" (did you mean "core/clock"?)
  screens[0].pages[0].tiles[1].widgets[0].options.seconds (core/clock): must be true or false; got the text "yes"

Warnings (harmless, but worth a look):
  screens[0].pages[0].tiles[1].widgets[0].options.timezone: is not an option of core/clock, so it is ignored. Its options: seconds, hour12, showDate, color, align
```

A file pasted from a chat inside a ```` ```json ```` block is read anyway.

## Using it: `kiosko config import`

```sh
kiosko config import ai-config.json            # dry run: shows, writes nothing
kiosko config import ai-config.json --apply    # backs up, then uses it
```

The dry run validates the file, then shows:

- **Changes**: screens, pages and tiles added, removed or changed, sources
  and settings changed (option names, never their values);
- **Preview**: a PNG of every page, painted with sample data, in a temporary
  folder (`--preview dir` to choose it, `--no-preview` to skip);
- **Values to review**: every value that runs programs, contacts hosts or
  reads paths, grouped that way; `NEW` marks the ones your current config
  doesn't have;
- **Secrets**: which are kept from your current config and which are left to
  fill in the editor.

```
Changes: 2 settings changed, 2 sources added, 1 screen changed, 1 page removed, 1 page added, 1 interlude removed
  ~ theme: "midnight" → "aurora"
  ~ location: unset → {"latitude":40.4168,"longitude":-3.7038,"name":"Madrid"}
  + source gitlab/merge-requests (host, token)
  + source news/deck (feeds)
  ~ screen "Desk"
    - page "Home": 4 tiles (agents/sessions, core/clock, weather/forecast, mirror/compliments, usage/rail, vitals/vitals, +1 more)
    + page "Work": 4 tiles (core/clock, calendar/next, gitlab/reviews, news/headline)
    - interlude agents/runner every 15 min (off)
  kept from your current config (the file leaves them out): locale, workday, plugins, server

Preview (sample data: nothing was read, run or fetched)
  /tmp/kiosko-import-20261109-130412/1-desk--1-work.png  Desk › Work, 1920×462

Values to review (2 new; NEW = not in your current config)
  Runs programs (exec): none
  Contacts hosts (network)
         sources["calendar/events"].urls[0] = https://outlook.office365.com/… (secret, rest hidden)
    NEW  sources["news/deck"].feeds[0].url = "https://feeds.bbci.co.uk/news/rss.xml"
    NEW  sources["gitlab/merge-requests"].host = "gitlab.example.com"
  Reads paths (path): none

Secrets
  kept from your current config:
    sources["calendar/events"].urls[0] (ICS address)
  to fill in the editor (left empty):
    sources["gitlab/merge-requests"].token (Access token)
```

With `--apply` the current file is first copied to
`config.json.bak-<date>-<time>`. If a running Kiosko serves that config (it
is looked for at the `server` address of the config, or `--host`/`--port`),
the new one goes through its API, so the editor and the panels update at
once; otherwise the file is written and Kiosko picks it up when it starts.

## The safety model

A config is not code, but it can make Kiosko run a program (`bin` of the
GitLab or ccusage sources, an ssh host for GPU readings, an aimonitor module),
contact a host (feeds, calendars, API hosts, URLs) or read a file. Importing
is built so you see all of that before it happens:

- **Nothing runs during the review.** Validation and the diff only read the
  two files; the preview paints sample data and leaves out background
  images, so no source, fetch, program or URL is touched.
- **Every risky value is listed**, marked `NEW` when your current config
  doesn't already have it. Plugins mark these options with `risk` (see
  [plugins](plugins.md#options-schema-t)); defaults a plugin ships, such as
  the `glab` command, are not repeated.
- **Secrets stay where they are.** An empty or placeholder secret (`""`,
  `<…>`, `${…}`, `TODO`, `CHANGEME`, `your-token`…) keeps your current value
  for the same field, matched by widget, screen or interlude id or by source
  type, so moving a widget doesn't lose its token. It is kept only while the
  host or URL next to it is unchanged, so a token never follows a new address
  to another server; otherwise it is left empty for you to fill in. Secrets
  are shown by host only.
- **What the file leaves out is kept**: location, server address, locale,
  work hours, disabled plugins and the options of sources it doesn't mention.
- **Nothing is written without `--apply`**, and an invalid file is never
  applied. The previous config is always one copy away.

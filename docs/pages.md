# Pages: turns, pins and context pages

A screen can have several pages: a dashboard, a cats room, a page for games.
This guide covers which one is on the panel at each moment.

## How pages take turns

- **Turns.** The enabled pages take turns, each for its own *Time on screen*
  (`durationMs`, 10 minutes by default), against the wall clock: two Kiosko
  machines with the same pages show the same one.
- **When.** A page can show *always*, only *in work hours* or only *outside
  them* (`when`, see the work schedule in Settings).
- **Pinned.** The pin on a page's card keeps that page on (`pinnedPage`; Home
  Assistant and the API can pin one too).
- **Interludes** play every so often over whatever page is on, and **alerts**
  take the panel over above everything.

## Widgets in a tile take turns

A tile can hold a **stack** of widgets (drop one onto another in the
editor). They take turns every *Turn length* (`rotateMs`, 30 s by default),
against the wall clock like pages; an urgent one (a meeting about to start)
keeps the tile while it lasts.

- **Nothing to show, no turn.** A widget that has nothing to show passes its
  turn to the others of its tile: an empty list (no reviews, no tasks), one
  whose data hasn't come yet, or one whose source is failing. The error is
  still in the editor and in the widget's status.
- **Never a blank tile.** Alone in its tile, or when none of its tile has
  anything, a widget is shown as always: its empty message, *loading* or the
  error. On the first run, a tile whose widgets are all loading shows the
  first one until another has something.
- **No flicker.** Turns still change on the clock's beat. A widget that runs
  out of things to show gives way after half a turn at the earliest, one that
  comes back waits for the next turn, and whatever comes stays at least half
  a turn.
- **Your call.** In the widget's settings, *When it has nothing to show*:
  **Pass its turn** (the default), **Hide** (also hidden when it is alone in
  its tile, which then shows nothing; only widgets that can tell they are
  empty) or **Always show** (`hideWhenEmpty`: missing, `true`, `false`).

A widget that isn't shown is not painted either: the stack costs no CPU for
the widgets skipped.

## Show this page when…

A page can also come up **by itself** while something is happening: a game
is open, you are in a call, the electricity is expensive, it is Friday
evening, a meeting is about to start. Open the page (click its card, then an
empty spot of the stage) and, in its settings, add a condition under **Show
this page when…**:

| Condition | It holds while… |
|---|---|
| **A program is open** | a process with that name is running. A glob, case-insensitive: `steam*`, `obs*`, `zoom*`; several separated by commas. |
| **A source's value** | a source's data, at a path, compares as you say, for example `calls/active` · `active` · *is on*; `electricity/pvpc` · `now.price` · *is more than* · `0.2`. |
| **A time of day** | local time is in the window, on the days you pick. `22:00` to `07:00` goes across midnight. |
| **A widget here is urgent** | a widget on this page says it is urgent (a meeting about to start, a permission waiting). |

While a condition holds, the page takes the screen over from the turns; when
none holds any more, the turns come back where the clock says. A page with
conditions **only** comes up when they hold, unless you switch on *Also take
turns in the rotation*.

- **Several at once.** Each condition has a **priority**: the highest wins.
  Pages of the same priority take turns among themselves.
- **No flicker.** A context page stays at least 20 s once it came up, and 10 s
  more after its condition stopped holding, in case it holds again (a game
  restarting, a value hovering at the threshold). Both are per screen, under
  *Against flicker*. A higher priority page never waits.
- **What goes first**: an alert, then a pinned page, then a context page,
  then the turns. While a context page is on, scheduled interludes wait.
- **Why is this page on?** Next to the pages, the editor says which page has
  the screen and why: *fixed by: game open (steam)*.

A condition can have a **name** ("game open"): the editor shows it as the
reason. In the config file, one condition can check several things at once;
they must all hold:

```json
"showWhen": [
  { "label": "game open", "priority": 5, "app": "steam*, *.x86_64" },
  { "label": "in a call", "priority": 9, "source": "calls/active", "path": "active" },
  { "time": { "start": "18:00", "end": "23:00", "days": [5, 6] }, "source": "electricity/pvpc", "path": "now.price", "op": "lt", "value": 0.1 }
]
```

Comparisons (`op`): `truthy` (the default without a `value`), `falsy`, `eq`
(the default with one), `ne`, `gt`, `gte`, `lt`, `lte`, `contains`. A source
that has sent no data yet, or a path that isn't there, never holds. The
source runs even if no widget shows it. The screen's margins are
`"context": { "minMs": 20000, "holdMs": 10000 }`.

A source with [profiles](data-sources.md#profiles-one-source-several-configurations) (two news decks, two GitHub
accounts) shows a **Profile** next to it: the condition looks at that
profile's data, and that profile keeps running for it. In the file,
`"profile": "tech"` next to `"source"`; without it, or if the profile is
deleted, the default one.

### Programs on each system

Kiosko lists the running programs every 3 seconds, and only while some
condition needs it, with what any user may read:

- **Linux**: the kernel's name of each process (cut at 15 characters) and the
  name it was started with (`argv[0]`, the full name). If `/proc` is mounted
  with `hidepid`, only your own processes are seen. Games under Steam's
  Proton usually show up as their `.exe` (`*.exe` matches them all).
- **macOS**: the executable's name and its app's (`zoom.us`, `OBS`).
- **Windows**: the image name, with or without `.exe` (`steam.exe`,
  `steam`).

Only names are read, never command lines. Programs in a container or on
another computer aren't seen.

### Not yet

A meeting that starts, a webhook or a screen starting to stream are not
conditions of their own yet; the calendar's widget being urgent, or a source
with that value, cover some of it.

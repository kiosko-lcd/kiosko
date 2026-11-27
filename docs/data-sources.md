# Data sources and profiles

Many widgets don't fetch their data themselves: they read a **shared data
source** (`plugin/source`), read once for every widget that uses it. The news
deck (`news/deck`), the weather, your calendars, a Home Assistant: each is a
source. Their settings live in the editor under **Settings → Data sources**;
each line says how often it is read and how its last reading went.

A source runs only while some widget on an enabled screen uses it. Those that
can raise alerts (weather warnings, earthquakes) can also run with no widget:
**Watch for alerts without a widget**.

## Profiles: one source, several configurations

Some sources can have **profiles**: several named configurations of the same
source, each with its own options and read on its own. One screen shows
general news and another technology; a tile shows your work GitHub account
and another your own. Sources say whether they have profiles; those that read
something unique on this machine (a battery, a sensor) don't.

- **Settings → Data sources**: a source with profiles shows them as tabs.
  **Default** is the configuration every widget reads unless it picks
  another. **+ Profile** adds one; each tab can be renamed, duplicated or
  deleted (it tells you how many tiles read it; those go back to the default
  one).
- **In a tile**: the inspector shows **Source profile**. Pick one, or
  **New profile…**, which makes a copy of the one the widget reads now, names
  it and lets you change its options right there (**Edit profile**).
- **In a context page**: a *source's value* condition on a source with
  profiles has a **Profile** of its own (see [Pages](pages.md#show-this-page-when)).

Each profile has its own data, interval and status: in a widget's inspector
the data line reads `news/deck#technology`. A profile's options are shared by
every tile that reads it.

### News by topic

The news deck has profiles: «General» with the front pages, «Technology» with
the technology sections (each paper has an RSS per section), «Sports»… Each
profile groups its own stories, so «carried by 4 outlets» counts within the
profile, and a feed that two profiles list is downloaded once.

Without profiles, a news widget can still keep only some stories with
**Topics**: words looked for in the headline and standfirst, comma-separated,
`!` in front to leave out (`fútbol, liga, !apuestas`). Case and accents don't
matter, and a word matches at the start of a word (`ia` finds «IA», not
«familia»).

## In the config file

```json
{
  "sources": { "news/deck": { "feeds": [ { "name": "El País", "url": "https://…/portada" } ] } },
  "sourceProfiles": {
    "news/deck": {
      "technology": { "name": "Technology", "options": { "feeds": [ { "name": "Xataka", "url": "https://www.xataka.com/feedburner.xml" } ] } }
    }
  }
}
```

and in the widget, `"profile": "technology"`. `sources["plugin/source"]` is
always the default profile: a config without `sourceProfiles` works exactly as
before. A widget whose profile is gone reads the default one, and
`kiosko config check` warns about it.

For plugin authors: declare `profiles: true` in the source (see
[Writing plugins](plugins.md#shared-sources)); widgets need no change, they
find the profile's data in `ctx.sources["plugin/source"]`, and `ctx.profile`
tells the source which one it reads.

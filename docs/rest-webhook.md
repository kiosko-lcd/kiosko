# JSON widgets and pushes from scripts

Two ways to put anything on the panel without writing a plugin:

- **JSON from a URL.** Kiosko asks a URL every so often (an API, a status
  page, a sensor on your network) and shows a value from the answer: big with
  its unit and a curve, as a list, or inside a sentence.
- **Pushes.** A script, a cron job, your CI or Home Assistant sends the value
  to Kiosko with one `curl`, whenever it has something to say: the last
  backup, a deploy, the aquarium's temperature.

Both come with Kiosko (the Essentials plugin): **JSON value**, **JSON list**,
**JSON text** and **Push** are in the editor's widget library, under
Development.

## JSON from a URL

Add a **JSON value** widget and fill in:

- **URL**: what Kiosko asks, e.g.
  `https://api.open-meteo.com/v1/forecast?latitude=40.42&longitude=-3.70&current=temperature_2m`
  (free, no key).
- **Path to the value**: where the value is in the answer, e.g.
  `$.current.temperature_2m`. Leave it empty at first: the tile then lists
  the paths it finds in the answer, with their values, so you can copy one.
- **Unit**, **Before the value** (`$`, `€`), **Decimals** and a **Label**.

**JSON list** shows several values, one row each: list the **Fields** (a
label, a path and a unit each), or give the path of a list in the answer
(**Or a list in it**, e.g. `$.items`) and, inside each item, the path of its
label and of its value (`name`, `price`). An object works as a list too:
each key is an item with `key` and `value`.

**JSON text** writes a sentence with values in it:
`Backup {$.status} at {$.finished}`. `{$.items[*].name}` writes them all,
separated by commas; `{{` and `}}` write braces.

### Paths

A small part of JSONPath, read without running any code:

| Path | Finds |
|---|---|
| `$` | the whole answer (plain text, too) |
| `$.current.temperature_2m` | a key, then another (`$` and the first dot are optional: `current.temperature_2m`) |
| `items[0].price` | the first item of a list |
| `items[-1]` | the last one (negative indexes count from the end) |
| `['key with spaces']` | a key with spaces or dots, in quotes (`\` escapes a quote) |
| `items[*].name`, `prices.*` | every item, or every value of an object (for lists and texts) |
| `items.length` | how many items a list has |

Only keys that are really in the answer are read. A path is at most 300
characters and 32 steps, and a wildcard gathers at most 500 values.

### Colours by value

**Colours by value** is a list of rules; the first one that holds gives the
value its colour (green, blue, amber, red, the theme's accent or dim):

| Rule | Holds when the value is |
|---|---|
| `>= 30`, `> 30`, `< 0`, `<= 5` | a number, compared |
| `30` | a number of 30 or more (a bare number means `>=`) |
| `= failed`, `!= ok` | that text (or not), ignoring case; or that number |

In a **JSON text**, **Colour from** says which path the rules look at
(`$.status`); without it they look at the whole sentence.

### The curve

**JSON value** draws the history of its value under it: one point per
refresh, up to **Points in the curve** (60 by default). It is kept in
Kiosko's cache (in memory), so restarting Kiosko doesn't blank it; restarting
the computer does. Set **History curve** to None to show only the value.

### Keys, tokens and headers

Put the key or token in **Secret**: it is masked in the editor and never
logged. By default it goes in the `Authorization` header as it is, so write
the whole value (`Bearer abc123`, `token abc123`). Under the advanced options:

- **Header for the secret**: another header (`X-Api-Key`), or empty.
- `{secret}` written in the URL (`…?apikey={secret}`), in a header value or
  in the body puts it there instead (URL-encoded in the URL).
- **Other headers**, **Method** (GET or POST) and **Body** (sent as JSON
  when it looks like JSON).

Like every secret in Kiosko, it is kept in the config file
(`~/.config/kiosko/config.json` on Linux), readable only by you.

### Refresh, limits and errors

- Each widget asks every minute by default; change it with the widget's
  **Refresh every** (5 seconds at least: mind the API's limits). Two widgets on the
  same URL at the same moment share one request.
- **Give up after** (10 s by default, up to 60 s) and **Largest answer**
  (512 KB by default, up to 5 MB): a longer answer is refused.
- Kiosko introduces itself as `kiosko-core Kiosko (+https://kioskolcd.dev)`,
  sends `If-None-Match`/`If-Modified-Since` back when the server gave an ETag
  or a date, and when a server says "too many requests" (429, `Retry-After`)
  it waits as long as it is told.
- When a request fails, the widget keeps its last value and the editor says
  why under the widget's options, where it shows when its data was updated (`HTTP 404 from api.example.com`,
  `timed out after 10 s`, `response larger than 524288 bytes`).

The URL is something you type, so Kiosko lists it among the hosts the
config contacts (`kiosko config import` shows it before applying a config
written by someone else).

## Pushes from scripts

### Set one up

In **Settings → Push**, type a name (lowercase letters, digits, `-` and `_`,
e.g. `backup`) and press **Add**. Kiosko makes a random token for it and shows
its URL, its token and a `curl` to try it. Then add a **Push** widget to a
page and choose that name.

```sh
curl -X POST -H 'Authorization: Bearer <token>' -H 'Content-Type: application/json' \
  -d '{"value": 42, "text": "Backup finished"}' http://127.0.0.1:7420/api/push/backup
```

**New token** replaces it (scripts with the old one are refused from then on);
the bin icon deletes the name.

### What to send

A JSON object; every field is optional:

| Field | What the Push widget does with it |
|---|---|
| `value` | shows it big (a number or a short word) |
| `text` (or `message`) | a line under it, or alone, as big as it fits |
| `title` | small, on top |
| `unit` | after the value (or the widget's own **Unit**) |
| `level` | `ok` (green), `info` (blue), `warn` (amber), `alert` (red, and the tile stays on screen while it lasts), `critical` (red, and a full-screen alert on the screens that let alerts through) |
| `ttlMs` | how long it counts, in milliseconds (up to 30 days): after that the widget is hidden until the next push |

Plain text (`curl -d 'Deploy done' …`) is taken as `{"text": "Deploy done"}`,
and a form (`-d value=21.5 -d unit=°C`) as an object, numbers as numbers.
JSON is read as JSON whatever the `Content-Type` (plain `curl -d` says it's
a form).

Any other JSON works too: show it with a **JSON value**, **JSON list** or
**JSON text** whose **Or a push name** is that name, and a path into it
(`{"temp": 21.4, "humidity": 48}` with the path `$.temp`). The JSON value's
curve then has one point per push.

### The request

| | |
|---|---|
| `POST /api/push/<name>` (or `PUT`) | the new payload; answers `{"ok": true, "at": …}` |
| `GET /api/push/<name>` | what it has now |
| `DELETE /api/push/<name>` | forgets it |
| Token | `Authorization: Bearer <token>`, or `?token=<token>` in the URL |

Answers: `401` for an unknown name or a wrong token (the same, so names
can't be guessed), `400` for an empty body or broken JSON sent as JSON,
`413` above 64 KB, `429` above 20 requests in a burst and 5 a second after
that, per name (wait for `Retry-After`).

The latest payload of each name, and a short history of them for the curve
(up to 240 or 64 KB), are kept in memory and in `push.json` next to the
config file, so a restart doesn't blank a tile that changes once a day.

### Only on this computer

Kiosko's editor and API listen on `127.0.0.1:7420`, this computer only, and
pushes come in the same way. To push from somewhere else:

- **Run the script here**, where Kiosko runs (cron, a systemd timer, a git
  hook, a self-hosted CI runner).
- **Or bring the port over a tunnel**, from the other machine:
  `ssh -N -L 7420:127.0.0.1:7420 you@kiosko-machine`, then push to
  `http://127.0.0.1:7420/…` there.
- Or a small script here that fetches what it needs and pushes it.

Don't open the port to your network (`server.host: 0.0.0.0`) for this: the
whole editor would be open too.

### Why pushes don't need `X-Kiosko: 1`

Every other request that changes something must carry the `X-Kiosko: 1`
header: a web page you visit can't send it to `127.0.0.1` without the
browser asking Kiosko first, and Kiosko never says yes, so a page can't drive
the editor behind your back (CSRF). A push carries its own secret, the token,
which such a page can't know, so asking for the header too would only make
scripts longer. A push can only set what its name shows; it can't touch the
config, the plugins or anything else. The `Host` check that stops DNS
rebinding still applies.

## Recipes

### The last backup

At the end of the backup script:

```sh
#!/bin/sh
TOKEN=…   # Settings → Push → backup
if restic backup /home; then
  body='{"title": "Backup", "value": "OK", "text": "'"$(date +%H:%M)"'", "level": "ok", "ttlMs": 129600000}'
else
  body='{"title": "Backup", "value": "FAILED", "level": "alert"}'
fi
curl -fsS -X POST -H "Authorization: Bearer $TOKEN" -d "$body" http://127.0.0.1:7420/api/push/backup
```

`ttlMs` of 36 hours: if a night is missed, the tile goes away instead of
saying "OK" about an old backup.

### The deploy

From a deploy script or a self-hosted CI runner on the same machine:

```sh
curl -fsS -X POST -H "Authorization: Bearer $KIOSKO_TOKEN" \
  -d "{\"title\": \"Deploy\", \"value\": \"#$CI_PIPELINE_ID\", \"text\": \"$CI_COMMIT_REF_NAME passed\", \"level\": \"ok\", \"ttlMs\": 3600000}" \
  http://127.0.0.1:7420/api/push/deploy
```

### The aquarium's temperature

A sensor read every 5 minutes by cron (`*/5 * * * *`), shown by a **JSON
value** with **Or a push name** `aquarium`, path `$.temp`, unit `°C`, colours
`< 23` blue and `> 27` red, and its curve:

```sh
t=$(cat /sys/bus/w1/devices/28-*/temperature)
curl -fsS -X POST -H "Authorization: Bearer $TOKEN" -d "{\"temp\": $(echo "scale=1; $t/1000" | bc)}" \
  http://127.0.0.1:7420/api/push/aquarium
```

### Home Assistant

With Home Assistant on the same machine (or the port brought over a tunnel),
a `rest_command` in `configuration.yaml`:

```yaml
rest_command:
  kiosko_doorbell:
    url: http://127.0.0.1:7420/api/push/doorbell
    method: POST
    headers:
      authorization: "Bearer <token>"
    content_type: application/json
    payload: '{"title": "Doorbell", "text": "Someone at the door", "level": "alert", "ttlMs": 120000}'
```

Call it from an automation (`action: rest_command.kiosko_doorbell`). To show
Home Assistant's entities all the time, the Home Assistant plugin is better.

### Windows (PowerShell)

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:7420/api/push/backup `
  -Headers @{ Authorization = "Bearer <token>" } -ContentType application/json `
  -Body '{"value": "OK", "level": "ok"}'
```

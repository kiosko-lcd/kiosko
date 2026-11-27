# Sandbox mode: a throwaway Kiosko

When you test a change, run an end-to-end check or try a plugin on a machine
where Kiosko already runs for real, start the throwaway one as a **sandbox**:

```sh
kiosko start --sandbox                  # a fresh folder in the system temp folder, a free port
kiosko start --sandbox /tmp/try --port 7491 --sandbox-config ~/.config/kiosko/config.json
# from a checkout:
node --conditions=source packages/server/src/cli.ts start --sandbox --demo --open
```

It prints where it is and how long it lives:

```
SANDBOX — this is not the real Kiosko. Everything it writes is in /tmp/kiosko-sandbox-Ab12Cd (removed when it ends; --sandbox-keep keeps it)
SANDBOX — editor at http://127.0.0.1:38211/; ends in 2h
SANDBOX — usb off, remote off, lan off; no self-update, no service, no Home Assistant
```

The editor shows a **SANDBOX** badge (and the tab's title says so), and
`/api/version` answers `{ "version": …, "sandbox": { "dir": …, "expires": … } }`.

`KIOSKO_SANDBOX=<dir>` in the environment does the same as `--sandbox <dir>`
for every command (`kiosko plugins link`, `kiosko gallery`, `kiosko render`…),
so a script can set it once.

## What stays inside

Before anything reads a path, the sandbox points every variable Kiosko, its
plugins and the programs they start use to find folders at its own folder
(`sandboxEnv` in `packages/core/src/sandbox.ts`):

| Inside the sandbox      | What                                                                                   |
| ----------------------- | -------------------------------------------------------------------------------------- |
| `kiosko/`               | `KIOSKO_HOME`: `config.json`, `plugins/`, `data/<plugin>`, the store's cache, `kiosko.log`, push tokens |
| `home/`                 | `HOME`, `USERPROFILE` (so `~`, `os.homedir()`), `APPDATA`, `LOCALAPPDATA`, npm's cache |
| `xdg/config`, `xdg/data`, `xdg/cache`, `xdg/state` | `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`, `XDG_STATE_HOME`   |
| `run/`                  | `XDG_RUNTIME_DIR`: the plugins' RAM caches (`run/kiosko-cache/<plugin>`, `ctx.cacheDir`), Frame files written to `$XDG_RUNTIME_DIR/…` |
| `tmp/`                  | `TMPDIR`, `TMP`, `TEMP` (`os.tmpdir()`)                                                |
| `outside/`              | absolute paths of a config that point outside the sandbox: a Frame file screen's `dir` of `/run/user/1000/kiosko-frames/main` is written to `outside/run/user/1000/kiosko-frames/main`, so the real sender never shows the sandbox's frames |

`AIMONITOR_DIR`, `AGENT_SESSIONS_DIR` and npm's `prefix` are removed. Data
sources that read the home folder (agent traces, a rootless Docker socket in
`$XDG_RUNTIME_DIR`) therefore see the sandbox's empty folders; give them an
explicit path in the config if a test needs them.

The one thing written outside is the list of running sandboxes, in the system
temp folder (`kiosko-sandboxes-<uid>/<pid>.json`).

## What it doesn't do (unless asked)

- **Real panels**: USB panels and `trcc serve` screens are shown in the editor
  only (`--sandbox-allow-usb` drives them); `kiosko usb test` refuses.
- **Remote screens**: no mDNS question on the network, no pairing, no OTA, no
  connection to a paired board (`--sandbox-allow-remote`); `kiosko remote` refuses.
- **The network**: it listens on `127.0.0.1` whatever `--host` or the config
  say (`--sandbox-allow-lan` lets `--host` open it), and doesn't publish to
  Home Assistant. The network-screens server for browser screens too: on
  `127.0.0.1` whatever `networkScreens.host` says, unless `--sandbox-allow-lan`.
- **The default port**: `--port 7420` is refused, since that is the real
  Kiosko's (`--sandbox-force-port` takes it anyway, e.g. inside a container).
  Without `--port` it takes a free one.
- **Your config**: `--config <file>` outside the sandbox is refused (the editor
  would save into it). `--sandbox-config <file>` copies the file into the
  sandbox at start and works on the copy; the file is only read.
- **Updates and services**: "Update Kiosko" is off, no daily question to npm,
  and `kiosko service install|uninstall` refuses.

Commands that talk to "the running Kiosko" (`kiosko editor`, `kiosko plugins
dev`, `kiosko config import --apply`) talk to the sandbox running in that
folder, never to the one on the config's port.

## How long it lives

- `--sandbox-ttl <duration>`: ends by itself after this long, saying why in
  its log (`90s`, `30m`, `2h`, `1d`; `off` for no limit). Default **2 h**;
  also `KIOSKO_SANDBOX_TTL`.
- `--sandbox-exit-with-parent`: ends when the process that started it does
  (a test runner, a script, a shell). Also `KIOSKO_SANDBOX_EXIT_WITH_PARENT=1`.
- `--sandbox-keep`: keep the temp folder it made when it ends (a folder you
  gave it is always kept).

## Finding the ones left running

```sh
kiosko sandbox list            # pid, address, age, time left, folder
kiosko sandbox list --json
kiosko sandbox stop 12345      # or: kiosko sandbox stop all
```

`stop` only signals a process that still answers on its port as that
sandbox (a pid can be reused); `--force` skips that check.

## In tests and scripts

Start it with a port of your own, a short TTL and `--sandbox-exit-with-parent`,
and wait for `/api/version` to answer with `sandbox.dir`:

```sh
node --conditions=source packages/server/src/cli.ts start \
  --sandbox "$dir" --port 37491 --sandbox-ttl 30m --sandbox-exit-with-parent \
  --sandbox-config examples/showcase.json --demo &
until curl -sf http://127.0.0.1:37491/api/version | grep -q '"sandbox"'; do sleep 0.5; done
```

`packages/server/src/sandbox.test.ts` does the same from `node:test`, with a
fake "production" home (`HOME`, `XDG_*`, `APPDATA`… and a Kiosko installed
there) that it checks is left untouched, byte for byte.

# USB sender (Linux, Thermalright LY panels)

> Kiosko now has a **USB** connection of its own (`"driver": "usb"`, see
> [docs/usb.md](../../docs/usb.md)) that does what this sender does without
> Python, and also on Windows and macOS. It is new and has not run against a
> real panel yet; this sender is the one that has been running for months, so
> keep it until the USB connection has been verified on yours.

`trcc serve` can drive only one panel per `VID:PID`, and the Trofeo Vision
9.16″ panels all report `0416:5408`. With two or more of them, give each one
Kiosko's **Frame file** connection and run one sender per panel: it opens
the panel **by USB serial number** with trcc's own LY protocol code and keeps
it showing the `frame.jpg` Kiosko writes (new frames at once, the same one
again every second so the firmware doesn't fall back to its logo).

## Install

```sh
# trcc must be installed with pipx: the sender runs with its Python.
pipx install trcc-linux

install -Dm644 kiosko-sender.py ~/.local/lib/kiosko/kiosko-sender.py
install -Dm644 kiosko-sender@.service ~/.config/systemd/user/kiosko-sender@.service
systemctl --user daemon-reload
```

For each panel, a folder with its config, e.g. `~/.config/kiosko/senders/left/config.json`:

```json
{
  "serial": "2025A1B2C3D4",
  "rotate": 180,
  "frameDir": "$XDG_RUNTIME_DIR/kiosko/left"
}
```

- `serial`: `lsusb -v -d 0416:5408 | grep iSerial`.
- `rotate`: how the panel is mounted. Only checked against what the
  firmware reports; set the same rotation on the screen in Kiosko.
- `frameDir`: the folder of that screen's Frame file connection.
- `wheel` (optional): `{ "dirs": [...], "slot": 0, "hours": 2 }` makes the
  panels take turns showing each folder, to share the wear between them.
- `heartbeat` (optional, default `true`): while its panel is connected the
  sender touches `.heartbeat` in the folder it is showing, every second.

## Pause screens whose panel is unplugged

Give each Frame file screen in Kiosko a `presence`, and a screen whose panel
is unplugged (or whose sender is not running) is paused: no CPU spent on it,
and it comes back with a fresh frame as soon as the panel does
([docs/usb.md](../../docs/usb.md#unplugged-panels-pause-their-screen-presence)):

```json
"device": { "driver": "file", "dir": "$XDG_RUNTIME_DIR/kiosko/left", "presence": { "heartbeat": { "path": ".heartbeat" } } }
```

With `wheel`, use the heartbeat: the folder each panel shows changes every few
hours, and the heartbeat follows it. Without `wheel`,
`"presence": { "usb": { "vendorId": "0416", "productId": "5408", "serial": "<the sender's serial>" } }`
works too and needs nothing from the sender. Update `kiosko-sender.py` before
turning the heartbeat on in Kiosko: an older one never touches it, and the
screen would stay paused.

Then `systemctl --user enable --now kiosko-sender@left`.

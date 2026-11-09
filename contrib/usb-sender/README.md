# USB sender (Linux, Thermalright LY panels)

`trcc serve` can drive only one panel per `VID:PID`, and the Trofeo Vision
9.16″ panels all report `0416:5408`. With two or more of them, give each one
Tessera's **Frame file** connection and run one sender per panel: it opens
the panel **by USB serial number** with trcc's own LY protocol code and keeps
it showing the `frame.jpg` Tessera writes (new frames at once, the same one
again every second so the firmware doesn't fall back to its logo).

## Install

```sh
# trcc must be installed with pipx: the sender runs with its Python.
pipx install trcc-linux

install -Dm644 tessera-sender.py ~/.local/lib/tessera/tessera-sender.py
install -Dm644 tessera-sender@.service ~/.config/systemd/user/tessera-sender@.service
systemctl --user daemon-reload
```

For each panel, a folder with its config, e.g. `~/.config/tessera/senders/left/config.json`:

```json
{
  "serial": "2025A1B2C3D4",
  "rotate": 180,
  "frameDir": "$XDG_RUNTIME_DIR/tessera/left"
}
```

- `serial`: `lsusb -v -d 0416:5408 | grep iSerial`.
- `rotate`: how the panel is mounted. Only checked against what the
  firmware reports; set the same rotation on the screen in Tessera.
- `frameDir`: the folder of that screen's Frame file connection.
- `wheel` (optional): `{ "dirs": [...], "slot": 0, "hours": 2 }` makes the
  panels take turns showing each folder, to share the wear between them.

Then `systemctl --user enable --now tessera-sender@left`.

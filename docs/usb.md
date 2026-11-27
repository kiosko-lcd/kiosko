# Connecting a panel over USB

The **USB** connection (`"device": { "driver": "usb" }`) lets Kiosko talk to
a Thermalright LY panel (Trofeo Vision 9.16 and siblings; USB `0416:5408` and
`0416:5409`) by itself, through libusb. No Python, no `trcc serve`.

```json
"device": { "driver": "usb", "serial": "202592047DAE" }
```

- `serial`: the USB serial number. **With several identical panels it is the
  only thing that tells them apart**, so fill it in. A serial that is not
  found is waited for, never replaced by another panel (taking a twin that
  another process holds would blank it). Empty: the first panel found.
- `keepalive`: seconds between re-sends of an unchanged frame (default 1). The
  firmware shows the factory logo again 2–3 s after the last frame.

`kiosko doctor` lists the panels libusb sees, with their serial numbers, and
the editor's **Screens → Add screen → Detect panels** offers them.

Frames are always JPEG. The firmware keeps up to about 511 871 bytes and drops
anything bigger **silently**; Kiosko reads the panel's acknowledgement and
says so in the screen's status ("the panel dropped a … KB frame: lower the
JPEG quality").

## Unplugged panels pause their screen (presence)

A screen whose panel is not there costs CPU for nobody: its page is composed,
its widgets painted and its frames encoded all the same. So Kiosko **pauses a
screen whose panel is missing**: nothing is composed, painted nor encoded for
it, its interludes, animations and alerts wait, and the sources and fetches
only that screen shows stop. It is looked for again cheaply (after 2 s, 4 s,
8 s… up to every 30 s, and at once on a USB hotplug event: inotify on
`/dev/bus/usb` on Linux, libusb's hotplug events elsewhere) and the screen
**resumes with a fresh, full frame** as soon as the panel is back. The editor
says *Panel disconnected · paused (saving CPU)*, and `kiosko doctor` shows
each Frame file screen's presence. A screen you switched off stays off:
presence is not the screen's on/off switch.

- **USB** connection: automatic. The panel is absent when no LY panel with its
  `serial` (any LY panel, without one) is plugged in. Looked up without
  opening it.
- **Remote screen**: automatic. Offline (no session, no mDNS announcement) or
  not paired is absent; its announcement brings it back at once.
- **Frame file**: Kiosko can't see the panel its sender drives, so tell it how
  with `presence` (without it the screen is always painted, as before):

```json
"device": {
  "driver": "file",
  "dir": "$XDG_RUNTIME_DIR/kiosko/left",
  "presence": {
    "usb": { "vendorId": "0416", "productId": "5408", "serial": "202592047DAE" },
    "heartbeat": { "path": ".heartbeat", "maxAgeMs": 5000 }
  }
}
```

- `usb`: a USB device with this vendor and product id (and serial) is plugged
  in. Read only: on Linux from sysfs, without opening the device at all;
  elsewhere libusb opens it for a moment to read the serial, once per plug,
  and never claims it. The sender keeps the panel undisturbed.
- `heartbeat`: a file the sender touches while it drives the panel; missing or
  older than `maxAgeMs` (default 5000) means absent. A relative path is inside
  `dir`. The sender in `contrib/usb-sender` touches `.heartbeat` in the folder
  it is showing every second while its panel is connected.
- `command`: `{ "argv": ["lsusb", "-d", "0416:5408"], "everyMs": 30000 }`: a
  program (no shell) that exits 0 while the panel is there; run every
  `everyMs` (at least 5 s), killed after 10 s. Listed for review when a config
  is imported, like any value that runs a program.

Several probes: absent if **any** says absent. A probe that can't tell (libusb
missing, a twin whose serial can't be read) says *unknown*, and unknown
screens are painted as always.

In the editor: **Screens → (the screen) → Frame file → Pause when its panel is
unplugged**, and **Detect serials** lists the devices with that VID:PID and
their serials (read only), saying which screen already uses each.

**Identical panels need the serial.** Several Trofeo Vision panels all report
`0416:5408`. Without a `serial`, Kiosko can only tell that *some* panel is
plugged in, never *which*, so it pauses the screen only when **none** is
plugged in. With two of three unplugged and no serials, nothing pauses: that
is on purpose, since pausing a screen whose panel is in fact there would leave
it frozen. `kiosko doctor` lists the serials (`lsusb -v -d 0416:5408 | grep
iSerial` too).

### With the trcc sender (`contrib/usb-sender`)

Each sender drives one panel, chosen by serial, and shows the `frame.jpg` of
one folder. Give each Frame file screen the presence of *its* sender:

- Without `wheel` in the senders' config: either probe works. `usb` with the
  sender's `serial` needs nothing from the sender; `heartbeat` also notices a
  sender that is not running.
- **With `wheel`** (the panels take turns showing each folder every few hours)
  the folder a panel shows changes, so its serial says nothing about which
  screen it shows: use **`heartbeat`** only (`{ "path": ".heartbeat" }`). The
  sender touches the heartbeat of the folder it shows *now*, so exactly the
  screens some connected panel is showing are painted; at a turn the new
  folder's heartbeat is touched within a second and its screen resumes.

The heartbeat needs the updated `kiosko-sender.py` (it touches `.heartbeat`
unless its config says `"heartbeat": false`). An older sender never touches
it, and the screen would stay paused: update the sender first.

## What each system needs

**Linux.** Your user must be allowed to open the device. If `kiosko doctor`
shows `(unreadable)` or an access error, add a udev rule and replug the panel:

```
# /etc/udev/rules.d/99-kiosko-lcd.rules
SUBSYSTEM=="usb", ENV{DEVTYPE}=="usb_device", ATTR{idVendor}=="0416", ATTR{idProduct}=="540[89]", TAG+="uaccess"
```

(`sudo udevadm control --reload && sudo udevadm trigger`.) Kiosko detaches the
kernel driver while it uses the panel and gives it back when it stops. Two
programs cannot use one panel at once: stop `trcc serve` or `kiosko-sender` for
the panel you give to Kiosko.

**Windows.** libusb only sees devices with the **WinUSB** driver. Install it
for the panel with [Zadig](https://zadig.akeo.ie/) (select the panel, driver
*WinUSB*, *Replace Driver*) once, as administrator. While WinUSB is on the
panel, the official Thermalright TRCC software no longer sees it; restore the
original driver from Device Manager if you need it back. Without WinUSB,
`kiosko doctor` shows `LIBUSB_ERROR_NOT_SUPPORTED`.

**macOS.** Nothing to install.

The native module (`usb`) is an **optional** dependency with prebuilt
binaries for Linux, macOS and Windows; if it can't load, everything else in
Kiosko works and this connection says why.

## Status

Written from the protocol as implemented by
[thermalright-trcc-linux](https://github.com/Lexonight1/thermalright-trcc-linux)
9.12: the byte stream for a frame is identical to `trcc`'s for the 22 test
frames in `packages/usb-ly` (generated by `trcc` itself), and the rest is
tested against a simulated firmware. **It has not been run against a real
panel yet**, nor on macOS or Windows: treat it as experimental and keep `trcc
serve` or a frame-file sender as a fallback.

# Kiosko remote screens

A **remote screen** is a small display on the network that runs Kiosko's
screen firmware ([`firmware/esp32-screen`](../firmware/esp32-screen)) and
shows what one Kiosko sends it. The first board is the Waveshare
ESP32-C6-LCD-1.47 (172×320). Several can share a network, each with its own
name and orientation.

In the editor: **Screens → Add screen → Detect panels** lists the remote
screens heard on the network. **Pair** makes the screen show a 6-digit code.
Type it in, and the screen becomes a Kiosko screen like any other. The setup
wizard offers remote screens the same way.

From the command line:

```sh
kiosko remote list                      # the screens on the LAN and which Kiosko screen uses each
kiosko remote pair a085e3ae92d0         # by uid (or by address); asks for the code it shows
kiosko remote ota "Desk" kiosko_screen.bin
kiosko remote logs "Desk"
kiosko remote unpair "Desk"
kiosko doctor                           # also lists the remote screens it hears
```

How to set one up, step by step: [remote-screens.md](remote-screens.md).

This document is the protocol, version 1. The firmware
(`firmware/esp32-screen/main/ks_proto.c`, `session.c`) and the driver
(`packages/core/src/remote/`) implement it together. They share test vectors:
`firmware/esp32-screen/test/vectors.h` comes from
`packages/core/src/remote/vectors.ts`, and `firmware/esp32-screen/test/run.sh`
checks the C code against them on the host. **Change both sides together.**

## Discovery

A screen announces itself over mDNS/DNS-SD when it joins the Wi-Fi:

- Service `_kiosko-screen._tcp`, port **7428**. The instance name is the
  screen's `id`.
- Host name `kiosko-<id>.local`. There is also `_http._tcp` on port 80, the
  read-only status page.
- TXT records:

| key | meaning |
|---|---|
| `id` | the name the user gave it: `[a-z0-9-]`, 1–24 characters. Default `screen-<last 4 hex of the MAC>` |
| `uid` | stable unique id: the 12 hex digits of its Wi-Fi MAC. Kiosko's config keeps this one |
| `model` | the board, e.g. `waveshare-esp32c6-lcd-1.47` |
| `w`, `h` | native size of the glass (172, 320) |
| `rot` | the rotation it shows at now (0/90/180/270) |
| `fw` | firmware version |
| `proto` | `1` |
| `paired` | `1` if it holds a pairing key |

Kiosko's browser (`remote/mdns.ts`) is plain Node over UDP, with no
dependency. It shares port 5353 with Avahi or Bonjour (`SO_REUSEADDR`) so it
hears announcements as they happen. Where it can't share the port, it asks
from a port of its own, and the screens answer it directly. A screen's
config can also give an address (`host`), for another subnet or a network
without multicast.

## Messages

All traffic is one TCP connection to port 7428. Every message is a `u32`
big-endian length `L` followed by `L` bytes. Kiosko rejects messages over 1 MiB.
The screen rejects messages over its `max` (98 304 bytes on the C6), and over
1 KiB before authentication.

- **Plain** (before the session is up): `type` (1 byte), then UTF-8 JSON.
- **Sealed** (after `AUTH_OK`): ChaCha20-Poly1305 over `type || payload`.
  - Each direction has its own key.
  - Nonce: `00000000 || u64 BE seq`. `seq` counts that direction's messages
    from 0 and never goes on the wire.
  - AAD: the 4 length bytes. The 16-byte tag goes last.
  - A message replayed, reordered, cut or forged doesn't open. The receiver
    then closes the connection.

| type | name | dir | payload |
|---|---|---|---|
| 01 | HELLO | K→S | `{"proto":1,"nonce":hex32,"want":"session"\|"pair"\|"info"}` |
| 02 | INFO | S→K | `{"proto","uid","id","model","w","h","rot","fw","max","nonce":hex32,"paired","pairing"}` |
| 03 | AUTH | K→S | `{"mac":hex32}` |
| 04 | AUTH_OK | S→K | `{"mac":hex32}` (everything after this is sealed) |
| 05 | ERROR | S→K | `{"code","msg"}`; the screen then closes |
| 06 | PAIR_START | K→S | `{"name":"Kiosko on <host>"}` |
| 07 | PAIR_READY | S→K | `{"ttl":120}` (the code is on the glass) |
| 08 | PAIR_X | K→S | `{"X":hex65}` |
| 09 | PAIR_Y | S→K | `{"Y":hex65,"c":hex32}` (cB) |
| 0A | PAIR_CONFIRM | K→S | `{"c":hex32}` (cA) |
| 0B | PAIR_OK | S→K | `{}` |
| 10 | FRAME | K→S | `u32 BE frame number`, then a baseline JPEG |
| 11 | ACK | S→K | `{"n","ok","rx":ms,"dec":ms,"err"?}` |
| 12 | SET | K→S | `{"rot"?,"id"?,"tz"?,"lang"?,"idle"?,"bright"?}`; answered with STATE |
| 13 | STATE | S→K | `{"uid","id","model","w","h","rot","fw","max","last","up","heap","rssi","ip","part","resend"?,"bright"?,"tempC"?,"heapMin"?,"heapLargest"?}` |
| 14 | LED | K→S | `{"rgb":"rrggbb","blink":ms}` (`000000` = off) |
| 15/16 | PING/PONG | both | `{}` |
| 17 | UNPAIR | K→S | `{}`; the screen forgets the key, answers UNPAIR and closes |
| 18 | OTA_BEGIN | K→S | `{"size":n,"sha256":hex32}` |
| 19 | OTA_ACK | S→K | `{"off":n}` (after BEGIN and after each DATA) |
| 1A | OTA_DATA | K→S | raw bytes, in order (16 KiB pieces) |
| 1B | OTA_END | K→S | `{}` |
| 1C | OTA_DONE | S→K | `{"ok":true}` or `{"ok":false,"err"}`; on success it restarts into the new image |
| 1D | LOGS | both | K→S `{}`; S→K `{"text"}` (the last ~6 KB of its log; from 0.1.2, then the time in each power mode) |

ERROR codes: `proto`, `notPaired`, `badKey`, `busy` (pairing or update in
progress), `pairingClosed`, `tooManyTries`, `badCode`.

## Pairing

Pairing needs someone in front of the screen. A screen accepts a pairing
when it isn't paired yet. Once paired, it accepts one only for 2 minutes
after a short press of its **BOOT** button.

1. Kiosko sends `HELLO want=pair`, then `PAIR_START`. The screen picks a
   uniform random 6-digit code and shows it for 120 s. The LED blinks blue.
2. The user types the code in Kiosko. Both sides run **SPAKE2 (RFC 9382)**
   over P-256 with SHA-256. Kiosko is A (identity `kiosko`), the screen is B
   (identity = its `uid`). M and N are the RFC's points.
   - `w = SHA256("KSv1 pake w" || uid || ":" || code) mod n`.
   - `X = x·G + w·M`, `Y = y·G + w·N`, `K = h·x·(Y − w·N) = h·y·(X − w·M)`.
   - `TT = len‖"kiosko" ‖ len‖uid ‖ len‖X ‖ len‖Y ‖ len‖K ‖ len‖w`. Each
     `len` is 8 bytes, little-endian. The points are SEC1 uncompressed and
     `w` is 32 bytes big-endian.
   - Key schedule, widened to 256 bits:
     - `h = SHA256(TT)`
     - `KcA‖KcB = HKDF(h, info "KSv1 confirm", 64)`
     - `cA = HMAC(KcA, TT)`, `cB = HMAC(KcB, TT)`
     - **pairing key = `HKDF(h, info "KSv1 pair key", 32)`**
3. The screen sends `Y` and `cB`. Kiosko checks `cB`, then sends `cA`. The
   screen checks `cA`, stores the key in NVS and answers `PAIR_OK`. Kiosko
   stores the key in the screen's config (`device.key`, marked `x-secret`).
   The editor never shows it.

What this protects against:

- A passive listener learns nothing usable about the key or the code.
- An active attacker gets **one guess per code**: 1 in 10⁶.
- A wrong confirmation burns the code. Each failure makes the screen refuse
  pairings for longer: 5 s, 10 s, 20 s… up to 5 min.

The code is never sent, in clear or otherwise.

## Session

1. Kiosko sends `HELLO want=session` with a fresh 32-byte nonce `nk`. The
   screen answers `INFO` with its own fresh nonce `nd`.
2. Kiosko sends `AUTH` with `HMAC(key, "KSv1 auth kiosko" ‖ nk ‖ nd ‖ uid)`.
   The screen checks it and answers `AUTH_OK` with
   `HMAC(key, "KSv1 auth screen" ‖ nk ‖ nd ‖ uid)`, which Kiosko checks.
   Each side has proved the key, with nonces never used before.
3. Session keys: `HKDF(key, salt = nk‖nd, info "KSv1 session", 64)`. The
   first 32 bytes seal Kiosko→screen, the last 32 screen→Kiosko.

There is one session at a time. A new authenticated one (Kiosko back on a
half-open link) replaces the old one. Nothing that changes state is reachable
without a session. The HTTP status page (`/`, `/status.json`) is read-only
and carries no secrets.

The key lives in the screen's NVS. **NVS encryption and flash encryption**
can be turned on for a production fleet (`menuconfig → Security`). They are
not on by default here: turning them on is irreversible on the chip
(eFuses), and a lost key means reflashing.

## Frames and flow control

- Kiosko paints the page at its **logical** size: 320×172 for this board
  turned 90°, 172×320 upright. It encodes the page as a baseline JPEG (the
  screen decodes it with the ROM decoder) and sends it as `FRAME`.
- **At most one frame is in flight.** The next one leaves on the ACK and is
  always the newest. Frames painted in the meantime replace each other, so a
  slow link never builds a queue.
- An unchanged picture is not sent again. A `PING` every 5 s keeps the
  session. Firmware 0.1.2 runs the Wi-Fi in modem sleep, so an answer can
  wait for the next beacon (100–300 ms); while frames come fast (over 2 fps)
  it turns power save off, and turns it on again 5 s after they slow down. A screen hearing nothing for 20 s closes it. Kiosko gives up
  after 16 s without an answer.
- ACK times (`rx`, `dec`) and Kiosko's round trip show in the editor (fps,
  ms a frame, ms decoding).
- A frame bigger than the screen's `max` is not sent, and the editor says
  so. Screens added by pairing get `maxBytes` under it, so Kiosko lowers the
  JPEG quality first.

## Brightness and temperature

Firmware 0.1.2 adds two optional fields, still protocol 1. A side that
doesn't know them ignores them: Kiosko 0.2.10 and older never send `bright`
and don't read `tempC`, and firmware 0.1.1 ignores a `bright` in `SET`.

- **`SET bright`**: the backlight, 0–100 in perceived brightness (0 = off).
  The screen applies it at once and keeps it in NVS, so it stays without
  Kiosko and after a restart. Kiosko pushes it on every connection when the
  screen's config has `device.brightness`; without one, the screen keeps
  its own (70 % by default, or what its setup page set).
- **`STATE bright`**: the brightness it has. Kiosko only offers the control
  for screens that say it.
- **`STATE heapMin`, `heapLargest`** (0.1.3): the lowest free heap since
  boot and the largest free block, in bytes, for diagnosis.
- **`STATE tempC`**: the chip's own temperature sensor, °C with one
  decimal. It reads it every 5 s and sends `STATE` every 30 s on its own, so
  Kiosko sees it change. `status.json` has it too.

For a future night dimming, the screen keeps the shown brightness apart
from the saved one (`display_set_brightness`). A temporary dim would be
another optional `SET` field that changes only the first, not this one,
which writes to flash.

## Resync

The screen is not always there: unplugged, off the Wi-Fi, rebooting.

- The driver reconnects with an exponential pause (1 s, 2 s, 4 s… up to
  30 s, with jitter). The screen announcing itself again over mDNS ends the
  pause at once.
- While the screen is away, the editor shows it as *offline*, not as an
  error, and the log gets one line per change, not one per retry.
- On every (re)connection:
  1. The screen reports its state.
  2. Kiosko pushes its settings: **Kiosko's screen config is the truth** for
     the rotation, the language of the screen's own pages, and its time zone
     as a POSIX TZ string.
  3. Kiosko sends the **current frame at once**.
- If the screen's rotation changed while it was away, Kiosko's own wins.
  Without Kiosko, the screen keeps the last one it was given.
- When the screen draws over Kiosko's frame (a pairing window, a BOOT hint),
  it asks for the frame again (`STATE resend:true`).

## Orientation

Rotation (0/90/180/270) is applied **on the screen** through the ST7789's
MADCTL, at no cost. For `remote` screens Kiosko doesn't turn the picture
(`paintTurn`): it sends the page as the editor shows it and pushes the
screen's `rotate`.

Its sense matches Kiosko's own turning for USB panels: the picture turned
`rotate` clockwise. As with any panel, 90 and 270 differ by which way the
board stands. If the picture comes out upside down, flip it in the editor.

## On the screen

- **Idle page.** After 15 s without Kiosko (configurable with `SET idle`),
  the screen shows its own page: the time (SNTP, with the time zone Kiosko
  gave it), its name, `kiosko-<id>.local`, its IP and *Waiting for Kiosko*.
  If it isn't paired yet, it says *Not paired yet: add it in Kiosko*. While
  pairing, it shows the code in large digits with a countdown.
- **LED.** Off normally. Kiosko drives it while one of its alerts has the
  screen: critical blinks red, warn is amber, info is blue. The screen's own
  uses come first: blue blinking while pairing, purple while in setup.
- **Provisioning.** With no Wi-Fi saved, or no connection within 20 s, the
  screen opens its own WPA2 network `Kiosko-<id>-setup`. Its password (8
  digits, new each time) is shown on the glass. A captive page at
  `http://192.168.4.1` sets the Wi-Fi network, the screen's name and its
  time zone. It also takes a firmware upload. That page only answers on the
  setup network.
- **BOOT button.**
  - Short press: opens pairing for 2 minutes on a paired screen (or cancels
    a pairing in progress).
  - Hold 5 s: forget the pairing.
  - Hold 10 s: forget the pairing and the Wi-Fi, and restart in setup.
- **OTA.** Only over an authenticated session, or from the setup page
  (physical presence: the password on the glass). The image is checked
  against the SHA-256 Kiosko sent and by ESP-IDF's own image checks. With
  rollback on, a new firmware must be on the Wi-Fi with its server up for
  30 s, or it restarts into the previous one. A firmware that came by
  Kiosko's OTA, or the first one after another firmware, must also have had
  an authenticated Kiosko session within 10 minutes. An update Kiosko can't
  talk to does not stay.

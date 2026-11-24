# Wi-Fi screens (ESP32)

> **New, experimental.** Kiosko can also drive small Wi-Fi screens built on an
> ESP32, running Kiosko's own open firmware. They show a Kiosko screen like any
> panel, from anywhere in the house. This guide covers using them; the protocol
> is in [remote-screen.md](remote-screen.md).

What you get:

- **It announces itself.** Kiosko finds it on your network by itself.
- **You pair it with the code on its screen.** Only someone standing in front
  of the screen can pair it, and the link is encrypted.
- **It resyncs by itself.** If it is unplugged or the Wi-Fi drops, Kiosko
  picks it up again and sends the current picture as soon as it is back.
- **Any orientation**, upright or on its side, set from Kiosko.
- **Several at once**, each with its own name and its own pages.

## What you need

- A supported board. Today: the **Waveshare ESP32-C6-LCD-1.47** (172×320).
  More are to come; the firmware has a board layer for them.
- A USB-C cable to install the firmware once. After that, updates go over the
  Wi-Fi.
- A 2.4 GHz Wi-Fi network shared with the computer running Kiosko, with
  multicast (mDNS) allowed between them.

## Install the firmware

**From the browser (easiest).** Open the
[web installer](https://kioskolcd.dev/flash/) in Chrome or Edge on a
computer, plug the board in by USB, press *Connect and install* and pick its
port. It writes the latest release's full image; nothing to install. Then go
on with [First boot and Wi-Fi](#first-boot-and-wi-fi).

**Ready-made images.** Each Kiosko release on
[GitHub](https://github.com/kiosko-lcd/kiosko/releases/latest) carries, with
their SHA-256:

- `kiosko-screen-<version>-waveshare-esp32c6-lcd-1.47-full.bin`: the whole
  flash, for a new board over USB. It erases what the board had.
- `kiosko-screen-<version>-waveshare-esp32c6-lcd-1.47.bin`: the app alone,
  for updating from Kiosko or from the screen's setup page.

To write the full image, plug the board in and use `esptool` in Docker
(nothing to install):

```sh
docker run --rm -v "$PWD:/w" --device /dev/ttyACM0 espressif/idf:v5.5.5 \
  esptool.py --chip esp32c6 -b 921600 write_flash 0x0 /w/kiosko-screen-0.1.1-waveshare-esp32c6-lcd-1.47-full.bin
```

Use the port your board shows up as (`ls /dev/serial/by-id/` on Linux). Any
other `esptool`, or Espressif's web flasher, works too.

**Building it yourself.** In [firmware/esp32-screen](../firmware/esp32-screen),
everything runs in Docker:

```sh
./idf build           # build/kiosko_screen.bin
./idf flash           # over USB
./idf backup old.bin  # first, a copy of the board's current flash
```

**USB permission on Linux.** Your user must be able to open the serial port.
Add yourself to the `dialout` group, then log out and in again:

```sh
sudo usermod -aG dialout "$USER"
```

## First boot and Wi-Fi

With no Wi-Fi saved, or if it can't connect within 20 s, the screen opens its
own network, `Kiosko-<name>-setup`, and shows its password on the glass.

1. Join that network from your phone or laptop.
2. The setup page opens by itself; if not, go to `http://192.168.4.1`.
3. Choose your Wi-Fi network and type its password. You can also give the
   screen a name here (`a-z`, `0-9`, `-`) and its time zone.
4. Save. The screen restarts and joins your network. Then it shows its name,
   its address and *Not paired yet: add it in Kiosko*.

## Add it in Kiosko

Any of these:

- **Editor.** *Screens → Add screen → Detect panels*. The screen appears in
  the list. Click it, and the screen shows a 6-digit code. Type it in the
  editor. A new screen is made, sized for the glass.
- **First-run wizard.** The *Your panel* step lists Wi-Fi screens next to USB
  ones, each with a **Pair** button.
- **Command line.**
  ```sh
  kiosko remote list
  kiosko remote pair <uid or address>
  ```
  `pair` asks for the code shown on the screen.

The code works for one attempt and lasts 2 minutes.

## Orientation

Set it on the screen's card in Kiosko: *Landscape* or *Portrait*, and *Turn 180°*. Kiosko sends the page as you see it in the editor, and the
screen turns it by itself, at no cost. If it comes out upside down, press
*Turn 180°*. Kiosko's setting wins: the screen takes it every time it connects.

## Brightness and temperature

With screen firmware 0.1.2 or later, the screen's card has a **Brightness**
slider (0–100 %). The screen keeps it, even without Kiosko. Unset, it uses
its own: 70 %, or what you chose on its setup page. A lower brightness runs
cooler.

**Night mode** (screen firmware 0.1.4 or later): turn it on in the card,
choose the hours (for example 22:30 to 07:00) and the night brightness, down
to *backlight off*. The screen goes back to its own brightness when the night
ends. Alerts that take the screen over still light it up. And whenever Kiosko
shows the screen black (switched off from Home Assistant, or asleep because
nothing on the page has anything to show), its backlight goes off too. None
of this is saved on the screen: if Kiosko goes away, the screen lights up
again.

The card's status line also shows the **chip's temperature**. It reads warmer
than the room: around 35–45 °C is normal for this chip.

## Several screens

Pair each one. Every screen gets its own card, pages and orientation. Give
them names on their setup page (*kitchen*, *desk*), so they are easy to tell
apart. Kiosko keeps track of each one by its unique id, so renaming a screen
doesn't break anything. Their hostnames are `kiosko-<name>.local`.

## The BOOT button

| Press | What it does |
|---|---|
| Short | On a paired screen, allows a new pairing for 2 minutes (or cancels one in progress) |
| Hold 5 s | Forgets the pairing |
| Hold 10 s | Forgets the pairing and the Wi-Fi, and restarts into setup |

The screen counts the seconds while you hold the button.

## Updating the firmware

When this Kiosko brings a newer firmware than the screen has, the screen's
card says so and offers **Update firmware to X**. On that click, and only
then, Kiosko downloads the firmware from its own release on GitHub, checks
its SHA-256 and sends it. Without internet access (or GitHub out of reach),
download the file from the release page and use *Update firmware…* instead.

By hand: *Update firmware…* on the screen's card, then choose the app `.bin` (not the
`-full` one). Or from the command line:

```sh
kiosko remote ota <screen> kiosko-screen-<version>-waveshare-esp32c6-lcd-1.47.bin
```

The screen checks the image and restarts into it. If the new firmware can't
get on the Wi-Fi, or Kiosko can't talk to it afterwards, the screen goes back
to the previous firmware by itself.

## Reset and unpair

- **From Kiosko:** *Unpair* on the screen's card, or `kiosko remote unpair <screen>`.
  The screen forgets this Kiosko and can be paired again.
- **On the screen:** hold BOOT 5 s (pairing only) or 10 s (pairing and Wi-Fi).
- **To give it to another Kiosko:** press BOOT once, then pair it from the
  other Kiosko within 2 minutes.

## Troubleshooting

- **It isn't found on the network.**
  - Check that the screen shows an IP address.
  - The computer and the screen must be on the same network, with multicast
    (mDNS) allowed. Guest networks, separate VLANs and some mesh systems block
    it.
  - Run `kiosko doctor` to see what Kiosko hears.
  - As a workaround, type the screen's address in its card (*Address*), or
    pair by address: `kiosko remote pair 192.168.1.50`.
- **"That is not the code on the screen".** Each code works once. Start
  again: the screen shows a new code.
- **"Too many wrong codes".** After each wrong code the screen waits longer
  before taking another try (5 s, 10 s, 20 s… up to 5 minutes). Wait, then try
  again.
- **"Already paired with another Kiosko".** Press BOOT once on the screen,
  then pair within 2 minutes.
- **"Refuses this Kiosko's key".** The screen was reset or paired elsewhere.
  Use *Pair again* on its card.
- **Offline.** The screen is unplugged or off the Wi-Fi. Kiosko reconnects by
  itself as soon as it is back, and doesn't fill the log meanwhile.
- **Slow pictures.** Each picture takes about 60–90 ms to decode, so lively
  animations top out at about 8–10 fps. Static pages are not affected.

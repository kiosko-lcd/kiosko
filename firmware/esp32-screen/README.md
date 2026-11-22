# Kiosko screen firmware (ESP32)

An open reference firmware that makes a small ESP32 display into a
**Kiosko remote screen**. It announces itself on the Wi-Fi, pairs with one
Kiosko using a code shown on its glass, and shows the frames Kiosko sends it
over an authenticated, encrypted session. To set one up, see the
[user guide](../../docs/remote-screens.md); the protocol is in
[docs/remote-screen.md](../../docs/remote-screen.md).

Boards (`main/boards/`, chosen in `menuconfig → Kiosko screen → Board`):

| board | chip | panel | notes |
|---|---|---|---|
| Waveshare ESP32-C6-LCD-1.47 | ESP32-C6FH8, 8 MB flash, no PSRAM | ST7789 172×320 (column offset 34, inverted) | WS2812 LED on GPIO 8, BOOT on GPIO 9 |

To add a board, write a header under `main/boards/` with its pins and panel,
and add a choice in `main/Kconfig.projbuild`. A panel other than the ST7789
also needs its `esp_lcd` driver in `display.c`: for instance the ILI9341 of
the 320×240 "Cheap Yellow Display".

## Build

Everything runs in Docker with **ESP-IDF v5.5.5**, pinned in the
`Dockerfile`. Nothing is installed on the machine.

```sh
./idf build                    # → build/kiosko_screen.bin
./idf flash monitor            # over USB (Ctrl+] leaves the monitor)
./idf backup before.bin        # the whole 8 MB flash, read back and verified
./idf menuconfig
./test/run.sh                  # the protocol's C code against Kiosko's test vectors, on the host
```

`./idf` copies the sources into a named Docker volume with `tar`, runs
`idf.py` there, and copies the results back. A snap Docker (which can only
mount `$HOME`) and a rootless one both work that way, wherever the checkout
is. `docker volume rm kiosko-esp32-screen-work` starts from scratch.

USB needs your user to be able to open the serial port, through the
`dialout` group or a udev rule. For example:

```
SUBSYSTEM=="tty", ATTRS{idVendor}=="303a", TAG+="uaccess"
```

The port is picked from `/dev/serial/by-id/usb-Espressif_*`. Force another
with `ESPPORT=/dev/ttyACMx ./idf flash`.

## Install

- **New board, over USB.** `./idf flash`. Back up its factory firmware first
  with `./idf backup factory.bin`.
- **Over the air, from Kiosko.** `kiosko remote ota <screen> build/kiosko_screen.bin`,
  or *Update firmware…* in the editor.
- **From the screen's setup page.** Hold BOOT 10 s, join `Kiosko-<id>-setup`
  with the password the screen shows, then upload the `.bin` at
  http://192.168.4.1.
- **Over the Waveshare photo-frame firmware**, which this one shares a
  partition layout with: upload the `.bin` with its own OTA. On its first
  boot it reads that firmware's saved Wi-Fi (read-only), so it comes up on
  the same network. It leaves the photo frame's photos and settings alone,
  so the photo frame can be installed back the same way.

Rollback is on. A new firmware has to prove itself or the bootloader goes
back to the previous one by itself:

- It must be on the Wi-Fi with its server up for 30 s.
- If it came by Kiosko's OTA, or it just replaced another firmware, it also
  needs an authenticated Kiosko session within 10 minutes.

## Use

- **First start.** It joins the saved Wi-Fi. With none, it opens the setup
  network (see above), where you set the Wi-Fi, its name and its time zone.
- **Pairing.** In Kiosko: Screens → Add screen → Detect panels → Pair. The
  screen shows a 6-digit code: type it in. A paired screen accepts another
  pairing only after a short press of BOOT.
- **BOOT.**
  - Short press: open pairing for 2 min (or cancel one in progress).
  - Hold 5 s: forget the pairing.
  - Hold 10 s: forget the pairing and the Wi-Fi.
- **Status page.** http://kiosko-&lt;id&gt;.local/ is read-only, without secrets.
- **Without Kiosko.** After 15 s with no Kiosko, the screen shows its own
  page: the time, its name, its address, and whether it is paired.

## Notes

- **JPEG.** It uses the decoder in the chip's ROM (`CONFIG_JD_USE_ROM`),
  about 90 ms for a 320×172 frame. esp_jpeg's own build with RGB565 output
  hung this board on the second image.
- **Memory.** There is no PSRAM: a 110 KB framebuffer and a 96 KB receive
  buffer, both in internal RAM. Frames are decrypted in place.
- **Wi-Fi.** Power save is off, because modem sleep holds frames back until
  the next beacon. The country is `ES` (channels 1–13); set
  `KS_WIFI_COUNTRY` for yours.
- **Pairing key.** It is kept in NVS, in clear. NVS and flash encryption are
  in menuconfig (Security), off by default. Turning them on burns eFuses for
  good.
- **Test-only options.** `KS_TEST_PAIR_CODE` fixes the pairing code (for an
  automated end-to-end test that can't read the glass). `KS_TEST_CRASH_AFTER`
  crashes on purpose, to try the rollback. Never ship a build with either:
  `sdkconfig.test` and `sdkconfig.crash` exist only for
  `./idf -B build-test -D SDKCONFIG=build-test/sdkconfig -D 'SDKCONFIG_DEFAULTS=sdkconfig.defaults;sdkconfig.test' build`.
- **Font.** `main/font.h` is DejaVu Sans Bold (DejaVu fonts licence, free to use and embed), made by `tools/gen_font.sh`.

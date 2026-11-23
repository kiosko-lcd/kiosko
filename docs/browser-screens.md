# Browser screens (tablets, phones)

> **New, experimental.** Any browser on your network can show a Kiosko screen
> full-screen: an old tablet on the wall, a spare phone on the desk. No
> hardware to buy and no firmware: open an address, type a code in the editor,
> done. For small Wi-Fi displays with Kiosko's own firmware, see
> [remote-screens.md](remote-screens.md).

What you get:

- **Pairing with a code.** The browser shows a 6-digit code; you type it in
  the editor. Only a browser you paired gets pictures, and they travel
  encrypted.
- **It follows the device.** The screen takes the size of the browser's
  window and turns when the tablet turns.
- **It comes back by itself.** After the tablet sleeps, the Wi-Fi drops or
  the page is reloaded, it reconnects without pairing again and shows the
  current picture at once.
- **The editor stays private.** Browsers talk to a second, small server that
  serves only the screen page; the editor keeps listening on this computer
  only.

## Turn on network screens

They are off until you switch them on. In the editor, **Screens**, at the
bottom: **Network screens (browsers)**. Turn it on, and choose:

- **Listen on**: *The local network* (every interface, the usual choice),
  *This computer only* (for a tablet on a USB cable, see
  [Cable mode](#cable-mode-android-on-usb)), or one address of this computer.
- **Port**: 7429 unless that one is taken.

The card then shows the address to open (one per network interface of this
computer) and a QR code of it.

In the config file it is:

```json
"networkScreens": { "enabled": true, "host": "0.0.0.0", "port": 7429 }
```

Your firewall must let the tablet reach that port (on Windows, allow Node.js
on private networks when it asks).

## Add a browser

1. On the tablet or phone, open the address the editor shows, e.g.
   `http://192.168.1.20:7429/` (or scan the QR code). The page shows a big
   6-digit code and, under it, what the browser is and 4 characters of its
   id.
2. In the editor: **Screens → Add screen → Browser (tablet, phone…)**. The
   browsers waiting to be paired are listed, with their size and address.
3. Pick yours (when only one is waiting it is already picked) and type its
   code. A wrong code is refused, the browser shows a new one, and the next
   try has to wait a little (longer after each wrong code).
4. A new screen appears, with the browser's size and its first page. Edit it
   like any other.

Tap the page to go full screen. Hold anywhere (or tap the top right corner)
for its menu: full screen, and forgetting the pairing.

To pair a browser to an existing screen instead of a new one, use **Pair
again** on that screen's card.

## Size and orientation

With **Follow the browser's size** on (the default), the screen takes the
size of the browser's window in device pixels (the longer side at most
1920) and turns between landscape and portrait when the device does, with
its pages laid out again as for any panel you turn. Small changes (an
address bar coming and going) are ignored. Turn it off to keep a size you set
yourself: the browser then shows the picture as big as it fits.

## Keeping the screen on

Browsers let the screen sleep unless the page asks them not to. The page
does what it can:

- **Wake Lock**, where the browser allows it: only on secure pages (`https`,
  or `http://127.0.0.1`, see [Cable mode](#cable-mode-android-on-usb)). A page
  at `http://192.168.x.x` is not one of them.
- Elsewhere, a **tiny muted video** that keeps playing, which keeps most
  mobile browsers awake. Some don't count a muted video: then use one of the
  options below.

The page's menu says which one is working. More reliable, whatever the
browser:

- The device's own setting: the longest screen timeout; on Android,
  *Developer options → Stay awake* keeps it on while charging.
- A **kiosk browser app** (on Android, apps such as Fully Kiosk Browser; on
  iPad, *Guided Access* with *Auto-Lock: Never*): full screen, kept awake,
  restarted on boot. Point it at the page's address.
- Adding the page to the home screen opens it without the browser's bars.

## Cable mode (Android on USB)

An Android tablet on a USB cable can reach Kiosko without any network at
all, and as a secure page (so Wake Lock works):

1. On the tablet, enable *Developer options → USB debugging*; plug it in and
   accept the computer.
2. In the editor, set network screens to listen on **This computer only**
   (`"host": "127.0.0.1"`): nothing is exposed to the network.
3. On the computer, run `adb reverse tcp:7429 tcp:7429`.
4. On the tablet, open `http://127.0.0.1:7429/` and pair it as above.

`adb reverse` lasts until the cable is unplugged or the tablet restarts: run
it again then (a small script or a udev rule can do it).

## Security

What the network-screens server exposes, to anyone on your network:

- the viewer page (its HTML, script, style and icon);
- a WebSocket where a browser either proves it has a pairing key or waits to
  be paired, showing a code.

Everything else answers 404. It is a separate server, not the editor's with
fewer permissions: it has no route to the editor, its API, the config, the
logs or the plugins, and the editor keeps listening on 127.0.0.1 only.

How browsers are trusted:

- **Pairing** is SPAKE2 (the same as the ESP32 screens'), on the code the
  browser shows: someone must read it off the screen and type it in the
  editor. A wrong code gives nothing away, makes the browser draw a new one,
  and makes the next attempt wait (5 s, doubling up to a minute).
- **Sessions**: on every connection both sides prove they have the key
  over fresh nonces, then every message is sealed with ChaCha20-Poly1305
  under keys made for that connection. A browser without a valid key gets
  no frame; a message that doesn't open ends the session.
- **Limits**: 32 connections at once, 4 WebSockets per address, 8 browsers
  waiting, 4 KB per message from a browser; a page from another site can't
  open the WebSocket.
- **Revoking**: *Revoke* on the screen's card drops the key from the config
  and tells the browser to forget it; it goes back to showing a code.
  *Forget the pairing* in the page's menu does the same from the tablet.

What it does not protect against:

- The page is served over plain HTTP: someone who can tamper with your local
  network's traffic could serve a modified page to the tablet. Cable mode, or
  a network you trust, avoids that.
- The pairing key is kept in the browser's storage: whoever has the tablet
  unlocked can copy it. Revoke a tablet you lose.
- Anyone on your network can open the page, and a device may put itself in
  the list of browsers waiting; pairing still needs the code shown on *your*
  tablet. Check the address and the 4 characters before you type it.

## Troubleshooting

- **The page doesn't open**: is the card *On, port 7429*? Is the tablet on
  the same network, and does the firewall let it in? Try the other addresses
  the card lists.
- **No browser in the list**: the page must be open and showing a code. A
  tablet that slept with the page on disappears from the list after half a
  minute; wake it.
- **The picture stops when the tablet sleeps**: see
  [Keeping the screen on](#keeping-the-screen-on). It resumes by itself when
  the tablet wakes.
- **Back to a code after it worked**: the screen was revoked, or removed in
  Kiosko, or the browser's storage was cleared. Pair it again.

The messages are in
[packages/core/src/browser/protocol.ts](../packages/core/src/browser/protocol.ts):
the remote screen protocol's ([remote-screen.md](remote-screen.md)) over a
WebSocket, with the browser connecting and speaking first.

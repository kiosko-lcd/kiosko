/**
 * Browser screens (docs/browser-screens.md): what the viewer page and Kiosko
 * say to each other over the WebSocket of the network-screens server. Pure:
 * the viewer bundles it.
 *
 * The messages are the remote screen protocol's (docs/remote-screen.md),
 * one per WebSocket binary message, framed the same way (u32 length, type,
 * body; sealed ones with ChaCha20-Poly1305 under the session key, the length
 * as associated data). The difference: the browser can't listen, so it
 * connects, and it speaks first.
 *
 *   viewer → INFO {proto, uid, id, w, h, want: "pair" | "session", nonce: nd}
 *   Kiosko → HELLO {proto, nonce: nk}
 *
 *   want "session" (it has a key):
 *     viewer → AUTH {mac: HMAC(key, "KSv1 auth screen" || nk || nd || uid)}
 *     Kiosko → AUTH_OK {mac: HMAC(key, "KSv1 auth kiosko" || nk || nd || uid)}
 *              or ERROR {code: "badKey"} and closes: the viewer forgets its key
 *     then sealed: Kiosko → FRAME (u32 BE number, JPEG or PNG), PING, UNPAIR
 *                  viewer → STATE {w, h}, ACK {n, ok, dec}, PONG, PING
 *
 *   want "pair" (it shows a 6-digit code; the editor lists it as waiting):
 *     Kiosko → PAIR_X {X}                    when someone types the code in the editor
 *     viewer → PAIR_Y {Y, c: cB}
 *     Kiosko → PAIR_CONFIRM {c: cA}          or ERROR {code: "badCode"}: the viewer makes a new code
 *     viewer → PAIR_OK {}                    it keeps the key
 *     Kiosko → PAIR_OK {}                    the screen is in the config: connect with the key
 */
export const BROWSER_PROTO = 1;
/** The network-screens server's port unless the config says another. */
export const BROWSER_PORT = 7429;

/** The same numbers as the remote screen protocol's (remote/link.ts `T`). */
export const BT = {
  HELLO: 0x01,
  INFO: 0x02,
  AUTH: 0x03,
  AUTH_OK: 0x04,
  ERROR: 0x05,
  PAIR_X: 0x08,
  PAIR_Y: 0x09,
  PAIR_CONFIRM: 0x0a,
  PAIR_OK: 0x0b,
  FRAME: 0x10,
  ACK: 0x11,
  STATE: 0x13,
  PING: 0x15,
  PONG: 0x16,
  UNPAIR: 0x17,
} as const;

/** The largest message a viewer may send (they are all small JSON). */
export const MAX_VIEWER_MESSAGE = 4096;
/** A viewer's id: 12 hex digits, made once and kept in its localStorage. */
export const VIEWER_UID = /^[0-9a-f]{12}$/;

/** The picture size a viewer asks for: its viewport in device pixels, the longer side at most this. */
export const MAX_SIDE = 1920;
export const MIN_SIDE = 120;

/**
 * Client for the REST API of `trcc serve` (thermalright-trcc-linux), the
 * process that owns a Thermalright USB LCD panel.
 *
 * Two facts about the hardware shape this module:
 *
 *   - The LY firmware of panels such as the Trofeo Vision **drops the image**
 *     and falls back to the factory logo after ~2-3 s without a frame, so the
 *     image has to be resent several times per second.
 *   - The USB interface is exclusive: two `trcc` processes cannot talk to the
 *     same panel at once. So the resending cannot be a separate process.
 *
 * `trcc serve` solves both: one process owns the USB device, and its
 * `DeviceSender` resends the cached frame every ~150 ms on its own. This
 * client therefore only sends a frame when something changes (`sendFrame`)
 * and runs a spaced health probe (`pinFrame`). It does not resend anything.
 */
import { readdirSync, readFileSync } from 'node:fs';

export interface TrccOptions {
  /** Base URL of `trcc serve`, e.g. `http://127.0.0.1:8099`. */
  url: string;
  /** API token, if `trcc serve` runs with `--token`. */
  token?: string;
  /** File holding the token (re-read every 30 s). Ignored if `token` is set. */
  tokenFile?: string;
  /** Timeout for each request, in ms. */
  timeoutMs: number;
  /** `VID:PID` key of the panel to use; empty = the first one the server lists. */
  deviceKey?: string;
  /**
   * USB serial number of the panel to use. With several identical panels,
   * trcc ≥ 9.10.8 lists each as `VID:PID@<usb path>` (`0416:5408@3-11.1`), and
   * the bare `VID:PID` means "the first one", which may be a twin another
   * process holds. The serial is mapped to its USB path through sysfs.
   */
  serial?: string;
  /** Where to look the serial up; for tests. */
  sysfsRoot?: string;
}

/** The USB path (`3-11.1`) of the device with this serial, from sysfs; null if not plugged in. */
export function usbPathForSerial(serial: string, root = '/sys/bus/usb/devices'): string | null {
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    return null;
  }
  for (const name of entries) {
    if (!/^\d+-[\d.]+$/.test(name)) continue;
    try {
      if (readFileSync(`${root}/${name}/serial`, 'utf8').trim() === serial) return name;
    } catch {
      // No serial (hubs and the like).
    }
  }
  return null;
}

export interface Panel {
  /** `VID:PID` key of the device. */
  key: string;
  width: number;
  height: number;
}

/** The token from its file, re-read every 30 s in case it changes or appears. */
let tokenCache: { path: string; at: number; value: string } | null = null;
export function apiToken(o: Pick<TrccOptions, 'token' | 'tokenFile'>, now = Date.now()): string {
  if (o.token) return o.token;
  const path = o.tokenFile ?? '';
  if (tokenCache && tokenCache.path === path && now - tokenCache.at < 30_000) return tokenCache.value;
  let value = '';
  try {
    value = path ? readFileSync(path, 'utf8').trim() : '';
  } catch {
    // No file, no token: a `trcc serve` started without `--token` accepts that.
  }
  tokenCache = { path, at: now, value };
  return value;
}

/** Request headers, with the token when there is one. */
function headers(o: TrccOptions, extra: Record<string, string> = {}): Record<string, string> {
  const token = apiToken(o);
  return token ? { ...extra, 'X-API-Token': token } : extra;
}

function base(o: TrccOptions): string {
  return o.url.replace(/\/+$/, '');
}

/** The key contains a colon, which has to be escaped in the path. */
function url(o: TrccOptions, key: string, suffix: string): string {
  return `${base(o)}/devices/${encodeURIComponent(key)}${suffix}`;
}

async function postJson(o: TrccOptions, target: string, body: unknown): Promise<unknown> {
  const res = await fetch(target, {
    method: 'POST',
    headers: headers(o, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(o.timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} at ${target}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/** Is `trcc serve` up? */
export async function serverAlive(o: TrccOptions): Promise<boolean> {
  try {
    const res = await fetch(`${base(o)}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Asks the server which panel there is and at which resolution. Render from
 * this, not from a constant: the driver documents 1920×462 for the Trofeo
 * Vision while shops advertise 1920×480.
 */
export async function detectPanel(o: TrccOptions): Promise<Panel | null> {
  try {
    const res = await fetch(`${base(o)}/devices`, { headers: headers(o), signal: AbortSignal.timeout(o.timeoutMs) });
    if (!res.ok) return null;
    const data = (await res.json()) as { products?: { key?: string; native_resolution?: [number, number] }[] };
    const list = data.products ?? [];
    let found = o.deviceKey ? list.find((p) => p.key === o.deviceKey) : list[0];
    if (o.serial && !o.deviceKey) {
      // Per-unit keys (trcc ≥ 9.10.8): the one at our panel's USB path. A
      // server without them lists a single key, which is already ours.
      const path = usbPathForSerial(o.serial, o.sysfsRoot);
      const perUnit = list.filter((p) => p.key?.includes('@'));
      if (perUnit.length) found = path ? perUnit.find((p) => p.key!.endsWith(`@${path}`)) : undefined;
    }
    if (!found?.key || !found.native_resolution) return null;
    const [width, height] = found.native_resolution;
    return { key: found.key, width, height };
  } catch {
    return null;
  }
}

/** Opens the device on the server. Without this, frames are stored but not shown. */
export async function connectPanel(o: TrccOptions, key: string): Promise<void> {
  await postJson(o, url(o, key, '/connect'), {});
}

/**
 * `multipart/form-data` body with the image in the `image` field, built by hand.
 *
 * **Do not use `FormData` + `Blob` here.** With Node 24's `fetch`, every such
 * request keeps a copy of the image alive forever: measured, 1500 requests of
 * 81 KB retained 118 MB of `arrayBuffers` after a forced GC. With the body in a
 * single `Buffer`, nothing. A dashboard sending on every change reached 8 GB
 * in nine days.
 *
 * `trcc` picks the format from the file name's extension, so it is derived
 * from the first bytes: JPEG starts with FF D8, anything else goes as PNG.
 */
export function multipartImage(
  image: Buffer,
  boundary = `trcc${crypto.randomUUID().replace(/-/g, '')}`,
): { body: Buffer; contentType: string } {
  const jpeg = image.length > 2 && image[0] === 0xff && image[1] === 0xd8;
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="image"; filename="frame.${jpeg ? 'jpg' : 'png'}"\r\n` +
      `Content-Type: image/${jpeg ? 'jpeg' : 'png'}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { body: Buffer.concat([head, image, tail]), contentType: `multipart/form-data; boundary=${boundary}` };
}

/** Uploads a PNG or JPEG and shows it. Throws if the server reports an error. */
export async function sendFrame(o: TrccOptions, key: string, image: Buffer): Promise<void> {
  const { body, contentType } = multipartImage(image);
  const target = url(o, key, '/display/send-image');
  const res = await fetch(target, {
    method: 'POST',
    headers: headers(o, { 'Content-Type': contentType }),
    body,
    signal: AbortSignal.timeout(o.timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { ok?: boolean; message?: string };
  if (data.ok === false) throw new Error(data.message ?? 'the server rejected the frame');
  // The server stores the frame even when the device is not open; then
  // nothing was shown, and the caller has to know.
  if (data.message && /not connected/i.test(data.message)) {
    throw new Error('the device is not connected on the server');
  }
}

/**
 * Checks that the keepalive contract is still the one `pinFrame` assumes.
 *
 * It exists because `trcc` once changed this endpoint's behaviour **without
 * changing its response**: the same `200 OK` blocking for 30 s as returning in
 * 3 ms, so a client written for the old contract silently degenerated into a
 * busy loop (87% of a core, not a single error in any log). Any assumption
 * about a foreign API that can flip silently deserves a cheap assertion. Here,
 * the three `pinFrame` depends on:
 *
 *   1. the call does **not** block;
 *   2. the call does **not** resend anything itself (`frames_resent === 0`),
 *      because the server's worker keeps the image;
 *   3. the server says so in its message.
 *
 * It fixes nothing: it warns. A canary, not a cage.
 */
export function checkKeepaliveContract(body: string, elapsedMs: number, warn: (msg: string) => void): void {
  if (elapsedMs > 5000) {
    warn(
      `the keepalive took ${(elapsedMs / 1000).toFixed(1)} s: it looks like it blocks again. ` +
        'The spaced probe in pinFrame assumes it answers at once.',
    );
  }
  let data: { message?: string; frames_resent?: number } = {};
  try {
    data = JSON.parse(body) as typeof data;
  } catch {
    warn('the keepalive no longer answers JSON; the contract has changed.');
    return;
  }
  if (typeof data.frames_resent === 'number' && data.frames_resent > 0) {
    warn(
      `the keepalive says it resent ${data.frames_resent} frames. It used to resend none (the ` +
        'worker did); if it now depends on this call, the probe is far too slow.',
    );
  }
  if (data.message && !/send worker resends|keepalive active/i.test(data.message)) {
    warn(`the keepalive answers something unexpected: "${data.message.slice(0, 80)}". Check the contract.`);
  }
}

/**
 * Watches that the panel keeps its image. **It does not resend anything, and
 * must not**: the server's `DeviceSender` resends the cached frame every
 * ~150 ms while the process lives, and the keepalive call with `count >= 1`
 * only checks that there is a frame and a connected device, returning in
 * microseconds.
 *
 * What remains is a **health probe**: one call every `intervalS`, to find out
 * that the panel was disconnected. Returns the function that stops it; the
 * wait is interruptible, so stopping never takes `intervalS`.
 */
export function pinFrame(o: TrccOptions, key: string, intervalS: number, onError: (msg: string) => void): () => void {
  let stopped = false;
  let contractChecked = false;
  const controller = new AbortController();

  const wait = (ms: number) =>
    new Promise<void>((resolve) => {
      if (stopped) return resolve();
      const done = () => {
        clearTimeout(timer);
        controller.signal.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      controller.signal.addEventListener('abort', done, { once: true });
    });

  const loop = async () => {
    while (!stopped) {
      try {
        const started = performance.now();
        const res = await fetch(url(o, key, '/display/keepalive'), {
          method: 'POST',
          headers: headers(o, { 'Content-Type': 'application/json' }),
          // Only `>= 1` matters: it picks the non-blocking branch. `count: 0`
          // would make the server sleep inside the HTTP handler and pin a
          // uvicorn worker forever.
          body: JSON.stringify({ count: 1 }),
          signal: controller.signal,
        });
        // Always consume the body: otherwise the connection stays busy and
        // sockets pile up against the server.
        const body = await res.text().catch(() => '');
        if (res.ok && !contractChecked) {
          contractChecked = true;
          checkKeepaliveContract(body, performance.now() - started, onError);
        }
        if (!res.ok) {
          onError(`the panel probe returned HTTP ${res.status}; retrying`);
          await wait(2000);
          continue;
        }
        await wait(intervalS * 1000);
      } catch (err) {
        if (stopped) return;
        onError(`panel probe interrupted: ${err instanceof Error ? err.message : String(err)}`);
        await wait(2000);
      }
    }
  };

  void loop();
  return () => {
    stopped = true;
    controller.abort();
  };
}

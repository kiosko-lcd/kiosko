/**
 * The screen firmware this Kiosko ships (firmware/esp32-screen), and getting
 * it to a paired screen without hunting for the file: every Kiosko release
 * carries the firmware built from the same commit (.github/workflows/
 * firmware.yml), so a Kiosko knows the version it would bring, offers it to
 * a screen that says an older one, and on the person's click downloads the
 * app image from its own release, checks it against the release's .sha256
 * and sends it through the authenticated OTA (ops.ts). Nothing is flashed
 * without that click.
 *
 * `SCREEN_FIRMWARE.version` must be firmware/esp32-screen/version.txt: a test
 * fails when they differ, so the offer and the release's file names agree.
 */
import { createHash } from 'node:crypto';
import { compareVersions, parseVersion } from '@kiosko/sdk';
import { parseSha256File, releaseAsset } from '../kiosko-release.ts';
import { ScreenError } from './link.ts';

export const SCREEN_FIRMWARE = {
  /** firmware/esp32-screen/version.txt */
  version: '0.1.4',
  /** The boards the release has images for: each one's `model`, as the screen says it (BOARD_MODEL). */
  boards: ['waveshare-esp32c6-lcd-1.47'] as readonly string[],
} as const;

/** The release's files for a firmware version and board: the app (OTA) and the full image (USB, at 0x0). */
export function firmwareFiles(version: string, board: string): { app: string; full: string } {
  return { app: `kiosko-screen-${version}-${board}.bin`, full: `kiosko-screen-${version}-${board}-full.bin` };
}

/**
 * The firmware version to offer a screen that says `model` and `fw`: this
 * Kiosko's, when it has one for that board and it is newer. Null otherwise
 * (an unknown board, the same or a newer firmware, a version that doesn't
 * read as one: a developer's build).
 */
export function firmwareOffer(model: string | undefined, fw: string | undefined, shipped: { version: string; boards: readonly string[] } = SCREEN_FIRMWARE): string | null {
  if (!model || !fw || !shipped.boards.includes(model)) return null;
  if (!parseVersion(fw) || !parseVersion(shipped.version)) return null;
  return compareVersions(shipped.version, fw) > 0 ? shipped.version : null;
}

/** What `downloadFirmware` needs of `fetch` (tests: a fake). */
export type FetchLike = (url: string, init?: { redirect?: 'follow'; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer>; text(): Promise<string> }>;

/** An app image is far below this; anything bigger is not ours. */
const MAX_IMAGE = 4 * 1024 * 1024;

/**
 * Downloads the app image of this Kiosko's firmware for `model` from the
 * release of `kioskoVersion` and checks it against the release's .sha256.
 * Throws a ScreenError: `noFirmware` (no image for that board),
 * `downloadFailed` (GitHub out of reach, or a release without it: a
 * development build), `hashMissing`, `hashMismatch`, `notFirmware`.
 */
export async function downloadFirmware(o: { kioskoVersion: string; model: string; fetch?: FetchLike; timeoutMs?: number; shipped?: { version: string; boards: readonly string[] } }): Promise<{ version: string; name: string; image: Buffer; sha256: string; url: string }> {
  const shipped = o.shipped ?? SCREEN_FIRMWARE;
  if (!shipped.boards.includes(o.model)) throw new ScreenError('noFirmware', `this Kiosko has no firmware for ${o.model}`);
  const get = o.fetch ?? ((u, i) => fetch(u, i));
  const name = firmwareFiles(shipped.version, o.model).app;
  const url = releaseAsset(o.kioskoVersion, name);
  const signal = () => AbortSignal.timeout(o.timeoutMs ?? 60_000);
  let expected: string | null;
  try {
    const r = await get(`${url}.sha256`, { redirect: 'follow', signal: signal() });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    expected = parseSha256File((await r.text()).slice(0, 4096), name);
  } catch (err) {
    throw new ScreenError('downloadFailed', `could not download ${name}.sha256 from the Kiosko ${o.kioskoVersion} release on GitHub (${err instanceof Error ? err.message : String(err)})`);
  }
  if (!expected) throw new ScreenError('hashMissing', `the release has no usable checksum for ${name}: not sending it`);
  let image: Buffer;
  try {
    const r = await get(url, { redirect: 'follow', signal: signal() });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    image = Buffer.from(await r.arrayBuffer());
  } catch (err) {
    throw new ScreenError('downloadFailed', `could not download ${name} from GitHub (${err instanceof Error ? err.message : String(err)})`);
  }
  const sha256 = createHash('sha256').update(image).digest('hex');
  if (sha256 !== expected) throw new ScreenError('hashMismatch', `${name} is not the file the release publishes (sha256 ${sha256.slice(0, 12)}…, expected ${expected.slice(0, 12)}…): not sent`);
  // An ESP-IDF image starts with 0xE9 (ops.ts checks it again).
  if (image.length > MAX_IMAGE || image[0] !== 0xe9) throw new ScreenError('notFirmware', `${name} is not an app image`);
  return { version: shipped.version, name, image, sha256, url };
}

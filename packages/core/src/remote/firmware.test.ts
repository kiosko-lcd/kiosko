import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { SCREEN_FIRMWARE, downloadFirmware, firmwareFiles, firmwareOffer, type FetchLike } from './firmware.ts';
import { ScreenError } from './link.ts';

const fwDir = new URL('../../../../firmware/esp32-screen/', import.meta.url);

test('SCREEN_FIRMWARE is the firmware in this repository: its version.txt and its boards', () => {
  assert.equal(SCREEN_FIRMWARE.version, readFileSync(new URL('version.txt', fwDir), 'utf8').trim(), 'bump SCREEN_FIRMWARE.version with firmware/esp32-screen/version.txt');
  const board = readFileSync(new URL('main/boards/waveshare_esp32c6_lcd147.h', fwDir), 'utf8').match(/#define BOARD_MODEL\s+"([^"]+)"/)?.[1];
  assert.ok(board && SCREEN_FIRMWARE.boards.includes(board));
  // The names the release workflow gives the images.
  const wf = readFileSync(new URL('../../.github/workflows/firmware.yml', fwDir), 'utf8');
  assert.match(wf, /kiosko-screen-\$v-\$board\.bin/);
  assert.match(wf, /kiosko-screen-\$v-\$board-full\.bin/);
  assert.match(wf, new RegExp(`board=${board!.replace(/\./g, '\\.')}`));
  assert.deepEqual(firmwareFiles('0.1.4', 'b'), { app: 'kiosko-screen-0.1.4-b.bin', full: 'kiosko-screen-0.1.4-b-full.bin' });
});

test('firmwareOffer: only a newer version, for a board it has, from a version that reads as one', () => {
  const shipped = { version: '0.1.4', boards: ['board-a'] };
  assert.equal(firmwareOffer('board-a', '0.1.3', shipped), '0.1.4');
  assert.equal(firmwareOffer('board-a', '0.1.4-beta.1', shipped), '0.1.4');
  assert.equal(firmwareOffer('board-a', '0.1.4', shipped), null);
  assert.equal(firmwareOffer('board-a', '0.2.0', shipped), null, 'never a downgrade');
  assert.equal(firmwareOffer('board-b', '0.1.0', shipped), null, 'another board');
  assert.equal(firmwareOffer('board-a', 'dev-6c1f', shipped), null, "a developer's build");
  assert.equal(firmwareOffer('board-a', '', shipped), null);
  assert.equal(firmwareOffer(undefined, '0.1.0', shipped), null);
});

/** A fake GitHub: the files by URL; a missing one is a 404; `down` fails like no network. */
function github(files: Record<string, Buffer | string>, o: { down?: boolean } = {}) {
  const asked: string[] = [];
  const f: FetchLike = async (url) => {
    asked.push(url);
    if (o.down) throw new TypeError('fetch failed');
    const body = files[url];
    const buf = body === undefined ? Buffer.from('Not Found') : Buffer.from(body);
    return { ok: body !== undefined, status: body === undefined ? 404 : 200, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) as ArrayBuffer, text: async () => buf.toString() };
  };
  return { fetch: f, asked };
}

test('downloadFirmware: from the running version\'s release, checked against its .sha256', async () => {
  const shipped = { version: '0.1.4', boards: ['board-a'] };
  const image = Buffer.concat([Buffer.from([0xe9]), Buffer.alloc(5000, 7)]);
  const sha = createHash('sha256').update(image).digest('hex');
  const url = 'https://github.com/kiosko-lcd/kiosko/releases/download/v0.2.12/kiosko-screen-0.1.4-board-a.bin';
  const gh = github({ [url]: image, [`${url}.sha256`]: `${sha}  kiosko-screen-0.1.4-board-a.bin\n` });
  const got = await downloadFirmware({ kioskoVersion: '0.2.12', model: 'board-a', fetch: gh.fetch, shipped });
  assert.ok(got.image.equals(image));
  assert.equal(got.sha256, sha);
  assert.equal(got.version, '0.1.4');
  assert.deepEqual(gh.asked, [`${url}.sha256`, url]);

  const code = (c: string) => (e: unknown) => e instanceof ScreenError && e.code === c;
  // Tampered with on the way (or the release changed): not sent.
  const bad = github({ [url]: Buffer.concat([image, Buffer.from([0])]), [`${url}.sha256`]: `${sha}  kiosko-screen-0.1.4-board-a.bin\n` });
  await assert.rejects(downloadFirmware({ kioskoVersion: '0.2.12', model: 'board-a', fetch: bad.fetch, shipped }), code('hashMismatch'));
  // A checksum for another file, or none.
  const other = github({ [url]: image, [`${url}.sha256`]: `${sha}  kiosko-screen-0.1.4-board-b.bin\n` });
  await assert.rejects(downloadFirmware({ kioskoVersion: '0.2.12', model: 'board-a', fetch: other.fetch, shipped }), code('hashMissing'));
  // No GitHub (offline, mainland China), or a version without a release (a development build).
  await assert.rejects(downloadFirmware({ kioskoVersion: '0.2.12', model: 'board-a', fetch: github({}, { down: true }).fetch, shipped }), code('downloadFailed'));
  await assert.rejects(downloadFirmware({ kioskoVersion: '0.2.13', model: 'board-a', fetch: gh.fetch, shipped }), code('downloadFailed'));
  // Not an ESP image, even with the right checksum.
  const junk = Buffer.from('<html>');
  const j = github({ [url]: junk, [`${url}.sha256`]: `${createHash('sha256').update(junk).digest('hex')}  kiosko-screen-0.1.4-board-a.bin` });
  await assert.rejects(downloadFirmware({ kioskoVersion: '0.2.12', model: 'board-a', fetch: j.fetch, shipped }), code('notFirmware'));
  // A board it has no firmware for: GitHub isn't even asked.
  const none = github({});
  await assert.rejects(downloadFirmware({ kioskoVersion: '0.2.12', model: 'board-z', fetch: none.fetch, shipped }), code('noFirmware'));
  assert.equal(none.asked.length, 0);
});

import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { apiToken, checkKeepaliveContract, detectPanel, multipartImage } from './client.ts';

function capture(body: string, ms: number): string[] {
  const out: string[] = [];
  checkKeepaliveContract(body, ms, (m) => out.push(m));
  return out;
}

/** What `trcc serve` answers today. */
const REAL = JSON.stringify({
  ok: true,
  message: 'Keepalive active — the send worker resends the frame',
  key: '0416:5408',
  frames_resent: 0,
  bytes_resent: 0,
});

test("canary: today's real answer raises no warning", () => {
  assert.deepStrictEqual(capture(REAL, 3), []);
});

test('canary: warns if the call blocks again', () => {
  // The OLD contract blocked ~30 s. Going back to it would change the cost of
  // the probe with no other signal giving it away.
  const warnings = capture(REAL, 30_000);
  assert.strictEqual(warnings.length, 1);
  assert.match(warnings[0]!, /blocks again/);
});

test('canary: warns if the call starts resending on its own', () => {
  const warnings = capture(JSON.stringify({ message: 'Keepalive active', frames_resent: 200 }), 3);
  assert.strictEqual(warnings.length, 1);
  assert.match(warnings[0]!, /resent 200 frames/);
});

test('canary: an unknown message is reported', () => {
  const warnings = capture(JSON.stringify({ message: 'Resent 200 frames over 30s' }), 3);
  assert.strictEqual(warnings.length, 1);
  assert.match(warnings[0]!, /unexpected/);
});

test('canary: if it stops being JSON, it says so and stops analysing', () => {
  assert.deepStrictEqual(capture('<html>502 Bad Gateway</html>', 3), ['the keepalive no longer answers JSON; the contract has changed.']);
});

test('multipartImage: a JPEG goes as .jpg, which is what trcc looks at', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  const head = multipartImage(jpeg, 'x').body.subarray(0, 200).toString('latin1');
  assert.match(head, /filename="frame\.jpg"/);
  assert.match(head, /Content-Type: image\/jpeg/);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  assert.match(multipartImage(png, 'x').body.subarray(0, 200).toString('latin1'), /filename="frame\.png"/);
});

test('multipartImage: a real multipart parser gets the PNG back intact', async () => {
  // A real PNG signature has stray CR and LF, and here also a "--": exactly
  // the bytes that would break a badly delimited body.
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x0d, 0x0a, 0x2d, 0x2d, 0xff]);
  const { body, contentType } = multipartImage(png);
  const form = await new Response(new Uint8Array(body), { headers: { 'content-type': contentType } }).formData();
  const file = form.get('image') as File;
  assert.strictEqual(file.name, 'frame.png');
  assert.strictEqual(file.type, 'image/png');
  assert.deepStrictEqual(Buffer.from(await file.arrayBuffer()), png);
});

test('API token: read from its file and sent as X-API-Token; no file, no header', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'token-'));
  const file = join(dir, 'trcc-token');
  const seen: (string | undefined)[] = [];
  const server = createServer((req, res) => {
    seen.push(req.headers['x-api-token'] as string | undefined);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ products: [{ key: '0416:5408', native_resolution: [1920, 462] }] }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const opts = (tokenFile: string) => ({ url: `http://127.0.0.1:${port}`, tokenFile, timeoutMs: 2000 });
  try {
    assert.strictEqual(apiToken(opts(join(dir, 'missing')), 1), '');
    assert.deepStrictEqual(await detectPanel(opts(join(dir, 'missing'))), { key: '0416:5408', width: 1920, height: 462 });
    writeFileSync(file, 'secret123\n');
    assert.strictEqual(apiToken(opts(file), 2), 'secret123', 'another file: re-read and trimmed');
    assert.ok(await detectPanel(opts(file)));
    assert.strictEqual(apiToken({ token: 'inline', tokenFile: file }), 'inline', 'an explicit token wins');
    assert.deepStrictEqual(seen, [undefined, 'secret123']);
  } finally {
    server.close();
  }
});

test('With several identical panels, the serial picks the per-unit key', async () => {
  const { usbPathForSerial, detectPanel } = await import('./client.ts');
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'sysfs-'));
  for (const [path, serial] of [['3-9', 'TERCERO'], ['3-11.1', 'GATOS'], ['3-11.2', 'NOTICIAS'], ['3-11', '']]) {
    mkdirSync(join(root, path));
    if (serial) writeFileSync(join(root, path, 'serial'), `${serial}\n`);
  }
  mkdirSync(join(root, 'usb3'));
  assert.equal(usbPathForSerial('GATOS', root), '3-11.1');
  assert.equal(usbPathForSerial('NO', root), null);
  const products = (keys: string[]) => ({ ok: true, products: keys.map((key) => ({ key, native_resolution: [1920, 462] })) });
  const serve = (body: unknown) => {
    globalThis.fetch = (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch;
  };
  const real = globalThis.fetch;
  try {
    const o = { url: 'http://x', timeoutMs: 1000, serial: 'GATOS', sysfsRoot: root };
    serve(products(['0416:5408@3-9', '0416:5408@3-11.2', '0416:5408@3-11.1']));
    assert.equal((await detectPanel(o))?.key, '0416:5408@3-11.1');
    serve(products(['0416:5408']));
    assert.equal((await detectPanel(o))?.key, '0416:5408');
    serve(products(['0416:5408@3-9']));
    assert.equal(await detectPanel(o), null);
  } finally {
    globalThis.fetch = real;
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { G, N, decodePoint, encodePoint, mul, onCurve, pointAdd, pointNeg, scalarFrom } from './p256.ts';
import { SpakeA, spakePoints, open, seal, sessionKeys, spakeRespond } from './crypto.ts';
import { vectorsHeader } from './vectors.ts';

test('p256: x·G and x·P agree with Node’s own ECDH', () => {
  for (let i = 0; i < 4; i++) {
    const a = createECDH('prime256v1');
    a.generateKeys();
    const x = scalarFrom(a.getPrivateKey());
    assert.equal(encodePoint(mul(x, G)).toString('hex'), a.getPublicKey('hex', 'uncompressed'));
    const b = createECDH('prime256v1');
    b.generateKeys();
    const shared = mul(x, decodePoint(b.getPublicKey()));
    assert.equal(encodePoint(shared).subarray(1, 33).toString('hex'), a.computeSecret(b.getPublicKey()).toString('hex'));
  }
});

test('p256: group laws and point checks', () => {
  const p = mul(12345n, G);
  assert.equal(mul(N, G), null);
  assert.deepEqual(pointAdd(p, pointNeg(p)), null);
  assert.deepEqual(pointAdd(p, p), mul(24690n, G));
  assert.ok(onCurve(spakePoints().M) && onCurve(spakePoints().N));
  const bad = encodePoint(p);
  bad[40] = bad[40]! ^ 1;
  assert.throws(() => decodePoint(bad), /not a point/);
});

test('spake2: both halves get the same key with the right code, different ones with a wrong code', () => {
  const uid = 'a085e3ae92d0';
  const a = new SpakeA(uid, '123456');
  const b = spakeRespond(uid, '123456', a.X);
  const ka = a.finish(b.Y);
  assert.ok(ka.key.equals(b.key) && ka.cA.equals(b.cA) && ka.cB.equals(b.cB));
  assert.equal(ka.key.length, 32);
  const wrong = spakeRespond(uid, '123457', a.X);
  const kw = a.finish(wrong.Y);
  assert.ok(!kw.cB.equals(wrong.cB) && !kw.key.equals(wrong.key));
  // Another screen (uid) with the same code: no match either.
  const other = spakeRespond('ffffffffffff', '123456', a.X);
  assert.ok(!a.finish(other.Y).cB.equals(other.cB));
});

test('session: sealed messages open in order, and a replayed, reordered or tampered one does not', () => {
  const key = randomBytes(32), nk = randomBytes(32), nd = randomBytes(32);
  const k = sessionKeys(key, nk, nd, 'kiosko');
  const d = sessionKeys(key, nk, nd, 'screen');
  const m0 = seal(k.tx, 0x10, Buffer.from('frame 0'));
  const m1 = seal(k.tx, 0x10, Buffer.from('frame 1'));
  const body = (m: Buffer) => [m.subarray(0, 4), m.subarray(4)] as const;
  assert.equal(open(d.rx, ...body(m0)).payload.toString(), 'frame 0');
  // m0 again: its nonce is behind the counter now.
  assert.throws(() => open({ ...d.rx }, ...body(m0)));
  assert.equal(open(d.rx, ...body(m1)).payload.toString(), 'frame 1');
  const m2 = seal(k.tx, 0x15, Buffer.from('{}'));
  const t = Buffer.from(m2);
  t[10] = t[10]! ^ 0x40;
  assert.throws(() => open({ ...d.rx }, ...body(t)));
  // The length is authenticated too.
  const h = Buffer.from(m2.subarray(0, 4));
  h[3] = h[3]! + 1;
  assert.throws(() => open({ ...d.rx }, h, m2.subarray(4)));
  // Another session (fresh nonces) can't take a message of this one.
  const d2 = sessionKeys(key, randomBytes(32), nd, 'screen');
  assert.throws(() => open(d2.rx, ...body(m2)));
  assert.equal(open(d.rx, ...body(m2)).type, 0x15);
  // The other way round.
  const r = seal(d.tx, 0x11, Buffer.from('{"n":1}'));
  assert.equal(open(k.rx, ...body(r)).payload.toString(), '{"n":1}');
});

test('the firmware’s test vectors are up to date', () => {
  const file = join(import.meta.dirname, '../../../../firmware/esp32-screen/test/vectors.h');
  const want = vectorsHeader();
  if (process.env.UPDATE_VECTORS === '1') writeFileSync(file, want);
  assert.ok(existsSync(file), 'firmware/esp32-screen/test/vectors.h is missing: UPDATE_VECTORS=1 npm test');
  assert.equal(readFileSync(file, 'utf8').replace(/\r\n/g, '\n'), want, 'vectors.h is stale: UPDATE_VECTORS=1 npm test');
});

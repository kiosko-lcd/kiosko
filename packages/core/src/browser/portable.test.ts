import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHash, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { vectors } from '../remote/vectors.ts';
import { SpakeA } from '../remote/crypto.ts';
import { aeadOpen, aeadSeal, authMac, fromHex, hkdf, hmac, open, LABEL_AUTH_D, LABEL_AUTH_K, plain, readPlain, seal, sessionKeys, sha256, spakeRespond, toHex } from './portable.ts';

const SIZES = [0, 1, 15, 16, 17, 55, 56, 63, 64, 65, 127, 128, 1000, 4095, 100_003];

test('portable sha256, hmac, hkdf: as Node computes them', () => {
  for (const n of SIZES) {
    const m = randomBytes(n);
    assert.equal(toHex(sha256(m)), createHash('sha256').update(m).digest('hex'), `sha256 of ${n} bytes`);
    const k = randomBytes(n % 100);
    assert.equal(toHex(hmac(k, m)), createHmac('sha256', k).update(m).digest('hex'), `hmac of ${n} bytes`);
  }
  const long = randomBytes(150);
  assert.equal(toHex(hmac(long, long)), createHmac('sha256', long).update(long).digest('hex'));
  for (const len of [16, 32, 64, 100]) {
    const ikm = randomBytes(32), salt = randomBytes(len % 3 ? 64 : 0);
    assert.equal(toHex(hkdf(ikm, salt, 'KSv1 session', len)), Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('KSv1 session'), len)).toString('hex'));
  }
});

test('portable ChaCha20-Poly1305: as Node seals, and refuses anything changed', () => {
  for (const n of SIZES) {
    const key = randomBytes(32), nonce = randomBytes(12), aad = randomBytes(n % 7), pt = randomBytes(n);
    const c = createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
    c.setAAD(aad, { plaintextLength: n });
    const node = Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]);
    const mine = aeadSeal(key, nonce, pt, aad);
    assert.equal(toHex(mine), node.toString('hex'), `${n} bytes`);
    assert.deepEqual(Buffer.from(aeadOpen(key, nonce, mine, aad)!), pt);
    if (n) {
      const bad = mine.slice();
      bad[n >> 1]! ^= 1;
      assert.equal(aeadOpen(key, nonce, bad, aad), null);
    }
    const badTag = mine.slice();
    badTag[badTag.length - 1]! ^= 0x80;
    assert.equal(aeadOpen(key, nonce, badTag, aad), null);
  }
});

test('portable SPAKE2 and session: the firmware vectors, byte for byte', () => {
  const v = vectors();
  const b = spakeRespond(v.UID!, v.CODE!, fromHex(v.X!), BigInt('0x' + v.Y_SCALAR));
  assert.equal(toHex(b.Y), v.Y);
  assert.equal(toHex(b.cA), v.CA);
  assert.equal(toHex(b.cB), v.CB);
  assert.equal(toHex(b.key), v.PAIR_KEY);
  const nk = fromHex(v.NK!), nd = fromHex(v.ND!);
  assert.equal(toHex(authMac(b.key, LABEL_AUTH_K, nk, nd, v.UID!)), v.AUTH_K);
  assert.equal(toHex(authMac(b.key, LABEL_AUTH_D, nk, nd, v.UID!)), v.AUTH_D);
  const s = sessionKeys(b.key, nk, nd, 'screen');
  const m0 = open(s.rx, fromHex(v.K2D_0!));
  assert.deepEqual([m0.type, new TextDecoder().decode(m0.payload)], [0x15, '{}']);
  const m1 = open(s.rx, fromHex(v.K2D_1!));
  assert.equal(m1.type, 0x10);
  assert.equal(toHex(seal(s.tx, 0x13, new TextEncoder().encode('{"id":"desk"}'))), v.D2K_0);
  // Replayed: the sequence moved on.
  assert.throws(() => open(s.rx, fromHex(v.K2D_1!)));
});

test('portable SPAKE2 against Kiosko’s half: the same key with the right code only', () => {
  const uid = 'b0b0b0b0b0b0';
  const a = new SpakeA(uid, '424242');
  const b = spakeRespond(uid, '424242', new Uint8Array(a.X));
  const ka = a.finish(Buffer.from(b.Y));
  assert.equal(ka.key.toString('hex'), toHex(b.key));
  assert.equal(ka.cB.toString('hex'), toHex(b.cB));
  const wrong = spakeRespond(uid, '424243', new Uint8Array(a.X));
  const a2 = new SpakeA(uid, '424242');
  assert.notEqual(a2.finish(Buffer.from(spakeRespond(uid, '424243', new Uint8Array(a2.X)).Y)).cB.toString('hex'), toHex(wrong.cB));
});

test('plain messages: written and read back, anything else is not one', () => {
  const m = plain(0x02, { uid: 'x', w: 3 });
  assert.deepEqual(readPlain(m), { type: 2, json: { uid: 'x', w: 3 } });
  assert.equal(readPlain(m.subarray(0, m.length - 1)), null);
  assert.equal(readPlain(new Uint8Array([0, 0, 0, 2, 1, 0x5b])), null);
});

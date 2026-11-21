import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { checkIntegrity, integrityOf, readTarGz, safeTarPath } from './tar.ts';
import { makeTar, makeTgz, paxRecord } from './fixtures/tar.ts';

const want = (p: string) => p === 'package/kiosko-manifest.json' || /^package\/docs\/[^/]+\.(png|jpg|webp)$/.test(p);

test('readTarGz: only the wanted files, nothing else unpacked', () => {
  const tgz = makeTgz([
    { path: 'package/package.json', body: '{"name":"kiosko-plugin-x"}' },
    { path: 'package/dist/index.js', body: 'process.exit(1)' },
    { path: 'package/kiosko-manifest.json', body: '{"manifest":1}' },
    { path: 'package/docs', type: '5' },
    { path: 'package/docs/card.png', body: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
  ]);
  const r = readTarGz(tgz, want);
  assert.deepEqual([...r.files.keys()], ['package/kiosko-manifest.json', 'package/docs/card.png']);
  assert.equal(r.files.get('package/kiosko-manifest.json')!.toString(), '{"manifest":1}');
  assert.deepEqual(r.skipped, []);
});

test('readTarGz: links are skipped, never followed', () => {
  const r = readTarGz(makeTgz([
    { path: 'package/kiosko-manifest.json', type: '2', link: '/etc/passwd' },
    { path: 'package/docs/a.png', type: '1', link: 'package/package.json' },
  ]), want);
  assert.equal(r.files.size, 0);
  assert.deepEqual(r.skipped.map((s) => s.why), ['a symbolic link', 'a hard link']);
});

test('readTarGz: a path that climbs out or starts at the root is refused', () => {
  for (const path of ['package/../../.bashrc', '/etc/passwd', '../x', 'package\\..\\x', 'C:/x']) {
    assert.throws(() => readTarGz(makeTgz([{ path, body: 'x' }]), () => true), /unsafe path/, path);
  }
  // Also when the name comes from a pax header.
  assert.throws(() => readTarGz(makeTgz([{ path: 'PaxHeader', type: 'x', body: paxRecord('path', 'package/../../x') }, { path: 'package/ok', body: 'x' }]), () => true), /unsafe path/);
  assert.equal(safeTarPath('./package/a'), 'package/a');
});

test('readTarGz: long names from pax headers', () => {
  const long = `package/docs/${'a'.repeat(120)}.png`;
  const r = readTarGz(makeTgz([{ path: 'PaxHeader', type: 'x', body: paxRecord('path', long) }, { path: 'package/docs/short.png', body: 'png' }]), () => true);
  assert.deepEqual([...r.files.keys()], [long]);
});

test('readTarGz: stops at its size limit (a gzip bomb)', () => {
  const big = gzipSync(Buffer.alloc(3 * 1024 * 1024));
  assert.throws(() => readTarGz(big, () => true, 1024 * 1024), /more than/);
  assert.throws(() => readTarGz(gzipSync(makeTar([{ path: 'package/a', body: 'x'.repeat(2000) }]).subarray(0, 1024)), () => true), /truncated/);
});

test('checkIntegrity: what npm says the tarball is', () => {
  const tgz = makeTgz([{ path: 'package/a', body: 'x' }]);
  const integrity = integrityOf(tgz);
  assert.match(integrity, /^sha512-/);
  assert.ok(checkIntegrity(tgz, integrity));
  assert.ok(!checkIntegrity(Buffer.concat([tgz, Buffer.from('x')]), integrity));
  assert.ok(!checkIntegrity(tgz, 'sha1-abc'));
});

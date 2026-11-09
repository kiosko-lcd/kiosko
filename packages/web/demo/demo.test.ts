// The browser demo's pieces that can be checked without a browser. The rest
// (painting, the editor) is checked end to end by scripts/demo-check-docker.sh.
import assert from 'node:assert/strict';
import { posix } from 'node:path';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { OFFICIAL_PLUGINS } from '../../server/src/builtin.ts';
import { EventEmitter, overrides } from './shims/node.ts';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

test('the path stand-in agrees with node:path (POSIX)', () => {
  const path = overrides.path as unknown as typeof posix;
  const cases = ['/a/b/../c', 'a/./b//c/', '../x/../../y', '/', '', '.', '/home/me/.config/kiosko', 'file.tar.gz', '.bashrc', '/a/b/'];
  for (const p of cases) {
    if (p) {
      assert.equal(path.normalize(p), posix.normalize(p).replace(/(.)\/$/, '$1'), `normalize ${p}`);
      assert.equal(path.basename(p), posix.basename(p), `basename ${p}`);
      assert.equal(path.dirname(p), posix.dirname(p), `dirname ${p}`);
      assert.equal(path.extname(p), posix.extname(p), `extname ${p}`);
    }
    assert.equal(path.isAbsolute(p), posix.isAbsolute(p), `isAbsolute ${p}`);
  }
  assert.equal(path.join('/kiosko-demo', 'data', 'news'), posix.join('/kiosko-demo', 'data', 'news'));
  assert.equal(path.join('a', '', '../b'), posix.join('a', '', '../b'));
  assert.equal(path.resolve('/a', 'b', '../c'), posix.resolve('/a', 'b', '../c'));
  assert.equal(path.relative('/a/b/c', '/a/d'), posix.relative('/a/b/c', '/a/d'));
  assert.equal(path.basename('/x/report.json', '.json'), 'report');
});

test('promisify turns a stub that throws into a rejection', async () => {
  const promisify = overrides.util!.promisify as (fn: (...a: unknown[]) => unknown) => (...a: unknown[]) => Promise<unknown>;
  const stub = () => {
    throw new Error('node:child_process.execFile() is not available in the browser demo');
  };
  await assert.rejects(promisify(stub)('git'), /not available in the browser demo/);
  const ok = (a: number, cb: (e: unknown, v: number) => void) => cb(null, a * 2);
  assert.equal(await promisify(ok as (...a: unknown[]) => unknown)(21), 42);
});

test('EventEmitter: on, once, off', () => {
  const e = new EventEmitter();
  const seen: unknown[] = [];
  const fn = (v: unknown) => seen.push(v);
  e.on('frame', fn);
  e.once('frame', (v) => seen.push(`once ${v}`));
  assert.equal(e.emit('frame', 1), true);
  e.emit('frame', 2);
  e.off('frame', fn);
  assert.equal(e.emit('frame', 3), false);
  assert.deepEqual(seen, [1, 'once 1', 2]);
});

test('the demo bundles every official plugin', () => {
  const src = read('./plugins.ts');
  for (const o of OFFICIAL_PLUGINS) {
    assert.match(src, new RegExp(`^import ${o.id} from '${o.npm}';$`, 'm'), `demo/plugins.ts should import ${o.npm}`);
    assert.match(src, new RegExp(`[{ ,]${o.id}[,} ]`), `${o.id} should be in OFFICIAL`);
  }
});

test('the demo ships the fonts core registers', () => {
  const files = (s: string) => [...s.matchAll(/'(DejaVu[\w-]+\.ttf)'/g)].map((m) => m[1]).sort();
  const core = files(read('../../core/src/fonts.ts'));
  assert.equal(core.length, 4);
  assert.deepEqual(files(read('./shims/fonts.ts')), core);
  assert.deepEqual(files(read('./build.mjs')), core);
});

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { expandPath, paths } from './paths.ts';
import { openDevice } from './devices.ts';
import {
  DEFAULT_PORT,
  SANDBOX_UNSET,
  applySandbox,
  confinePath,
  currentSandbox,
  isInside,
  listSandboxes,
  parseDuration,
  registerSandbox,
  sandboxAllows,
  sandboxEnv,
  sandboxLifetime,
  sandboxPortProblem,
  unregisterSandbox,
  type LifetimeDeps,
} from './sandbox.ts';

function tmp(t: TestContext, name: string): string {
  const d = mkdtempSync(join(tmpdir(), `kiosko-sbt-${name}-`));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

/** Runs `fn` with process.env as a sandbox in `dir` would have it, and puts it back after. */
function withSandbox(t: TestContext, dir: string, allow: ('usb' | 'remote' | 'lan')[] = []) {
  const saved = { ...process.env };
  t.after(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  });
  return applySandbox(dir, { allow, env: process.env });
}

test('sandboxEnv points every path variable inside the sandbox', () => {
  const env = sandboxEnv('/sb', { registry: '/reg' });
  for (const k of ['KIOSKO_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR', 'TMPDIR', 'TMP', 'TEMP', 'npm_config_cache']) {
    assert.ok(env[k] && isInside(env[k], '/sb'), `${k}=${env[k]}`);
  }
  assert.equal(env.KIOSKO_SANDBOX_REGISTRY, '/reg');
});

test('in a sandbox, paths.*, the RAM cache, homedir, tmpdir and $XDG_RUNTIME_DIR expansion are all inside it', (t) => {
  const dir = tmp(t, 'paths');
  process.env.AIMONITOR_DIR = '/real/aimonitor';
  const sb = withSandbox(t, dir);
  assert.equal(sb.dir, dir);
  for (const k of SANDBOX_UNSET) assert.equal(process.env[k], undefined, k);
  const all = [paths.home, paths.config, paths.plugins, paths.data('news'), paths.cache('news')!, paths.cache('../../evil')!, homedir(), tmpdir(), expandPath('$XDG_RUNTIME_DIR/kiosko-frames'), expandPath('~/x'), expandPath('${XDG_CACHE_HOME}/y')];
  for (const p of all) assert.ok(isInside(p, dir), p);
  // The runtime dir exists, so the cache is the sandbox's tmpfs-like folder, not /dev/shm.
  assert.ok(existsSync(process.env.XDG_RUNTIME_DIR!));
  assert.equal(paths.cache('news'), join(dir, 'run', 'kiosko-cache', 'news'));
  // Even if something resets KIOSKO_HOME, Kiosko's folder stays the sandbox's.
  process.env.KIOSKO_HOME = '/somewhere/else';
  assert.equal(paths.home, join(dir, 'kiosko'));
});

test('a sandbox without a folder makes a fresh one in the system temp folder', (t) => {
  const saved = { ...process.env };
  t.after(() => Object.assign(process.env, saved));
  const sys = tmpdir();
  const sb = withSandbox(t, undefined as unknown as string);
  t.after(() => rmSync(sb.dir, { recursive: true, force: true }));
  assert.ok(sb.created);
  assert.ok(isInside(sb.dir, sys));
  assert.match(sb.dir, /kiosko-sandbox-/);
  // The registry stays in the system temp folder, not the sandbox's.
  assert.ok(!isInside(sb.registry, sb.dir));
});

test('confinePath moves paths outside the sandbox into its outside/ folder', (t) => {
  const dir = tmp(t, 'confine');
  assert.equal(confinePath('/run/user/1000/frames'), '/run/user/1000/frames');
  withSandbox(t, dir);
  assert.equal(confinePath(join(dir, 'run', 'f')), join(dir, 'run', 'f'));
  const moved = confinePath('/run/user/1000/kiosko-frames/a');
  assert.ok(isInside(moved, dir), moved);
  assert.ok(moved.endsWith(join('run', 'user', '1000', 'kiosko-frames', 'a')));
  assert.ok(isInside(confinePath('C:\\Users\\x\\frames'), dir));
  assert.ok(isInside(confinePath('../../etc'), dir));
});

test('in a sandbox, real panels are off unless allowed, and Frame files go inside it', async (t) => {
  const dir = tmp(t, 'devices');
  withSandbox(t, dir);
  for (const cfg of [{ driver: 'usb' as const }, { driver: 'trcc' as const, url: 'http://127.0.0.1:1' }, { driver: 'remote' as const, uid: 'abc' }]) {
    const d = openDevice(cfg, () => undefined);
    assert.equal(d.status.code, 'sandboxOff', cfg.driver);
    await d.send(Buffer.from('x'));
    d.close();
  }
  const f = openDevice({ driver: 'file', dir: '/run/user/1000/kiosko-frames/main' }, () => undefined);
  const path = String(f.status.params?.path);
  assert.ok(isInside(path, dir), path);
  f.close();
  assert.equal(sandboxAllows('usb'), false);
  assert.equal(sandboxAllows('lan'), false);
});

test('sandbox allowances come from the environment', (t) => {
  const dir = tmp(t, 'allow');
  withSandbox(t, dir, ['usb']);
  assert.equal(sandboxAllows('usb'), true);
  assert.equal(sandboxAllows('remote'), false);
  assert.deepEqual([...currentSandbox()!.allow], ['usb']);
  assert.equal(openDevice({ driver: 'remote', uid: 'x' }, () => undefined).status.code, 'sandboxOff');
  assert.equal(sandboxAllows('usb', {}), true, 'outside a sandbox everything is allowed');
});

test('durations', () => {
  assert.equal(parseDuration('90s'), 90_000);
  assert.equal(parseDuration('30m'), 1_800_000);
  assert.equal(parseDuration('2h'), 7_200_000);
  assert.equal(parseDuration('1d'), 86_400_000);
  assert.equal(parseDuration('250ms'), 250);
  assert.equal(parseDuration('45'), 45_000);
  for (const off of ['0', 'off', 'none', 'never']) assert.equal(parseDuration(off), null);
  assert.throws(() => parseDuration('soon'), /not a duration/);
});

test('a sandbox refuses the default port unless forced', () => {
  assert.match(sandboxPortProblem(DEFAULT_PORT)!, /7420/);
  assert.equal(sandboxPortProblem(DEFAULT_PORT, { force: true }), null);
  assert.equal(sandboxPortProblem(7491), null);
});

/** Timers and a parent you move by hand. */
function fakeLife() {
  let now = 0;
  const timers: { at: number; every?: number; fn: () => void; id: number }[] = [];
  let id = 0;
  let ppid = 100;
  const alive = new Set([100]);
  const deps: LifetimeDeps = {
    setTimeout: (fn, ms) => (timers.push({ at: now + ms, fn, id: ++id }), id),
    clearTimeout: (t) => void timers.splice(timers.findIndex((x) => x.id === t) >>> 0, 1),
    setInterval: (fn, ms) => (timers.push({ at: now + ms, every: ms, fn, id: ++id }), id),
    clearInterval: (t) => void timers.splice(timers.findIndex((x) => x.id === t) >>> 0, 1),
    ppid: () => ppid,
    alive: (p) => alive.has(p),
  };
  const advance = (ms: number) => {
    const until = now + ms;
    for (;;) {
      const next = timers.filter((x) => x.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      now = next.at;
      if (next.every) next.at += next.every;
      else timers.splice(timers.indexOf(next), 1);
      next.fn();
    }
    now = until;
  };
  return { deps, advance, killParent: () => (alive.delete(100), (ppid = 1)), pending: () => timers.length };
}

test('the TTL ends a sandbox once, with the reason', () => {
  const f = fakeLife();
  const ends: string[] = [];
  sandboxLifetime({ ttlMs: 2 * 3600_000, onEnd: (w) => ends.push(w), deps: f.deps });
  f.advance(3600_000);
  assert.deepEqual(ends, []);
  f.advance(3600_000);
  assert.equal(ends.length, 1);
  assert.match(ends[0]!, /time to live \(2h\)/);
  f.advance(10 * 3600_000);
  assert.equal(ends.length, 1);
});

test('exit-with-parent ends a sandbox when its parent is gone; cancel stops both', () => {
  const f = fakeLife();
  const ends: string[] = [];
  sandboxLifetime({ ttlMs: null, exitWithParent: true, pollMs: 500, onEnd: (w) => ends.push(w), deps: f.deps });
  f.advance(5000);
  assert.deepEqual(ends, []);
  f.killParent();
  f.advance(500);
  assert.equal(ends.length, 1);
  assert.match(ends[0]!, /pid 100\) is gone/);
  assert.equal(f.pending(), 0);

  const g = fakeLife();
  const cancel = sandboxLifetime({ ttlMs: 1000, exitWithParent: true, onEnd: () => assert.fail('cancelled'), deps: g.deps });
  cancel();
  g.killParent();
  g.advance(10_000);
  assert.equal(g.pending(), 0);
});

test('the registry lists live sandboxes and drops dead and broken entries', (t) => {
  const reg = tmp(t, 'registry');
  const e = (pid: number) => ({ pid, port: 7490 + pid, host: '127.0.0.1', dir: `/sb/${pid}`, started: pid, expires: null, version: '0', temporary: false });
  registerSandbox(reg, e(2));
  registerSandbox(reg, e(1));
  registerSandbox(reg, e(3));
  writeFileSync(join(reg, '9.json'), '{ half');
  mkdirSync(join(reg, 'other'), { recursive: true });
  const alive = (pid: number) => pid !== 3;
  assert.deepEqual(listSandboxes(reg, { alive }).map((x) => x.pid), [1, 2]);
  assert.deepEqual(readdirSync(reg).sort(), ['1.json', '2.json', 'other']);
  unregisterSandbox(reg, 1);
  assert.deepEqual(listSandboxes(reg, { alive }).map((x) => x.pid), [2]);
  assert.deepEqual(listSandboxes(join(reg, 'missing')), []);
});

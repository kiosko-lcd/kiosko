/**
 * Sandbox mode end to end: real `kiosko start --sandbox` processes, with a
 * fake "production" home (HOME, XDG_*, APPDATA… and a Kiosko installed there)
 * that must come out of every test untouched.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { DEFAULT_CONFIG, newScreen, newTile, newWidget, type Config } from '@kiosko/core';
import { listSandboxes, type SandboxEntry } from '@kiosko/core/sandbox';
import { parseSandboxArgs } from './sandbox-args.ts';
import { SandboxRefusal, sandboxCommand, sandboxConfig, sandboxListen, sandboxTtl } from './sandbox-cli.ts';

const ROOT = resolve(import.meta.dirname, '../../..');
const CLI = join(ROOT, 'packages/server/src/cli.ts');

function tmp(t: TestContext, name: string): string {
  const d = mkdtempSync(join(tmpdir(), `kiosko-sbx-${name}-`));
  t.after(() => rmSync(d, { recursive: true, force: true, maxRetries: 5 }));
  return d;
}

/** A machine with a real Kiosko on it: its home, its XDG folders, its config and its RAM cache. */
function production(t: TestContext) {
  const root = tmp(t, 'prod');
  const home = join(root, 'home');
  const dirs = { home, config: join(home, '.config'), data: join(home, '.local', 'share'), cache: join(home, '.cache'), state: join(home, '.local', 'state'), run: join(root, 'run'), tmp: join(root, 'tmp'), appdata: join(home, 'AppData', 'Roaming'), local: join(home, 'AppData', 'Local') };
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
  const kioskoHome = process.platform === 'win32' ? join(dirs.appdata, 'Kiosko') : process.platform === 'darwin' ? join(home, 'Library', 'Application Support', 'Kiosko') : join(dirs.config, 'kiosko');
  mkdirSync(join(kioskoHome, 'plugins'), { recursive: true });
  mkdirSync(join(dirs.run, 'kiosko-cache', 'news'), { recursive: true });
  writeFileSync(join(dirs.run, 'kiosko-cache', 'news', 'deck.json'), '{"real":true}');
  // Where the real senders read the real panels' frames from.
  mkdirSync(join(dirs.run, 'kiosko-frames', 'a'), { recursive: true });
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(KIOSKO_|XDG_|npm_config_|AIMONITOR|AGENT_SESSIONS)/i.test(k)) env[k] = v;
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    APPDATA: dirs.appdata,
    LOCALAPPDATA: dirs.local,
    XDG_CONFIG_HOME: dirs.config,
    XDG_DATA_HOME: dirs.data,
    XDG_CACHE_HOME: dirs.cache,
    XDG_STATE_HOME: dirs.state,
    XDG_RUNTIME_DIR: dirs.run,
    TMPDIR: dirs.tmp,
    TMP: dirs.tmp,
    TEMP: dirs.tmp,
    KIOSKO_QUIET: '',
  });
  return { root, dirs, kioskoHome, env };
}

/** Every file and folder under `dir`, with what would show it changed. */
function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const s = statSync(p);
      out.set(relative(dir, p).split('\\').join('/'), s.isDirectory() ? 'dir' : `${s.size}:${s.mtimeMs}:${createHash('sha1').update(readFileSync(p)).digest('hex')}`);
      if (s.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out;
}

function files(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    if (!existsSync(d)) return;
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(dir, p).split('\\').join('/'));
    }
  };
  walk(dir);
  return out;
}

interface Running {
  child: ChildProcess;
  output: () => string;
  exited: Promise<number | null>;
  waitFor: (re: RegExp, ms?: number) => Promise<void>;
}

function kiosko(t: TestContext, args: string[], env: NodeJS.ProcessEnv): Running {
  const child = spawn(process.execPath, ['--conditions=source', CLI, ...args], { env, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout!.on('data', (b: Buffer) => void (out += b.toString()));
  child.stderr!.on('data', (b: Buffer) => void (out += b.toString()));
  const exited = new Promise<number | null>((ok) => child.once('exit', (code) => ok(code)));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await exited;
    }
  });
  return {
    child,
    output: () => out,
    exited,
    waitFor: async (re, ms = 30_000) => {
      const until = Date.now() + ms;
      while (!re.test(out)) {
        if (Date.now() > until) throw new Error(`timed out waiting for ${re}; output:\n${out}`);
        if (child.exitCode !== null) throw new Error(`exited (${child.exitCode}) before ${re}; output:\n${out}`);
        await new Promise((r) => setTimeout(r, 100));
      }
    },
  };
}

async function until(what: string, ok: () => boolean | Promise<boolean>, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await ok())) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

/** A plugin that writes everywhere a plugin could: its cache and data folders, ~, the temp folder, $XDG_*. */
const PROBE = `import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
const put = (dir, name) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, name), String(Date.now())); };
export default { id: 'probe', name: 'Probe', version: '1.0.0', widgets: [{ id: 'w', name: 'W', intervalMs: 1000, async fetch(ctx) {
  put(ctx.cacheDir, 'probe-cache');
  put(ctx.dataDir, 'probe-data');
  put(tmpdir(), 'probe-tmp');
  put(homedir(), 'probe-home');
  put(process.env.XDG_RUNTIME_DIR, 'probe-run');
  put(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'probe-xdg-cache');
  if (process.env.APPDATA) put(process.env.APPDATA, 'probe-appdata');
  if (process.env.LOCALAPPDATA) put(process.env.LOCALAPPDATA, 'probe-localappdata');
  return { ok: true };
}, render() {} }] };
`;

function productionConfig(prod: ReturnType<typeof production>, jsonUrl: string): Config {
  const a = newScreen('Frames A', 320, 240, { driver: 'file', dir: '$XDG_RUNTIME_DIR/kiosko-frames/a' });
  a.pages[0]!.tiles = [newTile({ x: 0, y: 0, w: 12, h: 12 }, [newWidget('probe/w'), newWidget('core/json', { url: jsonUrl, select: 'v', chart: 'below' })])];
  const b = newScreen('Frames B', 320, 240, { driver: 'file', dir: join(prod.dirs.run, 'frames-abs') });
  b.pages[0]!.tiles = [newTile({ x: 0, y: 0, w: 12, h: 12 }, [newWidget('core/clock')])];
  const usb = newScreen('USB', 320, 240, { driver: 'usb', serial: 'REAL-PANEL' });
  return { ...structuredClone(DEFAULT_CONFIG), locale: 'en', screens: [a, b, usb], server: { host: '0.0.0.0', port: 7420 } };
}

test('a sandboxed Kiosko writes nothing outside its folder: config, plugins, caches, Frame files, ~, temp', async (t) => {
  const prod = production(t);
  const registry = tmp(t, 'reg');
  const sb = join(tmp(t, 'sb'), 'box');
  // A JSON endpoint, so core/json keeps its curve in its RAM cache.
  const http = createServer((_q, r) => r.end('{"v": 21}'));
  await new Promise<void>((ok) => http.listen(0, '127.0.0.1', ok));
  t.after(() => http.close());
  const jsonUrl = `http://127.0.0.1:${(http.address() as { port: number }).port}/`;
  const prodConfig = join(prod.kioskoHome, 'config.json');
  writeFileSync(prodConfig, `${JSON.stringify(productionConfig(prod, jsonUrl), null, 2)}\n`);
  // The probe plugin, in the sandbox's own plugins folder.
  mkdirSync(join(sb, 'kiosko', 'plugins', 'probe'), { recursive: true });
  writeFileSync(join(sb, 'kiosko', 'plugins', 'probe', 'index.mjs'), PROBE);
  const before = snapshot(prod.root);

  const port = 37481;
  const k = kiosko(t, ['start', '--sandbox', sb, '--port', String(port), '--host', '0.0.0.0', '--sandbox-config', prodConfig, '--sandbox-ttl', '5m'], { ...prod.env, KIOSKO_SANDBOX_REGISTRY: registry });
  await k.waitFor(/SANDBOX — editor at/);
  const base = `http://127.0.0.1:${port}`;
  await until('the API answers', async () => (await fetch(`${base}/api/version`).catch(() => null))?.ok ?? false);
  const v = (await (await fetch(`${base}/api/version`)).json()) as { sandbox?: { dir: string; expires: number | null } };
  assert.equal(v.sandbox?.dir, resolve(sb));
  assert.ok(v.sandbox.expires && v.sandbox.expires > Date.now());

  const box = () => files(sb);
  await until('frames, the probe and the json cache are written', () => {
    const f = box();
    return ['run/kiosko-frames/a/frame.jpg', 'probe-cache', 'probe-data', 'probe-tmp', 'probe-home', 'probe-run', 'probe-xdg-cache'].every((n) => f.some((x) => x === n || x.endsWith(`/${n}`))) && f.some((x) => x.startsWith('outside/') && x.endsWith('frames-abs/frame.jpg')) && f.some((x) => x.startsWith('run/kiosko-cache/core/'));
  });
  const f = box();
  assert.ok(f.includes('run/kiosko-cache/probe/probe-cache'), f.join('\n'));
  assert.ok(f.includes('kiosko/data/probe/probe-data'), f.join('\n'));

  const state = (await (await fetch(`${base}/api/state`)).json()) as { sandbox: { dir: string } | null; config: Config; status: { screens: { id: string; device: { code?: string } }[] }; kioskoUpdate: { canUpdate: boolean; blocker: string } };
  assert.equal(state.sandbox?.dir, resolve(sb));
  assert.equal(state.kioskoUpdate.canUpdate, false);
  assert.equal(state.kioskoUpdate.blocker, 'sandbox');
  const usbId = state.config.screens.find((s) => s.name === 'USB')!.id;
  assert.equal(state.status.screens.find((s) => s.id === usbId)?.device.code, 'sandboxOff');
  // Remote screens: refused.
  const remote = await fetch(`${base}/api/remote/discover`, { headers: { 'x-kiosko': '1' } });
  assert.equal(remote.status, 403);

  // The editor saves into the sandbox's copy, never into the config it was copied from.
  const changed = { ...state.config, screens: state.config.screens.map((s) => ({ ...s, name: `${s.name} (edited)` })) };
  const put = await fetch(`${base}/api/config`, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-kiosko': '1' }, body: JSON.stringify({ config: changed }) });
  assert.equal(put.status, 200);
  assert.match(readFileSync(join(sb, 'kiosko', 'config.json'), 'utf8'), /Frames A \(edited\)/);
  assert.doesNotMatch(readFileSync(prodConfig, 'utf8'), /edited/);

  // It is listed while it runs, and gone from the list when it ends.
  assert.deepEqual(listSandboxes(registry).map((e) => [e.pid, e.port, e.dir]), [[k.child.pid, port, resolve(sb)]]);
  k.child.kill('SIGTERM');
  await k.exited;
  assert.deepEqual(listSandboxes(registry), []);
  // A folder it was given stays, to look into.
  assert.ok(existsSync(join(sb, 'kiosko', 'config.json')));
  assert.deepEqual(snapshot(prod.root), before, 'the production folders changed');
  assert.match(k.output(), /SANDBOX — this is not the real Kiosko/);
  assert.match(k.output(), /listening on 127\.0\.0\.1, not 0\.0\.0\.0/);
});

test('a sandbox refuses the default port and a config outside it, before touching anything', async (t) => {
  const prod = production(t);
  const registry = tmp(t, 'reg');
  const sb = join(tmp(t, 'sb'), 'box');
  const prodConfig = join(prod.kioskoHome, 'config.json');
  writeFileSync(prodConfig, '{}\n');
  const before = snapshot(prod.root);
  const run = (...args: string[]) => spawnSync(process.execPath, ['--conditions=source', CLI, 'start', '--sandbox', sb, ...args], { env: { ...prod.env, KIOSKO_SANDBOX_REGISTRY: registry }, encoding: 'utf8', timeout: 30_000 });
  const port = run('--port', '7420');
  assert.equal(port.status, 2, port.stdout + port.stderr);
  assert.match(port.stderr, /doesn't listen on 7420/);
  const config = run('--port', '37483', '--config', prodConfig);
  assert.equal(config.status, 2, config.stdout + config.stderr);
  assert.match(config.stderr, /outside the sandbox/);
  assert.match(config.stderr, /--sandbox-config/);
  const service = spawnSync(process.execPath, ['--conditions=source', CLI, 'service', 'install', '--sandbox', sb], { env: { ...prod.env, KIOSKO_SANDBOX_REGISTRY: registry }, encoding: 'utf8', timeout: 30_000 });
  assert.equal(service.status, 2, service.stdout + service.stderr);
  assert.match(service.stderr, /not in a sandbox/);
  assert.deepEqual(listSandboxes(registry), []);
  assert.deepEqual(snapshot(prod.root), before);
});

test('a sandbox ends by itself when its TTL is over, and removes the temp folder it made', async (t) => {
  const prod = production(t);
  const registry = tmp(t, 'reg');
  // The system temp folder, where a sandbox without a folder makes one.
  const sys = tmp(t, 'systmp');
  const k = kiosko(t, ['--sandbox', '--port', '37482', '--sandbox-ttl', '2s'], { ...prod.env, TMPDIR: sys, TMP: sys, TEMP: sys, KIOSKO_SANDBOX_REGISTRY: registry });
  await k.waitFor(/SANDBOX — editor at/);
  const dir = /Everything it writes is in (\S+)/.exec(k.output())![1]!;
  assert.ok(dir.startsWith(join(sys, 'kiosko-sandbox-')), dir);
  assert.ok(existsSync(dir));
  assert.equal(await k.exited, 0);
  assert.match(k.output(), /ending: its time to live \(2s\) is over/);
  assert.ok(!existsSync(dir), 'its temp folder is gone');
  assert.deepEqual(listSandboxes(registry), []);
});

test('with --sandbox-exit-with-parent a sandbox ends when the process that started it dies', async (t) => {
  const prod = production(t);
  const registry = tmp(t, 'reg');
  const sb = join(tmp(t, 'sb'), 'box');
  const log = join(tmp(t, 'log'), 'kiosko.log');
  // A parent that starts the sandbox, says its pid, and waits to be killed. Detached: on Windows,
  // libuv's job object would otherwise end the child with it, and this would test nothing.
  const parentCode = `
    const { spawn } = require('node:child_process');
    const fs = require('node:fs');
    const out = fs.openSync(${JSON.stringify(log)}, 'a');
    const c = spawn(process.execPath, ['--conditions=source', ${JSON.stringify(CLI)}, 'start', '--sandbox', ${JSON.stringify(sb)}, '--port', '37485', '--sandbox-exit-with-parent'], { stdio: ['ignore', out, out], detached: true });
    console.log(c.pid);
    setInterval(() => {}, 1000);
  `;
  const parent = spawn(process.execPath, ['-e', parentCode], { env: { ...prod.env, KIOSKO_SANDBOX_REGISTRY: registry }, stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => parent.kill('SIGKILL'));
  const pid = Number(await new Promise<string>((ok) => parent.stdout!.once('data', (b: Buffer) => ok(b.toString().trim()))));
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  t.after(() => {
    if (alive()) process.kill(pid, 'SIGKILL');
  });
  await until('the sandbox is listed', () => listSandboxes(registry).some((e) => e.pid === pid));
  parent.kill('SIGKILL');
  await until('the sandbox ended', () => !alive(), 20_000);
  assert.match(readFileSync(log, 'utf8'), /ending: the process that started it \(pid \d+\) is gone/);
  assert.deepEqual(listSandboxes(registry), []);
});

test('kiosko sandbox list and stop find and stop running sandboxes', async (t) => {
  const prod = production(t);
  const registry = tmp(t, 'reg');
  const sb = join(tmp(t, 'sb'), 'box');
  const env = { ...prod.env, KIOSKO_SANDBOX_REGISTRY: registry };
  const k = kiosko(t, ['start', '--sandbox', sb, '--port', '37484'], env);
  await k.waitFor(/SANDBOX — editor at/);
  await until('listed', () => listSandboxes(registry).length === 1);
  // Not spawnSync: this process must be free to reap the sandbox it started when it ends.
  const cli = (...args: string[]) =>
    new Promise<{ status: number | null; stdout: string; stderr: string }>((ok) => {
      const c = spawn(process.execPath, ['--conditions=source', CLI, 'sandbox', ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      c.stdout.on('data', (b: Buffer) => void (stdout += b.toString()));
      c.stderr.on('data', (b: Buffer) => void (stderr += b.toString()));
      c.once('close', (status) => ok({ status, stdout, stderr }));
    });
  const list = await cli('list', '--json');
  assert.equal(list.status, 0, list.stderr);
  const entries = JSON.parse(list.stdout) as SandboxEntry[];
  assert.deepEqual(entries.map((e) => [e.pid, e.port, e.dir]), [[k.child.pid, 37484, resolve(sb)]]);
  assert.match((await cli('list')).stdout, new RegExp(`pid ${k.child.pid}  http://127\\.0\\.0\\.1:37484/`));
  const stop = await cli('stop', 'all');
  assert.equal(stop.status, 0, stop.stdout + stop.stderr);
  assert.match(stop.stdout, /stopped pid/);
  await k.exited;
  assert.match((await cli('list')).stdout, /no sandboxed Kiosko running/);
});

test('sandbox stop leaves alone a pid that no longer answers as that sandbox', async (t) => {
  const registry = tmp(t, 'reg');
  const entry: SandboxEntry = { pid: 4242, port: 37486, host: '127.0.0.1', dir: '/sb/a', started: 1, expires: null, version: '0', temporary: false };
  writeFileSync(join(registry, '4242.json'), JSON.stringify(entry));
  const killed: number[] = [];
  const lines: string[] = [];
  let up = true;
  const deps = { registry, log: (l: string) => void lines.push(l), alive: () => up, kill: (pid: number) => (killed.push(pid), (up = false)), waitMs: 200 };
  assert.equal(await sandboxCommand(['stop', '4242'], { ...deps, version: async () => ({ sandbox: { dir: '/sb/other' } }) }), 1);
  assert.deepEqual(killed, []);
  assert.match(lines.at(-1)!, /doesn't answer as the sandbox/);
  assert.equal(await sandboxCommand(['stop', '999'], { ...deps, version: async () => null }), 1);
  assert.match(lines.at(-1)!, /no sandbox with pid 999/);
  assert.equal(await sandboxCommand(['stop', '4242'], { ...deps, version: async () => ({ sandbox: { dir: '/sb/a' } }) }), 0);
  assert.deepEqual(killed, [4242]);
  assert.equal(existsSync(join(registry, '4242.json')), false);
});

test('--sandbox arguments: the folder, the allowances, and a command word is not a folder', () => {
  assert.deepEqual(parseSandboxArgs(['start', '--sandbox', '/x', '--port', '1'], {}), { on: true, dir: '/x', allow: [], argv: ['start', '--port', '1'] });
  assert.deepEqual(parseSandboxArgs(['--sandbox', 'start'], {}), { on: true, allow: [], argv: ['start'] });
  assert.deepEqual(parseSandboxArgs(['start', '--sandbox', '--port', '1'], {}), { on: true, allow: [], argv: ['start', '--port', '1'] });
  assert.deepEqual(parseSandboxArgs(['start', '--sandbox=/y', '--sandbox-allow-usb'], { KIOSKO_SANDBOX_ALLOW: 'lan,bogus' }).allow.sort(), ['lan', 'usb']);
  assert.deepEqual(parseSandboxArgs(['start'], { KIOSKO_SANDBOX: '/z' }), { on: true, dir: '/z', allow: [], argv: ['start'] });
  assert.equal(parseSandboxArgs(['start'], {}).on, false);
});

test('sandbox config, listen and TTL decisions', async (t) => {
  const dir = tmp(t, 'decide');
  const sb = { dir, allow: new Set<'usb' | 'remote' | 'lan'>(), registry: join(dir, 'reg') };
  const own = join(dir, 'kiosko', 'config.json');
  const outside = join(tmp(t, 'outside'), 'config.json');
  writeFileSync(outside, '{"locale":"de"}');
  const before = statSync(outside).mtimeMs;
  assert.equal(sandboxConfig(sb, { own }), own);
  assert.throws(() => sandboxConfig(sb, { own, config: outside }), SandboxRefusal);
  assert.equal(sandboxConfig(sb, { own, config: join(dir, 'other.json') }), join(dir, 'other.json'));
  assert.equal(sandboxConfig(sb, { own, copyFrom: outside }), own);
  assert.equal(readFileSync(own, 'utf8'), '{"locale":"de"}');
  assert.equal(statSync(outside).mtimeMs, before);
  writeFileSync(join(dir, 'broken.json'), '{ nope');
  assert.throws(() => sandboxConfig(sb, { own, copyFrom: join(dir, 'broken.json') }), SyntaxError);

  await assert.rejects(sandboxListen(sb, { port: '7420' }), /7420/);
  assert.deepEqual(await sandboxListen(sb, { port: '7420', force: true }), { host: '127.0.0.1', port: 7420, notes: [] });
  const lan = await sandboxListen(sb, { host: '0.0.0.0', port: '37487' });
  assert.equal(lan.host, '127.0.0.1');
  assert.match(lan.notes[0]!, /--sandbox-allow-lan/);
  assert.equal((await sandboxListen({ ...sb, allow: new Set(['lan'] as const) }, { host: '0.0.0.0', port: '37487' })).host, '0.0.0.0');
  const free = await sandboxListen(sb, {});
  assert.ok(free.port > 0 && free.port !== 7420);
  await assert.rejects(sandboxListen(sb, { port: 'x' }), /not a port/);

  assert.equal(sandboxTtl(undefined, {}), 2 * 3600_000);
  assert.equal(sandboxTtl('30m', {}), 1_800_000);
  assert.equal(sandboxTtl(undefined, { KIOSKO_SANDBOX_TTL: 'off' }), null);
  assert.throws(() => sandboxTtl('later', {}), SandboxRefusal);
});

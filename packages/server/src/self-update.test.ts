import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { InstallInfo } from './install-kind.ts';
import { KioskoUpdater, installerArgs, judgeSelfCheck, lastJson, parseSha256File, readMarker, restartHow, windowsUpgradeScript, writeMarker, type Handover, type Run, type UpdaterDeps, type UpdateMarker } from './self-update.ts';

const PREFIX = '/home/ana/.nvm/versions/node/v22.18.0';
const CLI = `${PREFIX}/lib/node_modules/kiosko/cli.js`;
const NODE = `${PREFIX}/bin/node`;
const npmInstall: InstallInfo = { kind: 'npm-global', dir: `${PREFIX}/lib/node_modules/kiosko`, cli: CLI, prefix: PREFIX, service: null, platform: 'linux' };
const selfCheck = (version: string, o: { plugins?: string[]; problems?: { origin: string; message: string }[]; refused?: { id?: string; origin: string; reason: string }[] } = {}) =>
  `plugin noise\n${JSON.stringify({ kiosko: 'self-check', version, plugins: (o.plugins ?? ['core', 'weather']).map((id) => ({ id })), problems: o.problems ?? [], refused: o.refused ?? [] })}\n`;

/**
 * A pretend system: npm installs flip the "installed" version, `--version`
 * says it, `self-check` answers what `check` says. Every command is recorded.
 */
function fakeSystem(o: { installed?: string; prefix?: string; installFails?: (v: string) => boolean; versionSays?: (installed: string) => string; check?: (installed: string) => string; systemctl?: number } = {}) {
  let installed = o.installed ?? '0.2.8';
  const calls: string[] = [];
  const run: Run = async (cmd, args) => {
    const line = `${cmd.split('/').at(-1)} ${args.join(' ')}`;
    calls.push(line);
    if (args[0] === 'prefix') return { code: 0, stdout: `${o.prefix ?? PREFIX}\n`, stderr: '' };
    if (args[0] === 'install') {
      const v = args.find((a) => a.startsWith('kiosko@'))!.slice('kiosko@'.length);
      if (o.installFails?.(v)) return { code: 1, stdout: '', stderr: 'npm ERR! network ETIMEDOUT' };
      installed = v;
      return { code: 0, stdout: `changed 1 package`, stderr: '' };
    }
    if (args[1] === '--version') return { code: 0, stdout: `${o.versionSays ? o.versionSays(installed) : installed}\n`, stderr: '' };
    if (args[1] === 'self-check') return { code: 0, stdout: o.check ? o.check(installed) : selfCheck(installed), stderr: '' };
    if (cmd === 'systemctl' || cmd === 'launchctl') return { code: o.systemctl ?? 0, stdout: '', stderr: o.systemctl ? 'Failed to connect to bus' : '' };
    return { code: 127, stdout: '', stderr: `unexpected ${line}` };
  };
  return { run, calls, get installed() { return installed; } };
}

function fakeHandover(o: { answersAfter?: number; answers?: string; dies?: boolean } = {}) {
  const log: string[] = [];
  let probes = 0;
  const h: Handover = {
    instance: 'old',
    logFile: '/tmp/kiosko.log',
    release: async () => void log.push('release'),
    reclaim: async () => void log.push('reclaim'),
    spawn: () => {
      log.push('spawn');
      return { exited: o.dies ? Promise.resolve(1) : new Promise(() => undefined), kill: () => void log.push('kill') };
    },
    probe: async () => (++probes > (o.answersAfter ?? 2) && o.answers ? { version: o.answers, instance: 'new' } : null),
    exit: () => void log.push('exit'),
  };
  return { h, log };
}

function updater(sys: ReturnType<typeof fakeSystem>, over: Partial<UpdaterDeps> = {}) {
  const logs: string[] = [];
  const marks: UpdateMarker[] = [];
  let clock = 1_000;
  const u = new KioskoUpdater({
    install: npmInstall,
    current: '0.2.8',
    registry: 'https://registry.npmjs.org',
    node: NODE,
    run: sys.run,
    fetch: (async () => new Response('', { status: 404 })) as typeof fetch,
    loaded: () => ({ ids: ['core', 'weather'], problems: [] }),
    log: (m) => logs.push(m),
    changed: () => undefined,
    tmpDir: tmpdir(),
    restartHow: 'manual',
    mark: (m) => void (m ? marks.push(m) : marks.splice(0)),
    port: 7420,
    home: tmpdir(),
    now: () => (clock += 100),
    sleep: async () => undefined,
    handoverTimeoutMs: 5_000,
    ...over,
  });
  return { u, logs, marks };
}

test('npm: installs the exact version into this prefix, checks it runs and loads its plugins, then (in a terminal) asks for a restart', async () => {
  const sys = fakeSystem();
  const { u, marks } = updater(sys);
  const st = await u.start('0.2.9');
  assert.equal(st.state, 'done', JSON.stringify(st.error));
  assert.equal(st.restart, 'manual');
  assert.deepEqual(sys.calls, ['npm prefix -g', 'npm install -g --no-audit --no-fund kiosko@0.2.9', `node ${CLI} --version`, `node ${CLI} self-check --json`]);
  assert.deepEqual(st.steps.map((s) => `${s.code}:${s.ok}`), ['prefix:true', 'install:true', 'verify:true', 'selfCheck:true', 'restart:true']);
  assert.deepEqual(marks.map((m) => [m.from, m.to, m.how]), [['0.2.8', '0.2.9', 'manual']]);
  assert.ok(marks[0]!.lines!.some((l) => /^install ok/.test(l)), 'the marker carries the steps');
});

test('npm: the person\'s registry (npmmirror) is the one npm installs from', async () => {
  const sys = fakeSystem();
  await updater(sys, { registry: 'https://registry.npmmirror.com' }).u.start('0.2.9');
  assert.ok(sys.calls.includes('npm install -g --no-audit --no-fund kiosko@0.2.9 --registry=https://registry.npmmirror.com'));
});

test('npm: the new one says another version → the previous one is installed again, and it says why', async () => {
  const sys = fakeSystem({ versionSays: (v) => (v === '0.2.9' ? '0.2.8-broken' : v) });
  const { u } = updater(sys);
  const st = await u.start('0.2.9');
  assert.equal(st.state, 'failed');
  assert.equal(st.error?.code, 'verifyFailed');
  assert.match(st.error!.detail, /says 0\.2\.8-broken, not 0\.2\.9/);
  assert.equal(st.rolledBack, true);
  assert.equal(sys.installed, '0.2.8');
  assert.ok(sys.calls.includes('npm install -g --no-audit --no-fund kiosko@0.2.8'));
  assert.ok(!sys.calls.some((c) => c.startsWith('systemctl')), 'never restarts into a broken install');
});

test('npm: the dry run loses a plugin that loads now → rollback; one the new Kiosko refuses (its API) is only a warning', async () => {
  const lost = fakeSystem({ check: (v) => selfCheck(v, v === '0.2.9' ? { plugins: ['core'], problems: [{ origin: '/p/weather', message: 'SyntaxError: Unexpected token' }] } : {}) });
  const a = await updater(lost).u.start('0.2.9');
  assert.equal(a.error?.code, 'verifyFailed');
  assert.match(a.error!.detail, /weather/);
  assert.equal(a.rolledBack, true);
  const refused = fakeSystem({ check: (v) => selfCheck(v, { plugins: ['core'], refused: [{ id: 'weather', origin: '/p/weather', reason: 'written for the plugin API ^0.2.0' }], problems: [{ origin: '/p/weather', message: '"weather" not loaded: written for the plugin API ^0.2.0' }] }) });
  const b = await updater(refused).u.start('0.2.9');
  assert.equal(b.state, 'done');
  assert.deepEqual(b.warnings, ['weather: written for the plugin API ^0.2.0']);
});

test('npm: npm itself fails → nothing to roll back when the old one is still there; npm elsewhere → nothing installed', async () => {
  const sys = fakeSystem({ installFails: (v) => v === '0.2.9' });
  const st = await updater(sys).u.start('0.2.9');
  assert.equal(st.error?.code, 'installFailed');
  assert.match(st.error!.detail, /ETIMEDOUT/);
  assert.equal(st.rolledBack, false);
  assert.ok(!sys.calls.includes('npm install -g --no-audit --no-fund kiosko@0.2.8'), 'the old one answered: no reinstall');
  const other = fakeSystem({ prefix: '/usr/local' });
  const o = await updater(other).u.start('0.2.9');
  assert.equal(o.error?.code, 'prefixMismatch');
  assert.deepEqual(other.calls, ['npm prefix -g']);
});

test('npm: a new version that throws at start says its error, not the tail of its stack', async () => {
  const sys = fakeSystem();
  const run: Run = async (cmd, args, o) => (args[1] === '--version' && sys.installed === '0.2.9' ? { code: 1, stdout: '', stderr: 'file:///x/cli.js:2\nthrow new Error("boom");\n^\n\nError: boom\n    at file:///x/cli.js:2:7\n    at ModuleJob.run (node:internal/modules/esm/module_job:343:25)\n\nNode.js v22.18.0' } : sys.run(cmd, args, o));
  const st = await updater({ ...sys, run }).u.start('0.2.9');
  assert.equal(st.error?.detail, 'the new Kiosko does not start: Error: boom');
});

test('npm: the rollback fails too → says exactly what to run before restarting', async () => {
  const sys = fakeSystem({ versionSays: () => 'garbage', installFails: (v) => v === '0.2.8' });
  const st = await updater(sys).u.start('0.2.9');
  assert.equal(st.error?.code, 'rollbackFailed');
  assert.match(st.error!.detail, /npm install -g kiosko@0\.2\.8/);
});

test('npm: as the systemd service, the service manager restarts it (without waiting on itself); launchd kickstarts', async () => {
  const sys = fakeSystem();
  const st = await updater(sys, { restartHow: 'systemd' }).u.start('0.2.9');
  assert.equal(st.state, 'restarting');
  assert.equal(sys.calls.at(-1), 'systemctl --user --no-block restart kiosko.service');
  const mac = fakeSystem();
  await updater(mac, { restartHow: 'launchd' }).u.start('0.2.9');
  assert.match(mac.calls.at(-1)!, /^launchctl kickstart -k gui\/\d+\/dev\.kiosko$/);
  const bad = fakeSystem({ systemctl: 1 });
  const b = await updater(bad, { restartHow: 'systemd' }).u.start('0.2.9');
  assert.equal(b.error?.code, 'restartFailed');
  assert.equal(b.restart, 'manual');
});

test('npm: not a service → hands over to the new one and exits only once it answers with the new version', async () => {
  const sys = fakeSystem();
  const { h, log } = fakeHandover({ answers: '0.2.9', answersAfter: 3 });
  const st = await updater(sys, { restartHow: 'handover', handover: h }).u.start('0.2.9');
  assert.equal(st.state, 'restarting');
  assert.deepEqual(log, ['release', 'spawn', 'exit']);
});

test('npm: the new one never answers (or dies) → it is stopped, this one takes the port and panels back, and the old files return', async () => {
  for (const o of [{ answers: undefined }, { dies: true }]) {
    const sys = fakeSystem();
    const { h, log } = fakeHandover(o);
    const st = await updater(sys, { restartHow: 'handover', handover: h }).u.start('0.2.9');
    assert.equal(st.state, 'failed');
    assert.equal(st.error?.code, 'restartFailed');
    assert.deepEqual(log, ['release', 'spawn', 'kill', 'reclaim']);
    assert.equal(sys.installed, '0.2.8', 'rolled back on disk');
    // Someone else answering with the old version (this very process) is not the new one.
  }
  const sys = fakeSystem();
  const { h, log } = fakeHandover({ answers: '0.2.8', answersAfter: 0 });
  await updater(sys, { restartHow: 'handover', handover: h }).u.start('0.2.9');
  assert.ok(!log.includes('exit'));
});

test('guards: one update at a time, only newer versions, nothing for a checkout', async () => {
  let release!: () => void;
  const slow: Run = (cmd, args) => (args[0] === 'prefix' ? new Promise((ok) => (release = () => ok({ code: 1, stdout: '', stderr: '' }))) : Promise.resolve({ code: 0, stdout: '', stderr: '' }));
  const { u } = updater({ run: slow, calls: [], installed: '' } as never);
  const first = u.start('0.2.9');
  await assert.rejects(u.start('0.2.9'), /already under way/);
  release();
  await first;
  await assert.rejects(updater(fakeSystem()).u.start('0.2.8'), /not newer/);
  await assert.rejects(updater(fakeSystem()).u.start('0.2.9 && rm -rf ~'), /not newer/);
  const src = await updater(fakeSystem(), { install: { ...npmInstall, kind: 'source', prefix: undefined } as InstallInfo }).u.start('0.2.9');
  assert.equal(src.error?.code, 'cantUpdate');
});

// ---------- Windows ----------

const winInstall: InstallInfo = { kind: 'windows-installer', dir: 'C:\\Users\\Ana\\AppData\\Local\\Programs\\Kiosko', cli: 'C:\\Users\\Ana\\AppData\\Local\\Programs\\Kiosko\\app\\cli.js', perUser: true, service: null, platform: 'win32' };

function fakeGitHub(exe: Buffer, sha: string) {
  const asked: string[] = [];
  const f = (async (url: string | URL | Request) => {
    const u = String(url);
    asked.push(u);
    if (u.endsWith('.exe.sha256')) return new Response(`${sha}  Kiosko-Setup-0.2.9-x64.exe\n`);
    if (u.endsWith('.exe')) return new Response(exe);
    return new Response('', { status: 404 });
  }) as typeof fetch;
  return { f, asked };
}

test('windows: downloads the release\'s installer, checks it against its .sha256, and waits for the person to confirm', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'kiosko-win-upd-'));
  try {
    const exe = Buffer.from('MZ pretend installer');
    const sha = createHash('sha256').update(exe).digest('hex');
    const gh = fakeGitHub(exe, sha);
    const launched: string[] = [];
    const { u, marks } = updater(fakeSystem(), { install: winInstall, fetch: gh.f, tmpDir: tmp, restartHow: 'installer', launch: (s) => launched.push(s), serviceTask: async () => true });
    const st = await u.start('0.2.9');
    assert.equal(st.state, 'ready', JSON.stringify(st.error));
    assert.equal(st.sha256, sha);
    assert.deepEqual(gh.asked, ['https://github.com/kiosko-lcd/kiosko/releases/download/v0.2.9/Kiosko-Setup-0.2.9-x64.exe.sha256', 'https://github.com/kiosko-lcd/kiosko/releases/download/v0.2.9/Kiosko-Setup-0.2.9-x64.exe']);
    assert.equal(launched.length, 0, 'nothing runs before the person confirms');
    await assert.rejects(u.confirm('0.3.0'), /no verified installer/);
    const c = await u.confirm('0.2.9');
    assert.equal(c.state, 'restarting');
    assert.equal(launched.length, 1);
    const script = readFileSync(launched[0]!, 'utf8');
    assert.match(script, /Kiosko-Setup-0\.2\.9-x64\.exe" \/VERYSILENT \/SUPPRESSMSGBOXES \/NORESTART \/CURRENTUSER \/LOG="/);
    assert.match(script, /schtasks \/Query \/TN Kiosko/);
    assert.deepEqual(marks.map((m) => m.how), ['installer']);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('windows: a checksum that doesn\'t match → the file is deleted and never run; one changed after the check too', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'kiosko-win-upd-'));
  try {
    const launched: string[] = [];
    const bad = fakeGitHub(Buffer.from('tampered'), 'a'.repeat(64));
    const { u } = updater(fakeSystem(), { install: winInstall, fetch: bad.f, tmpDir: tmp, restartHow: 'installer', launch: (s) => launched.push(s) });
    const st = await u.start('0.2.9');
    assert.equal(st.state, 'failed');
    assert.equal(st.error?.code, 'hashMismatch');
    assert.ok(!existsSync(join(tmp, 'kiosko-update-0.2.9', 'Kiosko-Setup-0.2.9-x64.exe')));
    await assert.rejects(u.confirm('0.2.9'));
    // Checked, then replaced on disk before Confirm.
    const exe = Buffer.from('MZ good');
    const good = fakeGitHub(exe, createHash('sha256').update(exe).digest('hex'));
    const v = updater(fakeSystem(), { install: winInstall, fetch: good.f, tmpDir: tmp, restartHow: 'installer', launch: (s) => launched.push(s) }).u;
    assert.equal((await v.start('0.2.9')).state, 'ready');
    writeFileSync(join(tmp, 'kiosko-update-0.2.9', 'Kiosko-Setup-0.2.9-x64.exe'), 'MZ evil');
    const c = await v.confirm('0.2.9');
    assert.equal(c.error?.code, 'hashMismatch');
    assert.equal(launched.length, 0);
    // No checksum published: refused.
    const none = (async (url: string | URL | Request) => (String(url).endsWith('.sha256') ? new Response('', { status: 404 }) : new Response('x'))) as typeof fetch;
    const n = await updater(fakeSystem(), { install: winInstall, fetch: none, tmpDir: tmp, restartHow: 'installer' }).u.start('0.2.9');
    assert.equal(n.error?.code, 'downloadFailed');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('windowsUpgradeScript: the installer, then the service back or a plain start, quoted, in UTF-8', () => {
  const s = windowsUpgradeScript({ exe: 'C:\\Users\\Ana Gómez\\AppData\\Local\\Temp\\kiosko-update-0.2.9\\Kiosko-Setup-0.2.9-x64.exe', args: installerArgs(true, 'C:\\T\\install.log'), dir: 'C:\\Users\\Ana Gómez\\AppData\\Local\\Programs\\Kiosko', service: false, port: 7420, log: 'C:\\Users\\Ana Gómez\\AppData\\Roaming\\Kiosko\\kiosko.log' });
  assert.match(s, /^@echo off\r\nchcp 65001 >nul\r\n/);
  assert.match(s, /"C:\\Users\\Ana Gómez\\AppData\\Local\\Temp\\kiosko-update-0\.2\.9\\Kiosko-Setup-0\.2\.9-x64\.exe" \/VERYSILENT \/SUPPRESSMSGBOXES \/NORESTART \/CURRENTUSER \/LOG="C:\\T\\install\.log"/);
  assert.match(s, /curl\.exe -s -o nul -m 2 http:\/\/127\.0\.0\.1:7420\/api\/version && goto :eof/);
  assert.match(s, /"C:\\Users\\Ana Gómez\\AppData\\Local\\Programs\\Kiosko\\kiosko\.cmd" start >> "C:\\Users\\Ana Gómez\\AppData\\Roaming\\Kiosko\\kiosko\.log" 2>&1\r\n$/);
  assert.ok(!s.includes('schtasks'));
  const svc = windowsUpgradeScript({ exe: 'C:\\k.exe', args: installerArgs(false, 'C:\\l'), dir: 'C:\\Program Files\\Kiosko', service: true, port: 7420, log: 'C:\\k.log' });
  assert.match(svc, /"C:\\k\.exe" \/LOG="C:\\l"/, 'installed for all users: the wizard (it asks for an administrator)');
  assert.match(svc, /schtasks \/Query \/TN Kiosko >nul 2>&1 \|\| call "C:\\Program Files\\Kiosko\\kiosko\.cmd" service install/);
  assert.match(svc, /schtasks \/Run \/TN Kiosko/);
});

// ---------- pieces ----------

test('parseSha256File: the hash of the named file; another file\'s or garbage is none', () => {
  const h = 'ab'.repeat(32);
  assert.equal(parseSha256File(`${h}  Kiosko-Setup-0.2.9-x64.exe\n`, 'Kiosko-Setup-0.2.9-x64.exe'), h);
  assert.equal(parseSha256File(`${h.toUpperCase()} *Kiosko-Setup-0.2.9-x64.exe`, 'Kiosko-Setup-0.2.9-x64.exe'), h);
  assert.equal(parseSha256File(h, 'x.exe'), h);
  assert.equal(parseSha256File(`${h}  other.exe`, 'Kiosko-Setup-0.2.9-x64.exe'), null);
  assert.equal(parseSha256File('<html>Not Found</html>', 'x.exe'), null);
});

test('judgeSelfCheck and lastJson', () => {
  assert.equal(judgeSelfCheck({ ids: ['core'], problems: [] }, JSON.parse(selfCheck('0.3.0').split('\n')[1]!), '0.2.9').ok, false);
  assert.deepEqual(lastJson<{ a: number }>('noise\n{"a":1}\n{bad\n'), { a: 1 });
  assert.equal(lastJson('Usage: kiosko …'), null);
  // A problem that was already there before the update is not the new version's fault.
  const known = { origin: '/p/x', message: 'boom' };
  assert.equal(judgeSelfCheck({ ids: ['core'], problems: ['boom'] }, { kiosko: 'self-check', version: '0.2.9', plugins: [{ id: 'core' }], problems: [known], refused: [] }, '0.2.9').ok, true);
});

test('restartHow: the service manager, the installer, a handover, or the person in a terminal', () => {
  assert.equal(restartHow({ ...npmInstall, service: 'systemd' }, { tty: true, pid: 9 }), 'systemd');
  assert.equal(restartHow({ ...npmInstall, service: 'launchd' }, { tty: false, pid: 9 }), 'launchd');
  assert.equal(restartHow(npmInstall, { tty: false, pid: 9 }), 'handover');
  assert.equal(restartHow(npmInstall, { tty: true, pid: 9 }), 'manual');
  assert.equal(restartHow(npmInstall, { tty: false, pid: 1 }), 'manual', 'a container\'s first process: exiting would end the container');
  assert.equal(restartHow(winInstall, { tty: false, pid: 9 }), 'installer');
});

test('the note across the restart: says how it went once, and only when fresh', () => {
  const home = mkdtempSync(join(tmpdir(), 'kiosko-marker-'));
  try {
    writeMarker(home, { from: '0.2.8', to: '0.2.9', at: 1000, how: 'systemd' });
    assert.deepEqual(readMarker(home, '0.2.9', 2000), { ok: true, message: 'Kiosko updated from 0.2.8 to 0.2.9', lines: [] });
    writeMarker(home, { from: '0.2.8', to: '0.2.9', at: 1000, how: 'systemd', lines: ['install ok'] });
    assert.deepEqual(readMarker(home, '0.2.9', 2000)!.lines, ['install ok'], 'the steps cross the restart');
    assert.equal(readMarker(home, '0.2.9', 2000), null, 'read once');
    writeMarker(home, { from: '0.2.8', to: '0.2.9', at: 1000, how: 'installer' });
    assert.equal(readMarker(home, '0.2.8', 2000)!.ok, false);
    writeMarker(home, { from: '0.2.8', to: '0.2.9', at: 1000, how: 'installer' });
    assert.equal(readMarker(home, '0.2.9', 1000 + 2 * 3600_000), null, 'stale');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

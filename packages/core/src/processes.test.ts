import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { ProcessWatch, parseLinuxProc, parsePs, parseTasklist, systemProcesses } from './processes.ts';

// What each system says, trimmed from real machines.
const LINUX = [
  { comm: 'systemd\n', cmdline: '/sbin/init\0splash\0' },
  { comm: 'steamwebhelper\n', cmdline: '/home/me/.local/share/Steam/ubuntu12_64/steamwebhelper\0-lang=en_US\0' },
  // comm is cut at 15 characters; argv[0] has the whole name.
  { comm: 'GameThread_Main\n', cmdline: '/games/Hollow Knight/hollow_knight.x86_64\0' },
  // `exec -a fakegame sleep 600`: comm stays, argv[0] changes.
  { comm: 'sleep\n', cmdline: 'fakegame\x00600\x00' },
  // Rewrote its command line as one string.
  { comm: 'chrome\n', cmdline: '/opt/google/chrome/chrome --type=renderer --lang=en' },
  { comm: 'python3\n', cmdline: 'python3 bot.py' },
  // A kernel thread: no command line.
  { comm: 'kworker/0:1\n', cmdline: '' },
  { comm: '', cmdline: '' },
];

const MACOS = `/sbin/launchd
/usr/libexec/logd
/Applications/zoom.us.app/Contents/MacOS/zoom.us
/Applications/OBS.app/Contents/MacOS/obs
/Applications/Steam.app/Contents/MacOS/steam_osx
/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder

`;

const WINDOWS = `"System Idle Process","0","Services","0","8 K"\r
"System","4","Services","0","2.152 K"\r
"steam.exe","9876","Console","1","180.344 K"\r
"obs64.exe","4321","Console","1","250.120 K"\r
"Zoom.exe","1111","Console","1","120.000 K"\r
\r
`;

test('processes: Linux names from comm and argv[0]', () => {
  assert.deepEqual(parseLinuxProc(LINUX), ['systemd', 'init', 'steamwebhelper', 'GameThread_Main', 'hollow_knight.x86_64', 'sleep', 'fakegame', 'chrome', 'python3', 'python3 bot.py', 'kworker/0:1']);
});

test('processes: macOS executables and their app bundles', () => {
  assert.deepEqual(parsePs(MACOS), ['launchd', 'logd', 'zoom.us', 'obs', 'OBS', 'steam_osx', 'Steam', 'Finder']);
});

test('processes: Windows image names, with and without .exe', () => {
  assert.deepEqual(parseTasklist(WINDOWS), ['System Idle Process', 'System', 'steam.exe', 'steam', 'obs64.exe', 'obs64', 'Zoom.exe', 'Zoom']);
  assert.deepEqual(parseTasklist('INFO: No tasks are running which match the specified criteria.\r\n'), []);
});

test('processes: the watch asks at most every interval, never twice at once, and says a failure once', async () => {
  let calls = 0;
  let fail = false;
  let release: (() => void) | null = null;
  const logs: string[] = [];
  const w = new ProcessWatch({ list: () => (calls++, fail ? Promise.reject(new Error('nope')) : new Promise((r) => (release = () => r(['a', 'b'])))) }, (m) => logs.push(m), 1000);
  let changed = 0;
  w.poll(0, () => changed++);
  w.poll(5000, () => changed++);
  assert.equal(calls, 1, 'busy: not asked again');
  release!();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(w.names, ['a', 'b']);
  assert.equal(changed, 1);
  w.poll(500);
  assert.equal(calls, 1, 'not due yet');
  w.poll(1000);
  release!();
  await new Promise((r) => setImmediate(r));
  assert.equal(changed, 1, 'same names: no change');
  fail = true;
  w.poll(2000);
  await new Promise((r) => setImmediate(r));
  w.poll(3000);
  await new Promise((r) => setImmediate(r));
  assert.equal(w.names, null);
  assert.deepEqual(logs, ['could not list the running programs: nope']);
  w.stop();
  assert.equal(w.names, null);
});

test('processes: on this machine, a renamed process is seen', { skip: process.platform === 'win32' }, async (t) => {
  // `exec -a` names argv[0] on Linux; elsewhere the plain name is enough.
  const linux = process.platform === 'linux';
  const child = linux ? spawn('bash', ['-c', 'exec -a kiosko-fakegame sleep 30'], { stdio: 'ignore' }) : spawn('sleep', ['30'], { stdio: 'ignore' });
  t.after(() => child.kill());
  await new Promise((r) => setTimeout(r, 200));
  const names = await systemProcesses().list();
  assert.ok(names.includes(linux ? 'kiosko-fakegame' : 'sleep'), names.slice(0, 20).join(', '));
  assert.ok(names.includes('sleep'));
});

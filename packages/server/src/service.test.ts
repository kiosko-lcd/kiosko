import assert from 'node:assert/strict';
import { test } from 'node:test';
import { servicePlan } from './service.ts';

const win = () => servicePlan({ os: 'win32', node: 'C:\\Program Files\\nodejs\\node.exe', cli: 'C:\\Users\\Ana Gómez\\AppData\\Roaming\\npm\\node_modules\\kiosko\\cli.js', home: 'C:\\Users\\Ana Gómez\\AppData\\Roaming\\Kiosko' });

test('windows: the task runs a hidden launcher, not node.exe (no console window)', () => {
  const p = win();
  assert.equal(p.kind, 'schtasks');
  assert.match(p.file!, /kiosko-start\.vbs$/);
  const create = p.enable[0]!;
  assert.equal(create[0], 'schtasks');
  assert.equal(create[create.indexOf('/TR') + 1], `wscript.exe //B //Nologo "${p.file}"`);
  assert.match(p.content, /Run .*, 0, False/, 'window style 0 = hidden');
});

test('windows: the launcher quotes every path, doubles quotes for VBScript and logs to kiosko.log', () => {
  const c = win().content;
  assert.match(c, /cmd\.exe \/d \/s \/c """"C:\\Program Files\\nodejs\\node\.exe"" ""C:\\Users\\Ana Gómez\\.*cli\.js"" ""start"" >> ""C:\\Users\\Ana Gómez\\AppData\\Roaming\\Kiosko\\kiosko\.log"" 2>&1"""/);
  assert.equal(win().utf16, true, 'non-ASCII user names need UTF-16');
});

test('windows: uninstall ends the task, stops the processes left behind, and deletes the task', () => {
  const d = win().disable;
  assert.deepEqual(d.map((c) => c.slice(0, 2).join(' ')), ['schtasks /End', 'powershell -NoProfile', 'schtasks /Delete']);
  const script = d[1]!.at(-1)!;
  assert.match(script, /Win32_Process/);
  assert.ok(script.includes('node.exe') && script.includes('cmd.exe'));
  assert.ok(script.includes('cli.js'), 'matches this installation only, by its CLI path');
  assert.ok(script.includes(`-ne ${process.pid}`), 'never kills the process running uninstall');
});

test('linux and macOS plans are unchanged in shape', () => {
  assert.equal(servicePlan({ os: 'linux', node: '/usr/bin/node', cli: '/x/cli.js' }).kind, 'systemd');
  assert.equal(servicePlan({ os: 'darwin', node: '/usr/bin/node', cli: '/x/cli.js' }).kind, 'launchd');
});

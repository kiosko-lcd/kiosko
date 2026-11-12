import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { commandFor, expandPath } from './system.ts';

const home = '/home/u';

test('expandPath: ~, ~/x, ~\\x and $VAR; unset variables stay as written', () => {
  const o = { env: { A: 'x', B: 'y' }, home, os: 'linux' as const };
  assert.equal(expandPath('~', o), home);
  // `join` uses the separator of the machine running the test.
  assert.equal(expandPath('~/n/f.txt', o), join(home, 'n', 'f.txt'));
  assert.equal(expandPath('~\\n', o), join(home, 'n'));
  assert.equal(expandPath('$A/${B}/$NOPE', o), 'x/y/$NOPE');
  assert.equal(expandPath('100%A%', o), '100%A%', 'no %VAR% outside Windows');
  assert.equal(expandPath('/abs/~/x', o), '/abs/~/x');
});

test('expandPath: %VAR% on Windows', () => {
  const o = { env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, home, os: 'win32' as const };
  assert.equal(expandPath('%APPDATA%\\Kiosko', o), 'C:\\Users\\u\\AppData\\Roaming\\Kiosko');
  assert.equal(expandPath('%NOPE%\\x', o), '%NOPE%\\x');
});

test('commandFor: untouched outside Windows', () => {
  assert.deepEqual(commandFor('ccusage', ['daily'], { os: 'linux' }), { file: 'ccusage', args: ['daily'] });
});

const env = { PATH: 'C:\\npm;C:\\bin', PATHEXT: '.COM;.EXE;.BAT;.CMD', ComSpec: 'C:\\Windows\\system32\\cmd.exe' };
const has = (...files: string[]) => (p: string) => files.includes(p);

test('commandFor: a .cmd shim found on PATH runs through cmd.exe, arguments quoted', () => {
  const c = commandFor('ccusage', ['daily', '--json', '--since', '2026 11'], { os: 'win32', env, exists: has('C:\\npm\\ccusage.cmd') });
  assert.equal(c.file, 'C:\\Windows\\system32\\cmd.exe');
  assert.deepEqual(c.args, ['/d', '/s', '/c', '"C:\\npm\\ccusage.cmd daily --json --since "2026 11""']);
  assert.equal(c.windowsVerbatimArguments, true);
});

test('commandFor: an .exe is left alone, even with a .cmd of the same name later on PATH', () => {
  const c = commandFor('glab', ['api'], { os: 'win32', env, exists: has('C:\\npm\\glab.exe', 'C:\\bin\\glab.cmd') });
  assert.deepEqual(c, { file: 'glab', args: ['api'] });
  assert.deepEqual(commandFor('nvidia-smi.exe', [], { os: 'win32', env, exists: () => false }), { file: 'nvidia-smi.exe', args: [] });
});

test('commandFor: not found anywhere → as it was (execFile reports ENOENT)', () => {
  assert.deepEqual(commandFor('nothing', ['x'], { os: 'win32', env, exists: () => false }), { file: 'nothing', args: ['x'] });
});

test('commandFor: a quote, a % or a newline is refused for a shim', () => {
  const ex = has('C:\\npm\\npx.cmd');
  assert.throws(() => commandFor('npx', ['a%b'], { os: 'win32', env, exists: ex }), /not allowed/);
  assert.throws(() => commandFor('npx', ['a"b'], { os: 'win32', env, exists: ex }), /not allowed/);
  assert.throws(() => commandFor('npx', ['a\nb'], { os: 'win32', env, exists: ex }), /not allowed/);
});

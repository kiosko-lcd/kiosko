import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectInstall, detectService, npmInstallCommand, updateBlocker, updateInstructions, type DetectInput } from './install-kind.ts';

/** A disk with only these files. */
const disk = (files: string[], o: Partial<DetectInput> & Pick<DetectInput, 'cli' | 'execPath' | 'platform'>) => detectInstall({ env: {}, exists: (p) => files.includes(p), readFile: () => '', ...o });

test('windows installer: app\\cli.js run by the node.exe next to kiosko.cmd and the uninstaller; per user under %LOCALAPPDATA%\\Programs', () => {
  const app = 'C:\\Users\\Ana Gómez\\AppData\\Local\\Programs\\Kiosko';
  const i = disk([`${app}\\kiosko.cmd`, `${app}\\unins000.exe`], { cli: `${app}\\app\\cli.js`, execPath: `${app}\\node.exe`, platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\Ana Gómez\\AppData\\Local' } });
  assert.equal(i.kind, 'windows-installer');
  assert.equal(i.dir, app);
  assert.equal(i.perUser, true);
  // For all users (Program Files): still the installer, but not a silent per-user upgrade.
  const pf = 'C:\\Program Files\\Kiosko';
  const all = disk([`${pf}\\kiosko.cmd`, `${pf}\\unins000.exe`], { cli: `${pf}\\app\\cli.js`, execPath: `${pf}\\NODE.EXE`, platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\Ana\\AppData\\Local' } });
  assert.equal(all.kind, 'windows-installer');
  assert.equal(all.perUser, false);
  // The same folder run by another Node is not the installer's Kiosko.
  assert.notEqual(disk([`${app}\\kiosko.cmd`, `${app}\\unins000.exe`], { cli: `${app}\\app\\cli.js`, execPath: 'C:\\Program Files\\nodejs\\node.exe', platform: 'win32' }).kind, 'windows-installer');
});

test('npm global: <prefix>/lib/node_modules/kiosko with the bin shim (nvm, /usr/local, Homebrew); %APPDATA%\\npm on Windows', () => {
  const nvm = '/home/ana/.nvm/versions/node/v22.18.0';
  const l = disk([`${nvm}/bin/kiosko`], { cli: `${nvm}/lib/node_modules/kiosko/cli.js`, execPath: `${nvm}/bin/node`, platform: 'linux' });
  assert.deepEqual([l.kind, l.prefix, l.dir], ['npm-global', nvm, `${nvm}/lib/node_modules/kiosko`]);
  const brew = disk(['/opt/homebrew/bin/kiosko'], { cli: '/opt/homebrew/lib/node_modules/kiosko/cli.js', execPath: '/opt/homebrew/bin/node', platform: 'darwin' });
  assert.deepEqual([brew.kind, brew.prefix], ['npm-global', '/opt/homebrew']);
  const w = disk(['C:\\Users\\Ana\\AppData\\Roaming\\npm\\kiosko.cmd'], { cli: 'C:\\Users\\Ana\\AppData\\Roaming\\npm\\node_modules\\kiosko\\cli.js', execPath: 'C:\\Program Files\\nodejs\\node.exe', platform: 'win32' });
  assert.deepEqual([w.kind, w.prefix], ['npm-global', 'C:\\Users\\Ana\\AppData\\Roaming\\npm']);
  // A project's node_modules (no shim in a prefix): not global.
  assert.equal(disk([], { cli: '/home/ana/proj/node_modules/kiosko/cli.js', execPath: '/usr/bin/node', platform: 'linux' }).kind, 'other');
  // npx's cache.
  assert.equal(disk([], { cli: '/home/ana/.npm/_npx/0a1b/node_modules/kiosko/cli.js', execPath: '/usr/bin/node', platform: 'linux' }).kind, 'npx');
});

test('source: the TypeScript CLI (--conditions=source), or the bundle built inside a git checkout', () => {
  const ts = disk(['/src/kiosko/.git'], { cli: '/src/kiosko/packages/server/src/cli.ts', execPath: '/usr/bin/node', platform: 'linux' });
  assert.deepEqual([ts.kind, ts.dir], ['source', '/src/kiosko']);
  const built = disk(['/src/kiosko/.git'], { cli: '/src/kiosko/dist/kiosko/cli.js', execPath: '/usr/bin/node', platform: 'linux' });
  assert.deepEqual([built.kind, built.dir], ['source', '/src/kiosko']);
  // A worktree's .git is a file: existsSync sees it just the same.
  assert.equal(disk(['C:\\src\\kiosko\\.git'], { cli: 'C:\\src\\kiosko\\packages\\server\\src\\cli.ts', execPath: 'C:\\node\\node.exe', platform: 'win32' }).kind, 'source');
});

test('service: systemd by its cgroup, launchd by its label; otherwise none', () => {
  const read = (s: string) => () => s;
  assert.equal(detectService('linux', {}, read('0::/user.slice/user-1000.slice/user@1000.service/app.slice/kiosko.service\n')), 'systemd');
  assert.equal(detectService('linux', {}, read('0::/user.slice/user-1000.slice/user@1000.service/app.slice/ptyxis-spawn-3e9.scope\n')), null);
  assert.equal(detectService('linux', {}, () => { throw new Error('ENOENT'); }), null);
  assert.equal(detectService('darwin', { XPC_SERVICE_NAME: 'dev.kiosko' }, read('')), 'launchd');
  assert.equal(detectService('darwin', { XPC_SERVICE_NAME: '0' }, read('')), null);
  assert.equal(detectService('win32', {}, read('')), null);
});

test('instructions: the installer of that version, npm with the person\'s registry, git for a checkout', () => {
  const w = updateInstructions({ kind: 'windows-installer', platform: 'win32' }, '0.2.9', 'https://registry.npmjs.org');
  assert.equal(w.url, 'https://github.com/kiosko-lcd/kiosko/releases/tag/v0.2.9');
  assert.equal(w.download, 'https://github.com/kiosko-lcd/kiosko/releases/download/v0.2.9/Kiosko-Setup-0.2.9-x64.exe');
  assert.equal(w.command, undefined);
  assert.equal(updateInstructions({ kind: 'npm-global', platform: 'linux' }, '0.2.9', 'https://registry.npmjs.org').command, 'npm install -g kiosko@0.2.9');
  assert.equal(updateInstructions({ kind: 'npm-global', platform: 'linux' }, '0.2.9', 'https://registry.npmmirror.com').command, 'npm install -g kiosko@0.2.9 --registry=https://registry.npmmirror.com');
  assert.equal(updateInstructions({ kind: 'npm-global', platform: 'win32' }, '0.2.9', 'https://registry.npmjs.org').stopFirst, true);
  assert.equal(updateInstructions({ kind: 'source', platform: 'linux' }, '0.2.9', '').command, 'git pull && npm install && npm run web:build');
  assert.equal(npmInstallCommand('1.0.0', ''), 'npm install -g kiosko@1.0.0');
});

test('updateBlocker: the button for npm on Linux/macOS and the Windows installer only', () => {
  const base = { dir: '/x', cli: '/x/cli.js', service: null, platform: 'linux' as NodeJS.Platform };
  assert.equal(updateBlocker({ ...base, kind: 'npm-global', prefix: '/usr' }), null);
  assert.equal(updateBlocker({ ...base, kind: 'npm-global', prefix: '/usr', platform: 'win32' }), 'npmWindows');
  assert.equal(updateBlocker({ ...base, kind: 'windows-installer', platform: 'win32' }), null);
  assert.equal(updateBlocker({ ...base, kind: 'source' }), 'source');
  assert.equal(updateBlocker({ ...base, kind: 'npx' }), 'npx');
  assert.equal(updateBlocker({ ...base, kind: 'other' }), 'other');
  assert.equal(updateBlocker({ ...base, kind: 'npm-global', prefix: '/usr' }, { demo: true }), 'demo');
});

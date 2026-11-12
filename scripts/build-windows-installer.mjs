// Builds the Windows installer: dist/Kiosko-Setup-<version>-x64.exe
//
//   node scripts/build-windows-installer.mjs [--stage-only] [--plugins <dir>]
//
// What goes in the installer (a self-contained folder, no Node.js needed):
//
//   node.exe          the Node.js that runs this script (x64)
//   kiosko.cmd        `kiosko` on the command line
//   start-kiosko.vbs  starts Kiosko without a console window and opens the editor
//   app/              the npm package of `kiosko` (dist/kiosko) with its production
//                     dependencies installed: the Windows binaries of
//                     @napi-rs/canvas and libusb (`usb`), and the fonts
//   app/node_modules/kiosko-plugin-*   the official plugins, built, from
//                     ../kiosko-plugins (or --plugins) when they have a dist/;
//                     otherwise whatever npm resolves
//
// The wrapper is Inno Setup (installer/kiosko.iss): per user, no administrator
// needed. `--stage-only` stops before it (to try the folder). Run it on Windows:
// the native modules and node.exe are the ones of the machine that builds.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n) => (argv.indexOf(n) >= 0 ? argv[argv.indexOf(n) + 1] : undefined);

if (process.platform !== 'win32' && !flag('--stage-only')) {
  console.error('The installer is built on Windows (node.exe and the native modules are the builder\'s). Use --stage-only to only assemble the folder.');
  process.exit(1);
}
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const out = join(root, 'dist');
const stage = join(out, 'windows', 'stage');
const run = (cmd, args, o = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...o });

// 1. The npm package.
run(process.execPath, [join(root, 'scripts', 'build-dist.mjs')]);
rmSync(join(out, 'windows'), { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
const app = join(stage, 'app');
cpSync(join(out, 'kiosko'), app, { recursive: true });

// 2. Its production dependencies, with this machine's native binaries. No lifecycle
//    scripts: @napi-rs/canvas and usb ship prebuilt binaries and need none.
run('npm install --omit=dev --ignore-scripts --no-audit --no-fund --no-package-lock', [], { cwd: app, shell: true });

// libusb ships binaries for every platform, and its C++ sources: keep what runs here.
const usbDir = join(app, 'node_modules', 'usb');
const prebuilds = join(usbDir, 'prebuilds');
if (existsSync(prebuilds)) {
  for (const d of readdirSync(prebuilds)) if (!d.startsWith(`${process.platform}-`)) rmSync(join(prebuilds, d), { recursive: true, force: true });
  for (const d of ['libusb', 'src', 'test', 'binding.gyp', 'libusb.gypi', 'libusb_config', 'CHANGELOG.md']) rmSync(join(usbDir, d), { recursive: true, force: true });
  rmSync(join(app, 'node_modules', '@types'), { recursive: true, force: true });
}

// 3. The official plugins, built, over whatever npm brought.
const pluginsDir = resolve(opt('--plugins') ?? join(root, '..', 'kiosko-plugins'));
const bundled = [];
if (existsSync(pluginsDir)) {
  for (const d of readdirSync(pluginsDir)) {
    const src = join(pluginsDir, d);
    if (!d.startsWith('kiosko-plugin-') || !existsSync(join(src, 'dist', 'index.js'))) continue;
    const dest = join(app, 'node_modules', d);
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    cpSync(join(src, 'package.json'), join(dest, 'package.json'));
    cpSync(join(src, 'dist'), join(dest, 'dist'), { recursive: true });
    bundled.push(d);
  }
}
console.log(`official plugins from ${pluginsDir}: ${bundled.length ? bundled.map((d) => d.replace('kiosko-plugin-', '')).join(', ') : 'none (npm\'s copies, if any)'}`);

// 4. The launchers and texts.
if (process.platform === 'win32') cpSync(process.execPath, join(stage, 'node.exe'));
writeFileSync(join(stage, 'kiosko.cmd'), '@"%~dp0node.exe" "%~dp0app\\cli.js" %*\r\n');
cpSync(join(root, 'installer', 'start-kiosko.vbs'), join(stage, 'start-kiosko.vbs'));
cpSync(join(root, 'installer', 'notes.txt'), join(stage, 'notes.txt'));
cpSync(join(root, 'LICENSE'), join(stage, 'LICENSE'));
console.log(`staged ${stage}`);
if (flag('--stage-only')) process.exit(0);

// 5. Inno Setup.
const candidates = [process.env.ISCC, 'C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe', 'C:\\Program Files\\Inno Setup 6\\ISCC.exe', join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Inno Setup 6', 'ISCC.exe')].filter(Boolean);
const iscc = candidates.find((p) => existsSync(p));
if (!iscc) {
  console.error(`Inno Setup (ISCC.exe) not found. Install it (winget install JRSoftware.InnoSetup) or set ISCC. Tried:\n  ${candidates.join('\n  ')}`);
  process.exit(1);
}
run(iscc, [`/DVersion=${version}`, `/DStage=${stage}`, `/O${out}`, join(root, 'installer', 'kiosko.iss')]);
const exe = join(out, `Kiosko-Setup-${version}-x64.exe`);
const sha = createHash('sha256').update(readFileSync(exe)).digest('hex');
writeFileSync(`${exe}.sha256`, `${sha}  Kiosko-Setup-${version}-x64.exe\n`);
console.log(`${exe}\nsha256 ${sha}`);

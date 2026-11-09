// Builds the publishable npm package in dist/kiosko:
//
//   cli.js            the daemon, the server and every built-in plugin, bundled
//   sdk.js, kit.js…   what third-party plugins import (see core/sdk-resolver.ts)
//   web/              the editor
//   package.json      `kiosko` binary; only native/data packages stay as dependencies
//
//   node scripts/build-dist.mjs && cd dist/kiosko && npm pack
import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist', 'kiosko');
const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version = rootPkg.version ?? '0.1.0';

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

execFileSync(process.execPath, [join(root, 'packages/web/build.mjs')], { stdio: 'inherit' });
cpSync(join(root, 'packages/web/dist'), join(out, 'web'), { recursive: true });

// Native or data packages stay outside the bundle.
const external = ['@napi-rs/canvas', 'dejavu-fonts-ttf'];
const common = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  conditions: ['source'],
  external,
  legalComments: 'linked',
  // ESM bundles still meet CommonJS-style requires in some deps.
  banner: { js: "import { createRequire as __kioskoRequire } from 'node:module'; const require = __kioskoRequire(import.meta.url);" },
  logLevel: 'warning',
};

await build({ ...common, entryPoints: { cli: join(root, 'packages/server/src/cli.ts') }, outdir: out, banner: common.banner });
await build({
  ...common,
  entryPoints: {
    sdk: join(root, 'packages/sdk/src/index.ts'),
    kit: join(root, 'packages/lcd-canvas-kit/src/index.ts'),
    'weather-astro': join(root, 'packages/weather-astro/src/index.ts'),
  },
  outdir: out,
});

const deps = {};
for (const name of ['@napi-rs/canvas', 'dejavu-fonts-ttf']) {
  deps[name] = JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8')).version.replace(/^/, '^');
}
const pkg = {
  name: 'kiosko',
  version,
  description: 'A widget mosaic for small always-on USB LCD panels (Thermalright Trofeo Vision and friends), with a visual editor and plugins.',
  type: 'module',
  license: 'MIT',
  bin: { kiosko: './cli.js' },
  exports: { './sdk': './sdk.js' },
  files: ['*.js', '*.LEGAL.txt', 'web', 'README.md', 'LICENSE', 'examples'],
  engines: { node: '>=22.18' },
  keywords: ['lcd', 'thermalright', 'trofeo-vision', 'dashboard', 'widgets', 'claude-code', 'aio', 'usb-display'],
  repository: { type: 'git', url: 'git+https://github.com/kiosko-lcd/kiosko.git' },
  dependencies: deps,
  // The official plugins live in their own repos; installing Kiosko brings
  // them along. Optional, so a missing one never breaks the install.
  optionalDependencies: Object.fromEntries(['agents', 'cats', 'system', 'vitals', 'usage', 'weather', 'calendar', 'news', 'mirror', 'gitlab'].map((id) => [`kiosko-plugin-${id}`, `^${version}`])),
};
writeFileSync(join(out, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
for (const f of ['README.md', 'LICENSE']) cpSync(join(root, f), join(out, f));
cpSync(join(root, 'examples'), join(out, 'examples'), { recursive: true });
console.log(`built ${out} (kiosko ${version})`);

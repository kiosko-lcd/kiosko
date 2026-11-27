// Bundles the editor with esbuild into dist/ (served by @kiosko/server).
//
//   node packages/web/build.mjs [--watch]
//   node packages/web/build.mjs --demo [--out site/demo]   static browser demo (see demo/build.mjs)
//   node packages/web/build.mjs --site [--out site]        the whole site: front page, gallery, demo (see landing/build.mjs)
import { build, context } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const watch = args.includes('--watch');
const demo = args.includes('--demo');
const outArg = args.includes('--out') ? args[args.indexOf('--out') + 1] : undefined;

/**
 * The editor's esbuild options. `KIOSKO_DEMO` is a compile-time constant:
 * false here, so the demo-only branches in src/ are dropped from this build.
 */
function editorOptions(outdir, { demo = false } = {}) {
  return {
    entryPoints: { app: join(here, 'src/main.tsx'), styles: join(here, 'src/styles.css') },
    outdir,
    bundle: true,
    format: 'esm',
    target: ['es2022', 'chrome110', 'firefox115', 'safari16'],
    jsx: 'automatic',
    jsxImportSource: 'preact',
    conditions: ['source'],
    minify: !watch,
    sourcemap: watch ? 'inline' : false,
    legalComments: 'linked',
    logLevel: 'info',
    loader: { '.svg': 'text' },
    define: { KIOSKO_DEMO: String(demo) },
  };
}

/**
 * The browser screen's viewer (src/viewer), served by the network-screens server from
 * dist/viewer: a page of its own, apart from the editor. It may open on an old tablet,
 * so an older target; ES2020 for BigInt (its crypto is pure JS: no crypto.subtle over http).
 */
function viewerOptions(outdir) {
  return {
    entryPoints: { viewer: join(here, 'src/viewer/viewer.ts') },
    outdir,
    bundle: true,
    format: 'iife',
    target: ['es2020', 'chrome80', 'firefox78', 'safari14'],
    conditions: ['source'],
    minify: !watch,
    sourcemap: watch ? 'inline' : false,
    legalComments: 'linked',
    logLevel: 'info',
  };
}

async function buildViewer(out) {
  const dir = join(out, 'viewer');
  mkdirSync(dir, { recursive: true });
  cpSync(join(here, 'src/viewer/index.html'), join(dir, 'index.html'));
  cpSync(join(here, 'src/viewer/viewer.css'), join(dir, 'viewer.css'));
  cpSync(join(here, 'public/icon.svg'), join(dir, 'icon.svg'));
  if (watch) await (await context(viewerOptions(dir))).watch();
  else await build(viewerOptions(dir));
}

if (args.includes('--site')) {
  const { buildSite } = await import('./landing/build.mjs');
  await buildSite({ out: resolve(outArg ?? join(here, '../../site')), editorOptions });
} else if (demo) {
  const { buildDemo } = await import('./demo/build.mjs');
  await buildDemo({ out: resolve(outArg ?? join(here, 'dist-demo')), editorOptions });
} else {
  const out = outArg ? resolve(outArg) : join(here, 'dist');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  cpSync(join(here, 'public'), out, { recursive: true });
  const options = editorOptions(join(out, 'assets'));
  await buildViewer(out);
  if (watch) {
    const ctx = await context(options);
    await ctx.watch();
  } else {
    await build(options);
  }
}

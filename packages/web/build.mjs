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
  if (watch) {
    const ctx = await context(options);
    await ctx.watch();
  } else {
    await build(options);
  }
}

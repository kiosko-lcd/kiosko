// Bundles the editor with esbuild into dist/ (served by @kiosko/server).
import { build, context } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'dist');
const watch = process.argv.includes('--watch');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(join(here, 'public'), out, { recursive: true });

const options = {
  entryPoints: { app: join(here, 'src/main.tsx'), styles: join(here, 'src/styles.css') },
  outdir: join(out, 'assets'),
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
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
} else {
  await build(options);
}

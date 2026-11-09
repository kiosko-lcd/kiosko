// The static browser demo of the editor (https://kioskolcd.dev/demo/), run
// from packages/web/build.mjs --demo [--out dir]:
//
//   index.html             the editor's, with relative paths
//   assets/app.js          the editor, built with KIOSKO_DEMO: its API is
//                          src/demo/transport.ts instead of HTTP
//   assets/renderer.js     Kiosko's runtime and every bundled plugin, for the
//                          browser (renderer.ts): a module Web Worker
//   assets/fonts/          the panel fonts (DejaVu), plain and gzipped
//
// The runtime is the same code the daemon runs. To make it browser-safe
// without touching plugins, the bundle swaps a few modules:
//   @napi-rs/canvas        → shims/canvas.ts (the browser's own canvas)
//   core/src/fonts.ts      → shims/fonts.ts (FontFace instead of files)
//   node:*                 → generated stubs: helpers like path or promisify
//                            work (shims/node.ts), anything that would read
//                            the machine throws "not available in the
//                            browser demo"
//   process                → shims/process.ts
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { builtinModules, createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, '..');
const coreSrc = resolve(web, '../core/src');
const shims = join(here, 'shims');
const require = createRequire(import.meta.url);

/** Must match shims/fonts.ts. */
const FONTS = ['DejaVuSansCondensed.ttf', 'DejaVuSansCondensed-Bold.ttf', 'DejaVuSansMono.ttf', 'DejaVuSansMono-Bold.ttf'];

const BUILTINS = new Set(builtinModules.map((m) => m.replace(/^node:/, '')));
const ident = /^[A-Za-z_$][\w$]*$/;

/** `node:*` (and bare built-in names) → a generated module with the same exports. */
function nodeStubs() {
  const shim = join(shims, 'node.ts');
  return {
    name: 'kiosko-demo-node-stubs',
    setup(b) {
      b.onResolve({ filter: /^(node:)?[a-z_]+(\/[a-z_]+)?$/ }, (a) => {
        const name = a.path.replace(/^node:/, '');
        if (!BUILTINS.has(name) || a.namespace === 'node-stub') return undefined;
        return { path: name, namespace: 'node-stub' };
      });
      b.onLoad({ filter: /.*/, namespace: 'node-stub' }, async (a) => {
        const mod = a.path;
        const real = await import(`node:${mod}`).catch(() => ({}));
        const { overrides } = await import(pathToFileURL(shim).href);
        const own = overrides[mod] ?? {};
        const names = [...new Set([...Object.keys(real), ...Object.keys(own)])].filter((k) => k !== 'default' && ident.test(k));
        const q = JSON.stringify;
        const lines = [
          `import { overrides as __o } from ${q(shim)};`,
          `function __stub(n) { return function () { throw new Error("node:${mod}." + n + "() is not available in the browser demo"); }; }`,
        ];
        for (const k of names) {
          const v = real[k];
          let value;
          if (k in own) value = `/* @__PURE__ */ (() => __o[${q(mod)}][${q(k)}])()`;
          else if (typeof v === 'function') value = `/* @__PURE__ */ __stub(${q(k)})`;
          else if (v === null || v === undefined || ['string', 'number', 'boolean'].includes(typeof v)) value = v === undefined ? 'undefined' : q(v);
          else value = '{}';
          lines.push(`export const ${k} = ${value};`);
        }
        const def = 'default' in own ? `__o[${q(mod)}].default` : `{ ${names.join(', ')} }`;
        lines.push(`export default /* @__PURE__ */ (() => ${def})();`);
        return { contents: lines.join('\n'), loader: 'js', resolveDir: shims };
      });
    },
  };
}

/** @napi-rs/canvas and core's font loader → their browser versions. */
function browserAliases() {
  return {
    name: 'kiosko-demo-aliases',
    setup(b) {
      b.onResolve({ filter: /^@napi-rs\/canvas$/ }, () => ({ path: join(shims, 'canvas.ts') }));
      b.onResolve({ filter: /^\.\/fonts\.ts$/ }, (a) => (resolve(a.resolveDir) === coreSrc ? { path: join(shims, 'fonts.ts') } : undefined));
    },
  };
}

/**
 * An official plugin that isn't checked out next to Kiosko is left out with
 * a warning (as `kiosko gallery` does) instead of failing the build; the
 * demo logs it in Activity (see plugins.ts).
 */
function optionalPlugins() {
  return {
    name: 'kiosko-demo-optional-plugins',
    setup(b) {
      b.onResolve({ filter: /^kiosko-plugin-[a-z0-9-]+$/ }, async (a) => {
        if (a.pluginData?.probe) return undefined;
        const r = await b.resolve(a.path, { kind: a.kind, importer: a.importer, resolveDir: a.resolveDir, pluginData: { probe: true } });
        if (!r.errors.length) return { path: r.path, namespace: r.namespace, sideEffects: r.sideEffects };
        return { path: a.path, namespace: 'missing-plugin', warnings: [{ text: `${a.path} is not installed: the demo goes without it` }] };
      });
      b.onLoad({ filter: /.*/, namespace: 'missing-plugin' }, () => ({ contents: 'export default undefined;', loader: 'js' }));
    },
  };
}

/** The editor's HTTP client (src/api.ts) → the in-browser one. */
function demoTransport() {
  const api = join(web, 'src/api.ts');
  return {
    name: 'kiosko-demo-transport',
    setup(b) {
      b.onResolve({ filter: /api\.ts$/ }, (a) => (resolve(a.resolveDir, a.path) === api ? { path: join(web, 'src/demo/transport.ts') } : undefined));
    },
  };
}

function sizeOf(dir) {
  let n = 0;
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    n += statSync(p).isDirectory() ? sizeOf(p) : statSync(p).size;
  }
  return n;
}
const kb = (n) => `${(n / 1024).toFixed(0)} kB`;

/**
 * @param {{ out: string, editorOptions: (outdir: string, o: { demo: boolean }) => import('esbuild').BuildOptions }} o
 */
export async function buildDemo({ out, editorOptions }) {
  rmSync(out, { recursive: true, force: true });
  const assets = join(out, 'assets');
  mkdirSync(join(assets, 'fonts'), { recursive: true });

  // The page: the editor's, with paths relative to wherever the demo lives.
  cpSync(join(web, 'public/icon.svg'), join(out, 'icon.svg'));
  const html = readFileSync(join(web, 'public/index.html'), 'utf8')
    .replace('<title>Kiosko</title>', '<title>Kiosko · editor demo</title>\n  <meta name="description" content="Try the Kiosko editor in your browser: a widget mosaic for small always-on USB LCD panels. Sample data, nothing to install." />')
    .replace(/\s*<link rel="manifest"[^>]*>/, '')
    .replace(/(href|src)="\/(?!\/)/g, '$1="./');
  writeFileSync(join(out, 'index.html'), html);

  // The editor, with the in-browser transport.
  const editor = editorOptions(assets, { demo: true });
  await build({
    ...editor,
    entryPoints: { ...editor.entryPoints, styles: join(web, 'src/demo/styles.css') },
    plugins: [demoTransport()],
  });

  // The runtime with every plugin, for a module worker (or the page).
  await build({
    entryPoints: { renderer: join(here, 'renderer.ts') },
    outdir: assets,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: ['es2022', 'chrome110', 'firefox115', 'safari16'],
    conditions: ['source'],
    minify: true,
    legalComments: 'linked',
    logLevel: 'info',
    plugins: [nodeStubs(), browserAliases(), optionalPlugins()],
    inject: [join(shims, 'process.ts')],
    // The CLI-only module loader (sdk-resolver) reads import.meta.dirname; never called here.
    define: { 'import.meta.dirname': '""' },
  });

  // Fonts: plain and gzipped (shims/canvas.ts picks one).
  const ttf = join(dirname(require.resolve('dejavu-fonts-ttf/package.json')), 'ttf');
  for (const f of FONTS) {
    copyFileSync(join(ttf, f), join(assets, 'fonts', f));
    writeFileSync(join(assets, 'fonts', `${f}.gz`), gzipSync(readFileSync(join(ttf, f)), { level: 9 }));
  }

  // GitHub Pages caches files for a while and these names never change, so
  // each reference carries a hash of what it points to: right after a deploy
  // a visitor can't pair a new app.js with an old renderer.js.
  const hash = (f) => createHash('sha256').update(readFileSync(join(assets, f))).digest('hex').slice(0, 10);
  const appFile = join(assets, 'app.js');
  const app = readFileSync(appFile, 'utf8');
  if (!app.includes('"./renderer.js"')) throw new Error('demo build: no "./renderer.js" reference in app.js to version');
  writeFileSync(appFile, app.replaceAll('"./renderer.js"', `"./renderer.js?v=${hash('renderer.js')}"`));
  const page = readFileSync(join(out, 'index.html'), 'utf8').replace(/((?:href|src)="\.\/assets\/(app\.js|styles\.css))"/g, (_, ref, f) => `${ref}?v=${hash(f)}"`);
  if (!page.includes('app.js?v=') || !page.includes('styles.css?v=')) throw new Error('demo build: could not version index.html');
  writeFileSync(join(out, 'index.html'), page);

  const js = (f) => statSync(join(assets, f)).size;
  const gz = (f) => gzipSync(readFileSync(join(assets, f)), { level: 9 }).length;
  const fontsGz = FONTS.reduce((n, f) => n + statSync(join(assets, 'fonts', `${f}.gz`)).size, 0);
  console.log(
    `demo → ${relative(process.cwd(), out) || '.'}: app.js ${kb(js('app.js'))} (${kb(gz('app.js'))} gzipped), renderer.js ${kb(js('renderer.js'))} (${kb(gz('renderer.js'))} gzipped), fonts ${kb(fontsGz)} gzipped; ${kb(sizeOf(out))} on disk`,
  );
}

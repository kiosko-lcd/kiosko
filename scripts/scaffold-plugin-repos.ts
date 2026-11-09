/**
 * Turns every folder in ../tessera-plugins into a publishable plugin repo:
 * package.json, esbuild build, tsconfig, CI, licence, .gitignore and a README
 * generated from the plugin definition itself (widgets, sources, options,
 * screenshots rendered with demo data). Safe to run again: it overwrites only
 * the files it owns.
 *
 *   node --conditions=source scripts/scaffold-plugin-repos.ts [--owner Loksly]
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Registry, composeWidget, normalize } from '@tessera/core';
import { localize, themeById, type Field, type PluginDefinition } from '@tessera/sdk';
import core from '@tessera/plugin-core';

const args = process.argv.slice(2);
const oi = args.indexOf('--owner');
const owner = oi >= 0 && args[oi + 1] ? args[oi + 1]! : 'Loksly';
const root = resolve(import.meta.dirname, '..');
const pluginsRoot = resolve(root, '../tessera-plugins');
const L = (x: Parameters<typeof localize>[0]) => localize(x, 'en');
const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };
const VERSION = rootPkg.version;

/** What each plugin needs outside Tessera, said once in its README. */
const REQUIREMENTS: Record<string, string[]> = {
  agents: ['A hook that writes agent session files. With Claude Code, add `agent-sessions-hook` (from [`@loksly/agent-sessions`](https://github.com/Loksly/tessera/tree/main/packages/agent-sessions)) to your `settings.json` hooks; sessions land in `~/.aimonitor/sessions` by default.'],
  cats: ['The `agents/sessions` source from [tessera-plugin-agents](../tessera-plugin-agents) (each session is a cat).', 'Optional: `weather/current` from [tessera-plugin-weather](../tessera-plugin-weather) for the sky in the window.'],
  usage: ['[`ccusage`](https://github.com/ryoppippi/ccusage) on the `PATH` (`npm install -g ccusage`).'],
  gitlab: ['[`glab`](https://gitlab.com/gitlab-org/cli) logged in, or a personal access token with `read_api` in the source options.'],
  system: ['Works everywhere; CPU temperature and failed units are read on Linux only.'],
  vitals: ['The `system/vitals` source from [tessera-plugin-system](../tessera-plugin-system).'],
  weather: ['Your location in Tessera → Settings (Open-Meteo, no key needed).'],
  calendar: ['The ICS address of a published calendar (Outlook: *Settings → Calendar → Shared calendars → Publish*; Google: *Secret address in iCal format*). Treat it as a password.'],
  news: ['Internet access to the RSS feeds (Spanish outlets by default; any RSS/Atom feed with images works).'],
  mirror: ['Location in Tessera → Settings for air quality, earthquakes and the rain radar. *Now playing* reads MPRIS (Linux).'],
};

/** Modules every plugin gets from the Tessera that loads it (see core/sdk-resolver.ts): never bundled. */
const HOST = ['@tessera/sdk', '@loksly/lcd-canvas-kit', '@loksly/weather-astro', '@napi-rs/canvas'];

function importsOf(dir: string): Set<string> {
  const out = new Set<string>();
  const walk = (d: string) => {
    for (const f of readdirSync(d, { withFileTypes: true })) {
      if (f.isDirectory()) walk(join(d, f.name));
      else if (f.name.endsWith('.ts')) for (const m of readFileSync(join(d, f.name), 'utf8').matchAll(/(?:from|import\()\s*'(@[\w.-]+\/[\w.-]+|[a-z][\w.-]*)(?:\/[\w./-]+)?'/g)) out.add(m[1]!);
    }
  };
  walk(join(dir, 'src'));
  return out;
}

const VERSIONS: Record<string, string> = {
  '@tessera/sdk': `^${VERSION}`,
  '@tessera/core': `^${VERSION}`,
  '@loksly/agent-sessions': '^0.1.0',
  '@loksly/lcd-canvas-kit': '^0.1.0',
  '@loksly/weather-astro': '^0.1.0',
  '@napi-rs/canvas': '^1.0.10',
  'ical.js': '^2.2.1',
};

function optionRows(f: Field | undefined, prefix = ''): string[] {
  if (!f || f.kind !== 'object') return [];
  const rows: string[] = [];
  for (const [k, sub] of Object.entries(f.props as Record<string, Field>)) {
    const name = `${prefix}${k}`;
    const def = sub.kind === 'string' && sub.secret ? '*(secret)*' : `\`${JSON.stringify(sub.default)}\``;
    const kind = sub.kind === 'enum' ? (sub.values as readonly string[]).map((v) => `\`${v}\``).join(' \\| ') : sub.kind === 'number' && sub.unit === 'ms' ? 'duration (ms)' : sub.kind;
    const label = [L(sub.label), L(sub.help)].filter(Boolean).join('. ');
    if (sub.kind === 'object') rows.push(...optionRows(sub, `${name}.`));
    else rows.push(`| \`${name}\` | ${kind} | ${def.length > 60 ? '…' : def} | ${label.replace(/\|/g, '\\|')} |`);
  }
  return rows;
}

function optionsTable(f: Field | undefined): string {
  const rows = optionRows(f);
  return rows.length ? `| Option | Type | Default | |\n|---|---|---|---|\n${rows.join('\n')}\n` : '*No options.*\n';
}

const ciYml = `name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
    runs-on: \${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - run: npm install --no-audit --no-fund
      - run: npm run check
      - run: npm test
      - run: npm run build
`;

const buildMjs = `// Bundles the plugin into dist/index.js. What Tessera itself provides to
// every plugin (the SDK, the drawing kit, the canvas) stays external: the
// host resolves those imports to its own copies at load time.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  conditions: ['source'],
  external: ${JSON.stringify(HOST)},
  legalComments: 'linked',
  banner: { js: "import { createRequire as __pluginRequire } from 'node:module'; const require = __pluginRequire(import.meta.url);" },
  logLevel: 'warning',
});
console.log('dist/index.js');
`;

const tsconfig = {
  compilerOptions: {
    target: 'ES2023',
    module: 'nodenext',
    moduleResolution: 'nodenext',
    lib: ['ES2023'],
    strict: true,
    noUncheckedIndexedAccess: true,
    verbatimModuleSyntax: true,
    erasableSyntaxOnly: true,
    allowImportingTsExtensions: true,
    noEmit: true,
    skipLibCheck: true,
    types: ['node'],
    customConditions: ['source'],
  },
  include: ['src/**/*.ts'],
};

const registry = new Registry();
registry.add(core);
const loaded: { dir: string; def: PluginDefinition }[] = [];
for (const name of readdirSync(pluginsRoot).sort()) {
  const dir = join(pluginsRoot, name);
  if (!name.startsWith('tessera-plugin-') || !existsSync(join(dir, 'src', 'index.ts'))) continue;
  const def = (await import(pathToFileURL(join(dir, 'src', 'index.ts')).href)).default as PluginDefinition;
  registry.add(def, dir);
  loaded.push({ dir, def });
}

const cfg = normalize({ locale: 'en', theme: 'midnight', location: { latitude: 40.4168, longitude: -3.7038, name: 'Madrid' } });
const theme = themeById('midnight');
const now = Date.parse('2026-11-05T10:42:00');

for (const { dir, def } of loaded) {
  const id = def.id;
  const repo = basename(dir);
  const imports = importsOf(dir);
  const devDependencies: Record<string, string> = { '@tessera/sdk': VERSIONS['@tessera/sdk']!, '@types/node': '^24.0.0', esbuild: '^0.25.0', typescript: '^5.9.3' };
  for (const m of imports) if (VERSIONS[m] && m !== '@tessera/sdk') devDependencies[m] = VERSIONS[m]!;
  if (imports.has('@napi-rs/canvas') || imports.has('@tessera/core')) devDependencies['@napi-rs/canvas'] = VERSIONS['@napi-rs/canvas']!;
  const old = existsSync(join(dir, 'package.json')) ? (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { description?: string }) : {};
  const pkg = {
    name: repo,
    version: VERSION,
    description: old.description ?? L(def.description),
    type: 'module',
    license: 'MIT',
    author: 'Loksly',
    keywords: ['tessera', 'tessera-plugin', 'lcd', 'widgets', ...new Set((def.widgets ?? []).map((w) => w.category ?? 'info'))],
    homepage: `https://github.com/${owner}/${repo}#readme`,
    repository: { type: 'git', url: `git+https://github.com/${owner}/${repo}.git` },
    bugs: { url: `https://github.com/${owner}/${repo}/issues` },
    exports: { '.': { source: './src/index.ts', default: './dist/index.js' } },
    tessera: { plugin: './dist/index.js', id },
    files: ['dist', 'README.md', 'LICENSE'],
    engines: { node: '>=22.18' },
    scripts: {
      build: 'node build.mjs',
      test: 'node --conditions=source --test "src/**/*.test.ts"',
      check: 'tsc -p tsconfig.json',
      prepublishOnly: 'npm run build',
    },
    devDependencies: Object.fromEntries(Object.entries(devDependencies).sort()),
  };
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  writeFileSync(join(dir, 'build.mjs'), buildMjs);
  writeFileSync(join(dir, 'tsconfig.json'), `${JSON.stringify(tsconfig, null, 2)}\n`);
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\ndist/\n*.log\n.DS_Store\n');
  writeFileSync(join(dir, 'LICENSE'), readFileSync(join(root, 'LICENSE'), 'utf8'));
  mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(dir, '.github', 'workflows', 'ci.yml'), ciYml);

  // Screenshots, painted with demo data by Tessera's own compositor.
  mkdirSync(join(dir, 'docs'), { recursive: true });
  const shots: string[] = [];
  for (const w of def.widgets ?? []) {
    const pref = w.size?.preferred ?? { w: 480, h: 300 };
    const width = Math.min(1920, pref.w);
    const height = Math.min(720, pref.h);
    const r = composeWidget({ cfg, registry, theme, type: `${id}/${w.id}`, width, height, now, ...(w.chrome === 'bare' ? {} : { title: L(w.name) }) });
    writeFileSync(join(dir, 'docs', `${w.id}.png`), r.canvas.toBuffer('image/png'));
    shots.push(`![${L(w.name)}](docs/${w.id}.png)`);
  }

  const widgets = (def.widgets ?? []).map((w) => `### ${L(w.name)} — \`${id}/${w.id}\`

${L(w.description)}

![${L(w.name)}](docs/${w.id}.png)

${w.sources?.length ? `Uses: ${w.sources.map((s) => `\`${s}\``).join(', ')}.\n\n` : ''}${optionsTable(w.options)}`);
  const sources = (def.sources ?? []).map((s) => `### ${L(s.name)} — \`${id}/${s.id}\`

${L(s.description)}${s.intervalMs ? ` Read every ${s.intervalMs >= 60_000 ? `${s.intervalMs / 60_000} min` : `${s.intervalMs / 1000} s`} while a widget uses it.` : ''} Options are set once in Tessera → Settings → Data sources.

${optionsTable(s.options)}`);
  const interludes = (def.interludes ?? []).map((i) => `### ${L(i.name)} — \`${id}/${i.id}\`

${L(i.description)} Add it in Tessera → Screens → Interludes.

${optionsTable(i.options)}`);
  const req = REQUIREMENTS[id] ?? [];
  const readme = `# ${repo}

${L(def.description)}

A plugin for [Tessera](https://github.com/${owner}/tessera), the widget mosaic for small USB LCD panels.

${shots[0] ?? ''}

## Install

In Tessera, **Plugins → Install from npm** → \`${repo}\`, then restart Tessera. Or from a terminal:

\`\`\`sh
npm install --prefix ~/.config/tessera/plugins ${repo}
\`\`\`

(macOS: \`~/Library/Application Support/Tessera/plugins\`, Windows: \`%APPDATA%\\Tessera\\plugins\`.)
${req.length ? `\n## Requirements\n\n${req.map((r) => `- ${r}`).join('\n')}\n` : ''}
${widgets.length ? `## Widgets\n\n${widgets.join('\n')}` : ''}
${sources.length ? `## Data sources\n\n${sources.join('\n')}` : ''}
${interludes.length ? `## Interludes\n\n${interludes.join('\n')}` : ''}
## Development

\`\`\`sh
npm install
npm test          # node:test
npm run check     # TypeScript
npm run build     # dist/index.js, what Tessera loads
\`\`\`

To try it in a running Tessera without publishing: \`tessera plugins link .\` and restart Tessera.

Working on Tessera and its plugins together: clone them side by side
(\`tessera/\` and \`tessera-plugins/${repo}/\`) and run \`npm install\` in
\`tessera/\`; its workspaces link every plugin found in \`../tessera-plugins\`.

## License

MIT
`;
  writeFileSync(join(dir, 'README.md'), readme.replace(/\n{3,}/g, '\n\n'));
  console.log(`${repo}: ${(def.widgets ?? []).length} widgets, ${(def.sources ?? []).length} sources, ${(def.interludes ?? []).length} interludes`);
}

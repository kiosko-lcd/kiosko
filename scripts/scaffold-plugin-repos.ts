/**
 * Turns every folder in ../kiosko-plugins into a publishable plugin repo:
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
import { Registry, composeWidget, normalize } from '@kiosko/core';
import { localize, themeById, type Field, type PluginDefinition } from '@kiosko/sdk';
import core from '@kiosko/plugin-core';

const args = process.argv.slice(2);
const oi = args.indexOf('--owner');
const owner = oi >= 0 && args[oi + 1] ? args[oi + 1]! : 'Loksly';
const root = resolve(import.meta.dirname, '..');
const pluginsRoot = resolve(root, '../kiosko-plugins');
const L = (x: Parameters<typeof localize>[0]) => localize(x, 'en');
const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };
const VERSION = rootPkg.version;

/** What each plugin needs outside Kiosko, said once in its README. */
const REQUIREMENTS: Record<string, string[]> = {
  agents: ['A hook that writes agent session files. With Claude Code, add `agent-sessions-hook` (from [`@loksly/agent-sessions`](https://github.com/kiosko-lcd/kiosko/tree/main/packages/agent-sessions)) to your `settings.json` hooks; sessions land in `~/.aimonitor/sessions` by default.'],
  cats: ['The `agents/sessions` source from [kiosko-plugin-agents](../kiosko-plugin-agents) (each session is a cat).', 'Optional: `weather/current` from [kiosko-plugin-weather](../kiosko-plugin-weather) for the sky in the window.'],
  usage: ['[`ccusage`](https://github.com/ryoppippi/ccusage) on the `PATH` (`npm install -g ccusage`).'],
  gitlab: ['[`glab`](https://gitlab.com/gitlab-org/cli) logged in, or a personal access token with `read_api` in the source options.'],
  github: ['[`gh`](https://cli.github.com) logged in (`gh auth login`), or a token in the source options: fine-grained with read access to Actions, Pull requests and Metadata, or classic with `repo` and `read:org` (plus `notifications` for the unread count). GitHub Enterprise Server: set the host.'],
  timesheet: ['[`glab`](https://gitlab.com/gitlab-org/cli) logged in, or a personal access token with `read_api` in the `timesheet/timelogs` source options.', 'For *Left to log*: the `calendar/events` source from [kiosko-plugin-calendar](../kiosko-plugin-calendar) for meetings, and the activity log the aimonitor agent hook writes to `~/.aimonitor/actividad` for agent work.'],
  llm: ['One or more inference servers reachable over HTTP: Ollama, llama.cpp `llama-server` (start it with `--metrics` for tokens/s, queue and KV cache; `/slots` for per-slot state), vLLM, TGI or any OpenAI-compatible server (LM Studio…; only its model list and whether it answers).', 'Ollama exposes no tokens/s, queue or KV-cache endpoint: for Ollama servers the widgets show the loaded models, their size, VRAM, context and keep-alive countdown, and leave tokens/s blank.'],
  gpu: ['A GPU and its tool: `nvidia-smi` (NVIDIA driver), `rocm-smi` or `amd-smi` (ROCm), or the amdgpu / i915 / xe drivers for sysfs readings. For another machine: key-based `ssh` to it (the CLIs run there), or a Prometheus URL serving [DCGM exporter](https://github.com/NVIDIA/dcgm-exporter) or [nvidia_gpu_exporter](https://github.com/utkuozdemir/nvidia_gpu_exporter) metrics.'],
  system: ['Works everywhere; CPU temperature and failed units are read on Linux only.'],
  vitals: ['The `system/vitals` source from [kiosko-plugin-system](../kiosko-plugin-system).'],
  weather: ['Your location in Kiosko → Settings (Open-Meteo, no key needed).'],
  calendar: ['The ICS address of a published calendar (Outlook: *Settings → Calendar → Shared calendars → Publish*; Google: *Secret address in iCal format*). Treat it as a password.'],
  news: ['Internet access to the RSS feeds (Spanish outlets by default; any RSS/Atom feed with images works).'],
  mirror: ['Location in Kiosko → Settings for air quality, earthquakes and the rain radar. *Now playing* reads MPRIS (Linux).'],
};

/** Modules every plugin gets from the Kiosko that loads it (see core/sdk-resolver.ts): never bundled. */
const HOST = ['@kiosko/sdk', '@loksly/lcd-canvas-kit', '@loksly/weather-astro', '@napi-rs/canvas'];

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
  '@kiosko/sdk': `^${VERSION}`,
  '@kiosko/core': `^${VERSION}`,
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
  workflow_dispatch:

# The plugin is tested against the current Kiosko (SDK, drawing kit, libs),
# checked out next to it the same way plugin development is set up locally:
#   kiosko/  and  kiosko-plugins/<this repo>/
jobs:
  test:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
    runs-on: \${{ matrix.os }}
    defaults:
      run:
        working-directory: kiosko-plugins/\${{ github.event.repository.name }}
    steps:
      - uses: actions/checkout@v4
        with:
          path: kiosko-plugins/\${{ github.event.repository.name }}
      - uses: actions/checkout@v4
        with:
          repository: \${{ github.repository_owner }}/kiosko
          path: kiosko
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - run: npm install --no-audit --no-fund
        working-directory: kiosko
      - run: npm run dev:link
        working-directory: kiosko
      - run: npm run check
      - run: npm test
      - run: npm run build
`;

const buildMjs = `// Bundles the plugin into dist/index.js. What Kiosko itself provides to
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
  if (!name.startsWith('kiosko-plugin-') || !existsSync(join(dir, 'src', 'index.ts'))) continue;
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
  const devDependencies: Record<string, string> = { '@kiosko/sdk': VERSIONS['@kiosko/sdk']!, '@types/node': '^24.0.0', esbuild: '^0.25.0', typescript: '^5.9.3' };
  for (const m of imports) if (VERSIONS[m] && m !== '@kiosko/sdk') devDependencies[m] = VERSIONS[m]!;
  if (imports.has('@napi-rs/canvas') || imports.has('@kiosko/core')) devDependencies['@napi-rs/canvas'] = VERSIONS['@napi-rs/canvas']!;
  const old = existsSync(join(dir, 'package.json')) ? (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { description?: string }) : {};
  const pkg = {
    name: repo,
    version: VERSION,
    description: old.description ?? L(def.description),
    type: 'module',
    license: 'MIT',
    author: 'Loksly',
    keywords: ['kiosko', 'kiosko-plugin', 'lcd', 'widgets', ...new Set((def.widgets ?? []).map((w) => w.category ?? 'info'))],
    homepage: `https://github.com/${owner}/${repo}#readme`,
    repository: { type: 'git', url: `git+https://github.com/${owner}/${repo}.git` },
    bugs: { url: `https://github.com/${owner}/${repo}/issues` },
    exports: { '.': { source: './src/index.ts', default: './dist/index.js' } },
    kiosko: { plugin: './dist/index.js', id },
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

  // Screenshots, painted with demo data by Kiosko's own compositor.
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

${L(s.description)}${s.intervalMs ? ` Read every ${s.intervalMs >= 60_000 ? `${s.intervalMs / 60_000} min` : `${s.intervalMs / 1000} s`} while a widget uses it.` : ''} Options are set once in Kiosko → Settings → Data sources.

${optionsTable(s.options)}`);
  const interludes = (def.interludes ?? []).map((i) => `### ${L(i.name)} — \`${id}/${i.id}\`

${L(i.description)} Add it in Kiosko → Screens → Interludes.

${optionsTable(i.options)}`);
  const req = REQUIREMENTS[id] ?? [];
  const readme = `# ${repo}

${L(def.description)}

A plugin for [Kiosko](https://github.com/${owner}/kiosko), the widget mosaic for small USB LCD panels.

${shots[0] ?? ''}

## Install

In Kiosko, **Plugins → Install from npm** → \`${repo}\`, then restart Kiosko. Or from a terminal:

\`\`\`sh
npm install --prefix ~/.config/kiosko/plugins ${repo}
\`\`\`

(macOS: \`~/Library/Application Support/Kiosko/plugins\`, Windows: \`%APPDATA%\\Kiosko\\plugins\`.)
${req.length ? `\n## Requirements\n\n${req.map((r) => `- ${r}`).join('\n')}\n` : ''}
${widgets.length ? `## Widgets\n\n${widgets.join('\n')}` : ''}
${sources.length ? `## Data sources\n\n${sources.join('\n')}` : ''}
${interludes.length ? `## Interludes\n\n${interludes.join('\n')}` : ''}
## Development

\`\`\`sh
npm install
npm test          # node:test
npm run check     # TypeScript
npm run build     # dist/index.js, what Kiosko loads
\`\`\`

To try it in a running Kiosko without publishing: \`kiosko plugins link .\` and restart Kiosko.

Working on Kiosko and its plugins together: clone them side by side
(\`kiosko/\` and \`kiosko-plugins/${repo}/\`) and run \`npm install\` in
\`kiosko/\`; its workspaces link every plugin found in \`../kiosko-plugins\`.

## License

MIT
`;
  writeFileSync(join(dir, 'README.md'), readme.replace(/\n{3,}/g, '\n\n'));
  console.log(`${repo}: ${(def.widgets ?? []).length} widgets, ${(def.sources ?? []).length} sources, ${(def.interludes ?? []).length} interludes`);
}

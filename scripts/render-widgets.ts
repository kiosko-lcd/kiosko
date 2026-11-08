/**
 * Renders every widget of the built-in plugins (or of one plugin) with its
 * demo data, at a few sizes, to PNG files. For plugin development:
 *
 *   node --conditions=source scripts/render-widgets.ts [--plugin id] [--entry plugins/x/src/index.ts] [--out dir] [--theme id] [--size 600x400 ...]
 *
 * `--entry` loads a plugin that isn't registered as built-in yet.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Registry, composeWidget, normalize } from '@tessera/core';
import { themeById } from '@tessera/sdk';
import { BUILTIN_PLUGINS } from '../packages/server/src/builtin.ts';

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const sizes = args.flatMap((a, i) => (args[i - 1] === '--size' ? [a] : [])).map((s) => s.split('x').map(Number) as [number, number]);
const out = opt('--out') ?? 'tmp/widgets';
const only = opt('--plugin');
const theme = themeById(opt('--theme'));
const now = opt('--now') ? Date.parse(opt('--now')!) : Date.parse('2026-11-05T10:42:00');
mkdirSync(out, { recursive: true });
const registry = new Registry();
const entry = opt('--entry');
if (entry) registry.add((await import(pathToFileURL(resolve(entry)).href)).default, entry);
else for (const p of BUILTIN_PLUGINS) registry.add(p);
const cfg = normalize({ location: { latitude: 40.4168, longitude: -3.7038, name: 'Madrid' }, locale: opt('--locale') ?? 'es' });
for (const p of registry.list()) {
  if (only && p.def.id !== only) continue;
  for (const w of p.def.widgets ?? []) {
    const pref = w.size?.preferred ?? { w: 480, h: 300 };
    const list: [number, number][] = sizes.length ? sizes : [[pref.w, pref.h], [Math.max(w.size?.min?.w ?? 160, 160), Math.max(w.size?.min?.h ?? 120, 120)]];
    for (const [width, height] of list) {
      const t0 = performance.now();
      const r = composeWidget({ cfg, registry, theme, type: `${p.def.id}/${w.id}`, width, height, now, title: typeof w.name === 'string' ? w.name : (w.name.es ?? w.name.en) });
      const file = join(out, `${p.def.id}-${w.id}-${width}x${height}.png`);
      writeFileSync(file, r.canvas.toBuffer('image/png'));
      const err = r.tiles[0]?.error;
      console.log(`${err ? '✗' : '✓'} ${file} ${(performance.now() - t0).toFixed(0)} ms${err ? `  ERROR: ${err}` : ''}`);
    }
  }
}

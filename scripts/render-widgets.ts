/**
 * Renders every widget of the built-in plugins (or of one plugin) with its
 * demo data, at a few sizes, to PNG files. For plugin development:
 *
 *   node --conditions=source scripts/render-widgets.ts [--plugin id] [--widget id] [--entry plugins/x/src/index.ts]
 *        [--out dir] [--theme id] [--locale es|en] [--now iso] [--size 600x400 ...]
 *        [--options '{"rows":2}' | --options @file.json] [--data file] [--sources file] [--empty] [--name label] [--chrome card|bare]
 *
 * - `--plugin` takes a built-in plugin (`core`, `legacy`) or an official one
 *   installed next to Kiosko (`gitlab` → the `kiosko-plugin-gitlab` package);
 *   `--entry` loads any other plugin by path.
 * - `--widget` renders one widget only (`pipelines` or `gitlab/pipelines`).
 * - `--options` is merged over the widget's demo options, as in the gallery.
 * - `--data` replaces the widget's own data and `--sources` its shared
 *   sources (`{ "gitlab/merge-requests": … }`): a JSON file, or a JS/TS
 *   module whose default export is the value or a function
 *   `({ now, locale, demo }) => value` (`demo` is what the widget's demo gives).
 * - `--empty` empties the lists in the demo data and sources (empty states).
 * - `--name` goes into the file names, to keep several runs apart.
 * - `--chrome bare` draws the widget without its card and title.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Registry, composeWidget, normalize } from '@kiosko/core';
import { themeById, type PluginDefinition, type WidgetDefinition } from '@kiosko/sdk';
import { BUILTIN_PLUGINS } from '../packages/server/src/builtin.ts';

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const sizes = args.flatMap((a, i) => (args[i - 1] === '--size' ? [a] : [])).map((s) => s.split('x').map(Number) as [number, number]);
const out = opt('--out') ?? 'tmp/widgets';
const only = opt('--plugin');
const onlyWidget = opt('--widget');
const theme = themeById(opt('--theme'));
const locale = opt('--locale') ?? 'es';
const now = opt('--now') ? Date.parse(opt('--now')!) : Date.parse('2026-11-05T10:42:00');
const label = opt('--name');
const empty = args.includes('--empty');
const chrome = opt('--chrome') as 'card' | 'bare' | undefined;

/** `--options '{…}'` or `--options @file.json`. */
function readOptions(): Record<string, unknown> | undefined {
  const raw = opt('--options');
  if (raw === undefined) return undefined;
  return JSON.parse(raw.startsWith('@') ? readFileSync(raw.slice(1), 'utf8') : raw) as Record<string, unknown>;
}

/** A JSON file, or a module whose default export is the value or a function of `{ now, locale, demo }`. */
async function readValue(file: string | undefined, demo: unknown): Promise<unknown> {
  if (!file) return undefined;
  if (extname(file) === '.json') return JSON.parse(readFileSync(file, 'utf8'));
  const mod = (await import(pathToFileURL(resolve(file)).href)) as { default: unknown };
  return typeof mod.default === 'function' ? (mod.default as (c: object) => unknown)({ now, locale, demo }) : mod.default;
}

/** Empties every list in `v` and in its objects one level down. */
function emptied(v: unknown): unknown {
  if (Array.isArray(v)) return [];
  if (!v || typeof v !== 'object') return v;
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, Array.isArray(x) ? [] : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k2, y]) => [k2, Array.isArray(y) ? [] : y])) : x]));
}

mkdirSync(out, { recursive: true });
const registry = new Registry();
const entry = opt('--entry');
if (entry) registry.add((await import(pathToFileURL(resolve(entry)).href)).default, entry);
else if (only && !BUILTIN_PLUGINS.some((p) => p.id === only)) registry.add(((await import(`kiosko-plugin-${only}`)) as { default: PluginDefinition }).default, `kiosko-plugin-${only}`);
else for (const p of BUILTIN_PLUGINS) registry.add(p);
const cfg = normalize({ location: { latitude: 40.4168, longitude: -3.7038, name: 'Madrid' }, locale });
const given = readOptions();
for (const p of registry.list()) {
  if (only && p.def.id !== only) continue;
  for (const w of (p.def.widgets ?? []) as WidgetDefinition<any, any>[]) {
    const type = `${p.def.id}/${w.id}`;
    if (onlyWidget && onlyWidget !== w.id && onlyWidget !== type) continue;
    const demo = (() => {
      try {
        return w.demo?.({ options: w.options ? (w.options as { default: unknown }).default : {}, now, locale });
      } catch {
        return undefined;
      }
    })();
    // The gallery's look (demo options) with the given ones on top.
    const options = { ...(demo?.options ?? {}), ...(given ?? {}) };
    let data = await readValue(opt('--data'), demo?.data);
    let sources = (await readValue(opt('--sources'), demo?.sources)) as Record<string, unknown> | undefined;
    if (data !== undefined || sources || empty) {
      // Given data turns the demo off: the rest comes from the demo explicitly.
      data = data !== undefined ? data : (demo?.data ?? null);
      sources = sources ?? demo?.sources;
      if (empty) [data, sources] = [emptied(data), emptied(sources) as Record<string, unknown> | undefined];
    }
    const pref = w.size?.preferred ?? { w: 480, h: 300 };
    const list: [number, number][] = sizes.length ? sizes : [[pref.w, pref.h], [Math.max(w.size?.min?.w ?? 160, 160), Math.max(w.size?.min?.h ?? 120, 120)]];
    for (const [width, height] of list) {
      const t0 = performance.now();
      const r = composeWidget({
        cfg, registry, theme, type, width, height, now,
        title: typeof w.name === 'string' ? w.name : (w.name.es ?? w.name.en),
        options,
        ...(chrome ? { chrome } : {}),
        ...(data !== undefined ? { data } : {}),
        ...(sources ? { sources } : {}),
      });
      const file = join(out, `${p.def.id}-${w.id}${label ? `-${label}` : ''}-${width}x${height}.png`);
      writeFileSync(file, r.canvas.toBuffer('image/png'));
      const err = r.tiles[0]?.error;
      console.log(`${err ? '✗' : '✓'} ${file} ${(performance.now() - t0).toFixed(0)} ms${err ? `  ERROR: ${err}` : ''}`);
    }
  }
}

/**
 * Compatibility with aimonitor modules: a file exporting by default
 * `{ name, defaults, fetch?, updateMs?, draw(c, ctx), visible?, urgent? }`
 * (aimonitor's `defineModule`, itself modelled on MagicMirror²) runs here as
 * a widget without touching it. New code should be a real plugin; this is
 * so nobody loses their custom cards when moving over.
 */
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { definePlugin, defineWidget, t, type Box, type CanvasApi, type Graphics, type Theme } from '@kiosko/sdk';

interface LegacyModule {
  name: string;
  defaults?: Record<string, unknown>;
  fetch?: (ctx: { config: Record<string, unknown>; now: number; log: (m: string) => void; canvas: CanvasApi }) => Promise<unknown>;
  updateMs?: number;
  draw: (c: Graphics, ctx: Record<string, unknown>) => void;
  visible?: (ctx: { config: Record<string, unknown>; data: unknown; now: number }) => boolean;
  urgent?: (ctx: { config: Record<string, unknown>; data: unknown; now: number }) => boolean;
}

const loaded = new Map<string, LegacyModule>();

/** Same lookup as aimonitor: absolute, or relative to the modules folder, with .mjs/.js/index.* tried. */
export function resolveModule(name: string, dir: string): string | null {
  const expanded = name.startsWith('~/') ? join(homedir(), name.slice(2)) : name;
  const base = isAbsolute(expanded) ? expanded : join(dir.startsWith('~/') ? join(homedir(), dir.slice(2)) : dir, expanded);
  for (const p of [base, `${base}.mjs`, `${base}.js`, join(base, 'index.mjs'), join(base, 'index.js')]) {
    if (existsSync(p) && statSync(p).isFile()) return p;
  }
  return null;
}

async function load(path: string): Promise<LegacyModule> {
  const hit = loaded.get(path);
  if (hit) return hit;
  const m = (await import(pathToFileURL(path).href)).default as LegacyModule | undefined;
  if (!m || typeof m.draw !== 'function') throw new Error(`${path} doesn't export a module (with name and draw)`);
  loaded.set(path, m);
  return m;
}

/** The colours and fonts an aimonitor module expects, from the Kiosko theme. */
export function legacyLook(theme: Theme) {
  return {
    fonts: { condensed: theme.fonts.sans, condensedBold: theme.fonts.sansBold, mono: theme.fonts.mono, monoBold: theme.fonts.monoBold },
    colors: { bg: theme.colors.bg, ink: theme.colors.ink, inkDim: theme.colors.inkDim, inkFaint: theme.colors.inkFaint, alert: theme.colors.alert, warn: theme.colors.warn, info: theme.colors.info, ok: theme.colors.ok },
  };
}

interface Data {
  path: string;
  data: unknown;
}

const optionsSchema = t.object({
  module: t.string({ risk: 'exec', label: { en: 'Module (name or path)', es: 'Módulo (nombre o ruta)' }, placeholder: 'pizarra', help: { en: 'Looked up in the folder below unless absolute.', es: 'Se busca en la carpeta de abajo salvo que sea absoluta.' } }),
  dir: t.string({ default: '~/.aimonitor/modules', format: 'path', risk: 'exec', label: { en: 'Modules folder', es: 'Carpeta de módulos' }, advanced: true }),
  config: t.map({ label: { en: 'Module config (key → value)', es: 'Config del módulo (clave → valor)' }, help: { en: 'Simple values only; numbers and true/false are converted.', es: 'Sólo valores simples; números y true/false se convierten.' } }),
  json: t.string({ multiline: true, label: { en: 'Module config as JSON', es: 'Config del módulo en JSON' }, help: { en: 'For lists and nested values. Wins over the table above.', es: 'Para listas y valores anidados. Manda sobre la tabla de arriba.' }, advanced: true }),
});

/** The module's config: its defaults, then the key/value table, then the JSON. */
export function moduleConfig(mod: LegacyModule | undefined, o: { config: Record<string, string>; json: string }): Record<string, unknown> {
  const kv = Object.fromEntries(Object.entries(o.config).map(([k, v]) => [k, v === 'true' ? true : v === 'false' ? false : v.trim() !== '' && !Number.isNaN(Number(v)) ? Number(v) : v]));
  let js: Record<string, unknown> = {};
  try {
    js = o.json.trim() ? (JSON.parse(o.json) as Record<string, unknown>) : {};
  } catch {
    /* shown as an error by fetch */
  }
  return { ...(mod?.defaults ?? {}), ...kv, ...js };
}

export const module = defineWidget({
  id: 'module',
  name: { en: 'aimonitor module', es: 'Módulo de aimonitor' },
  description: { en: 'Runs a custom card written for aimonitor (defineModule) unchanged.', es: 'Ejecuta sin cambios una tarjeta propia escrita para aimonitor (defineModule).' },
  icon: 'puzzle',
  category: 'productivity',
  size: { min: { w: 200, h: 120 }, preferred: { w: 600, h: 440 } },
  options: optionsSchema,
  intervalMs: 60_000,
  async fetch({ options, now, log, canvas }): Promise<Data> {
    if (!options.module) throw new Error('no module set');
    const path = resolveModule(options.module, options.dir);
    if (!path) throw new Error(`module "${options.module}" not found in ${options.dir}`);
    const mod = await load(path);
    if (options.json.trim()) JSON.parse(options.json);
    const data = mod.fetch ? await mod.fetch({ config: moduleConfig(mod, options), now, log, canvas }) : undefined;
    return { path, data };
  },
  // The module's own `updateMs`, as in aimonitor.
  intervalOf: ({ data }) => (data ? loaded.get(data.path)?.updateMs : undefined),
  render(g, ctx) {
    const mod = ctx.data ? loaded.get(ctx.data.path) : undefined;
    if (!mod) {
      ctx.kit.drawTracked(g, ctx.options.module ? '…' : ctx.t({ en: 'Pick a module in the options', es: 'Elige un módulo en las opciones' }), ctx.box.x, ctx.box.y + 30, { size: 22, family: ctx.theme.fonts.sans, color: ctx.theme.colors.inkDim });
      return;
    }
    const box: Box = ctx.box;
    mod.draw(g, { config: moduleConfig(mod, ctx.options), data: ctx.data?.data, now: ctx.now, box, ...legacyLook(ctx.theme), kit: ctx.kit, canvas: ctx.canvas });
  },
  redraw: 'minute',
  visible({ options, data, now }) {
    const mod = data ? loaded.get(data.path) : undefined;
    return mod?.visible?.({ config: moduleConfig(mod, options), data: data?.data, now }) ?? true;
  },
  urgent({ options, data, now }) {
    const mod = data ? loaded.get(data.path) : undefined;
    return mod?.urgent?.({ config: moduleConfig(mod, options), data: data?.data, now }) ?? false;
  },
});

export default definePlugin({
  id: 'legacy',
  name: { en: 'aimonitor compatibility', es: 'Compatibilidad aimonitor' },
  version: '0.1.0',
  description: { en: 'Run your aimonitor custom modules as widgets.', es: 'Tus módulos propios de aimonitor, como widgets.' },
  author: 'Kiosko',
  license: 'MIT',
  icon: 'puzzle',
  widgets: [module],
});

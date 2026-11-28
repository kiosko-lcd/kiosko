/**
 * Compatibility with aimonitor modules: a file exporting by default
 * `{ name, defaults, fetch?, updateMs?, draw(c, ctx), visible?, urgent? }`
 * (aimonitor's `defineModule`, itself modelled on MagicMirror²) runs here as
 * a widget without touching it. New code should be a real plugin; this is
 * so nobody loses their custom cards when moving over.
 */
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { definePlugin, defineWidget, expandPath, t, type Box, type CanvasApi, type Graphics, type Theme } from '@kiosko/sdk';

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
  const expanded = expandPath(name);
  const base = isAbsolute(expanded) ? expanded : join(expandPath(dir), expanded);
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
  module: t.string({ risk: 'exec', label: { en: 'Module (name or path)', es: 'Módulo (nombre o ruta)', de: 'Modul (Name oder Pfad)', 'zh-Hant': '模組（名稱或路徑）', 'zh-Hans': '模块（名称或路径）' }, placeholder: 'pizarra', help: { en: 'Looked up in the folder below unless absolute.', es: 'Se busca en la carpeta de abajo salvo que sea absoluta.', de: 'Wird im Ordner unten gesucht, außer der Pfad ist absolut.', 'zh-Hant': '若不是絕對路徑，會在下方的資料夾中尋找。', 'zh-Hans': '如果不是绝对路径，会在下方的文件夹中查找。' } }),
  dir: t.string({ default: '~/.aimonitor/modules', format: 'path', risk: 'exec', label: { en: 'Modules folder', es: 'Carpeta de módulos', de: 'Modulordner', 'zh-Hant': '模組資料夾', 'zh-Hans': '模块文件夹' }, advanced: true }),
  config: t.map({ label: { en: 'Module config (key → value)', es: 'Config del módulo (clave → valor)', de: 'Modulkonfiguration (Schlüssel → Wert)', 'zh-Hant': '模組設定（鍵 → 值）', 'zh-Hans': '模块配置（键 → 值）' }, help: { en: 'Simple values only; numbers and true/false are converted.', es: 'Sólo valores simples; números y true/false se convierten.', de: 'Nur einfache Werte; Zahlen und true/false werden umgewandelt.', 'zh-Hant': '僅限簡單值；數字和 true/false 會自動轉換。', 'zh-Hans': '仅限简单值；数字和 true/false 会自动转换。' } }),
  json: t.string({ multiline: true, label: { en: 'Module config as JSON', es: 'Config del módulo en JSON', de: 'Modulkonfiguration als JSON', 'zh-Hant': 'JSON 格式的模組設定', 'zh-Hans': 'JSON 格式的模块配置' }, help: { en: 'For lists and nested values. Wins over the table above.', es: 'Para listas y valores anidados. Manda sobre la tabla de arriba.', de: 'Für Listen und verschachtelte Werte. Hat Vorrang vor der Tabelle oben.', 'zh-Hant': '用於清單和巢狀值，優先於上方的表格。', 'zh-Hans': '用于列表和嵌套值，优先于上方的表格。' }, advanced: true }),
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
  name: { en: 'aimonitor module', es: 'Módulo de aimonitor', de: 'aimonitor-Modul', 'zh-Hant': 'aimonitor 模組', 'zh-Hans': 'aimonitor 模块' },
  description: { en: 'Runs a custom card written for aimonitor (defineModule) unchanged.', es: 'Ejecuta sin cambios una tarjeta propia escrita para aimonitor (defineModule).', de: 'Führt eine für aimonitor geschriebene eigene Karte (defineModule) unverändert aus.', 'zh-Hant': '原封不動執行為 aimonitor 撰寫的自訂卡片（defineModule）。', 'zh-Hans': '原样运行为 aimonitor 编写的自定义卡片（defineModule）。' },
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
      ctx.kit.drawTracked(g, ctx.options.module ? '…' : ctx.t({ en: 'Pick a module in the options', es: 'Elige un módulo en las opciones', de: 'Wähle ein Modul in den Optionen', 'zh-Hant': '請在選項中選擇模組', 'zh-Hans': '请在选项中选择模块' }), ctx.box.x, ctx.box.y + 30, { size: 22, family: ctx.theme.fonts.sans, color: ctx.theme.colors.inkDim });
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
  name: { en: 'aimonitor compatibility', es: 'Compatibilidad aimonitor', de: 'aimonitor-Kompatibilität', 'zh-Hant': 'aimonitor 相容性', 'zh-Hans': 'aimonitor 兼容' },
  version: '0.2.16',
  languages: ['en', 'es', 'de', 'zh-Hant', 'zh-Hans'],
  sdk: '^0.2.0',
  // Runs the aimonitor modules you point it at, and reads their folder.
  permissions: { exec: ['user'], files: ['user'] },
  description: { en: 'Run your aimonitor custom modules as widgets.', es: 'Tus módulos propios de aimonitor, como widgets.', de: 'Deine eigenen aimonitor-Module als Widgets.', 'zh-Hant': '將你的 aimonitor 自訂模組當作小工具執行。', 'zh-Hans': '把你的 aimonitor 自定义模块作为小组件运行。' },
  author: 'Kiosko',
  license: 'MIT',
  icon: 'puzzle',
  widgets: [module],
});

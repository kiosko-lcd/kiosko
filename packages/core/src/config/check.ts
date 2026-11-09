/**
 * Validating a config: against its JSON Schema (shape, types, known widget
 * types and option values) and against what `normalize` makes of it (ids,
 * tiles that fit the grid and don't overlap, sizes widgets need, option
 * names no plugin knows). Errors make Kiosko misbehave or lose something;
 * warnings are worth a look but harmless.
 *
 * The messages carry a JSON path and say what to change, so a user can paste
 * them back to the AI that wrote the file. Pure (no Node).
 */
import type { Field, PluginDefinition } from '@kiosko/sdk';
import { cellsFor, inBounds, overlaps, toPx, type GridSpec } from '../layout/grid.ts';
import { closest, formatPath, toPointer, validateJson, type JsonIssue, type JsonSchema, type PathSeg } from './jsonschema.ts';
import type { Config } from './model.ts';
import { normalize } from './normalize.ts';
import { configSchema, TYPE_PATTERN } from './schema.ts';

export interface ConfigReport {
  errors: JsonIssue[];
  warnings: JsonIssue[];
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const issue = (path: PathSeg[], message: string, context?: string): JsonIssue => ({ path: formatPath(path), pointer: toPointer(path), message, ...(context ? { context } : {}) });
const near = (word: string, names: string[]) => {
  const c = closest(word, names);
  return c.length ? ` (did you mean ${c.map((x) => JSON.stringify(x)).join(' or ')}?)` : '';
};

/** Option names a plugin doesn't know (typos, invented ones): ignored by Kiosko, so worth a warning. */
function unknownOptions(f: Field, v: unknown, path: PathSeg[], out: JsonIssue[], owner: string): void {
  if (f.kind === 'object' && isObj(v)) {
    const props = f.props as Record<string, Field>;
    const names = Object.keys(props);
    for (const [k, x] of Object.entries(v)) {
      const sub = props[k];
      if (sub) unknownOptions(sub, x, [...path, k], out, owner);
      else out.push(issue([...path, k], `is not an option of ${owner}${near(k, names)}, so it is ignored. Its options: ${names.join(', ') || 'none'}`, owner));
    }
  } else if (f.kind === 'list' && Array.isArray(v)) v.forEach((x, i) => unknownOptions(f.item, x, [...path, i], out, owner));
}

const validGrid = (g: unknown): g is GridSpec => isObj(g) && ['cols', 'rows', 'gap', 'padding'].every((k) => Number.isInteger(g[k])) && (g.cols as number) >= 1 && (g.rows as number) >= 1;
const validRect = (t: unknown) => isObj(t) && ['x', 'y', 'w', 'h'].every((k) => Number.isInteger(t[k]));

function repeated(items: unknown[], path: PathSeg[], what: string, out: JsonIssue[]): void {
  const seen = new Map<string, number>();
  items.forEach((x, i) => {
    if (!isObj(x) || typeof x.id !== 'string') return;
    const first = seen.get(x.id);
    if (first !== undefined) out.push(issue([...path, i, 'id'], `repeats the id ${JSON.stringify(x.id)} of ${formatPath([...path, first])}: ${what} ids must be unique`));
    else seen.set(x.id, i);
  });
}

/** What the schema can't say: checked on `normalize(raw)`, with paths into `raw` (normalize keeps every list's order). */
export function checkConfig(raw: unknown, plugins: readonly PluginDefinition[]): ConfigReport {
  const errors: JsonIssue[] = [];
  const warnings: JsonIssue[] = [];
  if (!isObj(raw)) return { errors: [issue([], 'the config must be a JSON object')], warnings };
  let cfg: Config;
  try {
    cfg = normalize(raw);
  } catch {
    // Lists where objects should be (or the other way round): the schema errors say where.
    return { errors, warnings };
  }
  const widgets = new Map<string, NonNullable<PluginDefinition['widgets']>[number]>(plugins.flatMap((p) => (p.widgets ?? []).map((w) => [`${p.id}/${w.id}`, w] as const)));
  const sources = new Map<string, NonNullable<PluginDefinition['sources']>[number]>(plugins.flatMap((p) => (p.sources ?? []).map((s) => [`${p.id}/${s.id}`, s] as const)));
  const interludes = new Map<string, NonNullable<PluginDefinition['interludes']>[number]>(plugins.flatMap((p) => (p.interludes ?? []).map((i) => [`${p.id}/${i.id}`, i] as const)));
  const pluginIds = plugins.map((p) => p.id);
  const disabled = new Set(Array.isArray(cfg.plugins.disabled) ? cfg.plugins.disabled : []);
  const widgetIds = new Map<string, PathSeg[]>();

  if (!Array.isArray(cfg.screens)) return { errors, warnings };
  repeated(cfg.screens, ['screens'], 'screen', errors);
  cfg.screens.forEach((s, si) => {
    const sp: PathSeg[] = ['screens', si];
    if (!isObj(s) || !Array.isArray(s.pages)) return;
    repeated(s.pages, [...sp, 'pages'], 'page', errors);
    if (!s.pages.length) warnings.push(issue([...sp, 'pages'], 'the screen has no pages, so it shows nothing'));
    if (s.pinnedPage && !s.pages.some((p) => p.id === s.pinnedPage)) errors.push(issue([...sp, 'pinnedPage'], `names no page of this screen; its pages are ${s.pages.map((p) => JSON.stringify(p.id)).join(', ') || 'none'}`));
    s.pages.forEach((p, pi) => {
      const pp: PathSeg[] = [...sp, 'pages', pi];
      if (!isObj(p) || !Array.isArray(p.tiles)) return;
      repeated(p.tiles, [...pp, 'tiles'], 'tile', errors);
      const grid = validGrid(p.grid) ? p.grid : null;
      p.tiles.forEach((t, ti) => {
        const tp: PathSeg[] = [...pp, 'tiles', ti];
        if (!isObj(t)) return;
        const geometry = grid && validRect(t) && Number.isInteger(s.width) && Number.isInteger(s.height);
        if (geometry && !inBounds(t, grid)) {
          const past = [t.x + t.w > grid.cols && `x + w = ${t.x + t.w} but the grid has ${grid.cols} columns`, t.y + t.h > grid.rows && `y + h = ${t.y + t.h} but the grid has ${grid.rows} rows`, (t.x < 0 || t.y < 0) && 'x and y start at 0', (t.w < 1 || t.h < 1) && 'w and h are at least 1'].filter(Boolean);
          errors.push(issue(tp, `does not fit the ${grid.cols}×${grid.rows} grid: ${past.join('; ')}`));
        }
        if (geometry) {
          p.tiles.forEach((o, oi) => {
            if (oi > ti && isObj(o) && validRect(o) && overlaps(t, o)) warnings.push(issue(tp, `overlaps ${formatPath([...pp, 'tiles', oi])} (${JSON.stringify(o.id)}): one hides part of the other; move or shrink one`));
          });
        }
        if (!Array.isArray(t.widgets)) return;
        if (!t.widgets.length) warnings.push(issue([...tp, 'widgets'], 'the tile has no widgets, so it stays empty'));
        t.widgets.forEach((w, wi) => {
          const wp: PathSeg[] = [...tp, 'widgets', wi];
          if (!isObj(w)) return;
          if (typeof w.id === 'string') {
            const first = widgetIds.get(w.id);
            if (first) errors.push(issue([...wp, 'id'], `repeats the id ${JSON.stringify(w.id)} of ${formatPath(first)}: widget ids must be unique in the whole config`));
            else widgetIds.set(w.id, wp);
          }
          const def = typeof w.type === 'string' ? widgets.get(w.type) : undefined;
          if (!def) return; // unknown types are schema errors
          const plugin = w.type.split('/')[0]!;
          if (disabled.has(plugin)) warnings.push(issue(wp, `its plugin ${JSON.stringify(plugin)} is switched off in plugins.disabled, so it won't show`, w.type));
          const min = def.size?.min;
          if (min && geometry) {
            const px = toPx(t, grid, s.width, s.height);
            if (px.w < min.w || px.h < min.h) {
              const need = cellsFor(min, grid, s.width, s.height);
              warnings.push(issue(tp, `is ${px.w}×${px.h} px but ${w.type} needs at least ${min.w}×${min.h} px: make it at least ${Math.max(need.w, t.w)}×${Math.max(need.h, t.h)} cells (w×h)`, w.type));
            }
          }
          if (def.options) unknownOptions(def.options, w.options, [...wp, 'options'], warnings, w.type);
        });
      });
    });
    if (!Array.isArray(s.interludes)) return;
    repeated(s.interludes, [...sp, 'interludes'], 'interlude', errors);
    s.interludes.forEach((x, xi) => {
      const def = isObj(x) && typeof x.type === 'string' ? interludes.get(x.type) : undefined;
      if (def?.options) unknownOptions(def.options, x.options, [...sp, 'interludes', xi, 'options'], warnings, x.type);
    });
  });

  if (isObj(cfg.sources)) {
    for (const [type, opts] of Object.entries(cfg.sources)) {
      const def = sources.get(type);
      if (def?.options) unknownOptions(def.options, opts, ['sources', type], warnings, type);
      else if (!def && new RegExp(TYPE_PATTERN).test(type)) warnings.push(issue(['sources', type], `no installed plugin provides this source, so it is ignored${near(type, [...sources.keys()])}`));
    }
  }
  if (Array.isArray(cfg.plugins.disabled)) {
    cfg.plugins.disabled.forEach((id, i) => {
      if (typeof id === 'string' && !pluginIds.includes(id)) warnings.push(issue(['plugins', 'disabled', i], `no installed plugin is called ${JSON.stringify(id)}${near(id, pluginIds)}`));
    });
  }
  return { errors, warnings };
}

/** Schema errors, then what only `normalize` reveals. `schema` defaults to the one of `plugins`. */
export function validateConfig(raw: unknown, plugins: readonly PluginDefinition[], schema: JsonSchema = configSchema(plugins)): ConfigReport {
  const shape = validateJson(schema, raw);
  const more = checkConfig(raw, plugins);
  return { errors: [...shape, ...more.errors], warnings: more.warnings };
}

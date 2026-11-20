/**
 * The conventions of docs/plugins.md ("Option conventions" and the
 * contract), checked on a plugin's definition, so every plugin names the
 * same idea the same way and a store can trust what it lists:
 *
 *   kiosko plugins check ./my-plugin
 *
 * `error`: breaks something Kiosko or the editor relies on. `warn`: against
 * a convention, or something a person installing it would want to know.
 */
import type { Field, InterludeDefinition, Localized, ObjectField, PluginDefinition, SourceDefinition, WidgetDefinition } from '@kiosko/sdk';
import { languagesOf } from './plugin-meta.ts';

export interface LintIssue {
  level: 'error' | 'warn';
  /** `weather/forecast options.tempCrit`, `plugin`. */
  where: string;
  message: string;
}

const ID = /^[a-z0-9][a-z0-9-]*$/;
const PART_ID = /^[a-z0-9][a-zA-Z0-9-]*$/;

/** Keys of the options of an object field, recursively, with their fields. */
function* fieldsOf(f: Field | undefined, prefix = ''): Generator<[string, Field]> {
  if (!f || f.kind !== 'object') return;
  for (const [k, sub] of Object.entries((f as ObjectField).props as Record<string, Field>)) {
    const path = prefix ? `${prefix}.${k}` : k;
    yield [path, sub];
    if (sub.kind === 'object') yield* fieldsOf(sub, path);
    if (sub.kind === 'list' && sub.item.kind === 'object') yield* fieldsOf(sub.item, `${path}[]`);
  }
}

const last = (path: string) => path.split(/[.[\]]+/).filter(Boolean).pop() ?? path;

/** Options against the naming and unit conventions. */
export function lintOptions(where: string, f: Field | undefined, kind: 'widget' | 'source' | 'interlude'): LintIssue[] {
  const out: LintIssue[] = [];
  const warn = (path: string, message: string) => out.push({ level: 'warn', where: `${where} options.${path}`, message });
  const err = (path: string, message: string) => out.push({ level: 'error', where: `${where} options.${path}`, message });
  const names = new Set([...fieldsOf(f)].map(([p]) => p));
  for (const [path, x] of fieldsOf(f)) {
    const name = last(path);
    if (x.kind === 'number' && x.unit === 'ms' && !/Ms$/.test(name)) warn(path, 'a duration: name it …Ms (rotateMs, maxAgeMs)');
    if (x.kind === 'number' && /Ms$/.test(name) && x.unit !== 'ms') warn(path, 'named …Ms but not a duration: use t.duration()');
    // …Minutes is a duration; …Min only when nothing else says what it is (tileMin in px is a minimum).
    if (x.kind === 'number' && (/(Minutes|Hours|Secs|Seconds)$/.test(name) || (/Mins?$/.test(name) && (!x.unit || x.unit === 'min')))) warn(path, 'durations are milliseconds with t.duration() and a name ending in Ms');
    if (/(Crit|Critical)$/.test(name)) warn(path, 'thresholds are …Warn (amber) and …Alert (red), never …Crit');
    if (/Warn$/.test(name) && !names.has(path.replace(/Warn$/, 'Alert'))) warn(path, `thresholds come in pairs: add ${name.replace(/Warn$/, 'Alert')}`);
    if (/Alert$/.test(name) && !names.has(path.replace(/Alert$/, 'Warn'))) warn(path, `thresholds come in pairs: add ${name.replace(/Alert$/, 'Warn')}`);
    if (x.kind === 'number' && x.unit === '%' && (!x.integer || (x.max !== undefined && x.max > 100) || (x.max !== undefined && x.max <= 1))) warn(path, 'percentages are integers 0–100: t.integer({ min: 0, max: 100, unit: "%" })');
    if (x.kind === 'number' && x.unit === '°C' && !x.integer) warn(path, 'temperatures are integer °C');
    if (x.kind === 'boolean' && /Only$/.test(name)) warn(path, 'no …Only suffix: only<Condition> (onlyLatest)');
    if (x.kind === 'boolean' && ['seconds', 'moon', 'cores', 'date', 'title'].includes(name)) warn(path, `a part shown or hidden is show<Part>: show${name[0]!.toUpperCase()}${name.slice(1)}`);
    if (name === 'takeOver') err(path, 'takeOver is the instance\'s switch, not an option: declare `takeOver` on the definition');
    if (name === 'hideWhenEmpty') err(path, 'hideWhenEmpty is the instance\'s switch: declare `empty(ctx)` (and `hideWhenEmpty` on the definition)');
    if (kind === 'source' && (name === 'intervalMs' || name === 'timeoutMs') && !path.includes('.')) err(path, 'refresh and timeout are not options: declare intervalMs / timeoutMs on the source');
    if (name === 'max' || name === 'count') warn(path, 'a cap is max<Things> (maxProcesses); a list length is `rows` through listOptions()');
    if ((name === 'latitude' || name === 'longitude') && !(x.kind === 'number' && x.advanced)) warn(path, 'use ctx.location, with locationOptions() as an advanced override');
    if (x.kind === 'string') {
      const looks = x.format === 'url' || x.format === 'path' || /^(url|host|endpoint|command|cmd|bin|path|dir|file|ssh)$/i.test(name) || /(Url|Host|Path|Dir|Command)$/.test(name);
      if (looks && !x.risk && !x.secret) warn(path, 'its value contacts a host, runs a program or reads a path: mark it with `risk`');
    }
    if (kind === 'widget' && x.kind === 'list' && x.item.kind === 'string' && !x.filter && /^(repos|projects|calendars|servers|people|outlets|entities|gpus|branches|users)$/.test(name)) warn(path, 'a list of names to show is a filter: t.filter() with matchFilter');
  }
  return out;
}

/** A text without every language the rest of the plugin speaks. */
function missingLanguages(text: Localized | undefined, langs: string[]): string[] {
  if (text === undefined) return [];
  if (typeof text === 'string') return langs.filter((l) => l !== 'en');
  return langs.filter((l) => !(l in text));
}

/** Whether Intl has a name for the tag's language (`xx` has none). */
function knownLanguage(tag: string): boolean {
  try {
    const lang = new Intl.Locale(tag).language;
    return new Intl.DisplayNames(['en'], { type: 'language', fallback: 'none' }).of(lang) !== undefined;
  } catch {
    return false;
  }
}

/** A widget, source or interlude without its options, for the languages of its own texts. */
const bare = <T extends { options?: unknown }>(x: T): T => ({ ...x, options: undefined });

export function lintPlugin(def: PluginDefinition): LintIssue[] {
  const out: LintIssue[] = [];
  const add = (level: LintIssue['level'], where: string, message: string) => out.push({ level, where, message });
  if (!ID.test(def.id ?? '')) add('error', 'plugin', `id ${JSON.stringify(def.id)}: lowercase letters, digits and dashes`);
  if (!/^\d+\.\d+\.\d+/.test(def.version ?? '')) add('error', 'plugin', `version ${JSON.stringify(def.version)} is not semver`);
  if (!def.sdk) add('warn', 'plugin', 'say which plugin API it is written for: `sdk: "^0.2.0"` (and `kiosko.sdk` in package.json, so an incompatible Kiosko never runs it)');
  const reaches = (def.sources ?? []).length > 0 || (def.widgets ?? []).some((w) => w.fetch);
  if (reaches && !def.permissions) add('warn', 'plugin', 'it reads data: declare `permissions` (hosts, programs, files, devices) so people know before installing');
  if (!def.description) add('warn', 'plugin', 'a description, for the Plugins page and the store');
  for (const r of [...(def.requires ?? []), ...(def.optional ?? [])]) if (!/^[a-z0-9][a-z0-9-]*\/[a-zA-Z0-9-]+$/.test(r)) add('error', 'plugin', `requires/optional ${JSON.stringify(r)}: a type, plugin/thing`);
  // The languages it says it speaks, checked against the ones its texts use.
  const used = languagesOf(def);
  const declared = def.languages;
  if (!declared?.length) add('warn', 'plugin', `declare the languages its texts come in: \`languages: [${used.map((l) => `'${l}'`).join(', ')}]\` (and "kiosko": { "languages": [...] } in package.json)`);
  else {
    for (const tag of declared) {
      let canon: string | undefined;
      try {
        canon = Intl.getCanonicalLocales(tag)[0];
      } catch {
        add('error', 'plugin', `languages: "${tag}" is not a language tag (en, es, zh-Hant…)`);
        continue;
      }
      if (canon !== tag) add('warn', 'plugin', `languages: write "${tag}" as "${canon}"`);
      else if (!knownLanguage(tag)) add('warn', 'plugin', `languages: "${tag}" is not a language Intl knows`);
    }
    if (!declared.includes('en')) add('error', 'plugin', 'languages: English (`en`) is the one every text falls back to: list it, and write every text in it');
    if (new Set(declared).size !== declared.length) add('warn', 'plugin', 'languages: a language is listed twice');
    // Only the plugin's own texts: options built with the SDK's helpers (place, lists) bring
    // every language Kiosko speaks, which says nothing about the plugin.
    const own = languagesOf({ ...def, widgets: def.widgets?.map(bare), sources: def.sources?.map(bare), interludes: def.interludes?.map(bare) } as PluginDefinition);
    const unlisted = own.filter((l) => !declared.includes(l));
    if (unlisted.length) add('warn', 'plugin', `its texts come in ${unlisted.join(', ')} too, which \`languages\` doesn't list`);
  }
  const langs = declared?.length ? declared : used;
  if (langs.includes('zh') || used.includes('zh')) add('warn', 'plugin', 'a bare `zh` is read as Simplified and never shown in Taiwan or Hong Kong: write `zh-Hans` (mainland China) and `zh-Hant` (Taiwan, Hong Kong)');
  const texts = (where: string, ...ts: (Localized | undefined)[]) => {
    for (const tx of ts) {
      const miss = missingLanguages(tx, langs);
      if (miss.length) add('warn', where, `"${typeof tx === 'string' ? tx : tx?.en}" has no ${miss.join(', ')} (the plugin speaks ${langs.join(', ')})`);
    }
  };
  texts('plugin', def.name, def.description);
  const ids = new Set<string>();
  const part = (kind: string, x: { id: string; name: Localized; description?: Localized | undefined }) => {
    const where = `${def.id}/${x.id}`;
    if (!PART_ID.test(x.id ?? '')) add('error', where, `${kind} id ${JSON.stringify(x.id)}`);
    if (ids.has(`${kind}:${x.id}`)) add('error', where, `two ${kind}s with the id "${x.id}"`);
    ids.add(`${kind}:${x.id}`);
    texts(where, x.name, x.description);
    if (!x.description) add('warn', where, 'a description, for the library and the store');
    return where;
  };
  // Option labels, help and choice labels: what the editor shows next to every option.
  const optionTexts = (where: string, f: Field | undefined) => {
    for (const [path, x] of fieldsOf(f)) {
      const o = x as { label?: Localized; help?: Localized; labels?: Record<string, Localized | undefined> };
      // A plain string is a name that is the same in every language (Ollama, NVIDIA): fine here.
      texts(`${where} options.${path}`, ...[o.label, o.help, ...Object.values(o.labels ?? {})].filter((x) => typeof x !== 'string'));
    }
  };
  for (const w of def.widgets ?? []) optionTexts(`${def.id}/${w.id}`, w.options);
  for (const s of def.sources ?? []) optionTexts(`${def.id}/${s.id}`, s.options);
  for (const i of def.interludes ?? []) optionTexts(`${def.id}/${i.id}`, i.options);
  for (const w of def.widgets ?? []) {
    const where = part('widget', w as WidgetDefinition<any, any>);
    out.push(...lintOptions(where, w.options, 'widget'));
    if (!w.demo) add('warn', where, 'no `demo`: the gallery, the editor and the store show it empty');
    if (!w.icon) add('warn', where, 'an icon (a Lucide name)');
    const min = w.size?.min, pref = w.size?.preferred;
    if (min && pref && (min.w > pref.w || min.h > pref.h)) add('error', where, `size.min ${min.w}×${min.h} is bigger than size.preferred ${pref.w}×${pref.h}`);
    if (!pref) add('warn', where, 'a size.preferred, what it is dropped at');
    for (const s of w.sources ?? []) {
      const [pid] = s.split('/');
      if (pid !== def.id && !(def.requires ?? []).includes(s) && !(def.optional ?? []).includes(s)) add('warn', where, `uses ${s} from another plugin: list it in \`requires\` (or \`optional\`, if it does without)`);
    }
  }
  for (const s of def.sources ?? []) {
    const where = part('source', s as SourceDefinition<any, any>);
    out.push(...lintOptions(where, s.options, 'source'));
    if (!s.read && !s.watch) add('error', where, 'a source needs `read` or `watch`');
    if (!s.demo) add('warn', where, 'no `demo`: widgets using it show nothing in the gallery');
  }
  for (const i of def.interludes ?? []) {
    const where = part('interlude', i as InterludeDefinition<any>);
    out.push(...lintOptions(where, i.options, 'interlude'));
  }
  for (const tp of def.templates ?? []) {
    const where = `${def.id}/${tp.id} template`;
    for (const tile of [...tp.wide, ...(tp.square ?? []), ...(tp.tall ?? [])]) {
      if ([tile.x, tile.y, tile.w, tile.h].some((v) => v < 0 || v > 1) || tile.x + tile.w > 1.0001 || tile.y + tile.h > 1.0001) add('error', where, 'tiles are fractions of the page (0..1) and stay inside it');
    }
  }
  return out;
}

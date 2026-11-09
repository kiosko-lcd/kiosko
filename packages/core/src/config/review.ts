/**
 * Reviewing a config written elsewhere (by hand, by an AI) before it
 * replaces the current one: which values run programs, contact hosts or read
 * paths (`x-risk` in the schema), which secrets (`x-secret`) it leaves empty,
 * and what it changes. `planImport` puts it together for `kiosko config
 * import`; an editor or an MCP server can call the same.
 *
 * Secrets are never invented nor moved: an empty or placeholder secret keeps
 * the value the current config has for the same field (matched by widget,
 * screen or interlude id, or by source type, so moving a widget doesn't lose
 * it), and only while the hosts next to it stay the same, so a token never
 * follows a changed URL to another server. Pure (no Node).
 */
import { risksOf, type PluginDefinition, type Risk } from '@kiosko/sdk';
import { validateConfig, type ConfigReport } from './check.ts';
import { diffConfigs, type DiffLine } from './diff.ts';
import { deref, formatPath, toPointer, walkWithSchema, type JsonSchema, type PathSeg } from './jsonschema.ts';
import type { Config } from './model.ts';
import { normalize } from './normalize.ts';
import { configSchema } from './schema.ts';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

/**
 * Empty, or obviously not a real value: `<token>`, `${GITLAB_TOKEN}`, `TODO`,
 * `CHANGEME`, `your-api-key`, `xxxx`, `…`.
 */
export function isPlaceholder(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v !== 'string') return false;
  const s = v.trim();
  return !s || /<[^<>\n]*>/.test(s) || /\$\{[^}]*\}/.test(s) || /…/.test(s) || /\b(TODO|TBD|FIXME|CHANGEME|CHANGE_ME|REPLACE_ME)\b/.test(s) || /\byour[-_ ]?(api[-_ ]?)?(token|key|secret|password|url)\b/i.test(s) || /^(x{4,}|\*{3,}|\.{3})$/i.test(s);
}

/**
 * Names the same field in two versions of a config even when lists were
 * reordered: from the nearest list item with an id,
 * `widgets#w-12<core/image>.options.src`, `screens#main.device.url`,
 * `sources["llm/servers"].endpoints[0].token`.
 */
export function stableKey(root: unknown, path: readonly PathSeg[]): string {
  let key = '';
  let cur: unknown = root;
  path.forEach((seg, i) => {
    cur = Array.isArray(cur) ? cur[seg as number] : isObj(cur) ? cur[seg as string] : undefined;
    if (typeof seg === 'number' && isObj(cur) && typeof cur.id === 'string') key = `${String(path[i - 1])}#${cur.id}${typeof cur.type === 'string' ? `<${cur.type}>` : ''}`;
    else key += typeof seg === 'number' ? `[${seg}]` : /^[A-Za-z_$][\w$]*$/.test(seg) ? `.${seg}` : `[${JSON.stringify(seg)}]`;
  });
  return key;
}

function getAt(root: unknown, path: readonly PathSeg[]): unknown {
  let cur = root;
  for (const seg of path) cur = Array.isArray(cur) ? cur[seg as number] : isObj(cur) ? cur[seg as string] : undefined;
  return cur;
}

function setAt(root: unknown, path: readonly PathSeg[], value: unknown): void {
  const parent = getAt(root, path.slice(0, -1));
  const last = path[path.length - 1]!;
  if (Array.isArray(parent)) parent[last as number] = value;
  else if (isObj(parent)) parent[last as string] = value;
}

export interface Annotated {
  path: PathSeg[];
  value: unknown;
  key: string;
  risks: Risk[];
  secret: boolean;
  /** The field's title in the schema (`Access token`). */
  title?: string;
  /** Widget, source or interlude type it belongs to. */
  context?: string;
  default?: unknown;
  /** Schema of the object that holds the value (to look at its neighbours). */
  holder?: Obj;
}

/** Every value present in `config` whose schema carries `x-risk` or `x-secret`, list items one by one. */
export function annotatedValues(config: unknown, schema: JsonSchema): Annotated[] {
  const out = new Map<string, Annotated>();
  walkWithSchema(schema, config, (v) => {
    const risks = risksOf(v.schema as { 'x-risk'?: unknown });
    const secret = v.schema['x-secret'] === true;
    if (!risks.length && !secret) return;
    const add = (path: PathSeg[], value: unknown) => {
      if (isObj(value) || Array.isArray(value)) return;
      const ptr = toPointer(path);
      const prev = out.get(ptr);
      out.set(ptr, {
        path,
        value,
        key: stableKey(config, path),
        risks: [...new Set([...(prev?.risks ?? []), ...risks])],
        secret: secret || !!prev?.secret,
        ...(typeof v.schema.title === 'string' ? { title: v.schema.title } : prev?.title ? { title: prev.title } : {}),
        ...(v.context ? { context: v.context } : {}),
        ...('default' in v.schema ? { default: v.schema.default } : {}),
        ...(v.parent && isObj(v.parent.value) ? { holder: v.parent.schema } : prev?.holder ? { holder: prev.holder } : {}),
      });
    };
    // Annotated list (rather than its items): each item counts.
    if (Array.isArray(v.value)) v.value.forEach((x, i) => add([...v.path, i], x));
    else add(v.path, v.value);
  });
  return [...out.values()];
}

/* ---------- Risks ---------- */

export interface RiskItem {
  risk: Risk;
  path: string;
  pointer: string;
  value: string;
  /** What to print: secrets show only their host. */
  shown: string;
  secret: boolean;
  /** Not in the current config (for the same kind of risk). */
  isNew: boolean;
  /** Same as the field's default. */
  isDefault: boolean;
  title?: string;
  context?: string;
}

const URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

/** Which of a field's risks a value is: a URL counts as `network`, anything else as the next risk. */
export function riskOf(risks: readonly Risk[], value: string): Risk {
  if (risks.length === 1) return risks[0]!;
  if (risks.includes('exec')) return 'exec';
  if (risks.includes('network') && URL_RE.test(value) && !/^file:/i.test(value)) return 'network';
  return risks.find((r) => r !== 'network') ?? risks[0]!;
}

/** A secret, without the secret: the scheme and host of a URL, else nothing. */
export function redact(value: string): string {
  try {
    if (URL_RE.test(value)) {
      const u = new URL(value);
      return `${u.protocol}//${u.host}/… (secret, rest hidden)`;
    }
  } catch {
    /* not a URL after all */
  }
  return '(secret, hidden)';
}

/**
 * The risky values present in `config` (empty values and placeholders are
 * not risky), each marked new when `before` doesn't have the same value for
 * the same kind of risk.
 */
export function listRisks(config: unknown, schema: JsonSchema, before?: unknown): RiskItem[] {
  const items = (cfg: unknown) =>
    annotatedValues(cfg, schema)
      .filter((a) => a.risks.length && typeof a.value === 'string' && !isPlaceholder(a.value))
      .map((a) => ({ a, value: a.value as string, risk: riskOf(a.risks, a.value as string) }));
  const known = new Set(before === undefined ? [] : items(before).map((x) => `${x.risk}\0${x.value.trim()}`));
  return items(config).map(({ a, value, risk }) => ({
    risk,
    path: formatPath(a.path),
    pointer: toPointer(a.path),
    value,
    shown: a.secret ? redact(value) : value,
    secret: a.secret,
    isNew: !known.has(`${risk}\0${value.trim()}`),
    isDefault: a.default === value,
    ...(a.title ? { title: a.title } : {}),
    ...(a.context ? { context: a.context } : {}),
  }));
}

/* ---------- Secrets ---------- */

export interface SecretItem {
  path: string;
  pointer: string;
  title?: string;
  context?: string;
  /** Why it wasn't kept, or where it came from. */
  note?: string;
}

export interface SecretMerge {
  /** The incoming config with secrets restored from the current one, or emptied. */
  config: unknown;
  /** Left empty or as a placeholder in the file; the current value is kept. */
  kept: SecretItem[];
  /** No value to keep: to be filled in the editor (emptied in the result). */
  toFill: SecretItem[];
  /** The file itself carries a value for these secrets. */
  provided: SecretItem[];
}

/** Every object and list of `root` by its stable key. */
function containers(root: unknown): Map<string, PathSeg[]> {
  const out = new Map<string, PathSeg[]>();
  const go = (v: unknown, path: PathSeg[]) => {
    if (!isObj(v) && !Array.isArray(v)) return;
    out.set(stableKey(root, path), path);
    if (Array.isArray(v)) v.forEach((x, i) => go(x, [...path, i]));
    else for (const [k, x] of Object.entries(v)) go(x, [...path, k]);
  };
  go(root, []);
  return out;
}

const item = (a: Annotated, note?: string): SecretItem => ({ path: formatPath(a.path), pointer: toPointer(a.path), ...(a.title ? { title: a.title } : {}), ...(a.context ? { context: a.context } : {}), ...(note ? { note } : {}) });

/** Names that hold where a secret goes, for plugins that don't mark their hosts with `risk: 'network'`. */
const HOSTISH = /^(host(name)?|server|ur[il]|endpoint|address|base_?url)$|(url|host|endpoint)$/i;

/**
 * The neighbours of a secret that say where it is sent (marked `network`, or
 * named like a host or URL) and differ between `merged` and `current`, as a
 * sentence; null if none.
 */
function hostMoved(schema: JsonSchema, merged: unknown, mergedPath: PathSeg[], current: unknown, currentPath: PathSeg[], holder: Obj | undefined): string | null {
  if (!holder || !isObj(holder.properties)) return null;
  const a = getAt(merged, mergedPath.slice(0, -1));
  const b = getAt(current, currentPath.slice(0, -1));
  if (!isObj(a) || !isObj(b)) return null;
  const own = mergedPath[mergedPath.length - 1];
  for (const [k, sub] of Object.entries(holder.properties)) {
    if (k === own) continue;
    const s = deref(schema, sub as JsonSchema);
    if (typeof s !== 'object' || !(risksOf(s as { 'x-risk'?: unknown }).includes('network') || (HOSTISH.test(k) && s.type === 'string'))) continue;
    const was = String(b[k] ?? '').trim();
    const now = String(a[k] ?? '').trim();
    if (was !== now) {
      const show = (v: string) => (v ? (s['x-secret'] === true ? redact(v) : JSON.stringify(v)) : 'empty');
      return `its ${k} changed (${show(was)} → ${show(now)}), so the current value is not sent there`;
    }
  }
  return null;
}

/**
 * Restores the secrets the incoming config leaves empty, as placeholders, or
 * out altogether, from `current`; empties placeholders that have nothing to
 * restore. See the module comment for the rules.
 */
export function mergeSecrets(incoming: unknown, current: unknown, schema: JsonSchema): SecretMerge {
  const out = clone(incoming);
  const real = (a: Annotated) => a.secret && typeof a.value === 'string' && !isPlaceholder(a.value);
  const cur = annotatedValues(current, schema).filter(real);
  const curByKey = new Map(cur.map((a) => [a.key, a]));
  const curContainers = containers(current);
  const kept: { a: Annotated; from: Annotated }[] = [];
  const toFill: SecretItem[] = [];
  const provided: SecretItem[] = [];
  const done = new Set<string>();

  const inc = annotatedValues(out, schema).filter((a) => a.secret);
  // A list of secrets (calendar addresses) given only as placeholders: keep the whole current list.
  const lists = new Map<string, Annotated[]>();
  for (const a of inc) if (typeof a.path[a.path.length - 1] === 'number') lists.set(toPointer(a.path.slice(0, -1)), [...(lists.get(toPointer(a.path.slice(0, -1))) ?? []), a]);
  for (const items of lists.values()) {
    if (!items.every((a) => isPlaceholder(a.value))) continue;
    const listPath = items[0]!.path.slice(0, -1);
    const curPath = curContainers.get(stableKey(out, listPath));
    const curList = curPath ? getAt(current, curPath) : undefined;
    const curItems = Array.isArray(curList) ? cur.filter((c) => toPointer(c.path.slice(0, -1)) === toPointer(curPath!)) : [];
    if (curItems.length) {
      setAt(out, listPath, clone(curList));
      for (const c of curItems) kept.push({ a: { ...c, path: [...listPath, c.path[c.path.length - 1]!] }, from: c });
    } else {
      setAt(out, listPath, []);
      toFill.push(item({ ...items[0]!, path: listPath }));
    }
    for (const a of items) done.add(toPointer(a.path));
  }

  for (const a of inc) {
    if (done.has(toPointer(a.path))) continue;
    done.add(toPointer(a.path));
    if (!isPlaceholder(a.value)) {
      provided.push(item(a));
      continue;
    }
    const from = curByKey.get(a.key);
    if (from) {
      setAt(out, a.path, from.value);
      kept.push({ a, from });
    } else {
      setAt(out, a.path, '');
      toFill.push(item(a));
    }
  }

  // Secrets the file leaves out of an object it keeps (a source given
  // without its token, or without its list of calendar addresses).
  const incContainers = containers(out);
  const incKeys = new Set(annotatedValues(out, schema).map((a) => a.key));
  const restored = new Set<string>();
  for (const c of cur) {
    if (incKeys.has(c.key)) continue;
    const parentPath = c.path.slice(0, -1);
    const parentKey = stableKey(current, parentPath);
    const last = c.path[c.path.length - 1]!;
    if (typeof last === 'string') {
      const there = incContainers.get(parentKey);
      if (!there || !isObj(getAt(out, there))) continue;
      setAt(out, [...there, last], c.value);
      kept.push({ a: { ...c, path: [...there, last] }, from: c });
      continue;
    }
    if (!restored.has(parentKey)) {
      // A list the file has is the file's: it is not extended.
      if (incContainers.has(parentKey)) continue;
      const holder = incContainers.get(stableKey(current, parentPath.slice(0, -1)));
      const name = parentPath[parentPath.length - 1];
      if (!holder || !isObj(getAt(out, holder)) || typeof name !== 'string') continue;
      setAt(out, [...holder, name], clone(getAt(current, parentPath)));
      incContainers.set(parentKey, [...holder, name]);
      restored.add(parentKey);
    }
    kept.push({ a: { ...c, path: [...incContainers.get(parentKey)!, last] }, from: c });
  }

  // A kept secret only goes back to the host it was for. Emptying one may
  // move another (a secret URL next to its token), hence the loop.
  const reverted = new Set<number>();
  for (let changed = true; changed; ) {
    changed = false;
    kept.forEach((k, i) => {
      if (reverted.has(i)) return;
      const why = hostMoved(schema, out, k.a.path, current, k.from.path, k.from.holder);
      if (!why) return;
      setAt(out, k.a.path, '');
      reverted.add(i);
      toFill.push(item(k.a, why));
      changed = true;
    });
  }
  return { config: out, kept: kept.filter((_, i) => !reverted.has(i)).map((k) => item(k.a)), toFill, provided };
}

/* ---------- Import plan ---------- */

export interface ImportPlan {
  /** Validation of the incoming file as written. */
  report: ConfigReport;
  /** What would be written: normalized, secrets restored, left-out settings carried over. */
  config: Config;
  /** Settings and sources the file leaves out, kept from the current config. */
  carried: string[];
  diff: DiffLine[];
  risks: RiskItem[];
  secrets: Omit<SecretMerge, 'config'>;
}

const CARRIED = ['locale', 'theme', 'location', 'workday', 'plugins', 'server'] as const;

/**
 * Everything `kiosko config import` shows before applying `incoming` over
 * `current`. Settings and sources the file leaves out are kept (a config
 * written for the layout shouldn't reset the location, the port or a
 * calendar), and secrets go through `mergeSecrets`.
 */
export function planImport(incoming: unknown, current: Config, plugins: readonly PluginDefinition[], schema: JsonSchema = configSchema(plugins)): ImportPlan {
  const report = validateConfig(incoming, plugins, schema);
  const { config: merged, ...secrets } = mergeSecrets(incoming, current, schema);
  const raw: Obj = isObj(merged) ? { ...merged } : {};
  const carried: string[] = [];
  for (const k of CARRIED) {
    if (raw[k] === undefined && current[k] !== undefined) {
      raw[k] = clone(current[k]);
      carried.push(k);
    }
  }
  if (raw.$schema === undefined && current.$schema) raw.$schema = current.$schema;
  const sources: Obj = isObj(raw.sources) ? { ...raw.sources } : {};
  for (const [k, v] of Object.entries(current.sources)) {
    if (sources[k] === undefined) {
      sources[k] = clone(v);
      carried.push(`sources[${JSON.stringify(k)}]`);
    }
  }
  raw.sources = sources;
  const config = normalize(raw);
  return { report, config, carried, diff: diffConfigs(current, config), risks: listRisks(config, schema, current), secrets };
}

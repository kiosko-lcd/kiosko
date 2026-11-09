/**
 * A small JSON Schema (draft 2020-12) checker for the subset Kiosko's own
 * schemas use, with messages written for people, and for pasting back to the
 * AI that wrote a config: a JSON path, what was expected, what was found and,
 * for typos, the closest valid name.
 *
 * Supported: local `$ref`, `type`, `const`, `enum`, `properties`, `required`,
 * `additionalProperties`, `propertyNames`, `items`, `minItems`, `maxItems`,
 * `uniqueItems`, `minimum`, `maximum`, `minLength`, `maxLength`, `pattern`,
 * `format: date`, `allOf`, `anyOf`, `oneOf` and `not`. A `oneOf` whose
 * branches all pin the same property with `const` (widgets by `type`, devices
 * by `driver`) is a tagged union: only the branch named by the value is
 * checked, so errors talk about that widget and not about all seventy.
 *
 * Pure (no Node): the editor, the CLI and an MCP server can share it.
 */

export type JsonSchema = { [k: string]: unknown } | boolean;
type Obj = { [k: string]: unknown };
export type PathSeg = string | number;

export interface JsonIssue {
  /** `screens[0].pages[1].tiles[2]` */
  path: string;
  /** RFC 6901, `/screens/0/pages/1/tiles/2`. */
  pointer: string;
  message: string;
  /** What the value belongs to: `core/clock` for a widget's options, `trcc` for a device. */
  context?: string;
}

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

/** `screens[0].sources["weather/current"].name`, or `(root)`. */
export function formatPath(segs: readonly PathSeg[]): string {
  if (!segs.length) return '(root)';
  let out = '';
  for (const s of segs) {
    if (typeof s === 'number') out += `[${s}]`;
    else if (/^[A-Za-z_$][\w$]*$/.test(s)) out += out ? `.${s}` : s;
    else out += `[${JSON.stringify(s)}]`;
  }
  return out;
}

export function toPointer(segs: readonly PathSeg[]): string {
  return segs.map((s) => `/${String(s).replace(/~/g, '~0').replace(/\//g, '~1')}`).join('');
}

function resolvePointer(root: JsonSchema, ref: string): JsonSchema {
  if (!ref.startsWith('#')) throw new Error(`only local $ref are supported (${ref})`);
  let cur: unknown = root;
  for (const raw of ref.slice(1).split('/').slice(1)) {
    const key = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~');
    cur = Array.isArray(cur) ? cur[Number(key)] : isObj(cur) ? cur[key] : undefined;
  }
  if (cur === undefined) throw new Error(`$ref ${ref} points nowhere`);
  return cur as JsonSchema;
}

/** Follows `$ref`s; keywords next to a `$ref` (a description) are kept. */
export function deref(root: JsonSchema, s: JsonSchema): JsonSchema {
  let cur = s;
  for (let n = 0; isObj(cur) && typeof cur.$ref === 'string' && n < 32; n++) {
    const { $ref, ...rest } = cur;
    const target = resolvePointer(root, $ref as string);
    cur = Object.keys(rest).length && isObj(target) ? { ...target, ...rest } : target;
  }
  return cur;
}

const tags = new WeakMap<object, string | null>();
/** The property every branch of a union pins with `const` (`type`, `driver`), if any. */
export function tagOf(root: JsonSchema, branches: readonly JsonSchema[]): string | null {
  if (tags.has(branches)) return tags.get(branches)!;
  const props = branches.map((b) => {
    const d = deref(root, b);
    return isObj(d) && isObj(d.properties) ? d.properties : null;
  });
  let tag: string | null = null;
  const first = props[0];
  if (first && props.every(Boolean)) {
    for (const k of Object.keys(first)) {
      if (props.every((p) => isObj(p![k]) && (p![k] as Obj).const !== undefined)) {
        tag = k;
        break;
      }
    }
  }
  tags.set(branches, tag);
  return tag;
}

/** The branch of a tagged union that `value` names, or why there is none. */
export function pickBranch(root: JsonSchema, branches: readonly JsonSchema[], tag: string, value: unknown): { branch: Obj } | { missing: true } | { unknown: unknown; known: unknown[] } {
  if (!isObj(value) || value[tag] === undefined) return { missing: true };
  const known: unknown[] = [];
  for (const b of branches) {
    const d = deref(root, b) as Obj;
    const c = ((d.properties as Obj)[tag] as Obj).const;
    if (c === value[tag]) return { branch: d };
    known.push(c);
  }
  return { unknown: value[tag], known };
}

/* ---------- Messages ---------- */

const TYPE_NOUN: Record<string, string> = {
  string: 'text (a JSON string)',
  number: 'a number',
  integer: 'a whole number',
  boolean: 'true or false',
  object: 'an object',
  array: 'a list (JSON array)',
  null: 'null',
};

function describe(v: unknown): string {
  if (typeof v === 'string') return `the text ${JSON.stringify(v.length > 60 ? `${v.slice(0, 57)}...` : v)}`;
  if (typeof v === 'number') return `the number ${v}`;
  if (typeof v === 'boolean' || v === null) return String(v);
  if (Array.isArray(v)) return 'a list';
  return 'an object';
}

const q = (v: unknown) => JSON.stringify(v);

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n]!;
}

/** The closest names to a typo, best first (at most three). */
export function closest(word: string, candidates: readonly string[]): string[] {
  const w = word.toLowerCase();
  return candidates
    .map((c) => ({ c, d: c.toLowerCase() === w ? 0 : levenshtein(w, c.toLowerCase()) }))
    .filter((x) => x.d <= Math.max(1, Math.floor(Math.max(word.length, x.c.length) / 3)))
    .sort((a, b) => a.d - b.d)
    .slice(0, 3)
    .map((x) => x.c);
}

function didYouMean(word: string, candidates: readonly string[]): string {
  const near = closest(word, candidates);
  return near.length ? ` (did you mean ${near.map(q).join(' or ')}?)` : '';
}

function listOf(values: readonly unknown[], max = 12): string {
  const shown = values.slice(0, max).map(q).join(', ');
  return values.length > max ? `${shown}… (${values.length - max} more)` : shown;
}

/** Why a tag value is unknown, with the near misses: `core/clok` → `core/clock`; `fooo/x` → the plugins there are. */
function unknownTag(tag: string, value: unknown, known: unknown[]): string {
  const names = known.map(String);
  if (typeof value !== 'string') return `${q(tag)} must be one of ${listOf(names)}; got ${describe(value)}`;
  const near = closest(value, names);
  if (near.length) return `unknown ${tag} ${q(value)} (did you mean ${near.map(q).join(' or ')}?)`;
  if (names.every((n) => n.includes('/')) && value.includes('/')) {
    const [prefix] = value.split('/');
    const same = names.filter((n) => n.startsWith(`${prefix}/`));
    if (same.length) return `unknown ${tag} ${q(value)}; ${prefix} has ${listOf(same, 30)}`;
    const plugins = [...new Set(names.map((n) => n.split('/')[0]!))];
    return `unknown ${tag} ${q(value)}: no installed plugin is called ${q(prefix)}${didYouMean(prefix!, plugins)}. Installed: ${plugins.join(', ')}`;
  }
  return `unknown ${tag} ${q(value)}; expected one of ${listOf(names)}`;
}

function typeOk(t: string, v: unknown): boolean {
  switch (t) {
    case 'string':
      return typeof v === 'string';
    case 'number':
      return typeof v === 'number' && Number.isFinite(v);
    case 'integer':
      return typeof v === 'number' && Number.isInteger(v);
    case 'boolean':
      return typeof v === 'boolean';
    case 'object':
      return isObj(v);
    case 'array':
      return Array.isArray(v);
    case 'null':
      return v === null;
    default:
      return true;
  }
}

function equal(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

function validDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

/* ---------- Validation ---------- */

interface Run {
  root: JsonSchema;
  issues: JsonIssue[];
}

function push(run: Run, path: PathSeg[], message: string, context?: string): void {
  run.issues.push({ path: formatPath(path), pointer: toPointer(path), message, ...(context ? { context } : {}) });
}

function trial(run: Run, schema: JsonSchema, value: unknown, path: PathSeg[], context?: string): JsonIssue[] {
  const sub: Run = { root: run.root, issues: [] };
  check(sub, schema, value, path, context);
  return sub.issues;
}

function check(run: Run, schema: JsonSchema, value: unknown, path: PathSeg[], context?: string): void {
  if (schema === true) return;
  if (schema === false) return push(run, path, 'is not allowed here', context);
  const s = deref(run.root, schema) as Obj;
  if (s === undefined || typeof s !== 'object') return;

  if (Array.isArray(s.allOf)) for (const sub of s.allOf as JsonSchema[]) check(run, sub, value, path, context);

  for (const key of ['oneOf', 'anyOf'] as const) {
    const branches = s[key] as JsonSchema[] | undefined;
    if (!Array.isArray(branches)) continue;
    const tag = branches.length ? tagOf(run.root, branches) : null;
    if (tag) {
      if (!isObj(value)) return push(run, path, `must be an object; got ${describe(value)}`, context);
      const pick = pickBranch(run.root, branches, tag, value);
      if ('missing' in pick) return push(run, [...path, tag], `is required: one of ${listOf(branches.map((b) => ((deref(run.root, b) as Obj).properties as Obj)[tag] as Obj).map((p) => p.const))}`, context);
      if ('unknown' in pick) return push(run, [...path, tag], unknownTag(tag, pick.unknown, pick.known), context);
      check(run, pick.branch, value, path, typeof value[tag] === 'string' ? (value[tag] as string) : context);
      continue;
    }
    const results = branches.map((b) => trial(run, b, value, path, context));
    const valid = results.filter((r) => !r.length).length;
    if (valid === 0) {
      const best = results.reduce((a, b) => (b.length < a.length ? b : a), results[0] ?? []);
      if (best.length) run.issues.push(...best);
      else push(run, path, 'matches none of the allowed forms', context);
    } else if (key === 'oneOf' && valid > 1) push(run, path, 'matches more than one of the allowed forms', context);
  }

  if (s.not !== undefined && !trial(run, s.not as JsonSchema, value, path).length) push(run, path, typeof s.description === 'string' ? `is not allowed here: ${s.description}` : 'is not allowed here', context);

  if (s.const !== undefined && !equal(value, s.const)) return push(run, path, `must be ${q(s.const)}; got ${describe(value)}`, context);
  if (Array.isArray(s.enum) && !s.enum.some((e) => equal(e, value))) {
    const hint = typeof value === 'string' ? didYouMean(value, s.enum.filter((e): e is string => typeof e === 'string')) : '';
    return push(run, path, `must be one of ${listOf(s.enum, 20)}; got ${describe(value)}${hint}`, context);
  }

  const types = typeof s.type === 'string' ? [s.type] : Array.isArray(s.type) ? (s.type as string[]) : null;
  if (types && !types.some((t) => typeOk(t, value))) {
    return push(run, path, `must be ${types.map((t) => TYPE_NOUN[t] ?? t).join(' or ')}; got ${describe(value)}`, context);
  }

  if (typeof value === 'number') {
    if (typeof s.minimum === 'number' && value < s.minimum) push(run, path, `must be at least ${s.minimum}; got ${value}`, context);
    if (typeof s.maximum === 'number' && value > s.maximum) push(run, path, `must be at most ${s.maximum}; got ${value}`, context);
  }

  if (typeof value === 'string') {
    if (typeof s.minLength === 'number' && value.length < s.minLength) push(run, path, s.minLength === 1 ? 'must not be empty' : `must be at least ${s.minLength} characters long`, context);
    if (typeof s.maxLength === 'number' && value.length > s.maxLength) push(run, path, `must be at most ${s.maxLength} characters long; got ${value.length}`, context);
    if (typeof s.pattern === 'string' && !new RegExp(s.pattern, 'u').test(value)) {
      const hint = typeof s['x-pattern-hint'] === 'string' ? s['x-pattern-hint'] : `text matching /${s.pattern}/`;
      push(run, path, `must be ${hint}; got ${describe(value)}`, context);
    }
    if (s.format === 'date' && !validDate(value)) push(run, path, `must be a date as YYYY-MM-DD; got ${describe(value)}`, context);
  }

  if (Array.isArray(value)) {
    if (typeof s.minItems === 'number' && value.length < s.minItems) push(run, path, `must have at least ${s.minItems} item${s.minItems === 1 ? '' : 's'}; has ${value.length}`, context);
    if (typeof s.maxItems === 'number' && value.length > s.maxItems) push(run, path, `must have at most ${s.maxItems} items; has ${value.length}`, context);
    if (s.uniqueItems === true) {
      const seen = new Set<string>();
      value.forEach((v, i) => {
        const k = JSON.stringify(v);
        if (seen.has(k)) push(run, [...path, i], `repeats ${describe(v)}; items must be unique`, context);
        seen.add(k);
      });
    }
    if (s.items !== undefined) value.forEach((v, i) => check(run, s.items as JsonSchema, v, [...path, i], context));
  }

  if (isObj(value)) {
    const props = isObj(s.properties) ? s.properties : {};
    if (Array.isArray(s.required)) for (const k of s.required as string[]) if (value[k] === undefined) push(run, [...path, k], 'is required but missing', context);
    const names = isObj(s.propertyNames) ? s.propertyNames : null;
    for (const [k, v] of Object.entries(value)) {
      if (names && typeof names.pattern === 'string' && !new RegExp(names.pattern, 'u').test(k)) {
        push(run, [...path, k], `is not a valid name here: must be ${typeof names['x-pattern-hint'] === 'string' ? names['x-pattern-hint'] : `text matching /${names.pattern}/`}`, context);
        continue;
      }
      if (props[k] !== undefined) check(run, props[k] as JsonSchema, v, [...path, k], context);
      else if (s.additionalProperties === false) {
        const known = Object.keys(props);
        push(run, [...path, k], `is not a known property here${didYouMean(k, known)}. Allowed: ${known.join(', ') || 'none'}`, context);
      } else if (s.additionalProperties !== undefined && s.additionalProperties !== true) check(run, s.additionalProperties as JsonSchema, v, [...path, k], context);
    }
  }
}

/** Every problem of `value` against `schema` (its own root for `$ref`s). Never throws on bad data. */
export function validateJson(schema: JsonSchema, value: unknown): JsonIssue[] {
  const run: Run = { root: schema, issues: [] };
  check(run, schema, value, []);
  // A value can fail the same way through two routes (allOf + a $ref): say it once.
  const seen = new Set<string>();
  return run.issues.filter((i) => {
    const k = `${i.pointer}\0${i.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/* ---------- Walking a value with its schema ---------- */

export interface SchemaVisit {
  path: PathSeg[];
  value: unknown;
  /** The node's schema, `$ref`s followed. */
  schema: Obj;
  /** The object or list that holds the value, with its schema. */
  parent?: { value: unknown; schema: Obj; path: PathSeg[] };
  /** Tag of the nearest union branch on the way: the widget type, the device driver… */
  context?: string;
}

/**
 * Visits every value of `value` together with the schema node that describes
 * it (tagged unions resolved by their tag). Values the schema doesn't
 * describe are skipped. For finding annotated values: `x-risk`, `x-secret`.
 */
export function walkWithSchema(root: JsonSchema, value: unknown, visit: (v: SchemaVisit) => void): void {
  const go = (schema: JsonSchema, v: unknown, path: PathSeg[], parent: SchemaVisit['parent'], context: string | undefined): void => {
    if (typeof schema !== 'object') return;
    const s = deref(root, schema) as Obj;
    if (!isObj(s)) return;
    visit({ path, value: v, schema: s, ...(parent ? { parent } : {}), ...(context ? { context } : {}) });
    if (Array.isArray(s.allOf)) for (const sub of s.allOf as JsonSchema[]) go(sub, v, path, parent, context);
    for (const key of ['oneOf', 'anyOf'] as const) {
      const branches = s[key] as JsonSchema[] | undefined;
      if (!Array.isArray(branches) || !branches.length) continue;
      const tag = tagOf(root, branches);
      if (!tag) continue;
      const pick = pickBranch(root, branches, tag, v);
      if ('branch' in pick) go(pick.branch, v, path, parent, typeof (v as Obj)[tag] === 'string' ? ((v as Obj)[tag] as string) : context);
    }
    if (Array.isArray(v) && s.items !== undefined) v.forEach((x, i) => go(s.items as JsonSchema, x, [...path, i], { value: v, schema: s, path }, context));
    if (isObj(v)) {
      const props = isObj(s.properties) ? s.properties : {};
      for (const [k, x] of Object.entries(v)) {
        const sub = props[k] ?? (isObj(s.additionalProperties) ? s.additionalProperties : undefined);
        if (sub !== undefined) go(sub as JsonSchema, x, [...path, k], { value: v, schema: s, path }, context);
      }
    }
  };
  go(root, value, [], undefined, undefined);
}

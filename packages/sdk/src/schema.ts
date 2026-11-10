/**
 * A tiny, typed schema builder for plugin options.
 *
 * One declaration gives three things at once:
 *   - the TypeScript type of the options (`Infer<typeof schema>`),
 *   - the defaults and the validation the runtime applies to user config,
 *   - the form the editor renders (labels, hints, sliders, colour pickers…).
 *
 * `toJsonSchema` exports a standard JSON Schema (draft 2020-12) with `x-ui`
 * hints, so tools that don't speak TypeScript can still validate a config.
 */
import { localize, type Localized } from './i18n.ts';

/**
 * What a value of a field lets Kiosko do as the user, so a config written by
 * someone else (or by an AI) can be reviewed before it runs:
 *
 *   - `exec`: runs a program or loads code (a command, an ssh host, a module);
 *   - `network`: contacts a host (a URL, an API host, a feed);
 *   - `path`: reads (or writes) a local file or folder.
 *
 * A list when it depends on the value, e.g. `['network', 'path']` for "a URL
 * or a file": a value that looks like a URL counts as `network`, any other as
 * the next one. Only free values need it; a switch that turns on a fixed tool
 * (read git status) doesn't.
 */
export type Risk = 'exec' | 'network' | 'path';

interface Common<T> {
  /** Shown above the input in the editor. */
  label?: Localized;
  /** One line under the input. */
  help?: Localized;
  default: T;
  /** Hide in the editor unless "advanced" is toggled. */
  advanced?: boolean;
  /** See `Risk`. Exported as `x-risk`; `kiosko config import` lists these values before applying a config. */
  risk?: Risk | readonly Risk[];
}

export interface StringField extends Common<string> {
  kind: 'string';
  placeholder?: string;
  multiline?: boolean;
  /** Tokens, URLs with credentials…: masked in the editor and never logged. */
  secret?: boolean;
  /** Free text with a format hint: `url`, `path`, `time` (HH:MM), `date` (YYYY-MM-DD). */
  format?: 'url' | 'path' | 'time' | 'date' | 'datetime';
  maxLength?: number;
}
export interface NumberField extends Common<number> {
  kind: 'number';
  integer?: boolean;
  min?: number;
  max?: number;
  step?: number;
  /** Shown after the value: `ms`, `px`, `°C`, `%`… */
  unit?: string;
  /** Render as a slider when min and max are known. */
  slider?: boolean;
}
export interface BooleanField extends Common<boolean> {
  kind: 'boolean';
}
export interface EnumField<V extends string = string> extends Common<V> {
  kind: 'enum';
  values: readonly V[];
  /** Label per value; the raw value otherwise. */
  labels?: Partial<Record<V, Localized>>;
}
export interface ColorField extends Common<string> {
  kind: 'color';
}
export interface ListField<I extends Field = Field> extends Common<Infer<I>[]> {
  kind: 'list';
  item: I;
  max?: number;
  /** Patterns for `matchFilter` (see `t.filter`): the editor edits them as one line, comma-separated. */
  filter?: boolean;
}
export interface ObjectField<P extends Record<string, Field> = Record<string, Field>> extends Common<{ [K in keyof P]: Infer<P[K]> }> {
  kind: 'object';
  props: P;
}
/** A string → string map (aliases, renames…). */
export interface MapField extends Common<Record<string, string>> {
  kind: 'map';
  keyLabel?: Localized;
  valueLabel?: Localized;
}

export type Field = StringField | NumberField | BooleanField | EnumField<string> | ColorField | ListField<any> | ObjectField<any> | MapField;

/** The TypeScript type a field validates to. */
export type Infer<F> = F extends ObjectField<infer P>
  ? { [K in keyof P]: Infer<P[K]> }
  : F extends ListField<infer I>
    ? Infer<I>[]
    : F extends EnumField<infer V>
      ? V
      : F extends Common<infer T>
        ? T
        : never;

type Opts<F extends { kind: string; default: unknown }, X extends string = never> = Omit<F, 'kind' | 'default' | X> & { default?: F['default'] };

export const t = {
  string: (o: Opts<StringField> = {}): StringField => ({ kind: 'string', default: '', ...o }),
  number: (o: Opts<NumberField> = {}): NumberField => ({ kind: 'number', default: o.min ?? 0, ...o }),
  integer: (o: Opts<NumberField> = {}): NumberField => ({ kind: 'number', integer: true, default: o.min ?? 0, ...o }),
  boolean: (o: Opts<BooleanField> = {}): BooleanField => ({ kind: 'boolean', default: false, ...o }),
  enum: <const V extends string>(values: readonly V[], o: Opts<EnumField<V>, 'values'> = {}): EnumField<V> => ({ kind: 'enum', values, default: values[0]!, ...o }),
  color: (o: Opts<ColorField> = {}): ColorField => ({ kind: 'color', default: '#ffffff', ...o }),
  list: <I extends Field>(item: I, o: Opts<ListField<I>, 'item'> = {}): ListField<I> => ({ kind: 'list', item, default: [], ...o }),
  object: <P extends Record<string, Field>>(props: P, o: Omit<Opts<ObjectField<P>, 'props'>, 'default'> = {}): ObjectField<P> =>
    ({ kind: 'object', props, ...o, default: Object.fromEntries(Object.entries(props).map(([k, f]) => [k, clone(f.default)])) as ObjectField<P>['default'] }),
  map: (o: Opts<MapField> = {}): MapField => ({ kind: 'map', default: {}, ...o }),
  /** Duration in milliseconds, edited in seconds or minutes by the editor. */
  duration: (o: Opts<NumberField> = {}): NumberField => ({ kind: 'number', integer: true, unit: 'ms', min: 0, default: 60_000, ...o }),
  /**
   * Which items to show, as patterns for `matchFilter`: `["web", "acme/*",
   * "!*-old"]`. Empty = all. Name it after what it filters (`projects`,
   * `repos`, `calendars`, `people`) and give it a `label`; the `help`
   * explaining the patterns comes with it.
   */
  filter: (o: Opts<ListField<StringField>, 'item'> = {}): ListField<StringField> => ({
    kind: 'list',
    item: { kind: 'string', default: '', placeholder: 'name, group/*, !old-*' },
    default: [],
    filter: true,
    help: FILTER_HELP,
    ...o,
  }),
};

/** The help every `t.filter()` field carries unless it brings its own. */
export const FILTER_HELP: Localized = {
  en: 'Empty: all. Names or patterns, comma-separated: * matches anything, a leading ! leaves out (web, acme/*, !*-old).',
  es: 'Vacío: todos. Nombres o patrones separados por comas: * vale por cualquier cosa y un ! delante excluye (web, acme/*, !*-old).',
};

function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

/** The defaults of a field, deep-copied (safe to mutate). */
export function defaultsOf<F extends Field>(f: F): Infer<F> {
  return clone(f.default) as Infer<F>;
}

export interface ValidationIssue {
  /** `events.2.date` */
  path: string;
  message: string;
}

/**
 * Coerces `value` to the shape of `f`: unknown keys are kept (so a newer
 * config survives an older plugin), wrong types fall back to the default
 * and are reported. Never throws.
 */
export function validate<F extends Field>(f: F, value: unknown, path = ''): { value: Infer<F>; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  const out = coerce(f, value, path, issues);
  return { value: out as Infer<F>, issues };
}

function coerce(f: Field, v: unknown, path: string, issues: ValidationIssue[]): unknown {
  const bad = (msg: string) => {
    issues.push({ path: path || '(root)', message: msg });
    return clone(f.default);
  };
  if (v === undefined || v === null) return clone(f.default);
  switch (f.kind) {
    case 'string':
      if (typeof v === 'number') return String(v);
      if (typeof v !== 'string') return bad('expected text');
      return f.maxLength && v.length > f.maxLength ? v.slice(0, f.maxLength) : v;
    case 'color':
      if (typeof v !== 'string') return bad('expected a colour');
      return v;
    case 'number': {
      const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
      if (typeof n !== 'number' || !Number.isFinite(n)) return bad('expected a number');
      let x = f.integer ? Math.round(n) : n;
      if (f.min !== undefined && x < f.min) x = f.min;
      if (f.max !== undefined && x > f.max) x = f.max;
      return x;
    }
    case 'boolean':
      if (typeof v === 'boolean') return v;
      if (v === 'true' || v === 'false') return v === 'true';
      return bad('expected true/false');
    case 'enum':
      if (typeof v === 'string' && (f.values as readonly string[]).includes(v)) return v;
      return bad(`expected one of ${f.values.join(', ')}`);
    case 'list': {
      if (!Array.isArray(v)) return bad('expected a list');
      const items = v.map((item, i) => coerce(f.item, item, path ? `${path}.${i}` : String(i), issues));
      return f.max !== undefined ? items.slice(0, f.max) : items;
    }
    case 'map': {
      if (typeof v !== 'object' || Array.isArray(v)) return bad('expected key/value pairs');
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, x]) => typeof x === 'string' || typeof x === 'number').map(([k, x]) => [k, String(x)]));
    }
    case 'object': {
      if (typeof v !== 'object' || Array.isArray(v)) return bad('expected an object');
      const src = v as Record<string, unknown>;
      const out: Record<string, unknown> = { ...src };
      for (const [k, sub] of Object.entries(f.props as Record<string, Field>)) out[k] = coerce(sub, src[k], path ? `${path}.${k}` : k, issues);
      return out;
    }
  }
}

/** Appended to the description of secret fields in the JSON Schema. */
export const SECRET_NOTE = 'Secret: leave it empty (or a placeholder such as "<token>"). Kiosko keeps the value it already has, or asks for it in the editor.';

/**
 * Standard JSON Schema (draft 2020-12) with `x-ui` hints, for tools outside
 * TypeScript: `title`/`description` in English, `x-secret` on secrets and
 * `x-risk` (see `Risk`) on values that run programs, contact hosts or read
 * paths. URLs carry no `format` keyword: an empty value or a placeholder is
 * valid (a secret URL is filled in later), and editors would flag both.
 */
export function toJsonSchema(f: Field): Record<string, unknown> {
  const ui = { label: f.label, help: f.help, advanced: f.advanced };
  const secret = f.kind === 'string' && !!f.secret;
  const help = f.help === undefined ? undefined : localize(f.help, 'en');
  const description = secret ? [help, SECRET_NOTE].filter(Boolean).join(' ') : help;
  const base: Record<string, unknown> = {
    ...(f.label === undefined ? {} : { title: localize(f.label, 'en') }),
    ...(description ? { description } : {}),
    default: f.default,
    'x-ui': ui,
    ...(secret ? { 'x-secret': true } : {}),
    ...(f.risk === undefined ? {} : { 'x-risk': typeof f.risk === 'string' ? f.risk : [...f.risk] }),
  };
  switch (f.kind) {
    case 'string':
      return { ...base, type: 'string', ...(f.format === 'date' ? { format: 'date' } : {}), ...(f.maxLength ? { maxLength: f.maxLength } : {}), 'x-ui': { ...ui, secret: f.secret, multiline: f.multiline, placeholder: f.placeholder, format: f.format } };
    case 'color':
      return { ...base, type: 'string', 'x-ui': { ...ui, widget: 'color' } };
    case 'number':
      return { ...base, type: f.integer ? 'integer' : 'number', minimum: f.min, maximum: f.max, 'x-ui': { ...ui, unit: f.unit, step: f.step, slider: f.slider } };
    case 'boolean':
      return { ...base, type: 'boolean' };
    case 'enum':
      return { ...base, type: 'string', enum: [...f.values], 'x-ui': { ...ui, labels: f.labels } };
    case 'list':
      return { ...base, type: 'array', items: toJsonSchema(f.item), maxItems: f.max, ...(f.filter ? { 'x-ui': { ...ui, widget: 'filter' }, 'x-filter': true } : {}) };
    case 'map':
      return { ...base, type: 'object', additionalProperties: { type: 'string' } };
    case 'object':
      return { ...base, type: 'object', properties: Object.fromEntries(Object.entries(f.props as Record<string, Field>).map(([k, sub]) => [k, toJsonSchema(sub)])) };
  }
}

/** The risks of a field, as a list (empty when it has none). */
export function risksOf(f: { risk?: Risk | readonly Risk[] } | { 'x-risk'?: unknown }): Risk[] {
  const r = 'risk' in f ? f.risk : (f as { 'x-risk'?: unknown })['x-risk'];
  const list = typeof r === 'string' ? [r] : Array.isArray(r) ? r : [];
  return list.filter((x): x is Risk => x === 'exec' || x === 'network' || x === 'path');
}

/**
 * Where a value is inside a JSON document: a small subset of JSONPath, read
 * by hand (no `eval`, no regular expression run on the document):
 *
 *   $.current.temperature_2m     a key, then another
 *   data.items[0].price          `$` and the first dot are optional
 *   items[-1]                    a negative index counts from the end
 *   ['key with spaces']          a key in quotes ('…' or "…", `\` escapes)
 *   items[*].name / prices.*     every item (or every value of an object)
 *   $                            the whole document
 *
 * Only a document's own keys are read (`constructor` or `__proto__` find
 * nothing that JSON didn't put there), and a path, the number of its steps
 * and what a wildcard gathers are capped, so a path typed by anyone can't
 * make Kiosko work hard.
 */

export type PathStep = { key: string } | { index: number } | { all: true };

/** Longest path accepted, in characters. */
export const MAX_PATH_LENGTH = 300;
/** Most steps in a path. */
export const MAX_PATH_STEPS = 32;
/** Most values a path with wildcards gathers. */
export const MAX_PATH_RESULTS = 500;

export class PathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathError';
  }
}

/** What a bare key is made of: letters and digits of any script, `_`, `$`, `@` and `-`. Anything else goes in quotes. */
const NAME = /[\p{L}\p{N}_$@-]/u;

/** The steps of a path, or a `PathError` saying where it is wrong. */
export function parsePath(path: string): PathStep[] {
  const p = path.trim();
  if (p.length > MAX_PATH_LENGTH) throw new PathError(`path longer than ${MAX_PATH_LENGTH} characters`);
  const steps: PathStep[] = [];
  let i = 0;
  if (p[0] === '$') i = 1;
  const push = (s: PathStep) => {
    if (steps.length >= MAX_PATH_STEPS) throw new PathError(`path with more than ${MAX_PATH_STEPS} steps`);
    steps.push(s);
  };
  // A bare name may start the path (`data.items`), as if after a dot.
  let needDot = i === 1;
  while (i < p.length) {
    const c = p[i]!;
    if (c === '.') {
      i++;
      if (p[i] === '*') {
        push({ all: true });
        i++;
      } else {
        const start = i;
        while (i < p.length && NAME.test(p[i]!)) i++;
        if (i === start) throw new PathError(`a name is missing after the dot at ${start}`);
        push({ key: p.slice(start, i) });
      }
      needDot = true;
      continue;
    }
    if (c === '[') {
      i++;
      const q = p[i];
      if (q === "'" || q === '"') {
        let key = '';
        i++;
        for (;;) {
          if (i >= p.length) throw new PathError('a quoted key is not closed');
          const ch = p[i]!;
          if (ch === '\\' && i + 1 < p.length) {
            key += p[i + 1];
            i += 2;
            continue;
          }
          if (ch === q) break;
          key += ch;
          i++;
        }
        i++;
        push({ key });
      } else if (q === '*') {
        i++;
        push({ all: true });
      } else {
        const m = /^-?\d{1,9}/.exec(p.slice(i));
        if (!m) throw new PathError(`expected a number, '*' or a quoted key at ${i}`);
        i += m[0].length;
        push({ index: Number(m[0]) });
      }
      if (p[i] !== ']') throw new PathError(`expected ']' at ${i}`);
      i++;
      needDot = true;
      continue;
    }
    if (!needDot && NAME.test(c)) {
      const start = i;
      while (i < p.length && NAME.test(p[i]!)) i++;
      push({ key: p.slice(start, i) });
      needDot = true;
      continue;
    }
    throw new PathError(`unexpected '${c}' at ${i}`);
  }
  return steps;
}

const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

function step(v: unknown, s: PathStep, out: unknown[]): void {
  if (v === null || typeof v !== 'object') return;
  if ('all' in s) {
    for (const x of Array.isArray(v) ? v : Object.values(v)) {
      if (out.length >= MAX_PATH_RESULTS) return;
      out.push(x);
    }
    return;
  }
  if ('index' in s) {
    if (!Array.isArray(v)) return;
    const i = s.index < 0 ? v.length + s.index : s.index;
    if (i >= 0 && i < v.length) out.push(v[i]);
    return;
  }
  // An array's own keys are its indexes and `length`: `items.length` works, `items.map` doesn't.
  if (own(v, s.key)) out.push((v as Record<string, unknown>)[s.key]);
}

/**
 * What `path` finds in `doc`: `{ found: false }` when nothing; the value, for
 * a path without wildcards; the list of what it gathered, with them.
 */
export function readPath(doc: unknown, path: string | PathStep[]): { found: boolean; value: unknown } {
  const steps = typeof path === 'string' ? parsePath(path) : path;
  const many = steps.some((s) => 'all' in s);
  let cur: unknown[] = [doc];
  for (const s of steps) {
    const next: unknown[] = [];
    for (const v of cur) {
      step(v, s, next);
      if (next.length >= MAX_PATH_RESULTS) break;
    }
    cur = next;
    if (!cur.length) break;
  }
  if (many) return { found: cur.length > 0, value: cur };
  return cur.length ? { found: true, value: cur[0] } : { found: false, value: undefined };
}

/** A key as a path step: `.name` when it can be, `['…']` otherwise. */
const keyStep = (k: string) => (/^[A-Za-z_$][\w$-]*$/.test(k) ? `.${k}` : `['${k.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}']`);

/**
 * The first leaf values of a document with their paths (`$.current.temp`,
 * `$.items[0].name`), for the editor to suggest when a path finds nothing.
 * Arrays show only their first item.
 */
export function leafPaths(doc: unknown, max = 8): { path: string; value: unknown }[] {
  const out: { path: string; value: unknown }[] = [];
  const walk = (v: unknown, at: string, depth: number) => {
    if (out.length >= max) return;
    if (v !== null && typeof v === 'object' && depth < 8) {
      if (Array.isArray(v)) {
        if (v.length) walk(v[0], `${at}[0]`, depth + 1);
        else out.push({ path: at, value: v });
        return;
      }
      const keys = Object.keys(v);
      if (!keys.length) out.push({ path: at, value: v });
      for (const k of keys) walk((v as Record<string, unknown>)[k], at + keyStep(k), depth + 1);
      return;
    }
    out.push({ path: at, value: v });
  };
  walk(doc, '$', 0);
  return out;
}

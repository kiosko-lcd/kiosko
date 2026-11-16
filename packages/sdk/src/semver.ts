/**
 * Just enough semver to say whether a plugin fits this Kiosko: versions
 * `1.2.3` (a pre-release such as `1.2.3-beta.1` sorts before its release),
 * and ranges as npm writes them in package.json:
 *
 *   ^0.2.0   >=0.2.0 <0.3.0   (caret: the left-most non-zero part is fixed)
 *   ~0.2.1   >=0.2.1 <0.3.0
 *   0.2 · 0.2.x · *          wildcards
 *   >=0.2.0 <1               comparators, space-separated (all must hold)
 *   ^0.2 || ^1               alternatives
 *
 * No dependencies, so the registry can check a plugin before running it.
 */

type V = [number, number, number, string];

/** `1.2.3` → its parts; null when it isn't a version. */
export function parseVersion(s: string): V | null {
  const m = /^\s*v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?\s*$/.exec(s);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ?? ''] : null;
}

/** -1, 0 or 1. A pre-release sorts before the release of the same numbers. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] as number) < (y[i] as number) ? -1 : 1;
  if (x[3] === y[3]) return 0;
  if (!x[3]) return 1;
  if (!y[3]) return -1;
  return x[3] < y[3] ? -1 : 1;
}

type Cmp = { op: '>=' | '>' | '<=' | '<' | '='; v: string };

/** A partial version (`1`, `1.2`, `1.x`) as its parts, `undefined` for the missing or wild ones. */
function partial(s: string): [number | undefined, number | undefined, number | undefined, string] | null {
  const m = /^\s*v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?\s*$/.exec(s);
  if (!m) return null;
  const n = (p: string | undefined) => (p === undefined || /^[xX*]$/.test(p) ? undefined : Number(p));
  return [n(m[1]), n(m[2]), n(m[3]), m[4] ?? ''];
}

const ver = (a: number, b: number, c: number, pre = '') => `${a}.${b}.${c}${pre ? `-${pre}` : ''}`;

/** One space-separated set of comparators → plain `op version` pairs. */
function comparators(set: string): Cmp[] | null {
  const out: Cmp[] = [];
  const tokens = set.trim().replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1').split(/\s+/).filter(Boolean);
  if (!tokens.length) return [{ op: '>=', v: '0.0.0' }];
  for (const tk of tokens) {
    const m = /^(>=|<=|>|<|=|\^|~)?(.*)$/.exec(tk)!;
    const op = m[1] ?? '';
    const p = partial(m[2]!);
    if (!p) return null;
    const [ma, mi, pa, pre] = p;
    if (ma === undefined) {
      out.push({ op: '>=', v: '0.0.0' });
      continue;
    }
    if (op === '^') {
      const lo = ver(ma, mi ?? 0, pa ?? 0, pre);
      const hi = ma > 0 || mi === undefined ? ver(ma + 1, 0, 0) : mi > 0 || pa === undefined ? ver(0, mi + 1, 0) : ver(0, 0, pa + 1);
      out.push({ op: '>=', v: lo }, { op: '<', v: `${hi}-0` });
    } else if (op === '~') {
      const lo = ver(ma, mi ?? 0, pa ?? 0, pre);
      const hi = mi === undefined ? ver(ma + 1, 0, 0) : ver(ma, mi + 1, 0);
      out.push({ op: '>=', v: lo }, { op: '<', v: `${hi}-0` });
    } else if (op === '' || op === '=') {
      if (mi === undefined) out.push({ op: '>=', v: ver(ma, 0, 0) }, { op: '<', v: `${ver(ma + 1, 0, 0)}-0` });
      else if (pa === undefined) out.push({ op: '>=', v: ver(ma, mi, 0) }, { op: '<', v: `${ver(ma, mi + 1, 0)}-0` });
      else out.push({ op: '=', v: ver(ma, mi, pa, pre) });
    } else {
      // >1.2 means >=1.3.0; <=1.2 means <1.3.0.
      if (pa === undefined && (op === '>' || op === '<=')) {
        const next = mi === undefined ? ver(ma + 1, 0, 0) : ver(ma, mi + 1, 0);
        out.push(op === '>' ? { op: '>=', v: next } : { op: '<', v: `${next}-0` });
      } else out.push({ op: op as Cmp['op'], v: ver(ma, mi ?? 0, pa ?? 0, pre) });
    }
  }
  return out;
}

/**
 * Whether `version` is in `range`. A pre-release only matches a range that
 * names a pre-release of the same numbers (npm's rule), so `0.3.0-beta` does
 * not quietly satisfy `^0.2`. An unreadable range or version is `false`.
 */
export function satisfies(version: string, range: string): boolean {
  const v = parseVersion(version);
  if (!v) return false;
  return range.split('||').some((set) => {
    const cs = comparators(set);
    if (!cs) return false;
    const ok = cs.every(({ op, v: w }) => {
      const c = compareVersions(version, w);
      return op === '>=' ? c >= 0 : op === '>' ? c > 0 : op === '<=' ? c <= 0 : op === '<' ? c < 0 : c === 0;
    });
    if (!ok || !v[3]) return ok;
    return cs.some(({ v: w }) => {
      const x = parseVersion(w);
      return !!x && !!x[3] && x[3] !== '0' && x[0] === v[0] && x[1] === v[1] && x[2] === v[2];
    });
  });
}

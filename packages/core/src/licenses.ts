/**
 * Licences, as SPDX expressions (`MIT`, `GPL-3.0-or-later`, `MIT OR Apache-2.0`),
 * for the plugin linter and the store's licence filter. No dependency: the
 * identifiers plugins actually use, and a small parser for `AND`, `OR`,
 * `WITH` and parentheses. An identifier that isn't here is "unknown", not
 * wrong: `LicenseRef-…` and `UNLICENSED` (not open source) are valid too.
 */

/** Permissive: use it for anything, keep the notice. */
const PERMISSIVE = ['MIT', 'MIT-0', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'BSD-3-Clause-Clear', '0BSD', 'Apache-2.0', 'Zlib', 'Unlicense', 'CC0-1.0', 'BSL-1.0', 'PostgreSQL', 'NCSA', 'X11', 'Python-2.0', 'BlueOak-1.0.0', 'UPL-1.0', 'Artistic-2.0', 'WTFPL', 'CC-BY-4.0'];
/** Copyleft: changes (or the whole program) stay under the same licence. */
const COPYLEFT = [
  'GPL-2.0-only', 'GPL-2.0-or-later', 'GPL-3.0-only', 'GPL-3.0-or-later', 'LGPL-2.1-only', 'LGPL-2.1-or-later', 'LGPL-3.0-only', 'LGPL-3.0-or-later',
  'AGPL-3.0-only', 'AGPL-3.0-or-later', 'MPL-2.0', 'EPL-2.0', 'EUPL-1.2', 'CDDL-1.0', 'OSL-3.0', 'CC-BY-SA-4.0',
  // Deprecated spellings npm still accepts.
  'GPL-2.0', 'GPL-3.0', 'LGPL-2.1', 'LGPL-3.0', 'AGPL-3.0',
];
/** Not open source: you may look, not reuse freely. */
const OTHER = ['CC-BY-NC-4.0', 'CC-BY-NC-SA-4.0', 'CC-BY-ND-4.0', 'BUSL-1.1', 'Elastic-2.0', 'SSPL-1.0'];
const EXCEPTIONS = ['Classpath-exception-2.0', 'LLVM-exception', 'GCC-exception-3.1', 'Autoconf-exception-3.0', 'Bison-exception-2.2', 'Font-exception-2.0'];

const KNOWN = new Map<string, LicenseKind>([...PERMISSIVE.map((id) => [id, 'permissive'] as const), ...COPYLEFT.map((id) => [id, 'copyleft'] as const), ...OTHER.map((id) => [id, 'other'] as const)]);
const LOWER = new Map([...KNOWN.keys()].map((id) => [id.toLowerCase(), id]));

/** How free a licence leaves you: the store's licence filter. */
export type LicenseKind = 'permissive' | 'copyleft' | 'other';

export interface ParsedLicense {
  /** The identifiers in it, as written. */
  ids: string[];
  /** The ones not in Kiosko's list (still valid SPDX, maybe). */
  unknown: string[];
  /** Wrongly cased ids, with how to write them (`mit` → `MIT`). */
  fix: { from: string; to: string }[];
}

/**
 * Parses an SPDX expression. Throws on one that isn't (`MIT/Apache`, an
 * unbalanced parenthesis, `AND` with nothing after it).
 */
export function parseLicense(expr: string): ParsedLicense {
  const tokens = expr.trim().match(/\(|\)|[^\s()]+/g) ?? [];
  if (!tokens.length) throw new Error('an empty licence');
  const out: ParsedLicense = { ids: [], unknown: [], fix: [] };
  let i = 0;
  const id = (t: string | undefined, exception = false): void => {
    if (!t || /^(AND|OR|WITH|\(|\))$/i.test(t)) throw new Error(`a licence identifier was expected${t ? ` before "${t}"` : ' at the end'}`);
    if (!/^[A-Za-z0-9][A-Za-z0-9.+-]*$/.test(t)) throw new Error(`"${t}" is not an SPDX identifier (write "MIT OR Apache-2.0", not "MIT/Apache-2.0")`);
    if (exception) {
      if (!EXCEPTIONS.includes(t)) out.unknown.push(t);
      return;
    }
    const plus = t.endsWith('+') ? t.slice(0, -1) : t;
    out.ids.push(t);
    if (/^(LicenseRef|DocumentRef)-/.test(plus) || KNOWN.has(plus)) return;
    const right = LOWER.get(plus.toLowerCase());
    if (right) out.fix.push({ from: t, to: right });
    else out.unknown.push(t);
  };
  const primary = (): void => {
    const t = tokens[i];
    if (t === '(') {
      i++;
      expression();
      if (tokens[i++] !== ')') throw new Error('a "(" is never closed');
      return;
    }
    id(tokens[i++]);
    if (tokens[i]?.toUpperCase() === 'WITH') {
      i++;
      id(tokens[i++], true);
    }
  };
  const expression = (): void => {
    primary();
    while (tokens[i] && /^(AND|OR)$/i.test(tokens[i]!)) {
      i++;
      primary();
    }
  };
  if (/^UNLICENSED$/i.test(expr.trim())) return { ids: ['UNLICENSED'], unknown: [], fix: [] };
  expression();
  if (i < tokens.length) throw new Error(`"${tokens[i]}" is out of place (join licences with AND or OR)`);
  return out;
}

/**
 * The kind of a licence expression, for filtering: with `OR` the freest of
 * them (you may choose), with `AND` the strictest; unknown ones are `other`.
 */
export function licenseKind(expr: string | undefined): LicenseKind {
  if (!expr) return 'other';
  const rank: Record<LicenseKind, number> = { permissive: 0, copyleft: 1, other: 2 };
  const of = (t: string): LicenseKind => KNOWN.get(t.replace(/\+$/, '')) ?? 'other';
  try {
    parseLicense(expr);
  } catch {
    return 'other';
  }
  // Each OR branch is the strictest of its ANDs; the expression, the freest branch. Parentheses are flattened: good enough here.
  const branches = expr.replace(/[()]/g, ' ').split(/\s+OR\s+/i);
  const kinds = branches.map((b) => b.split(/\s+AND\s+/i).map((x) => of(x.trim().split(/\s+WITH\s+/i)[0]!)).reduce((a, k) => (rank[k] > rank[a] ? k : a), 'permissive' as LicenseKind));
  return kinds.reduce((a, k) => (rank[k] < rank[a] ? k : a), 'other' as LicenseKind);
}

/** An ISO 3166-1 alpha-2 country code Intl knows (`ES`, `TW`), or `EU`. */
export function isRegion(code: string): boolean {
  if (code === 'EU') return true;
  if (!/^[A-Z]{2}$/.test(code)) return false;
  try {
    return new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' }).of(code) !== undefined;
  } catch {
    return false;
  }
}

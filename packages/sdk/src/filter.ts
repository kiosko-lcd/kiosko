/**
 * Item filters, the same in every widget that lists projects, repos,
 * calendars, servers or people: a list of patterns, edited with `t.filter()`
 * and applied with `matchFilter`.
 *
 *   []                      everything
 *   ["web", "api"]          only these (by full name or by its last part)
 *   ["acme/*"]              everything under acme/ (`*` matches anything, `/` too)
 *   ["!legacy-*"]           everything except what starts with legacy-
 *   ["acme/*", "!*-old"]    under acme/, but not the *-old ones
 *
 * Case doesn't matter, `?` is one character, and `*text*` is "contains". A
 * value matches a pattern by its full form (`group/sub/project`) or by its
 * last `/` segment (`project`), like `aliases` do.
 */

/** A filter: patterns as a list, or one text with commas or line breaks between them. */
export type Filter = readonly string[] | string;

const cache = new Map<string, RegExp>();
function globRe(pattern: string): RegExp {
  let re = cache.get(pattern);
  if (!re) {
    const body = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    re = new RegExp(`^${body}$`, 'i');
    if (cache.size > 500) cache.clear();
    cache.set(pattern, re);
  }
  return re;
}

/** The patterns of a filter, trimmed, without empty ones. */
export function filterPatterns(filter: Filter | undefined): string[] {
  const list = typeof filter === 'string' ? filter.split(/[,\n]/) : (filter ?? []);
  return list.map((p) => p.trim()).filter((p) => p && p !== '!');
}

/**
 * Whether `value` passes `filter`. `value` may be several names of the same
 * item (a repo's full name and its alias): it passes if any of them matches
 * an include pattern and none matches an exclude one. An empty filter (or
 * one with only exclusions) lets everything else through.
 */
export function matchFilter(value: string | readonly string[], filter: Filter | undefined): boolean {
  const patterns = filterPatterns(filter);
  if (!patterns.length) return true;
  const names = (typeof value === 'string' ? [value] : [...value]).flatMap((v) => {
    const last = v.split('/').pop() ?? v;
    return last === v ? [v] : [v, last];
  });
  const hit = (p: string) => names.some((n) => globRe(p).test(n));
  const includes = patterns.filter((p) => !p.startsWith('!'));
  const excludes = patterns.filter((p) => p.startsWith('!')).map((p) => p.slice(1).trim());
  if (excludes.some(hit)) return false;
  return !includes.length || includes.some(hit);
}

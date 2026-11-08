/**
 * Craft signals taken from hook events and from the files a session touches.
 * Pure and cheap: the hook ones are on the path of every tool call.
 */

/** TODO/FIXME added by an edit (new ones minus those already there). */
export function todosAdded(tool: string, input: unknown): number {
  if (!input || typeof input !== 'object') return 0;
  const o = input as Record<string, unknown>;
  const count = (v: unknown) => (typeof v === 'string' ? (v.match(/\b(TODO|FIXME)\b/g) ?? []).length : 0);
  if (/^(Edit|replace)$/.test(tool)) return Math.max(0, count(o.new_string) - count(o.old_string));
  if (tool === 'MultiEdit' && Array.isArray(o.edits)) {
    return (o.edits as Record<string, unknown>[]).reduce((n, e) => n + Math.max(0, count(e.new_string) - count(e.old_string)), 0);
  }
  if (/^(Write|write_file)$/.test(tool)) return count(o.content);
  return 0;
}

/**
 * Longest definition in a file, in lines: from one top-level definition
 * (`function`, `def`, `fn`, `func`, `class`, `export …`) to the next. Plenty
 * of heuristic to tell whether there is a 500-line monster in there.
 */
export function longestDefinition(text: string): number {
  const lines = text.split('\n');
  const START = /^(export\s+)?(default\s+)?(async\s+)?(function\b|def\s|fn\s|func\s|class\s|const\s+\w+\s*=\s*(async\s*)?\(|(public|private|protected|static)\s)/;
  let best = 0, from = -1;
  lines.forEach((l, i) => {
    if (START.test(l)) {
      if (from >= 0) best = Math.max(best, i - from);
      from = i;
    }
  });
  if (from >= 0) best = Math.max(best, lines.length - from);
  return best;
}

/** A definition longer than this is spaghetti. */
export const SPAGHETTI_LINES = 500;

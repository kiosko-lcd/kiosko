/**
 * A short, readable summary of what changes between two configs: screens,
 * pages and tiles added or removed, sources and settings changed. For
 * `kiosko config import`, so a config written elsewhere can be reviewed
 * before it replaces the current one. Never prints option values (they may
 * be secrets), only which ones changed. Pure (no Node).
 */
import type { Config, DeviceConfig, InterludeSlot, Page, Screen, Tile } from './model.ts';

export interface DiffLine {
  /** Nesting: 0 for screens, sources and settings, 1 for pages, 2 for tiles. */
  depth: number;
  op: '+' | '-' | '~';
  kind: 'setting' | 'source' | 'screen' | 'page' | 'tile' | 'interlude';
  text: string;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const q = (s: string) => JSON.stringify(s);
const short = (v: unknown) => {
  const s = v === undefined ? 'unset' : JSON.stringify(v);
  return s.length > 60 ? `${s.slice(0, 57)}...` : s;
};
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Pairs items by id, then the leftovers by a second key (name, position…). */
function match<T extends { id: string }>(before: readonly T[], after: readonly T[], alt?: (x: T) => string): { pairs: [T, T][]; removed: T[]; added: T[] } {
  const pairs: [T, T][] = [];
  const left = [...before];
  const added: T[] = [];
  const unmatched: T[] = [];
  for (const a of after) {
    const i = left.findIndex((b) => b.id === a.id);
    if (i >= 0) pairs.push([left.splice(i, 1)[0]!, a]);
    else unmatched.push(a);
  }
  for (const a of unmatched) {
    const i = alt ? left.findIndex((b) => alt(b) === alt(a)) : -1;
    if (i >= 0) pairs.push([left.splice(i, 1)[0]!, a]);
    else added.push(a);
  }
  return { pairs, removed: left, added };
}

const types = (t: Tile) => t.widgets.map((w) => w.type).join(', ') || 'no widgets';
const rect = (t: Tile) => `${t.w}×${t.h} at ${t.x},${t.y}`;
const tileText = (t: Tile) => `tile ${rect(t)}: ${types(t)}`;
const pageTypes = (p: Page) => [...new Set(p.tiles.flatMap((t) => t.widgets.map((w) => w.type)))];
const pageText = (p: Page) => {
  const ts = pageTypes(p);
  return `page ${q(p.name)}: ${plural(p.tiles.length, 'tile')}${ts.length ? ` (${ts.slice(0, 6).join(', ')}${ts.length > 6 ? `, +${ts.length - 6} more` : ''})` : ''}`;
};
const deviceText = (d: DeviceConfig) => (d.driver === 'trcc' ? `trcc ${d.url}` : d.driver === 'file' ? `file ${d.dir}` : d.driver);
const changedKeys = (a: Record<string, unknown>, b: Record<string, unknown>) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => !same(a[k], b[k]));

function diffTiles(before: Page, after: Page, depth: number, out: DiffLine[]): void {
  const m = match(before.tiles, after.tiles, rect);
  for (const t of m.removed) out.push({ depth, op: '-', kind: 'tile', text: tileText(t) });
  for (const t of m.added) out.push({ depth, op: '+', kind: 'tile', text: tileText(t) });
  for (const [b, a] of m.pairs) {
    const what: string[] = [];
    if (rect(b) !== rect(a)) what.push(`moved/resized from ${rect(b)}`);
    const w = match(b.widgets, a.widgets, (x) => x.type);
    if (w.added.length) what.push(`+ ${w.added.map((x) => x.type).join(', ')}`);
    if (w.removed.length) what.push(`- ${w.removed.map((x) => x.type).join(', ')}`);
    const opts = w.pairs.filter(([x, y]) => !same(x.options, y.options) && x.type === y.type).map(([x, y]) => `${y.type} (${changedKeys(x.options, y.options).join(', ')})`);
    if (opts.length) what.push(`options of ${opts.join(', ')}`);
    const swapped = w.pairs.filter(([x, y]) => x.type !== y.type).map(([x, y]) => `${x.type} → ${y.type}`);
    if (swapped.length) what.push(swapped.join(', '));
    const rest = w.pairs.filter(([x, y]) => x.type === y.type && same(x.options, y.options) && !same(x, y));
    if (rest.length || b.rotateMs !== a.rotateMs || b.chrome !== a.chrome || !!b.locked !== !!a.locked) what.push('settings');
    if (what.length) out.push({ depth, op: '~', kind: 'tile', text: `tile ${rect(a)}: ${what.join('; ')}` });
  }
}

function diffPages(before: Screen, after: Screen, depth: number, out: DiffLine[]): void {
  const m = match(before.pages, after.pages, (p) => p.name);
  for (const p of m.removed) out.push({ depth, op: '-', kind: 'page', text: pageText(p) });
  for (const p of m.added) out.push({ depth, op: '+', kind: 'page', text: pageText(p) });
  for (const [b, a] of m.pairs) {
    const what: string[] = [];
    if (b.name !== a.name) what.push(`renamed from ${q(b.name)}`);
    if (!same(b.grid, a.grid)) what.push(`grid ${b.grid.cols}×${b.grid.rows} → ${a.grid.cols}×${a.grid.rows}`);
    for (const k of ['enabled', 'when', 'durationMs', 'gravity', 'background'] as const) if (!same(b[k], a[k])) what.push(`${k} ${short(b[k])} → ${short(a[k])}`);
    const tiles: DiffLine[] = [];
    diffTiles(b, a, depth + 1, tiles);
    if (what.length || tiles.length) out.push({ depth, op: '~', kind: 'page', text: `page ${q(a.name)}${what.length ? `: ${what.join('; ')}` : ''}` }, ...tiles);
  }
}

const slotText = (s: InterludeSlot) => `interlude ${s.type} every ${Math.round(s.everyMs / 60_000)} min${s.enabled ? '' : ' (off)'}`;

export function diffConfigs(before: Config, after: Config): DiffLine[] {
  const out: DiffLine[] = [];
  for (const k of ['locale', 'timeFormat', 'theme', 'location', 'workday', 'plugins', 'server'] as const) {
    if (!same(before[k], after[k])) out.push({ depth: 0, op: '~', kind: 'setting', text: `${k}: ${short(before[k])} → ${short(after[k])}` });
  }
  for (const k of [...new Set([...Object.keys(before.sources), ...Object.keys(after.sources)])].sort()) {
    const b = before.sources[k];
    const a = after.sources[k];
    if (!b && a) out.push({ depth: 0, op: '+', kind: 'source', text: `source ${k}${Object.keys(a).length ? ` (${Object.keys(a).join(', ')})` : ''}` });
    else if (b && !a) out.push({ depth: 0, op: '-', kind: 'source', text: `source ${k}` });
    else if (a && b && !same(a, b)) out.push({ depth: 0, op: '~', kind: 'source', text: `source ${k}: ${changedKeys(b, a).join(', ')} changed` });
  }
  const m = match(before.screens, after.screens, (s) => s.name);
  for (const s of m.removed) out.push({ depth: 0, op: '-', kind: 'screen', text: `screen ${q(s.name)} ${s.width}×${s.height} (${plural(s.pages.length, 'page')})` });
  for (const s of m.added) {
    out.push({ depth: 0, op: '+', kind: 'screen', text: `screen ${q(s.name)} ${s.width}×${s.height}, ${deviceText(s.device)}` });
    for (const p of s.pages) out.push({ depth: 1, op: '+', kind: 'page', text: pageText(p) });
    for (const x of s.interludes) out.push({ depth: 1, op: '+', kind: 'interlude', text: slotText(x) });
  }
  for (const [b, a] of m.pairs) {
    const what: string[] = [];
    if (b.name !== a.name) what.push(`renamed from ${q(b.name)}`);
    if (b.width !== a.width || b.height !== a.height) what.push(`size ${b.width}×${b.height} → ${a.width}×${a.height}`);
    if (!same(b.device, a.device)) what.push(`device ${deviceText(b.device)} → ${deviceText(a.device)}`);
    for (const k of ['enabled', 'rotate', 'pinnedPage', 'pixelShift', 'sleepWhenIdle', 'jpegQuality', 'maxFps'] as const) if (!same(b[k], a[k])) what.push(`${k} ${short(b[k])} → ${short(a[k])}`);
    const sub: DiffLine[] = [];
    diffPages(b, a, 1, sub);
    const xs = match(b.interludes, a.interludes, (x) => x.type);
    for (const x of xs.removed) sub.push({ depth: 1, op: '-', kind: 'interlude', text: slotText(x) });
    for (const x of xs.added) sub.push({ depth: 1, op: '+', kind: 'interlude', text: slotText(x) });
    for (const [x, y] of xs.pairs) if (!same(x, y)) sub.push({ depth: 1, op: '~', kind: 'interlude', text: slotText(y) });
    if (what.length || sub.length) out.push({ depth: 0, op: '~', kind: 'screen', text: `screen ${q(a.name)}${what.length ? `: ${what.join('; ')}` : ''}` }, ...sub);
  }
  return out;
}

/** "1 screen added, 3 pages added, 5 tiles removed, 1 source changed". */
export function summarizeDiff(lines: readonly DiffLine[]): string {
  const verb = { '+': 'added', '-': 'removed', '~': 'changed' } as const;
  const counts = new Map<string, number>();
  for (const l of lines) counts.set(`${l.kind} ${l.op}`, (counts.get(`${l.kind} ${l.op}`) ?? 0) + 1);
  const parts = [...counts].map(([k, n]) => {
    const [kind, op] = k.split(' ') as [DiffLine['kind'], DiffLine['op']];
    return `${plural(n, kind)} ${verb[op]}`;
  });
  return parts.length ? parts.join(', ') : 'no changes';
}

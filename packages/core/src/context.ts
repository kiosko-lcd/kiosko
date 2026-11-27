/**
 * Pages that come up on their own (`Page.showWhen`): a program running, a
 * source's value, a time window, an urgent widget. While a page's rule holds
 * it takes its screen over from the normal rotation; when it stops holding,
 * the rotation comes back. Several pages wanting the screen: the highest
 * priority wins, and equals take turns among themselves.
 *
 * Anti-flicker (`Screen.context`): a context page stays at least `minMs`
 * once it came up, and `holdMs` more after its rule stopped holding, in case
 * it holds again (a game restarting, a value hovering at the threshold). A
 * higher priority page doesn't wait.
 *
 * Pure (no Node): the main thread evaluates the rules (it has every source's
 * data and the process list, see processes.ts) and tells each screen's runner
 * the page it must show and why. A pinned page still wins over this; an
 * alert wins over everything.
 */
import { minutesOf } from '@kiosko/sdk/workday';
import { pickPage } from './layout/stack.ts';
import { resolveSourceKey, type ProfileAware } from './config/profiles.ts';
import { CONTEXT_TIMING, whenMatches, type CompareOp, type Config, type Page, type Screen, type ShowWhenRule } from './config/model.ts';

/** Why a context page is on screen: what the rule that holds saw. */
export interface ContextReason {
  /** The rule's own name ("game open"), if it has one. */
  label?: string;
  /** The process that matched `app`. */
  app?: string;
  /** The source, and its value at the path, that matched. */
  source?: string;
  /** The source's profile the rule read (missing: its default one). */
  profile?: string;
  path?: string;
  value?: string;
  /** The time window that holds, `09:00–17:00`. */
  time?: string;
  /** The widget type that is urgent. */
  urgent?: string;
}

/** The context page a screen must show now. */
export interface ContextPick {
  page: string;
  reason: ContextReason;
  priority: number;
  /** When this context took the screen. */
  since: number;
  /** Its rule stopped holding: it stays for the anti-flicker margin only. */
  leaving: boolean;
}

/** What rules look at, given by whoever evaluates them (the runtime; tests). */
export interface ContextEnv {
  now: number;
  /** Names of the running programs (see processes.ts); null: not known (yet). */
  apps: readonly string[] | null;
  /** A source's latest data (undefined: none yet): its default profile's, or `profile`'s (see config/profiles.ts). */
  source(type: string, profile?: string): unknown;
  /** The type of an urgent widget on that page, or null. */
  urgent(page: Page): string | null;
}

// ---------------------------------------------------------------- values

/** `a.b`, `a[0].b`, `a.0.b`; empty: `data` itself. Missing anywhere: undefined. */
export function valueAt(data: unknown, path: string | undefined): unknown {
  const keys = (path ?? '').replace(/\[(\d+|"[^"]*"|'[^']*')\]/g, (_, k: string) => `.${k.replace(/^["']|["']$/g, '')}`).split('.').filter((k) => k !== '');
  let v = data;
  for (const k of keys) {
    if (v === null || v === undefined || typeof v !== 'object') return undefined;
    v = (v as Record<string, unknown>)[k];
  }
  return v;
}

const asNumber = (v: unknown): number => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : typeof v === 'boolean' ? Number(v) : NaN);

/**
 * Compares a value. Undefined (no data yet, a path that isn't there) never
 * matches, whatever the comparison: a rule doesn't take the screen over on
 * data it hasn't got. Numbers in strings count as numbers (`"0.21" > 0.2`).
 */
export function compareValue(v: unknown, op: CompareOp | undefined, value: ShowWhenRule['value']): boolean {
  if (v === undefined) return false;
  const how = op ?? (value === undefined ? 'truthy' : 'eq');
  const truthy = Array.isArray(v) ? v.length > 0 : !!v && v !== 'false' && v !== '0';
  switch (how) {
    case 'truthy':
      return truthy;
    case 'falsy':
      return !truthy;
    case 'eq':
    case 'ne': {
      const a = asNumber(v), b = asNumber(value);
      const same = typeof value === 'boolean' ? truthy === value : Number.isFinite(a) && Number.isFinite(b) ? a === b : String(v ?? '').toLowerCase() === String(value ?? '').toLowerCase();
      return how === 'eq' ? same : !same;
    }
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const a = asNumber(v), b = asNumber(value);
      if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
      return how === 'gt' ? a > b : how === 'gte' ? a >= b : how === 'lt' ? a < b : a <= b;
    }
    case 'contains': {
      const want = String(value ?? '').toLowerCase();
      if (Array.isArray(v)) return v.some((x) => String(x).toLowerCase() === want);
      return typeof v === 'string' && v.toLowerCase().includes(want);
    }
  }
  return false;
}

/** A value, short, for the editor ("fixed by: price 0.21"). */
function shown(v: unknown): string {
  if (typeof v === 'string') return v.length > 40 ? `${v.slice(0, 39)}…` : v;
  if (typeof v === 'number' || typeof v === 'boolean' || v === null) return String(v);
  if (Array.isArray(v)) return `[${v.length}]`;
  return '{…}';
}

// ---------------------------------------------------------------- programs

const globCache = new Map<string, RegExp[]>();

/** `steam*, obs*` → its alternatives as regexps: `*` any run, `?` one character, case-insensitive, whole name. */
function globs(pattern: string): RegExp[] {
  let out = globCache.get(pattern);
  if (!out) {
    out = pattern
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i'));
    if (globCache.size > 200) globCache.clear();
    globCache.set(pattern, out);
  }
  return out;
}

/** The first name that matches the glob (or one of its comma-separated alternatives), or null. */
export function matchApp(pattern: string, names: readonly string[]): string | null {
  const res = globs(pattern);
  if (!res.length) return null;
  for (const n of names) if (res.some((r) => r.test(n))) return n;
  return null;
}

// ---------------------------------------------------------------- time

/** Whether local `now` is in the window (start included, end not); `days` are the days it starts on. */
export function inTimeWindow(w: NonNullable<ShowWhenRule['time']>, now: number): boolean {
  const a = minutesOf(w.start), b = minutesOf(w.end);
  if (a === b) return false;
  const d = new Date(now);
  const t = d.getHours() * 60 + d.getMinutes();
  const today = d.getDay();
  const days = w.days?.length ? w.days : null;
  if (a < b) return t >= a && t < b && (!days || days.includes(today));
  // Across midnight: before `end` belongs to the window that started yesterday.
  if (t >= a) return !days || days.includes(today);
  if (t < b) return !days || days.includes((today + 6) % 7);
  return false;
}

// ---------------------------------------------------------------- rules

/** Whether a rule has anything to check. */
export function ruleHasConditions(r: ShowWhenRule): boolean {
  return !!(r.app?.trim() || r.source || r.time || r.urgent);
}

/** The rule's reason when every condition of it holds; null otherwise. */
export function evalRule(rule: ShowWhenRule, page: Page, env: ContextEnv): ContextReason | null {
  if (!ruleHasConditions(rule)) return null;
  const why: ContextReason = rule.label ? { label: rule.label } : {};
  if (rule.app?.trim()) {
    const hit = env.apps ? matchApp(rule.app, env.apps) : null;
    if (!hit) return null;
    why.app = hit;
  }
  if (rule.source) {
    const v = valueAt(rule.profile ? env.source(rule.source, rule.profile) : env.source(rule.source), rule.path);
    if (!compareValue(v, rule.op, rule.value)) return null;
    why.source = rule.source;
    if (rule.profile) why.profile = rule.profile;
    if (rule.path) why.path = rule.path;
    why.value = shown(v);
  }
  if (rule.time) {
    if (!inTimeWindow(rule.time, env.now)) return null;
    why.time = `${rule.time.start}–${rule.time.end}`;
  }
  if (rule.urgent) {
    const u = env.urgent(page);
    if (!u) return null;
    why.urgent = u;
  }
  return why;
}

export interface PageMatch {
  page: Page;
  priority: number;
  reason: ContextReason;
}

/**
 * The pages of a screen whose rules hold now, each with its best rule
 * (highest priority, then first). Only enabled pages whose `when` fits.
 */
export function matchingPages(screen: Screen, env: ContextEnv, working: boolean): PageMatch[] {
  const out: PageMatch[] = [];
  for (const page of screen.pages) {
    if (page.enabled === false || !page.showWhen?.length || !whenMatches(page.when, working)) continue;
    let best: PageMatch | null = null;
    for (const rule of page.showWhen) {
      const priority = rule.priority ?? 0;
      if (best && priority <= best.priority) continue;
      const reason = evalRule(rule, page, env);
      if (reason) best = { page, priority, reason };
    }
    if (best) out.push(best);
  }
  return out;
}

/** Whether a page takes its turn in the normal rotation. */
export function inRotation(p: Pick<Page, 'showWhen' | 'inRotation'>): boolean {
  return !p.showWhen?.length || p.inRotation === true;
}

/**
 * The page a screen shows when no alert or interlude has it: the pinned one,
 * else the context one, else the rotation (pages without rules, and those
 * with `inRotation`), each taking its turn against the wall clock. With
 * nothing left to rotate (every page has rules, none holds) every page
 * rotates rather than leaving the panel black. Without any `showWhen` this is
 * exactly the rotation Kiosko always had.
 */
export function choosePage(screen: Pick<Screen, 'pages'>, now: number, working: boolean, pinned: string | null, context: string | null): Page | null {
  const eligible = screen.pages.filter((p) => whenMatches(p.when, working));
  const on = (id: string | null) => (id ? eligible.find((p) => p.id === id && p.enabled !== false) : undefined);
  const fixed = on(pinned) ?? on(context);
  if (fixed) return fixed;
  const rotation = eligible.filter(inRotation);
  return pickPage(rotation.some((p) => p.enabled !== false) ? rotation : eligible, now);
}

// ---------------------------------------------------------------- over time

interface Held {
  priority: number;
  /** The pages that want the screen at that priority, and why. */
  pages: PageMatch[];
  since: number;
  /** Last time one of them held. */
  heldAt: number;
}

/**
 * Turns what holds at each moment into what each screen shows, without
 * flicker (see the top of this file). One per runtime; call `step` with the
 * same screen as often as wanted (every second).
 */
export class ContextEngine {
  private held = new Map<string, Held>();

  step(screen: Screen, matches: PageMatch[], now: number): ContextPick | null {
    const minMs = Math.max(0, screen.context?.minMs ?? CONTEXT_TIMING.minMs);
    const holdMs = Math.max(0, screen.context?.holdMs ?? CONTEXT_TIMING.holdMs);
    let cur = this.held.get(screen.id) ?? null;
    // Pages gone from the config (or switched off) are let go at once.
    if (cur) {
      const ids = new Set(screen.pages.filter((p) => p.enabled !== false).map((p) => p.id));
      cur.pages = cur.pages.filter((m) => ids.has(m.page.id));
      if (!cur.pages.length) cur = null;
    }
    const top = matches.length ? Math.max(...matches.map((m) => m.priority)) : null;
    const best = top === null ? [] : matches.filter((m) => m.priority === top);
    const mayGo = (c: Held) => now - c.heldAt >= holdMs && now - c.since >= minMs;
    if (top !== null && (!cur || top > cur.priority)) cur = { priority: top, pages: best, since: now, heldAt: now };
    else if (top !== null && cur && top === cur.priority) {
      cur.pages = best;
      cur.heldAt = now;
    } else if (cur && mayGo(cur)) cur = top === null ? null : { priority: top, pages: best, since: now, heldAt: now };
    if (!cur) {
      this.held.delete(screen.id);
      return null;
    }
    this.held.set(screen.id, cur);
    // Equals take turns, each for its own duration, against the wall clock.
    const page = cur.pages.length === 1 ? cur.pages[0]! : (cur.pages.find((m) => m.page.id === pickPage(cur.pages.map((x) => x.page), now)?.id) ?? cur.pages[0]!);
    return { page: page.page.id, reason: page.reason, priority: cur.priority, since: cur.since, leaving: cur.heldAt < now };
  }

  /** Forgets screens that are gone. */
  retain(ids: Set<string>): void {
    for (const id of this.held.keys()) if (!ids.has(id)) this.held.delete(id);
  }
}

/**
 * The paths a source's data has, with a short value each, for the editor's
 * rule picker: leaves first come first, lists by their first item (and
 * their length), at most `max`.
 */
export function dataPaths(data: unknown, max = 60): { path: string; value: string }[] {
  const out: { path: string; value: string }[] = [];
  const walk = (v: unknown, path: string, depth: number) => {
    if (out.length >= max) return;
    if (Array.isArray(v)) {
      if (path) out.push({ path, value: shown(v) });
      if (v.length && depth < 6) walk(v[0], `${path}[0]`, depth + 1);
      return;
    }
    if (v && typeof v === 'object') {
      if (depth >= 6) return;
      for (const [k, x] of Object.entries(v)) walk(x, /^[A-Za-z_$][\w$-]*$/.test(k) ? (path ? `${path}.${k}` : k) : `${path}["${k}"]`, depth + 1);
      return;
    }
    out.push({ path, value: shown(v) });
  };
  walk(data, '', 0);
  return out;
}

/** Whether any enabled screen has a rule on a program: only then are processes listed. */
export function needsApps(cfg: Pick<Config, 'screens'>): boolean {
  return cfg.screens.some((s) => s.enabled && s.pages.some((p) => p.enabled !== false && p.showWhen?.some((r) => !!r.app?.trim())));
}

/**
 * The sources the rules of the enabled screens read, as source keys (a
 * rule's `profile`, when the source accepts profiles and the config has it:
 * `news/deck#tech`, see config/profiles.ts): they must run even with no
 * widget showing them. `source` tells whether a type accepts profiles.
 */
export function ruleSources(cfg: Pick<Config, 'screens' | 'sourceProfiles'>, source: (type: string) => ProfileAware | undefined = () => undefined): Set<string> {
  const out = new Set<string>();
  for (const s of cfg.screens) if (s.enabled) for (const p of s.pages) if (p.enabled !== false) for (const r of p.showWhen ?? []) if (r.source) out.add(resolveSourceKey(cfg, r.source, r.profile, source(r.source)));
  return out;
}

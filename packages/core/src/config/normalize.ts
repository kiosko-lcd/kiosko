/**
 * Turning whatever was read from disk (or sent by the editor, or written by
 * an AI) into a complete `Config`. Pure (no Node), so validation can run
 * anywhere.
 */
import { TIME_FORMATS } from '@kiosko/sdk/format';
import { DEFAULT_WORKDAY } from '@kiosko/sdk/workday';
import { suggestGrid } from '../layout/grid.ts';
import { normalizeProfiles } from './profiles.ts';
import { ALERT_THRESHOLDS, CONFIG_VERSION, PUSH_NAME_PATTERN, DEFAULT_CONFIG, DEFAULT_MAX_BYTES, TEXT_SCALE, SETUP_STATES, THREADS_MODES, type Config, type Screen, type ScreenAlerts, COMPARE_OPS, type ContextTiming, type ShowWhenRule } from './model.ts';

/**
 * Fills gaps of a config written by hand or by an older version. Never throws.
 * The top-level shape it accepts is described, for other tools, by
 * `configSchema` (schema.ts): change both together.
 */
export function normalize(raw: unknown): Config {
  const { $schema, threads, setup, bootAnimation, sourceProfiles, ...c } = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Partial<Config>;
  const screens = Array.isArray(c.screens) ? c.screens.map(normalizeScreen) : [];
  const profiles = normalizeProfiles(sourceProfiles);
  return {
    ...(typeof $schema === 'string' && $schema ? { $schema } : {}),
    ...DEFAULT_CONFIG,
    ...c,
    version: CONFIG_VERSION,
    timeFormat: TIME_FORMATS.includes(c.timeFormat as never) ? c.timeFormat! : DEFAULT_CONFIG.timeFormat,
    // A copy of the defaults: the editor edits the result in place.
    workday: { ...(JSON.parse(JSON.stringify(DEFAULT_WORKDAY)) as typeof DEFAULT_WORKDAY), ...(c.workday ?? {}) },
    sources: c.sources ?? {},
    // Only when there are any: a config without profiles stays as it was.
    ...(profiles ? { sourceProfiles: profiles } : {}),
    plugins: { disabled: c.plugins?.disabled ?? [] },
    server: { ...DEFAULT_CONFIG.server, ...(c.server ?? {}) },
    ...(c.homeassistant && typeof c.homeassistant === 'object' ? { homeassistant: normalizeHa(c.homeassistant) } : {}),
    ...(c.push && typeof c.push === 'object' ? { push: normalizePush(c.push) } : {}),
    ...(THREADS_MODES.includes(threads as never) ? { threads: threads! } : {}),
    ...(SETUP_STATES.includes(setup as never) ? { setup: setup! } : {}),
    // On unless switched off: only `false` is written.
    ...(bootAnimation === false ? { bootAnimation: false } : {}),
    screens,
  };
}

function normalizeHa(h: Partial<NonNullable<Config['homeassistant']>>): NonNullable<Config['homeassistant']> {
  const id = String(h.nodeId ?? '').toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  return {
    enabled: h.enabled ?? false,
    broker: typeof h.broker === 'string' ? h.broker.trim() : '',
    ...(h.username ? { username: String(h.username) } : {}),
    ...(h.password ? { password: String(h.password) } : {}),
    discoveryPrefix: (typeof h.discoveryPrefix === 'string' && h.discoveryPrefix.trim()) || 'homeassistant',
    nodeId: id || 'kiosko',
  };
}

/** Push names that can go in a URL, once each; a token kept as written (an empty one lets nobody in). */
function normalizePush(p: Partial<NonNullable<Config['push']>>): NonNullable<Config['push']> {
  const seen = new Set<string>();
  const name = new RegExp(PUSH_NAME_PATTERN);
  const hooks = (Array.isArray(p.hooks) ? p.hooks : []).flatMap((h) => {
    if (!h || typeof h !== 'object') return [];
    const n = String(h.name ?? '').trim().toLowerCase();
    if (!name.test(n) || seen.has(n)) return [];
    seen.add(n);
    return [{ name: n, token: typeof h.token === 'string' ? h.token.trim() : '' }];
  });
  return { hooks };
}

function normalizeScreen(s: Partial<Screen>, i: number): Screen {
  const width = s.width ?? 1920;
  const height = s.height ?? 462;
  return {
    id: s.id ?? `screen-${i + 1}`,
    name: s.name ?? `Screen ${i + 1}`,
    enabled: s.enabled ?? true,
    width,
    height,
    rotate: s.rotate ?? 0,
    device: s.device ?? { driver: 'virtual' },
    pages: (s.pages ?? []).map((p, j) => ({
      id: p.id ?? `page-${j + 1}`,
      name: p.name ?? `Page ${j + 1}`,
      enabled: p.enabled ?? true,
      durationMs: p.durationMs ?? 10 * 60_000,
      when: p.when ?? 'always',
      ...normalizeShowWhen(p.showWhen, p.inRotation),
      grid: p.grid ?? suggestGrid(width, height),
      gravity: p.gravity ?? 'none',
      background: p.background ?? {},
      tiles: (p.tiles ?? []).map((t, k) => ({ id: t.id ?? `tile-${k + 1}`, x: t.x ?? 0, y: t.y ?? 0, w: t.w ?? 1, h: t.h ?? 1, ...(t.locked ? { locked: true } : {}), widgets: (t.widgets ?? []).map((w, n) => ({ ...w, id: w.id ?? `w-${i + 1}-${j + 1}-${k + 1}-${n + 1}`, options: w.options ?? {} })), rotateMs: t.rotateMs ?? 30_000, chrome: t.chrome ?? 'auto' })),
    })),
    ...(s.pinnedPage ? { pinnedPage: s.pinnedPage } : {}),
    ...normalizeContextTiming(s.context),
    interludes: (s.interludes ?? []).map((x, k) => ({ id: x.id ?? `interlude-${k + 1}`, type: x.type, enabled: x.enabled ?? true, everyMs: x.everyMs ?? 15 * 60_000, maxSeconds: x.maxSeconds ?? 30, options: x.options ?? {} })),
    pixelShift: { enabled: true, amplitude: 2, periodMs: 8 * 60_000, ...(s.pixelShift ?? {}) },
    sleepWhenIdle: s.sleepWhenIdle ?? false,
    jpegQuality: s.jpegQuality ?? 90,
    maxBytes: Math.max(0, Math.round(s.maxBytes ?? DEFAULT_MAX_BYTES)),
    maxFps: s.maxFps ?? 12,
    ...(s.readingDistance === 'near' || s.readingDistance === 'far' ? { readingDistance: s.readingDistance } : {}),
    ...(typeof s.textScale === 'number' && Number.isFinite(s.textScale) && s.textScale !== 1 ? { textScale: Math.min(TEXT_SCALE.max, Math.max(TEXT_SCALE.min, s.textScale)) } : {}),
    ...(typeof s.diagonalIn === 'number' && s.diagonalIn > 0 ? { diagonalIn: s.diagonalIn } : {}),
    ...normalizeAlerts(s.alerts),
    // `auto` (or anything else) is the same as leaving it out: as the config's `threads` says.
    ...(s.thread === 'always' || s.thread === 'never' ? { thread: s.thread } : {}),
  };
}

const HHMM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

/**
 * A page's context rules (see context.ts): rules with nothing to check, and
 * fields of the wrong kind, are left out; no rules left, no `showWhen` (the
 * page rotates as it always did). `inRotation` is kept only with rules.
 */
export function normalizeShowWhen(raw: unknown, inRotation: unknown): { showWhen?: ShowWhenRule[]; inRotation?: boolean } {
  if (!Array.isArray(raw)) return {};
  const rules: ShowWhenRule[] = [];
  for (const r of raw as Partial<ShowWhenRule>[]) {
    if (!r || typeof r !== 'object') continue;
    const out: ShowWhenRule = {};
    if (typeof r.label === 'string' && r.label.trim()) out.label = r.label.trim();
    if (typeof r.priority === 'number' && Number.isFinite(r.priority) && r.priority !== 0) out.priority = Math.round(r.priority);
    if (typeof r.app === 'string' && r.app.trim()) out.app = r.app.trim();
    if (typeof r.source === 'string' && r.source.trim()) {
      out.source = r.source.trim();
      if (typeof r.path === 'string' && r.path.trim()) out.path = r.path.trim();
      if (COMPARE_OPS.includes(r.op as never)) out.op = r.op!;
      if (['string', 'number', 'boolean'].includes(typeof r.value)) out.value = r.value!;
    }
    const t = r.time;
    if (t && typeof t === 'object' && HHMM.test(String(t.start)) && HHMM.test(String(t.end)) && t.start !== t.end) {
      const days = Array.isArray(t.days) ? [...new Set(t.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort() : [];
      out.time = { start: t.start, end: t.end, ...(days.length && days.length < 7 ? { days } : {}) };
    }
    if (r.urgent === true) out.urgent = true;
    if (out.app || out.source || out.time || out.urgent) rules.push(out);
  }
  if (!rules.length) return {};
  return { showWhen: rules, ...(inRotation === true ? { inRotation: true } : {}) };
}

/** A screen's anti-flicker for context pages; left out when it is the default. */
export function normalizeContextTiming(raw: unknown): { context?: ContextTiming } {
  if (!raw || typeof raw !== 'object') return {};
  const c = raw as ContextTiming;
  const ms = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(3_600_000, Math.round(v)) : undefined);
  const minMs = ms(c.minMs), holdMs = ms(c.holdMs);
  if (minMs === undefined && holdMs === undefined) return {};
  return { context: { ...(minMs !== undefined ? { minMs } : {}), ...(holdMs !== undefined ? { holdMs } : {}) } };
}

/** A screen's alert settings; left out when they are the defaults (every level, no quiet hours). */
export function normalizeAlerts(raw: unknown): { alerts?: ScreenAlerts } {
  if (!raw || typeof raw !== 'object') return {};
  const a = raw as Partial<ScreenAlerts>;
  const minLevel = ALERT_THRESHOLDS.includes(a.minLevel as never) ? a.minLevel! : 'info';
  const q = a.quiet;
  const quiet = q && typeof q === 'object' && HHMM.test(String(q.start)) && HHMM.test(String(q.end)) && q.start !== q.end ? { start: q.start, end: q.end } : undefined;
  if (minLevel === 'info' && !quiet) return {};
  return { alerts: { minLevel, ...(quiet ? { quiet } : {}) } };
}

/**
 * Turning whatever was read from disk (or sent by the editor, or written by
 * an AI) into a complete `Config`. Pure (no Node), so validation can run
 * anywhere.
 */
import { TIME_FORMATS } from '@kiosko/sdk/format';
import { DEFAULT_WORKDAY } from '@kiosko/sdk/workday';
import { suggestGrid } from '../layout/grid.ts';
import { CONFIG_VERSION, DEFAULT_CONFIG, DEFAULT_MAX_BYTES, type Config, type Screen } from './model.ts';

/**
 * Fills gaps of a config written by hand or by an older version. Never throws.
 * The top-level shape it accepts is described, for other tools, by
 * `configSchema` (schema.ts): change both together.
 */
export function normalize(raw: unknown): Config {
  const { $schema, ...c } = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Partial<Config>;
  const screens = Array.isArray(c.screens) ? c.screens.map(normalizeScreen) : [];
  return {
    ...(typeof $schema === 'string' && $schema ? { $schema } : {}),
    ...DEFAULT_CONFIG,
    ...c,
    version: CONFIG_VERSION,
    timeFormat: TIME_FORMATS.includes(c.timeFormat as never) ? c.timeFormat! : DEFAULT_CONFIG.timeFormat,
    // A copy of the defaults: the editor edits the result in place.
    workday: { ...(JSON.parse(JSON.stringify(DEFAULT_WORKDAY)) as typeof DEFAULT_WORKDAY), ...(c.workday ?? {}) },
    sources: c.sources ?? {},
    plugins: { disabled: c.plugins?.disabled ?? [] },
    server: { ...DEFAULT_CONFIG.server, ...(c.server ?? {}) },
    screens,
  };
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
      grid: p.grid ?? suggestGrid(width, height),
      gravity: p.gravity ?? 'none',
      background: p.background ?? {},
      tiles: (p.tiles ?? []).map((t, k) => ({ id: t.id ?? `tile-${k + 1}`, x: t.x ?? 0, y: t.y ?? 0, w: t.w ?? 1, h: t.h ?? 1, ...(t.locked ? { locked: true } : {}), widgets: (t.widgets ?? []).map((w, n) => ({ ...w, id: w.id ?? `w-${i + 1}-${j + 1}-${k + 1}-${n + 1}`, options: w.options ?? {} })), rotateMs: t.rotateMs ?? 30_000, chrome: t.chrome ?? 'auto' })),
    })),
    ...(s.pinnedPage ? { pinnedPage: s.pinnedPage } : {}),
    interludes: (s.interludes ?? []).map((x, k) => ({ id: x.id ?? `interlude-${k + 1}`, type: x.type, enabled: x.enabled ?? true, everyMs: x.everyMs ?? 15 * 60_000, maxSeconds: x.maxSeconds ?? 30, options: x.options ?? {} })),
    pixelShift: { enabled: true, amplitude: 2, periodMs: 8 * 60_000, ...(s.pixelShift ?? {}) },
    sleepWhenIdle: s.sleepWhenIdle ?? false,
    jpegQuality: s.jpegQuality ?? 90,
    maxBytes: Math.max(0, Math.round(s.maxBytes ?? DEFAULT_MAX_BYTES)),
    maxFps: s.maxFps ?? 12,
  };
}

/**
 * Reading and writing the config file. The file holds secrets (calendar
 * URLs, tokens), so it's written with 0600 and atomically.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { paths } from '../paths.ts';
import { suggestGrid } from '../layout/grid.ts';
import { CONFIG_VERSION, DEFAULT_CONFIG, type Config, type Screen } from './model.ts';

/** Fills gaps of a config written by hand or by an older version. Never throws. */
export function normalize(raw: unknown): Config {
  const c = (raw && typeof raw === 'object' ? raw : {}) as Partial<Config>;
  const screens = Array.isArray(c.screens) ? c.screens.map(normalizeScreen) : [];
  return {
    ...DEFAULT_CONFIG,
    ...c,
    version: CONFIG_VERSION,
    workday: { ...DEFAULT_CONFIG.workday, ...(c.workday ?? {}) },
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
      tiles: (p.tiles ?? []).map((t, k) => ({ id: t.id ?? `tile-${k + 1}`, x: t.x ?? 0, y: t.y ?? 0, w: t.w ?? 1, h: t.h ?? 1, ...(t.locked ? { locked: true } : {}), widgets: (t.widgets ?? []).map((w, n) => ({ ...w, id: w.id ?? `w-${k}-${n}`, options: w.options ?? {} })), rotateMs: t.rotateMs ?? 30_000, chrome: t.chrome ?? 'auto' })),
    })),
    ...(s.pinnedPage ? { pinnedPage: s.pinnedPage } : {}),
    interludes: (s.interludes ?? []).map((x, k) => ({ id: x.id ?? `interlude-${k + 1}`, type: x.type, enabled: x.enabled ?? true, everyMs: x.everyMs ?? 15 * 60_000, maxSeconds: x.maxSeconds ?? 30, options: x.options ?? {} })),
    pixelShift: { enabled: true, amplitude: 2, periodMs: 8 * 60_000, ...(s.pixelShift ?? {}) },
    sleepWhenIdle: s.sleepWhenIdle ?? false,
    jpegQuality: s.jpegQuality ?? 90,
    maxFps: s.maxFps ?? 12,
  };
}

export function loadConfig(path = paths.config): { config: Config; exists: boolean; error?: string } {
  if (!existsSync(path)) return { config: normalize({}), exists: false };
  try {
    return { config: normalize(JSON.parse(readFileSync(path, 'utf8'))), exists: true };
  } catch (err) {
    return { config: normalize({}), exists: true, error: err instanceof Error ? err.message : String(err) };
  }
}

export function saveConfig(config: Config, path = paths.config): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    /* Windows */
  }
}

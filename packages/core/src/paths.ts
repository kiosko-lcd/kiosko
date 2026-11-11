import { existsSync } from 'node:fs';
/**
 * Where Kiosko keeps its things, per platform:
 *   Linux   $XDG_CONFIG_HOME/kiosko  (~/.config/kiosko)
 *   macOS   ~/Library/Application Support/Kiosko
 *   Windows %APPDATA%\Kiosko
 * `KIOSKO_HOME` overrides all of them (tests, portable installs).
 */
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

export function kioskoHome(): string {
  if (process.env.KIOSKO_HOME) return process.env.KIOSKO_HOME;
  const home = homedir();
  switch (platform()) {
    case 'darwin':
      return join(home, 'Library', 'Application Support', 'Kiosko');
    case 'win32':
      return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Kiosko');
    default:
      return join(process.env.XDG_CONFIG_HOME ?? join(home, '.config'), 'kiosko');
  }
}

export const paths = {
  get home() {
    return kioskoHome();
  },
  get config() {
    return join(kioskoHome(), 'config.json');
  },
  /** External plugins: one folder (or npm package) per plugin. */
  get plugins() {
    return join(kioskoHome(), 'plugins');
  },
  /**
   * Per-plugin re-fetchable caches, in RAM: `$XDG_RUNTIME_DIR/kiosko-cache/<plugin>`
   * (or `/dev/shm/kiosko-cache-<uid>/<plugin>`). Null where there is no tmpfs.
   */
  cache(plugin: string): string | null {
    const base = process.env.XDG_RUNTIME_DIR && existsSync(process.env.XDG_RUNTIME_DIR) ? join(process.env.XDG_RUNTIME_DIR, 'kiosko-cache') : existsSync('/dev/shm') ? `/dev/shm/kiosko-cache-${process.getuid?.() ?? 'u'}` : null;
    return base && join(base, plugin.replace(/[^a-z0-9._-]/gi, '_'));
  },
  /** Per-plugin data that must persist: `data/<plugin>`. */
  data(plugin: string) {
    return join(kioskoHome(), 'data', plugin.replace(/[^a-z0-9._-]/gi, '_'));
  },
};

/** `~/x` and `$VAR`/`${VAR}` expanded. */
export function expandPath(p: string): string {
  const v = p.replace(/\$(?:\{(\w+)\}|(\w+))/g, (whole, a?: string, b?: string) => process.env[a ?? b ?? ''] ?? whole);
  return v === '~' || v.startsWith('~/') ? join(homedir(), v.slice(1)) : v;
}

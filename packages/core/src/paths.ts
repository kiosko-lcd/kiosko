import { existsSync } from 'node:fs';
/**
 * Where Kiosko keeps its things, per platform:
 *   Linux   $XDG_CONFIG_HOME/kiosko  (~/.config/kiosko)
 *   macOS   ~/Library/Application Support/Kiosko
 *   Windows %APPDATA%\Kiosko
 * `KIOSKO_HOME` overrides all of them (tests, portable installs). In a
 * sandbox (sandbox.ts) every one of these is inside the sandbox's folder.
 */
import { homedir, platform } from 'node:os';
import { expandPath } from '@kiosko/sdk';
import { join } from 'node:path';
import { SANDBOX_LAYOUT, currentSandbox } from './sandbox.ts';

export function kioskoHome(): string {
  // A sandbox's KIOSKO_HOME is always its own, even if something changed the variable after it started.
  const sb = currentSandbox();
  if (sb) return join(sb.dir, SANDBOX_LAYOUT.kiosko);
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
   * On Windows there is none, but the cache belongs in the machine-local
   * profile (`%LOCALAPPDATA%\\Kiosko\\cache`), not in the roaming one `data/` uses.
   * In a sandbox, always `<sandbox>/run/kiosko-cache/<plugin>`, whatever the platform.
   */
  cache(plugin: string): string | null {
    const sb = currentSandbox();
    if (sb) return join(sb.dir, SANDBOX_LAYOUT.runtime, 'kiosko-cache', plugin.replace(/[^a-z0-9._-]/gi, '_'));
    if (platform() === 'win32') return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Kiosko', 'cache', plugin.replace(/[^a-z0-9._-]/gi, '_'));
    const base = process.env.XDG_RUNTIME_DIR && existsSync(process.env.XDG_RUNTIME_DIR) ? join(process.env.XDG_RUNTIME_DIR, 'kiosko-cache') : existsSync('/dev/shm') ? `/dev/shm/kiosko-cache-${process.getuid?.() ?? 'u'}` : null;
    return base && join(base, plugin.replace(/[^a-z0-9._-]/gi, '_'));
  },
  /** Per-plugin data that must persist: `data/<plugin>`. */
  data(plugin: string) {
    return join(kioskoHome(), 'data', plugin.replace(/[^a-z0-9._-]/gi, '_'));
  },
};

export { expandPath };

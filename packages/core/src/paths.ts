/**
 * Where Tessera keeps its things, per platform:
 *   Linux   $XDG_CONFIG_HOME/tessera  (~/.config/tessera)
 *   macOS   ~/Library/Application Support/Tessera
 *   Windows %APPDATA%\Tessera
 * `TESSERA_HOME` overrides all of them (tests, portable installs).
 */
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

export function tesseraHome(): string {
  if (process.env.TESSERA_HOME) return process.env.TESSERA_HOME;
  const home = homedir();
  switch (platform()) {
    case 'darwin':
      return join(home, 'Library', 'Application Support', 'Tessera');
    case 'win32':
      return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Tessera');
    default:
      return join(process.env.XDG_CONFIG_HOME ?? join(home, '.config'), 'tessera');
  }
}

export const paths = {
  get home() {
    return tesseraHome();
  },
  get config() {
    return join(tesseraHome(), 'config.json');
  },
  /** External plugins: one folder (or npm package) per plugin. */
  get plugins() {
    return join(tesseraHome(), 'plugins');
  },
  /** Per-plugin caches: `data/<plugin>`. */
  data(plugin: string) {
    return join(tesseraHome(), 'data', plugin.replace(/[^a-z0-9._-]/gi, '_'));
  },
};

/** `~/x` and `$VAR`/`${VAR}` expanded. */
export function expandPath(p: string): string {
  const v = p.replace(/\$(?:\{(\w+)\}|(\w+))/g, (whole, a?: string, b?: string) => process.env[a ?? b ?? ''] ?? whole);
  return v === '~' || v.startsWith('~/') ? join(homedir(), v.slice(1)) : v;
}

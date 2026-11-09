/**
 * Reading and writing the config file. The file holds secrets (calendar
 * URLs, tokens), so it's written with 0600 and atomically.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { paths } from '../paths.ts';
import { CONFIG_SCHEMA_ID, type Config } from './model.ts';
import { normalize } from './normalize.ts';

export { normalize };

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
  // One step back, always: a mistaken save is one `mv` away from undone.
  if (existsSync(path)) {
    try {
      copyFileSync(path, `${path}.bak`);
      chmodSync(`${path}.bak`, 0o600);
    } catch {
      /* best effort */
    }
  }
  const tmp = `${path}.tmp`;
  // `$schema` first, so editors pick the schema up and validate the file.
  const { $schema, ...rest } = config;
  const out = { $schema: $schema || CONFIG_SCHEMA_ID, ...rest };
  writeFileSync(tmp, `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    /* Windows */
  }
}

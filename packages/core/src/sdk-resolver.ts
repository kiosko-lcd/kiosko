/**
 * Third-party plugins import `@tessera/sdk` (and the drawing kit) but live
 * in a folder with no node_modules. This resolve hook points those imports
 * at the copies Tessera itself runs with, so a plugin is a single file that
 * works without `npm install`, and every plugin shares one SDK (and one
 * canvas: images from another copy of @napi-rs/canvas can't be drawn).
 */
import { existsSync } from 'node:fs';
import module from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const SHARED = ['@tessera/sdk', '@loksly/lcd-canvas-kit', '@loksly/weather-astro', '@napi-rs/canvas'];
/** In the published bundle these live next to the CLI instead of in node_modules. */
const BUNDLED: Record<string, string> = { '@tessera/sdk': 'sdk.js', '@loksly/lcd-canvas-kit': 'kit.js', '@loksly/weather-astro': 'weather-astro.js' };
let installed = false;

export function installSdkResolver(): void {
  if (installed) return;
  installed = true;
  const urls = new Map<string, string>();
  for (const name of SHARED) {
    const local = BUNDLED[name] ? join(import.meta.dirname, BUNDLED[name]) : null;
    if (local && existsSync(local)) {
      urls.set(name, pathToFileURL(local).href);
      continue;
    }
    try {
      urls.set(name, import.meta.resolve(name));
    } catch {
      /* not installed: the plugin gets the normal resolution error */
    }
  }
  const register = (module as unknown as { registerHooks?: (h: { resolve: (s: string, c: unknown, next: (s: string, c: unknown) => unknown) => unknown }) => void }).registerHooks;
  if (!register) return;
  register({
    resolve(specifier, context, next) {
      const url = urls.get(specifier);
      if (url) return { url, shortCircuit: true, format: url.endsWith('.ts') ? 'module-typescript' : 'module' };
      return next(specifier, context);
    },
  });
}

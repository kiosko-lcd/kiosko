/**
 * Third-party plugins import `@tessera/sdk` (and the drawing kit) but live
 * in a folder with no node_modules. This resolve hook points those imports
 * at the copies Tessera itself runs with, so a plugin is a single file that
 * works without `npm install`, and every plugin shares one SDK (and one
 * canvas: images from another copy of @napi-rs/canvas can't be drawn).
 */
import module from 'node:module';

const SHARED = ['@tessera/sdk', '@loksly/lcd-canvas-kit', '@loksly/weather-astro', '@napi-rs/canvas'];
let installed = false;

export function installSdkResolver(): void {
  if (installed) return;
  installed = true;
  const urls = new Map<string, string>();
  for (const name of SHARED) {
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

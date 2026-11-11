/**
 * What every plugin context shares: language, time formatters, place,
 * working week, log, canvas factory and a per-plugin data folder.
 */
import { mkdirSync } from 'node:fs';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import * as kit from '@loksly/lcd-canvas-kit';
import { createBaseContext, type BaseContext, type CanvasApi } from '@kiosko/sdk';
import type { Config } from './config/model.ts';
import { paths } from './paths.ts';

export const CANVAS: CanvasApi = { createCanvas, loadImage };
export { kit };

export function systemLocale(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || 'en';
  } catch {
    return 'en';
  }
}

export function resolveLocale(cfg: Pick<Config, 'locale'>): string {
  return !cfg.locale || cfg.locale === 'auto' ? systemLocale() : cfg.locale;
}

export type LogFn = (scope: string, msg: string) => void;

/** The base context for `plugin`. `dataDir` is created the first time it's read. */
export function baseContext(cfg: Config, plugin: string, log: LogFn, now: number): BaseContext {
  let made = false;
  const dir = paths.data(plugin);
  const cache = paths.cache(plugin);
  let cacheMade = false;
  const base = createBaseContext({ now, locale: resolveLocale(cfg), timeFormat: cfg.timeFormat, workday: cfg.workday, ...(cfg.location ? { location: cfg.location } : {}), log: (msg: string) => log(plugin, msg) });
  return {
    ...base,
    get cacheDir() {
      if (!cache) return this.dataDir;
      if (!cacheMade) {
        try {
          mkdirSync(cache, { recursive: true });
        } catch {
          return this.dataDir;
        }
        cacheMade = true;
      }
      return cache;
    },
    get dataDir() {
      if (!made) {
        try {
          mkdirSync(dir, { recursive: true });
        } catch {
          /* read-only home: plugins get the path anyway */
        }
        made = true;
      }
      return dir;
    },
  };
}

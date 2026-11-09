/**
 * What every plugin context shares: language, place, log, canvas factory and
 * a per-plugin data folder.
 */
import { mkdirSync } from 'node:fs';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import * as kit from '@loksly/lcd-canvas-kit';
import { localize, type BaseContext, type CanvasApi, type Localized } from '@kiosko/sdk';
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
  const locale = resolveLocale(cfg);
  let made = false;
  const dir = paths.data(plugin);
  return {
    now,
    locale,
    t: (text: Localized) => localize(text, locale),
    log: (msg: string) => log(plugin, msg),
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
    ...(cfg.location ? { location: cfg.location } : {}),
  };
}

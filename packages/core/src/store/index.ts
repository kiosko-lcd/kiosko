/**
 * The plugin store, browser-safe part: the index's types, which panels a
 * widget fits, and what the site and the editor work out from the index
 * (`@kiosko/core/store`). The builder (build.ts, tar.ts) is Node-only and
 * exported from `@kiosko/core`.
 */
export * from './types.ts';
export * from './fit.ts';
export * from './client.ts';

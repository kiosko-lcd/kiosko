/**
 * What a visitor hands the front page to see on its panel: a Kiosko
 * config.json, or one of the files the editor makes (a screen exported from
 * it, the demo's saved layout). Only its shape is looked at here: the
 * runtime, in its worker, is what reads it properly.
 */

/** Why a file can't be shown: not JSON, not a config, or a config with nothing to show. */
export type Problem = 'json' | 'shape' | 'empty';

export interface ShownScreen {
  id: string;
  name?: string;
  width: number;
  height: number;
  pages: { id: string; name?: string; enabled?: boolean }[];
}

/** The config in a file's text, out of whatever it came wrapped in; or why it isn't one. */
export function readConfig(text: string): { config: Record<string, unknown> } | { problem: Problem } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { problem: 'json' };
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return { problem: 'shape' };
  let o = json as Record<string, unknown>;
  // A screen exported from the editor ({ kiosko: 'screen', screen }), or the demo's saved layout ({ rev, config }).
  if (o.kiosko === 'screen' && o.screen && typeof o.screen === 'object') o = { screens: [o.screen] };
  else if (!Array.isArray(o.screens) && o.config && typeof o.config === 'object' && !Array.isArray(o.config)) o = o.config as Record<string, unknown>;
  if (!Array.isArray(o.screens)) return { problem: 'shape' };
  if (!o.screens.length) return { problem: 'empty' };
  return { config: o };
}

/** The screens of a normalized config that get a panel: those with a page to show, three at most. */
export function screensToShow<S extends ShownScreen>(config: { screens: S[] }, most = 3): S[] {
  return config.screens.filter((s) => s.width > 0 && s.height > 0 && s.pages.some((p) => p.enabled !== false)).slice(0, most);
}

/** How much of the stack a number of panels is, as the scene counts it: 0 = one panel, 1 = three. */
export const stackFor = (panels: number): number => Math.max(0, Math.min(2, panels - 1)) / 2;

/**
 * The plugins that ship inside Kiosko itself: the essentials and the bridge
 * from aimonitor. Every other official plugin lives in its own repository
 * (`kiosko-plugin-*`) and is loaded like any third-party one; the npm
 * package lists them as dependencies so a plain install has them all.
 */
import type { PluginDefinition } from '@kiosko/sdk';
import core from '@kiosko/plugin-core';
import legacy from '@kiosko/plugin-legacy';

export const BUILTIN_PLUGINS: PluginDefinition[] = [core, legacy];

/** Official plugins, by id → npm package. Shown in the editor's Plugins page and bundled with the npm package. */
export const OFFICIAL_PLUGINS: { id: string; npm: string }[] = ['agents', 'cats', 'system', 'vitals', 'usage', 'weather', 'calendar', 'news', 'mirror', 'gitlab', 'github', 'calls', 'timesheet', 'llm', 'gpu'].map((id) => ({ id, npm: `kiosko-plugin-${id}` }));

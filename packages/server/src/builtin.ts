/**
 * The plugins that ship inside Tessera itself: the essentials and the bridge
 * from aimonitor. Every other official plugin lives in its own repository
 * (`tessera-plugin-*`) and is loaded like any third-party one; the npm
 * package lists them as dependencies so a plain install has them all.
 */
import type { PluginDefinition } from '@tessera/sdk';
import core from '@tessera/plugin-core';
import legacy from '@tessera/plugin-legacy';

export const BUILTIN_PLUGINS: PluginDefinition[] = [core, legacy];

/** Official plugins, by id → npm package. Shown in the editor's Plugins page and bundled with the npm package. */
export const OFFICIAL_PLUGINS: { id: string; npm: string }[] = ['agents', 'cats', 'system', 'vitals', 'usage', 'weather', 'calendar', 'news', 'mirror', 'gitlab'].map((id) => ({ id, npm: `tessera-plugin-${id}` }));

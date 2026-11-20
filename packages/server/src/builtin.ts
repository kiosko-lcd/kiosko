/**
 * The plugins that ship inside Kiosko itself: the essentials and the bridge
 * from aimonitor. Every other official plugin lives in its own repository
 * (`kiosko-plugin-*`) and is loaded like any third-party one; the npm
 * package lists the bundled ones as dependencies so a plain install has
 * them, and the editor offers the optional ones.
 */
import type { PluginDefinition } from '@kiosko/sdk';
import core from '@kiosko/plugin-core';
import legacy from '@kiosko/plugin-legacy';

export const BUILTIN_PLUGINS: PluginDefinition[] = [core, legacy];

/** Official plugins, by id → npm package, bundled or optional: see official.ts. */
export { BUNDLED_PLUGINS, OFFICIAL_PLUGINS, type OfficialPlugin } from './official.ts';

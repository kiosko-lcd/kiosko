/**
 * The plugins that ship with Tessera. Each lives in `plugins/<name>` and is
 * an ordinary plugin: the same contract as a third-party one.
 */
import type { PluginDefinition } from '@tessera/sdk';
import core from '@tessera/plugin-core';

export const BUILTIN_PLUGINS: PluginDefinition[] = [core];

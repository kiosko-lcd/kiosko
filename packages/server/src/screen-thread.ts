/**
 * The entry point of a screen's thread in Kiosko (see core's threads/): the
 * built-in plugins come compiled in, as in the main thread; the rest are
 * loaded from their modules.
 */
import { runScreenThread } from '@kiosko/core';
import { BUILTIN_PLUGINS } from './builtin.ts';

await runScreenThread(BUILTIN_PLUGINS);

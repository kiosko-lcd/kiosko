/**
 * The default entry point of a screen's thread: every plugin is loaded from
 * its module (none built in). Kiosko's server uses its own, which brings
 * the built-in plugins along (packages/server/src/screen-thread.ts).
 */
import { runScreenThread } from './worker-main.ts';

await runScreenThread();

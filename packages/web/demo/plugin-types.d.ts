// Type-checking the demo runtime (tsconfig.demo.json) must not need the
// plugin repos checked out next to Kiosko (CI doesn't clone them): their
// entry points are typed by this declaration instead. The bundle imports
// the real ones (build.mjs never reads tsconfig.demo.json).
import type { PluginDefinition } from '@kiosko/sdk';

declare const plugin: PluginDefinition;
export default plugin;

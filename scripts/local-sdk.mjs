// Runs a plugin (its tests, a script) against THIS checkout's SDK instead of the one npm installed
// in the plugin's node_modules: for a plugin being translated to a language Kiosko only has here.
//
//   cd ../kiosko-plugin-weather
//   node --conditions=source --import ../kiosko/scripts/local-sdk.mjs --test "src/**/*.test.ts"
//
// The plugin still needs its own dependencies (npm install in its folder).
import { registerHooks } from 'node:module';

const SDK = new URL('../packages/sdk/src/', import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@kiosko/sdk') return { url: `${SDK}index.ts`, shortCircuit: true };
    if (specifier.startsWith('@kiosko/sdk/')) return { url: `${SDK}${specifier.slice('@kiosko/sdk/'.length)}.ts`, shortCircuit: true };
    return next(specifier, context);
  },
});

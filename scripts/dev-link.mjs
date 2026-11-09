// Local development of Kiosko together with its plugin repos, cloned side
// by side:
//
//   kiosko/                 this repo
//   kiosko-plugins/kiosko-plugin-*/
//
// `npm install` here links every plugin as a workspace; this script then
// lets the plugin sources resolve the shared packages (the SDK, the libs)
// from this repo's node_modules.
import { existsSync, lstatSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const plugins = resolve(root, '../kiosko-plugins');
if (!existsSync(plugins)) {
  console.log('no ../kiosko-plugins: nothing to link');
  process.exit(0);
}
const link = join(plugins, 'node_modules');
if (existsSync(link) || (() => { try { return lstatSync(link).isSymbolicLink(); } catch { return false; } })()) {
  console.log(`${link} already there`);
} else {
  symlinkSync(join(root, 'node_modules'), link, process.platform === 'win32' ? 'junction' : 'dir');
  console.log(`${link} → ${join(root, 'node_modules')}`);
}

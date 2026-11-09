/**
 * `kiosko plugins …`: manage the plugins folder from a terminal.
 *
 *   kiosko plugins                 what's loaded and from where
 *   kiosko plugins add <id|pkg>…   install from npm (`agents` → kiosko-plugin-agents)
 *   kiosko plugins link <dir>…     use a local checkout (development, unpublished plugins)
 *   kiosko plugins remove <id|pkg>…
 */
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { paths, type Registry } from '@kiosko/core';
import { localize } from '@kiosko/sdk';

const npmName = (s: string) => (/^[a-z0-9][\w.-]*$/.test(s) && !s.startsWith('kiosko-plugin-') && !s.includes('/') ? `kiosko-plugin-${s}` : s);

function ensureFolder(): string {
  const dir = paths.plugins;
  mkdirSync(dir, { recursive: true });
  const pkg = join(dir, 'package.json');
  if (!existsSync(pkg)) writeFileSync(pkg, `${JSON.stringify({ name: 'kiosko-user-plugins', private: true, type: 'module' }, null, 2)}\n`);
  return dir;
}

function npm(args: string[], cwd: string): void {
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
}

export async function pluginsCommand(argv: string[], registry: () => Promise<Registry>): Promise<void> {
  const [sub = 'list', ...names] = argv;
  switch (sub) {
    case 'list': {
      const r = await registry();
      for (const p of r.list()) {
        const widgets = p.def.widgets?.length ?? 0;
        console.log(`${p.enabled ? '●' : '○'} ${p.def.id.padEnd(10)} v${p.def.version.padEnd(8)} ${String(widgets).padStart(2)} widgets  ${localize(p.def.name, 'en').padEnd(24)} ${p.origin}`);
      }
      for (const pr of r.problems) console.log(`✗ ${pr.origin}: ${pr.message}`);
      console.log(`\nplugins folder: ${paths.plugins}`);
      return;
    }
    case 'add':
    case 'install': {
      if (!names.length) throw new Error('usage: kiosko plugins add <id|npm package>…');
      const dir = ensureFolder();
      // --ignore-scripts: a plugin is code that runs as you; its install shouldn't run anything else.
      npm(['install', '--no-audit', '--no-fund', '--ignore-scripts', ...names.map(npmName)], dir);
      console.log('installed; restart Kiosko to load it (systemctl --user restart kiosko)');
      return;
    }
    case 'link': {
      if (!names.length) throw new Error('usage: kiosko plugins link <folder>…');
      const dir = ensureFolder();
      for (const n of names) {
        const src = resolve(n);
        const pkgPath = join(src, 'package.json');
        if (!existsSync(pkgPath)) throw new Error(`${src} has no package.json`);
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: string; kiosko?: { plugin?: string; id?: string } };
        const entry = pkg.kiosko?.plugin;
        if (entry && !existsSync(join(src, entry))) console.warn(`warning: ${entry} doesn't exist yet in ${src} (run its build)`);
        const target = join(dir, pkg.kiosko?.id ?? basename(src).replace(/^kiosko-plugin-/, ''));
        const existing = (() => {
          try {
            return lstatSync(target);
          } catch {
            return null;
          }
        })();
        if (existing && !existing.isSymbolicLink()) throw new Error(`${target} is a real folder, not a link: move it away first`);
        if (existing) rmSync(target);
        symlinkSync(src, target, process.platform === 'win32' ? 'junction' : 'dir');
        console.log(`${target} → ${src}`);
      }
      console.log('restart Kiosko to load them (systemctl --user restart kiosko)');
      return;
    }
    case 'remove':
    case 'uninstall': {
      const dir = ensureFolder();
      for (const n of names) {
        const id = n.replace(/^kiosko-plugin-/, '');
        const link = join(dir, id);
        const st = (() => {
          try {
            return lstatSync(link);
          } catch {
            return null;
          }
        })();
        if (st?.isSymbolicLink()) {
          rmSync(link);
          console.log(`unlinked ${link}`);
        } else if (st) {
          console.log(`${link} is a folder you put there: delete it yourself if you mean it`);
        } else npm(['uninstall', '--no-audit', '--no-fund', npmName(n)], dir);
      }
      return;
    }
    default:
      console.log('usage: kiosko plugins [list|add <id|pkg>…|link <folder>…|remove <id>…]');
  }
}

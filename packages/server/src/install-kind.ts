/**
 * How this Kiosko was installed, and so how it is updated:
 *
 *   windows-installer  Kiosko-Setup-X.Y.Z-x64.exe (installer/kiosko.iss): a folder
 *                      with node.exe, kiosko.cmd, start-kiosko.vbs, unins000.exe
 *                      and app\cli.js; per user in %LOCALAPPDATA%\Programs\Kiosko
 *   npm-global         `npm install -g kiosko`: <prefix>/lib/node_modules/kiosko/cli.js
 *                      (<prefix>\node_modules\kiosko\cli.js on Windows)
 *   npx                npm's cache (~/.npm/_npx/…): every run fetches its own
 *   source             a checkout: cli.ts with --conditions=source, or a built
 *                      dist/kiosko inside a git repository
 *   other              anything else (a project's node_modules, a copied folder)
 *
 * And whether it runs as the session service `kiosko service install` sets up
 * (systemd user unit, LaunchAgent, scheduled task), which is who restarts it.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import { REGISTRY, releaseAsset, releasePage, windowsInstallerName } from '@kiosko/core';

export type InstallKind = 'windows-installer' | 'npm-global' | 'npx' | 'source' | 'other';
export type ServiceKind = 'systemd' | 'launchd' | 'schtasks' | null;

export interface InstallInfo {
  kind: InstallKind;
  /** The folder Kiosko runs from: the installer's, the npm package's, the checkout's. */
  dir: string;
  /** The CLI file that started this process. */
  cli: string;
  /** npm's global prefix this package is under (npm-global). */
  prefix?: string;
  /** Windows installer: installed for this user only (%LOCALAPPDATA%\Programs), which a silent upgrade can repeat without asking for an administrator. */
  perUser?: boolean;
  service: ServiceKind;
  platform: NodeJS.Platform;
}

export interface DetectInput {
  cli: string;
  execPath: string;
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  exists?: (p: string) => boolean;
  readFile?: (p: string) => string;
}

/** Where things are, from the paths alone (`exists` and `readFile` are the only look at the disk; tests fake them). */
export function detectInstall(i: DetectInput): InstallInfo {
  const exists = i.exists ?? existsSync;
  const read = i.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
  const win = i.platform === 'win32';
  const P = win ? win32 : posix;
  const cli = i.cli;
  const service = detectService(i.platform, i.env, read);
  const base = { cli, service, platform: i.platform };
  const norm = (p: string) => (win ? p.toLowerCase() : p);
  // From source: the TypeScript CLI, or a bundle built inside a checkout.
  const gitUp = (from: string) => {
    for (let d = from, n = 0; n < 8; n++) {
      if (exists(P.join(d, '.git'))) return d;
      const up = P.dirname(d);
      if (up === d) break;
      d = up;
    }
    return null;
  };
  if (cli.endsWith('.ts')) return { ...base, kind: 'source', dir: gitUp(P.dirname(cli)) ?? P.resolve(P.dirname(cli), '..', '..', '..') };
  const dir = P.dirname(cli);
  // The Windows installer: <app>\app\cli.js, run by <app>\node.exe.
  if (win && P.basename(dir).toLowerCase() === 'app') {
    const app = P.dirname(dir);
    if (exists(P.join(app, 'kiosko.cmd')) && exists(P.join(app, 'unins000.exe')) && norm(i.execPath) === norm(P.join(app, 'node.exe'))) {
      const local = i.env.LOCALAPPDATA && norm(app).startsWith(norm(P.join(i.env.LOCALAPPDATA, 'Programs') + P.sep));
      return { ...base, kind: 'windows-installer', dir: app, perUser: !!local };
    }
  }
  const checkout = gitUp(dir);
  if (checkout && !/[\\/]node_modules[\\/]/.test(dir)) return { ...base, kind: 'source', dir: checkout };
  if (/[\\/]_npx[\\/]/.test(dir)) return { ...base, kind: 'npx', dir };
  if (P.basename(dir) === 'kiosko' && P.basename(P.dirname(dir)) === 'node_modules') {
    // Global: <prefix>/lib/node_modules (POSIX) or <prefix>\node_modules (Windows), with npm's `kiosko` shim in the prefix.
    const nm = P.dirname(dir);
    const prefix = win ? P.dirname(nm) : P.basename(P.dirname(nm)) === 'lib' ? P.dirname(P.dirname(nm)) : null;
    const shim = prefix && (win ? exists(P.join(prefix, 'kiosko.cmd')) : exists(P.join(prefix, 'bin', 'kiosko')));
    if (prefix && shim) return { ...base, kind: 'npm-global', dir, prefix };
  }
  return { ...base, kind: 'other', dir };
}

/** Whether this process is the session service: systemd puts it in kiosko.service's cgroup, launchd names it in XPC_SERVICE_NAME. */
export function detectService(platform: NodeJS.Platform, env: Record<string, string | undefined>, read: (p: string) => string): ServiceKind {
  if (platform === 'linux') {
    try {
      if (/\/kiosko\.service(\/|$)/m.test(read('/proc/self/cgroup'))) return 'systemd';
    } catch {
      /* no /proc */
    }
    return null;
  }
  if (platform === 'darwin') return env.XPC_SERVICE_NAME === 'dev.kiosko' ? 'launchd' : null;
  // The scheduled task starts a hidden VBScript that runs cmd → node: nothing in the
  // process says so. The installer's own [Run] restarts it, which is all the updater needs.
  return null;
}

/** This process's install, read from its own command line. */
export function currentInstall(): InstallInfo {
  let cli = process.argv[1] ?? '';
  try {
    cli = realpathSync(cli);
  } catch {
    /* as given */
  }
  return detectInstall({ cli, execPath: process.execPath, platform: process.platform, env: process.env });
}

/** What the editor tells the person to do, per install: a command to run, or a page and a file to download. */
export interface UpdateInstructions {
  kind: InstallKind;
  version: string;
  /** A command to run in a terminal. */
  command?: string;
  /** The release's page. */
  url: string;
  /** The installer to download (Windows). */
  download?: string;
  /** Kiosko has to be stopped first (Windows locks the files a running Kiosko uses). */
  stopFirst?: boolean;
}

/** `npm install -g kiosko@X.Y.Z`, with `--registry` where the person's isn't npm's own (npmmirror in China). */
export const npmInstallCommand = (version: string, registry: string) => `npm install -g kiosko@${version}${registry && registry !== REGISTRY ? ` --registry=${registry}` : ''}`;

export function updateInstructions(info: Pick<InstallInfo, 'kind' | 'platform'>, version: string, registry: string): UpdateInstructions {
  const url = releasePage(version);
  switch (info.kind) {
    case 'windows-installer':
      return { kind: info.kind, version, url, download: releaseAsset(version, windowsInstallerName(version)) };
    case 'source':
      return { kind: info.kind, version, url, command: 'git pull && npm install && npm run web:build' };
    case 'npx':
      return { kind: info.kind, version, url, command: `npx kiosko@${version} start` };
    default:
      return { kind: info.kind, version, url, command: npmInstallCommand(version, registry), ...(info.platform === 'win32' ? { stopFirst: true } : {}) };
  }
}

/**
 * Whether the editor's "Update Kiosko" button may do it here, and why not.
 * npm on Linux and macOS, and the Windows installer. Not npm on Windows
 * (a running Kiosko holds its native modules open, so npm can't replace
 * them), a checkout (git is yours), npx or an unknown folder, nor the demo
 * (there is nothing to update).
 */
export function updateBlocker(info: InstallInfo, o: { demo?: boolean } = {}): string | null {
  if (o.demo) return 'demo';
  if (info.kind === 'windows-installer') return null;
  if (info.kind !== 'npm-global') return info.kind;
  if (info.platform === 'win32') return 'npmWindows';
  return null;
}

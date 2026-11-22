/**
 * "Update Kiosko" from the editor: careful, one step at a time, never on its
 * own (a click starts it) and never two at once.
 *
 * npm (Linux, macOS)  `npm install -g kiosko@X.Y.Z` with the person's npm and
 *                     registry, into the very prefix this Kiosko runs from;
 *                     then the new one is asked `--version` and loads its
 *                     plugins in a dry run (`kiosko self-check --json`). If
 *                     either fails, the previous version is installed again.
 *                     Then a restart: by the service manager when Kiosko is
 *                     the session service; otherwise this process hands over
 *                     to the new one (stops, starts it detached with the same
 *                     arguments, exits once it answers with the new version,
 *                     and takes the panels back if it doesn't).
 * Windows installer   the release's .exe is downloaded and checked against
 *                     the release's .sha256; only after the person confirms
 *                     is it run (silently when installed per user, the wizard
 *                     otherwise). It stops this Kiosko; a small script brings
 *                     Kiosko back afterwards (the service, or a plain start).
 *
 * Everything that touches the system is injected (`UpdaterDeps`), so the
 * whole thing is tested with fakes; server.ts wires the real ones.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, win32 } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { compareVersions, parseVersion } from '@kiosko/sdk';
import { REGISTRY, releaseAsset, windowsInstallerName } from '@kiosko/core';
import type { InstallInfo } from './install-kind.ts';

export type UpdateState = 'idle' | 'working' | 'ready' | 'restarting' | 'done' | 'failed';
/** Steps, by code (the editor names them in its language): */
export type StepCode = 'prefix' | 'install' | 'verify' | 'selfCheck' | 'rollback' | 'restart' | 'download' | 'hash' | 'launch';
export type RestartHow = 'systemd' | 'launchd' | 'handover' | 'manual' | 'installer';

export interface UpdateStep {
  at: number;
  code: StepCode;
  /** null: under way. */
  ok: boolean | null;
  /** What happened, in English (the log's words: versions, paths, npm's last lines). */
  detail?: string;
}

export interface UpdateStatus {
  state: UpdateState;
  /** The version being installed. */
  target: string | null;
  /** The version running. */
  from: string;
  method: 'npm' | 'windows' | null;
  steps: UpdateStep[];
  error: { code: string; detail: string } | null;
  /** The previous version is installed again after a failure. */
  rolledBack: boolean;
  /** How Kiosko comes back with the new version. */
  restart: RestartHow | null;
  /** The installer's checksum, once it matched (Windows). */
  sha256: string | null;
  /** Things worth knowing that didn't stop it (plugins the new Kiosko refuses). */
  warnings: string[];
  /** Where the new Kiosko writes its output when it was started by the handover. */
  logFile: string | null;
}

export interface Run {
  (cmd: string, args: string[], o?: { timeoutMs?: number; env?: Record<string, string | undefined> }): Promise<{ code: number; stdout: string; stderr: string }>;
}

/** What `kiosko self-check --json` prints: the plugins the new bundle loads, and what it couldn't. */
export interface SelfCheck {
  kiosko: 'self-check';
  version: string;
  plugins: { id: string; version?: string }[];
  problems: { origin: string; message: string }[];
  refused: { id?: string; origin: string; reason: string }[];
}

export interface Handover {
  /** Stop listening and painting, so the new one can take the port and the panels. */
  release(): Promise<void>;
  /** Take them back: the new one didn't come up. */
  reclaim(): Promise<void>;
  /** Start the new Kiosko, detached, with this one's arguments; its output to `logFile`. */
  spawn(): { exited: Promise<unknown>; kill(): void };
  /** Who answers on the port now: its version and instance id. */
  probe(): Promise<{ version: string; instance: string } | null>;
  /** This process's instance id (to tell the new one from this one). */
  instance: string;
  /** End this process (the new one is running). */
  exit(): void;
  logFile: string;
}

export interface UpdaterDeps {
  install: InstallInfo;
  current: string;
  /** The registry the update check asked (npm's, npmmirror…). */
  registry: string;
  /** The Node running Kiosko (the new one runs with it too). */
  node: string;
  run: Run;
  fetch: typeof fetch;
  /** Plugins loaded now, and the problems already known (a dry run must not do worse). */
  loaded: () => { ids: string[]; problems: string[] };
  log: (message: string) => void;
  changed: (s: UpdateStatus) => void;
  /** Where the Windows installer is downloaded. */
  tmpDir: string;
  /** Who restarts Kiosko, decided by `restartHow`. */
  restartHow: RestartHow;
  handover?: Handover;
  /** Before restarting: a note the new Kiosko reads at start, to say how it went in its activity log (null: take it back). */
  mark?: (m: UpdateMarker | null) => void;
  /** Windows: run the upgrade script, detached, hidden. */
  launch?: (script: string) => void;
  /** Windows: whether the "Kiosko" scheduled task exists (the service). */
  serviceTask?: () => Promise<boolean>;
  port: number;
  /** Kiosko's folder (%APPDATA%\Kiosko): the log the restarted Kiosko writes to. */
  home: string;
  now?: () => number;
  /** How long the new Kiosko has to answer after a handover (ms). */
  handoverTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface UpdateMarker {
  from: string;
  to: string;
  at: number;
  how: RestartHow;
  /** What the old Kiosko logged on the way, for the new one's activity log. */
  lines?: string[];
}

export class UpdateError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'UpdateError';
  }
}

const tail = (s: string, n = 600) => (s.length > n ? `…${s.slice(-n)}` : s).trim();
/** What a failed command said that matters: its first error line (a stack's tail says nothing), else its last lines. */
const why = (s: string, n = 300) => s.split(/\r?\n/).map((l) => l.trim()).find((l) => /^(\w*Error|npm (ERR|error))\b/.test(l))?.slice(0, n) ?? tail(s, n);
const isVersion = (v: unknown): v is string => typeof v === 'string' && !!parseVersion(v) && /^\d+\.\d+\.\d+(-[\w.]+)?$/.test(v);

/** The last line of a command's output that is a JSON object (plugins may print before it). */
export function lastJson<T>(out: string): T | null {
  for (const line of out.split(/\r?\n/).reverse()) {
    const l = line.trim();
    if (!l.startsWith('{')) continue;
    try {
      return JSON.parse(l) as T;
    } catch {
      /* not this one */
    }
  }
  return null;
}

/**
 * Whether the new bundle's dry run is at least as good as what runs now:
 * every plugin loaded now loads (or is refused for a reason, which is said),
 * and no new load error.
 */
export function judgeSelfCheck(now: { ids: string[]; problems: string[] }, next: SelfCheck, target: string): { ok: boolean; why?: string; warnings: string[] } {
  if (next.version !== target) return { ok: false, why: `the new Kiosko says it is ${next.version}, not ${target}`, warnings: [] };
  const refusedIds = new Set(next.refused.map((r) => r.id).filter(Boolean));
  const has = new Set(next.plugins.map((p) => p.id));
  const missing = now.ids.filter((id) => !has.has(id) && !refusedIds.has(id));
  const fresh = next.problems.filter((p) => !now.problems.includes(p.message) && !next.refused.some((r) => r.origin === p.origin));
  const warnings = next.refused.filter((r) => r.id && now.ids.includes(r.id)).map((r) => `${r.id}: ${r.reason}`);
  if (missing.length || fresh.length) return { ok: false, why: [missing.length ? `plugins that would not load: ${missing.join(', ')}` : '', ...fresh.map((p) => `${p.origin}: ${p.message}`)].filter(Boolean).join('; '), warnings };
  return { ok: true, warnings };
}

/** `abc…  Kiosko-Setup-0.2.9-x64.exe` → the hash, if it names that file (or no file). */
export function parseSha256File(text: string, name: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const m = /^([a-f0-9]{64})(?:\s+\*?(.+?))?\s*$/i.exec(line.trim());
    if (m && (!m[2] || m[2] === name)) return m[1]!.toLowerCase();
  }
  return null;
}

export async function sha256File(file: string): Promise<string> {
  const h = createHash('sha256');
  await pipeline(createReadStream(file), h);
  return h.digest('hex');
}

/** Who brings Kiosko back after an npm update. In a terminal (or as a container's first process), the person does. */
export function restartHow(info: InstallInfo, o: { tty: boolean; pid: number }): RestartHow {
  if (info.kind === 'windows-installer') return 'installer';
  if (info.service === 'systemd') return 'systemd';
  if (info.service === 'launchd') return 'launchd';
  if (o.tty || o.pid === 1) return 'manual';
  return 'handover';
}

/** The silent-upgrade flags of the Windows installer: silent for a per-user install (no administrator), the wizard otherwise. */
export function installerArgs(perUser: boolean, log: string): string[] {
  return [...(perUser ? ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/CURRENTUSER'] : []), `/LOG=${log}`];
}

/**
 * The script that runs the Windows installer and brings Kiosko back. The
 * installer stops this Kiosko (its PrepareToInstall ends the service and the
 * processes of this folder) and starts the service again when it was chosen
 * at install time (Inno Setup keeps the tasks). Afterwards: the scheduled
 * task back if it was there and isn't, then wait up to 20 s for the editor's
 * port; nobody there, start Kiosko (the service's task, or a plain start
 * with its output in kiosko.log). Batch, no PowerShell: runs everywhere.
 */
export function windowsUpgradeScript(o: { exe: string; args: string[]; dir: string; service: boolean; port: number; log: string }): string {
  const q = (s: string) => `"${s}"`;
  const kcmd = win32.join(o.dir, 'kiosko.cmd');
  const up = `curl.exe -s -o nul -m 2 http://127.0.0.1:${o.port}/api/version`;
  return [
    '@echo off',
    // Paths with accents (a user's name): the lines after this one are read as UTF-8.
    'chcp 65001 >nul',
    'rem Written by Kiosko to update itself: runs the installer, then starts Kiosko again.',
    `${q(o.exe)} ${o.args.map((a) => (a.startsWith('/LOG=') ? `/LOG=${q(a.slice(5))}` : a)).join(' ')}`,
    ...(o.service ? [`schtasks /Query /TN Kiosko >nul 2>&1 || call ${q(kcmd)} service install >> ${q(o.log)} 2>&1`] : []),
    'for /l %%i in (1,1,20) do (',
    `  ${up} && goto :eof`,
    '  ping -n 2 127.0.0.1 >nul',
    ')',
    o.service ? 'schtasks /Run /TN Kiosko >nul 2>&1' : `${q(kcmd)} start >> ${q(o.log)} 2>&1`,
    '',
  ].join('\r\n');
}

const idle = (from: string): UpdateStatus => ({ state: 'idle', target: null, from, method: null, steps: [], error: null, rolledBack: false, restart: null, sha256: null, warnings: [], logFile: null });

export class KioskoUpdater {
  status: UpdateStatus;
  private file: string | null = null;
  /** This update's log lines, carried across the restart in the marker. */
  private lines: string[] = [];
  private readonly d: UpdaterDeps;
  constructor(d: UpdaterDeps) {
    this.d = d;
    this.status = idle(d.current);
  }

  private get now() {
    return (this.d.now ?? Date.now)();
  }

  private set(patch: Partial<UpdateStatus>): void {
    this.status = { ...this.status, ...patch };
    this.d.changed(this.status);
  }

  private step(code: StepCode, ok: boolean | null, detail?: string): void {
    const steps = [...this.status.steps];
    const open = steps.findLastIndex((s) => s.code === code && s.ok === null);
    const keep = detail ?? (open >= 0 ? steps[open]!.detail : undefined);
    const s: UpdateStep = { at: this.now, code, ok, ...(keep ? { detail: keep } : {}) };
    if (open >= 0 && ok !== null) steps[open] = s;
    else steps.push(s);
    if (ok !== null || detail) this.say(`${code}${ok === false ? ' failed' : ok ? ' ok' : ''}${detail ? `: ${detail}` : ''}`);
    this.set({ steps });
  }

  private say(line: string): void {
    this.lines.push(line);
    this.d.log(line);
  }

  get busy(): boolean {
    return this.status.state === 'working' || this.status.state === 'restarting';
  }

  /** npm next to this Node (nvm, Homebrew…), else the one on the PATH. */
  private npm(): string {
    const here = join(dirname(this.d.node), process.platform === 'win32' ? 'npm.cmd' : 'npm');
    return existsSync(here) ? here : process.platform === 'win32' ? 'npm.cmd' : 'npm';
  }

  private registryArgs(): string[] {
    return this.d.registry && this.d.registry !== REGISTRY ? [`--registry=${this.d.registry}`] : [];
  }

  /** Starts an update to `version` (the newest the check found). Resolves when it ends (or is ready to confirm, on Windows). */
  async start(version: string): Promise<UpdateStatus> {
    if (this.busy) throw new UpdateError('busy', 'an update is already under way');
    if (!isVersion(version) || compareVersions(version, this.d.current) <= 0) throw new UpdateError('noUpdate', `${String(version)} is not newer than ${this.d.current}`);
    const method = this.d.install.kind === 'windows-installer' ? 'windows' : 'npm';
    if (this.status.state === 'ready' && this.status.target === version) return this.status;
    this.discard();
    this.status = { ...idle(this.d.current), state: 'working', target: version, method };
    this.lines = [];
    this.say(`updating Kiosko ${this.d.current} → ${version} (${this.d.install.kind}, ${this.d.install.dir})`);
    this.d.changed(this.status);
    try {
      if (method === 'windows') await this.downloadInstaller(version);
      else await this.viaNpm(version);
    } catch (err) {
      const e = err instanceof UpdateError ? err : new UpdateError('failed', err instanceof Error ? err.message : String(err));
      this.d.log(`update failed (${e.code}): ${e.message}`);
      this.set({ state: 'failed', error: { code: e.code, detail: e.message } });
    }
    return this.status;
  }

  // ---------- npm ----------

  private async viaNpm(version: string): Promise<void> {
    const { install, current } = this.d;
    if (install.kind !== 'npm-global' || !install.prefix) throw new UpdateError('cantUpdate', `this Kiosko is not a global npm install (${install.kind})`);
    const npm = this.npm();
    // 1. npm's global folder must be the one this Kiosko runs from (another Node, another prefix: it would install elsewhere).
    this.step('prefix', null);
    const pr = await this.d.run(npm, ['prefix', '-g'], { timeoutMs: 30_000 });
    const real = (p: string) => {
      try {
        return realpathSync(p);
      } catch {
        return p;
      }
    };
    const prefix = pr.stdout.trim().split(/\r?\n/).at(-1) ?? '';
    if (pr.code !== 0 || real(prefix) !== real(install.prefix)) {
      this.step('prefix', false, `npm installs into ${prefix || '(npm did not say)'}, but this Kiosko runs from ${install.prefix}`);
      throw new UpdateError('prefixMismatch', `npm's global folder is ${prefix || 'unknown'}, not ${install.prefix}: update it by hand with that npm`);
    }
    this.step('prefix', true, prefix);
    // 2. Install exactly that version.
    this.step('install', null, `npm install -g kiosko@${version}${this.registryArgs().length ? ` ${this.registryArgs()[0]}` : ''}`);
    const inst = await this.d.run(npm, ['install', '-g', '--no-audit', '--no-fund', `kiosko@${version}`, ...this.registryArgs()], { timeoutMs: 15 * 60_000 });
    if (inst.code !== 0) {
      this.step('install', false, tail(inst.stderr || inst.stdout));
      await this.rollback(current, false);
      throw new UpdateError('installFailed', `npm could not install kiosko@${version}: ${why(inst.stderr || inst.stdout)}`);
    }
    this.step('install', true);
    // 3. The new one runs, and is the right version.
    const problem = await this.verify(version);
    if (problem) {
      await this.rollback(current, true);
      throw new UpdateError('verifyFailed', problem);
    }
    // 4. Restart.
    await this.restart(version);
  }

  /** null if the installed Kiosko is `version` and its dry run loads what runs now; else why not. */
  private async verify(version: string): Promise<string | null> {
    const cli = this.d.install.cli;
    this.step('verify', null);
    const v = await this.d.run(this.d.node, [cli, '--version'], { timeoutMs: 60_000 });
    const said = v.stdout.trim().split(/\r?\n/).at(-1)?.trim() ?? '';
    if (v.code !== 0 || said !== version) {
      const problem = v.code !== 0 ? `the new Kiosko does not start: ${why(v.stderr || v.stdout)}` : `the installed Kiosko says ${said || 'nothing'}, not ${version}`;
      this.step('verify', false, problem);
      return problem;
    }
    this.step('verify', true, `kiosko --version: ${said}`);
    this.step('selfCheck', null);
    const c = await this.d.run(this.d.node, [cli, 'self-check', '--json'], { timeoutMs: 120_000, env: { ...process.env, KIOSKO_QUIET: '1' } });
    const report = lastJson<SelfCheck>(c.stdout);
    if (c.code !== 0 && !report) {
      const problem = `the new Kiosko failed loading its plugins: ${why(c.stderr || c.stdout)}`;
      this.step('selfCheck', false, problem);
      return problem;
    }
    if (report?.kiosko !== 'self-check') {
      // A version without the dry run: --version is all it can say.
      this.step('selfCheck', true, 'no dry run in that version: checked its version only');
      return null;
    }
    const j = judgeSelfCheck(this.d.loaded(), report, version);
    if (j.warnings.length) this.set({ warnings: j.warnings });
    if (!j.ok) {
      this.step('selfCheck', false, j.why);
      return j.why ?? 'the dry run failed';
    }
    this.step('selfCheck', true, `${report.plugins.length} plugins load${j.warnings.length ? `; not with this version: ${j.warnings.join('; ')}` : ''}`);
    return null;
  }

  /** Puts `version` back (after a failed install or check), and checks it is. */
  private async rollback(version: string, needed: boolean): Promise<void> {
    if (!needed) {
      // npm failed: did it leave the old one in place? Ask it.
      const v = await this.d.run(this.d.node, [this.d.install.cli, '--version'], { timeoutMs: 60_000 }).catch(() => ({ code: 1, stdout: '', stderr: '' }));
      if (v.code === 0 && v.stdout.trim().split(/\r?\n/).at(-1)?.trim() === version) return;
    }
    this.step('rollback', null, `npm install -g kiosko@${version}`);
    const r = await this.d.run(this.npm(), ['install', '-g', '--no-audit', '--no-fund', `kiosko@${version}`, ...this.registryArgs()], { timeoutMs: 15 * 60_000 });
    const v = r.code === 0 ? await this.d.run(this.d.node, [this.d.install.cli, '--version'], { timeoutMs: 60_000 }) : null;
    if (v && v.code === 0 && v.stdout.trim().split(/\r?\n/).at(-1)?.trim() === version) {
      this.step('rollback', true, `${version} is installed again`);
      this.set({ rolledBack: true });
      return;
    }
    this.step('rollback', false, tail(r.stderr || r.stdout || 'the previous version did not come back'));
    throw new UpdateError('rollbackFailed', `the update failed and ${version} could not be installed again: this Kiosko keeps running, but before restarting it run: npm install -g kiosko@${version}`);
  }

  private async restart(version: string): Promise<void> {
    const how = this.d.restartHow;
    this.d.mark?.({ from: this.d.current, to: version, at: this.now, how, lines: this.lines.slice(-30) });
    if (how === 'manual') {
      this.step('restart', true, `installed; restart Kiosko to use ${version}`);
      this.set({ state: 'done', restart: 'manual' });
      return;
    }
    this.set({ state: 'restarting', restart: how });
    if (how === 'systemd' || how === 'launchd') {
      const uid = process.getuid?.() ?? 0;
      const [cmd, args] = how === 'systemd' ? ['systemctl', ['--user', '--no-block', 'restart', 'kiosko.service']] : ['launchctl', ['kickstart', '-k', `gui/${uid}/dev.kiosko`]];
      this.step('restart', null, `${cmd} ${(args as string[]).join(' ')}`);
      const r = await this.d.run(cmd as string, args as string[], { timeoutMs: 30_000 });
      if (r.code !== 0) {
        this.step('restart', false, tail(r.stderr || r.stdout));
        this.set({ state: 'done', restart: 'manual' });
        throw new UpdateError('restartFailed', `${version} is installed, but the service did not restart (${tail(r.stderr || r.stdout, 200)}): restart Kiosko yourself`);
      }
      return;
    }
    // handover
    const h = this.d.handover;
    if (!h) throw new UpdateError('restartFailed', 'no way to restart here');
    this.step('restart', null, `handing over to ${version}; its output goes to ${h.logFile}`);
    this.set({ logFile: h.logFile });
    await h.release();
    const child = h.spawn();
    let gone = false;
    void child.exited.then(() => (gone = true));
    const sleep = this.d.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    const until = this.now + (this.d.handoverTimeoutMs ?? 60_000);
    while (this.now < until && !gone) {
      await sleep(500);
      const p = await h.probe().catch(() => null);
      if (p && p.version === version && p.instance !== h.instance) {
        this.d.log(`Kiosko ${version} is running; this one (${this.d.current}) stops`);
        h.exit();
        return;
      }
    }
    child.kill();
    await h.reclaim();
    this.d.mark?.(null);
    this.step('restart', false, gone ? `the new Kiosko stopped right away (see ${h.logFile})` : 'the new Kiosko did not answer in time');
    // The files on disk are the new version's: put the old ones back, so a later restart runs what runs now.
    await this.rollback(this.d.current, true).catch((err) => this.d.log(String(err instanceof Error ? err.message : err)));
    throw new UpdateError('restartFailed', `Kiosko ${version} did not start (see ${h.logFile}); ${this.d.current} keeps running`);
  }

  // ---------- Windows ----------

  private async downloadInstaller(version: string): Promise<void> {
    const name = windowsInstallerName(version);
    const exeUrl = releaseAsset(version, name);
    const dir = join(this.d.tmpDir, `kiosko-update-${version}`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const file = join(dir, name);
    this.step('download', null, exeUrl);
    let expected: string | null;
    try {
      const r = await this.d.fetch(`${exeUrl}.sha256`, { redirect: 'follow' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      expected = parseSha256File((await r.text()).slice(0, 4096), name);
    } catch (err) {
      this.step('download', false, `${name}.sha256: ${err instanceof Error ? err.message : String(err)}`);
      throw new UpdateError('downloadFailed', `could not download ${name}.sha256 from GitHub: download the installer from the release page instead`);
    }
    if (!expected) {
      this.step('download', false, `${name}.sha256 names no checksum for ${name}`);
      throw new UpdateError('hashMissing', `the release has no usable checksum for ${name}: not running it`);
    }
    const hash = createHash('sha256');
    let size = 0;
    try {
      const r = await this.d.fetch(exeUrl, { redirect: 'follow' });
      if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
      const count = new Transform({
        transform(chunk: Buffer, _e, cb) {
          size += chunk.length;
          if (size > 500 * 1024 * 1024) return cb(new Error('larger than 500 MB: not an installer of ours'));
          hash.update(chunk);
          cb(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(r.body as never), count, createWriteStream(file));
    } catch (err) {
      rmSync(dir, { recursive: true, force: true });
      this.step('download', false, err instanceof Error ? err.message : String(err));
      throw new UpdateError('downloadFailed', `could not download ${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.step('download', true, `${(size / 1024 / 1024).toFixed(1)} MB`);
    const got = hash.digest('hex');
    if (got !== expected) {
      rmSync(dir, { recursive: true, force: true });
      this.step('hash', false, `sha256 ${got}, the release says ${expected}`);
      throw new UpdateError('hashMismatch', `${name} is not the file the release publishes (sha256 ${got.slice(0, 12)}…, expected ${expected.slice(0, 12)}…): deleted, not run`);
    }
    this.step('hash', true, `sha256 ${got}`);
    this.file = file;
    this.set({ state: 'ready', sha256: got });
  }

  /** Windows, after the person confirms: checks the file once more and runs the installer. */
  async confirm(version: string): Promise<UpdateStatus> {
    if (this.status.state !== 'ready' || this.status.target !== version || !this.file) throw new UpdateError('notReady', `no verified installer of ${String(version)} waiting`);
    const got = await sha256File(this.file).catch(() => null);
    if (got !== this.status.sha256) {
      this.discard();
      this.set({ state: 'failed', error: { code: 'hashMismatch', detail: 'the downloaded installer changed since it was checked: deleted, not run' } });
      return this.status;
    }
    const info = this.d.install;
    const dir = dirname(this.file);
    const service = (await this.d.serviceTask?.().catch(() => false)) ?? false;
    const script = join(dir, 'kiosko-upgrade.cmd');
    const log = win32.join(this.d.home, 'kiosko.log');
    writeFileSync(script, windowsUpgradeScript({ exe: this.file, args: installerArgs(!!info.perUser, join(dir, 'install.log')), dir: info.dir, service, port: this.d.port, log }));
    this.d.mark?.({ from: this.d.current, to: version, at: this.now, how: 'installer', lines: this.lines.slice(-30) });
    this.step('launch', true, `${this.file} ${installerArgs(!!info.perUser, join(dir, 'install.log')).join(' ')}${info.perUser ? '' : ' (the wizard: this Kiosko is not installed per user)'}`);
    this.set({ state: 'restarting', restart: 'installer' });
    this.d.launch?.(script);
    return this.status;
  }

  /** Forgets a downloaded installer (Cancel in the editor, or a new start). */
  discard(): void {
    if (this.file) rmSync(dirname(this.file), { recursive: true, force: true });
    this.file = null;
    if (this.status.state === 'ready') this.set(idle(this.d.current));
  }
}

/** Runs a command, never throwing: its exit code and output. */
export const realRun: Run = (cmd, args, o = {}) =>
  new Promise((ok) => {
    const win = process.platform === 'win32';
    const child = spawn(cmd, args, { env: o.env ?? process.env, shell: win && /\.cmd$/i.test(cmd), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout = (stdout + d).slice(-20_000)));
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-20_000)));
    const t = setTimeout(() => child.kill(), o.timeoutMs ?? 120_000);
    child.on('error', (err) => {
      clearTimeout(t);
      ok({ code: 127, stdout, stderr: stderr || err.message });
    });
    child.on('close', (code) => {
      clearTimeout(t);
      ok({ code: code ?? 1, stdout, stderr });
    });
  });

/** The note the restarted Kiosko reads: `update.json` in Kiosko's folder. */
export const markerFile = (home: string) => join(home, 'update.json');

export function writeMarker(home: string, m: UpdateMarker | null): void {
  if (!m) return void rmSync(markerFile(home), { force: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(markerFile(home), `${JSON.stringify(m)}\n`);
}

/**
 * At start: how the last update went, from the note it left (and the note
 * goes). An hour old at most: an older one says nothing about this start.
 */
export function readMarker(home: string, version: string, now = Date.now()): { ok: boolean; message: string; lines: string[] } | null {
  const f = markerFile(home);
  if (!existsSync(f)) return null;
  let m: Partial<UpdateMarker> = {};
  try {
    m = JSON.parse(readFileSync(f, 'utf8')) as UpdateMarker;
  } catch {
    /* unreadable: just remove it */
  }
  rmSync(f, { force: true });
  if (typeof m.at !== 'number' || now - m.at > 3600_000 || !m.to || !m.from) return null;
  const lines = Array.isArray(m.lines) ? m.lines.filter((l): l is string => typeof l === 'string').slice(-30) : [];
  if (m.to === version) return { ok: true, message: `Kiosko updated from ${m.from} to ${version}`, lines };
  return { ok: false, message: `the update to ${m.to} did not happen: this is Kiosko ${version}`, lines };
}

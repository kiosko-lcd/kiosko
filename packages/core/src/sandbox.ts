/**
 * Sandbox mode (`kiosko start --sandbox [dir]`, or `KIOSKO_SANDBOX=dir`): a
 * throwaway Kiosko for tests, e2e runs and trying things out that can never
 * touch the real installation on the same machine.
 *
 * Everything Kiosko (and its plugins, and the programs it starts) finds
 * through the environment is pointed inside the sandbox folder by one
 * function, `sandboxEnv`: the home folder, the XDG folders (config, data,
 * cache, state and the runtime dir, where the plugins' RAM caches live),
 * `%APPDATA%`/`%LOCALAPPDATA%`/`%USERPROFILE%`, the temp folder, npm's cache
 * and `KIOSKO_HOME`. `applySandbox` writes them into `process.env` before
 * anything reads a path, so `os.homedir()`, `os.tmpdir()`, `paths.*` and
 * `expandPath('$XDG_RUNTIME_DIR/…')` all answer inside it. Absolute paths in a
 * config (a Frame file screen's folder) are moved inside with `confinePath`.
 *
 * What a sandbox doesn't do unless asked (`KIOSKO_SANDBOX_ALLOW`): drive USB
 * panels (or the `trcc serve` that drives them), talk to remote screens on
 * the network (mDNS, pairing), listen beyond 127.0.0.1 or publish to Home
 * Assistant. It never updates Kiosko or installs a service, and it refuses
 * the default port (7420) unless forced.
 *
 * Running sandboxes register themselves in the system temp folder (one file
 * per process, `kiosko sandbox list|stop`), and can end by themselves after a
 * time (`--sandbox-ttl`) or when the process that started them goes away.
 *
 * This module imports nothing of Kiosko: the CLI loads it before anything else.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

/** What a sandbox may do that it otherwise doesn't. */
export type SandboxAllow = 'usb' | 'remote' | 'lan';
export const SANDBOX_ALLOWS: readonly SandboxAllow[] = ['usb', 'remote', 'lan'];

/** Kiosko's default port: the real installation's, which a sandbox doesn't take unless forced. */
export const DEFAULT_PORT = 7420;
/** A sandbox's lifetime when none is given: 2 hours. */
export const DEFAULT_SANDBOX_TTL_MS = 2 * 3600_000;

export interface Sandbox {
  /** The sandbox folder (absolute). Everything Kiosko writes goes under it. */
  dir: string;
  allow: ReadonlySet<SandboxAllow>;
  /** Where running sandboxes register themselves: in the system temp folder, outside every sandbox. */
  registry: string;
}

/** The sandbox this process runs in, from the environment (`applySandbox` puts it there), or null. */
export function currentSandbox(env: NodeJS.ProcessEnv = process.env): Sandbox | null {
  const dir = env.KIOSKO_SANDBOX;
  if (!dir) return null;
  const allow = new Set(
    (env.KIOSKO_SANDBOX_ALLOW ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s): s is SandboxAllow => (SANDBOX_ALLOWS as readonly string[]).includes(s)),
  );
  return { dir: resolve(dir), allow, registry: env.KIOSKO_SANDBOX_REGISTRY || sandboxRegistryDir(env) };
}

export function inSandbox(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env.KIOSKO_SANDBOX;
}

/** Whether this process may do `what`: always outside a sandbox, inside only when allowed. */
export function sandboxAllows(what: SandboxAllow, env: NodeJS.ProcessEnv = process.env): boolean {
  const sb = currentSandbox(env);
  return !sb || sb.allow.has(what);
}

/** Where running sandboxes are listed: `<system temp>/kiosko-sandboxes-<uid>` (or `KIOSKO_SANDBOX_REGISTRY`). */
export function sandboxRegistryDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.KIOSKO_SANDBOX_REGISTRY) return env.KIOSKO_SANDBOX_REGISTRY;
  return join(tmpdir(), `kiosko-sandboxes-${process.getuid?.() ?? (env.USERNAME || 'user').replace(/[^\w.-]/g, '_')}`);
}

/** The folders a sandbox has, relative to its folder. */
export const SANDBOX_LAYOUT = {
  /** `KIOSKO_HOME`: config.json, plugins/, data/, the store's cache, kiosko.log, push tokens. */
  kiosko: 'kiosko',
  /** `HOME` / `USERPROFILE`: `~` for Kiosko, its plugins and what they start (npm, git…). */
  home: 'home',
  config: 'xdg/config',
  data: 'xdg/data',
  cache: 'xdg/cache',
  state: 'xdg/state',
  /** `XDG_RUNTIME_DIR`: the plugins' RAM caches (`kiosko-cache/<plugin>`), sockets, Frame files written to `$XDG_RUNTIME_DIR/…`. */
  runtime: 'run',
  tmp: 'tmp',
  /** Where absolute paths outside the sandbox (in a config) are moved: `outside/<the path>`. */
  outside: 'outside',
} as const;

/** Variables a sandbox removes: they would point Kiosko's plugins at the real installation's folders. */
export const SANDBOX_UNSET = ['AIMONITOR_DIR', 'AGENT_SESSIONS_DIR', 'npm_config_prefix', 'NPM_CONFIG_PREFIX'] as const;

/**
 * The environment of a sandbox in `dir`: the one place where every path
 * Kiosko and its plugins find through the environment is decided. The values
 * are set; the names in SANDBOX_UNSET are removed.
 */
export function sandboxEnv(dir: string, o: { allow?: Iterable<SandboxAllow>; registry: string }): Record<string, string> {
  const root = resolve(dir);
  const at = (k: keyof typeof SANDBOX_LAYOUT) => join(root, SANDBOX_LAYOUT[k]);
  const home = at('home');
  const env: Record<string, string> = {
    KIOSKO_SANDBOX: root,
    KIOSKO_SANDBOX_REGISTRY: o.registry,
    KIOSKO_SANDBOX_ALLOW: [...new Set(o.allow ?? [])].join(','),
    KIOSKO_HOME: at('kiosko'),
    HOME: home,
    XDG_CONFIG_HOME: at('config'),
    XDG_DATA_HOME: at('data'),
    XDG_CACHE_HOME: at('cache'),
    XDG_STATE_HOME: at('state'),
    XDG_RUNTIME_DIR: at('runtime'),
    TMPDIR: at('tmp'),
    TMP: at('tmp'),
    TEMP: at('tmp'),
    npm_config_cache: join(home, '.npm'),
    // No daily "is there a newer Kiosko / plugin" question to npm, and nothing in the real Home Assistant.
    KIOSKO_NO_UPDATE_CHECK: '1',
  };
  // Set everywhere, not only on Windows: a plugin may read them wherever they are set (WSL, Wine, a copied environment).
  Object.assign(env, { USERPROFILE: home, APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local') });
  return env;
}

/** Every folder `sandboxEnv` points at, to create them (the runtime dir must exist to be used). */
function sandboxDirs(env: Record<string, string>): string[] {
  return ['KIOSKO_HOME', 'HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR', 'TMPDIR', 'APPDATA', 'LOCALAPPDATA'].flatMap((k) => (env[k] ? [env[k]] : []));
}

/**
 * Turns this process into a sandbox in `dir` (created if missing; with no
 * `dir`, a fresh one in the system temp folder): sets the environment
 * (`sandboxEnv`) and creates its folders. Returns the sandbox.
 */
export function applySandbox(dir: string | undefined, o: { allow?: Iterable<SandboxAllow>; env?: NodeJS.ProcessEnv } = {}): Sandbox & { created: boolean } {
  const env = o.env ?? process.env;
  // Decided before the environment changes: the system temp folder, not the sandbox's.
  const registry = sandboxRegistryDir(env);
  const created = !dir;
  const root = dir ? resolve(dir) : mkdtempSync(join(tmpdir(), 'kiosko-sandbox-'));
  const vars = sandboxEnv(root, { allow: o.allow ?? [], registry });
  for (const k of SANDBOX_UNSET) delete env[k];
  Object.assign(env, vars);
  for (const d of sandboxDirs(vars)) mkdirSync(d, { recursive: true, mode: 0o700 });
  return { ...currentSandbox(env)!, created };
}

/** Whether `p` is `dir` or inside it. */
export function isInside(p: string, dir: string): boolean {
  const r = relative(resolve(dir), resolve(p));
  return r === '' || (!!r && !r.startsWith('..') && !isAbsolute(r));
}

/**
 * `p` if it is inside the sandbox; otherwise the same path under the
 * sandbox's `outside/` folder (`/run/user/1000/frames` → `<sandbox>/outside/run/user/1000/frames`).
 * Outside a sandbox, `p` as it is.
 */
export function confinePath(p: string, env: NodeJS.ProcessEnv = process.env): string {
  const sb = currentSandbox(env);
  if (!sb || isInside(p, sb.dir)) return p;
  const abs = resolve(sb.dir, p);
  if (isInside(abs, sb.dir)) return abs;
  // Drop the root (`/`, `C:\`, `\\server\share\`) and keep the rest.
  const rest = abs.replace(/^([a-zA-Z]:)?[\\/]+/, '').replace(/:/g, '');
  return join(sb.dir, SANDBOX_LAYOUT.outside, rest);
}

/**
 * Durations: `90s`, `30m`, `2h`, `1d`, `500ms`, or a number of seconds.
 * `0`, `off`, `none`, `never`: no limit (null). Throws on anything else.
 */
export function parseDuration(s: string): number | null {
  const v = s.trim().toLowerCase();
  if (['0', 'off', 'none', 'never', 'no'].includes(v)) return null;
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/.exec(v);
  if (!m) throw new Error(`not a duration: "${s}" (use e.g. 90s, 30m, 2h, 1d or off)`);
  const n = Number(m[1]);
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3600_000, d: 86_400_000 }[(m[2] ?? 's') as 'ms' | 's' | 'm' | 'h' | 'd'];
  const ms = Math.round(n * unit);
  return ms > 0 ? ms : null;
}

export function formatDuration(ms: number): string {
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000}d`;
  if (ms % 3600_000 === 0) return `${ms / 3600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1000 === 0) return `${ms / 1000}s`;
  return `${ms}ms`;
}

/** Why a sandbox may not listen on `port`, or null: the default port is the real Kiosko's. */
export function sandboxPortProblem(port: number, o: { force?: boolean } = {}): string | null {
  if (port === DEFAULT_PORT && !o.force) return `a sandbox doesn't listen on ${DEFAULT_PORT}, the real Kiosko's port: pick another with --port (or force it with --sandbox-force-port)`;
  return null;
}

/** Whether `host` is a loopback address. */
export function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host);
}

// ---------------------------------------------------------------- lifetime

export interface LifetimeDeps {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (t: unknown) => void;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (t: unknown) => void;
  /** The parent's pid now (it changes when the parent dies and the process is adopted). */
  ppid: () => number;
  alive: (pid: number) => boolean;
}

const realLifetimeDeps: LifetimeDeps = {
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref();
    return t;
  },
  clearTimeout: (t) => clearTimeout(t as NodeJS.Timeout),
  setInterval: (fn, ms) => {
    const t = setInterval(fn, ms);
    t.unref();
    return t;
  },
  clearInterval: (t) => clearInterval(t as NodeJS.Timeout),
  ppid: () => process.ppid,
  alive: pidAlive,
};

/**
 * Ends a sandbox by itself: after `ttlMs`, and (with `exitWithParent`) when
 * the process that started it is gone, checked every `pollMs`. `onEnd` gets
 * the reason, once. Returns a function that cancels both.
 */
export function sandboxLifetime(o: { ttlMs: number | null; exitWithParent?: boolean; pollMs?: number; onEnd: (reason: string) => void; deps?: Partial<LifetimeDeps> }): () => void {
  const d = { ...realLifetimeDeps, ...o.deps };
  let done = false;
  let ttl: unknown = null;
  let poll: unknown = null;
  const cancel = () => {
    if (ttl !== null) d.clearTimeout(ttl);
    if (poll !== null) d.clearInterval(poll);
    ttl = poll = null;
  };
  const end = (why: string) => {
    if (done) return;
    done = true;
    cancel();
    o.onEnd(why);
  };
  if (o.ttlMs) {
    const ms = o.ttlMs;
    ttl = d.setTimeout(() => end(`its time to live (${formatDuration(ms)}) is over`), ms);
  }
  if (o.exitWithParent) {
    const parent = d.ppid();
    poll = d.setInterval(() => {
      const now = d.ppid();
      if (now !== parent || !d.alive(parent)) end(`the process that started it (pid ${parent}) is gone`);
    }, o.pollMs ?? 1000);
  }
  return () => {
    done = true;
    cancel();
  };
}

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (err) {
    // EPERM: it exists, it's someone else's.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
  // A zombie (ended, not yet reaped by its parent) still answers signal 0.
  try {
    return !/\)\s+Z\s/.test(readFileSync(`/proc/${pid}/stat`, 'utf8'));
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------- registry

export interface SandboxEntry {
  pid: number;
  port: number;
  host: string;
  dir: string;
  /** ms since the epoch */
  started: number;
  /** When its TTL ends it (ms since the epoch), or null. */
  expires: number | null;
  version: string;
  /** Whether the folder was made for it (and is removed when it ends). */
  temporary: boolean;
}

const entryFile = (registry: string, pid: number) => join(registry, `${pid}.json`);

export function registerSandbox(registry: string, e: SandboxEntry): void {
  mkdirSync(registry, { recursive: true, mode: 0o700 });
  writeFileSync(entryFile(registry, e.pid), `${JSON.stringify(e)}\n`, { mode: 0o600 });
}

export function unregisterSandbox(registry: string, pid: number): void {
  rmSync(entryFile(registry, pid), { force: true });
}

/** The sandboxes registered, alive ones only; the entries of dead ones are removed. */
export function listSandboxes(registry: string, o: { alive?: (pid: number) => boolean } = {}): SandboxEntry[] {
  const alive = o.alive ?? pidAlive;
  if (!existsSync(registry)) return [];
  const out: SandboxEntry[] = [];
  for (const f of readdirSync(registry)) {
    if (!/^\d+\.json$/.test(f)) continue;
    const file = join(registry, f);
    let e: SandboxEntry | null = null;
    try {
      e = JSON.parse(readFileSync(file, 'utf8')) as SandboxEntry;
    } catch {
      /* half written or broken: dropped below */
    }
    if (e && typeof e.pid === 'number' && alive(e.pid)) out.push(e);
    else rmSync(file, { force: true });
  }
  return out.sort((a, b) => a.started - b.started);
}

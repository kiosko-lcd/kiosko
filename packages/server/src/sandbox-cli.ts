/**
 * What the CLI does for a sandbox (core's sandbox.ts):
 *
 *   kiosko start --sandbox [dir] [--port N] [--sandbox-config file] [--sandbox-ttl 2h]
 *                [--sandbox-exit-with-parent] [--sandbox-keep] [--sandbox-force-port]
 *                [--sandbox-allow-usb] [--sandbox-allow-remote] [--sandbox-allow-lan]
 *   kiosko sandbox list [--json]
 *   kiosko sandbox stop [all|<pid>…] [--force]
 */
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import {
  DEFAULT_SANDBOX_TTL_MS,
  formatDuration,
  isInside,
  isLoopback,
  listSandboxes,
  parseDuration,
  pidAlive,
  sandboxPortProblem,
  sandboxRegistryDir,
  unregisterSandbox,
  type Sandbox,
  type SandboxEntry,
} from '@kiosko/core/sandbox';

/** A problem that ends the command: its message, and exit code 2. */
export class SandboxRefusal extends Error {}

/**
 * The config a sandbox uses: its own (`<sandbox>/kiosko/config.json`), a
 * `--config` inside the sandbox, or a copy of `--sandbox-config <file>` (the
 * file itself is only read). A `--config` outside the sandbox is refused: the
 * editor would save into it.
 */
export function sandboxConfig(sb: Sandbox, o: { own: string; config?: string; copyFrom?: string }): string {
  if (o.config && !isInside(o.config, sb.dir)) throw new SandboxRefusal(`--config ${o.config} is outside the sandbox (${sb.dir}): a sandbox would write into it. Use --sandbox-config ${o.config} to start from a copy of it.`);
  const path = o.config ? resolve(o.config) : o.own;
  if (o.copyFrom) {
    // A JSON file, or no copy at all: a broken one would only fail later, in the sandbox.
    JSON.parse(readFileSync(o.copyFrom, 'utf8'));
    mkdirSync(dirname(path), { recursive: true });
    copyFileSync(o.copyFrom, path);
  }
  return path;
}

/** A free TCP port on `host` (not the default one), from the system. */
export async function freePort(host: string): Promise<number> {
  for (let i = 0; i < 5; i++) {
    const port = await new Promise<number>((ok, fail) => {
      const s = createServer();
      s.once('error', fail);
      s.listen(0, host, () => {
        const a = s.address();
        s.close(() => ok(typeof a === 'object' && a ? a.port : 0));
      });
    });
    if (port && !sandboxPortProblem(port)) return port;
  }
  throw new SandboxRefusal('no free port found: pick one with --port');
}

/**
 * Where a sandbox listens: 127.0.0.1 unless it may use the LAN, the `--port`
 * asked for (never the default one unless forced) or a free one.
 */
export async function sandboxListen(sb: Sandbox, o: { host?: string; port?: string; force?: boolean }): Promise<{ host: string; port: number; notes: string[] }> {
  const notes: string[] = [];
  let host = o.host || '127.0.0.1';
  if (!isLoopback(host) && !sb.allow.has('lan')) {
    notes.push(`sandbox: listening on 127.0.0.1, not ${host} (--sandbox-allow-lan to open it to the network)`);
    host = '127.0.0.1';
  }
  if (o.port === undefined) return { host, port: await freePort(host), notes };
  const port = Number(o.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new SandboxRefusal(`--port ${o.port} is not a port`);
  const problem = sandboxPortProblem(port, { force: !!o.force });
  if (problem) throw new SandboxRefusal(problem);
  return { host, port, notes };
}

/** The sandbox's time to live: `--sandbox-ttl`, else KIOSKO_SANDBOX_TTL, else 2 h. Null: none. */
export function sandboxTtl(flag: string | undefined, env: NodeJS.ProcessEnv = process.env): number | null {
  const v = flag ?? env.KIOSKO_SANDBOX_TTL;
  if (v === undefined || v === '') return DEFAULT_SANDBOX_TTL_MS;
  try {
    return parseDuration(v);
  } catch (err) {
    throw new SandboxRefusal(`--sandbox-ttl: ${(err as Error).message}`);
  }
}

/** The banner a sandbox starts with: in the console and the log, so nobody takes it for the real Kiosko. */
export function sandboxBanner(sb: Sandbox, o: { url: string; ttlMs: number | null; exitWithParent: boolean; temporary: boolean }): string[] {
  return [
    `SANDBOX — this is not the real Kiosko. Everything it writes is in ${sb.dir}${o.temporary ? ' (removed when it ends; --sandbox-keep keeps it)' : ''}`,
    `SANDBOX — editor at ${o.url}; ends ${o.ttlMs ? `in ${formatDuration(o.ttlMs)}` : 'only when stopped'}${o.exitWithParent ? ', or when the process that started it ends' : ''}`,
    `SANDBOX — ${['usb', 'remote', 'lan'].map((w) => `${w} ${sb.allow.has(w as 'usb') ? 'allowed' : 'off'}`).join(', ')}; no self-update, no service, no Home Assistant`,
  ];
}

export interface SandboxCliDeps {
  registry: string;
  log: (line: string) => void;
  alive?: (pid: number) => boolean;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  /** What `/api/version` of a sandbox says (to make sure a pid is still that sandbox before stopping it). */
  version?: (e: SandboxEntry) => Promise<{ sandbox?: { dir: string } } | null>;
  /** How long `stop` waits for a sandbox to end before saying it didn't (ms). */
  waitMs?: number;
}

async function realVersion(e: SandboxEntry): Promise<{ sandbox?: { dir: string } } | null> {
  const host = isLoopback(e.host) ? e.host : '127.0.0.1';
  try {
    const r = await fetch(`http://${host.includes(':') ? `[${host}]` : host}:${e.port}/api/version`, { signal: AbortSignal.timeout(1500) });
    return r.ok ? ((await r.json()) as { sandbox?: { dir: string } }) : null;
  } catch {
    return null;
  }
}

const age = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : ms < 3600_000 ? `${Math.round(ms / 60_000)}m` : `${(ms / 3600_000).toFixed(1)}h`);

/** `kiosko sandbox list|stop`. Returns the exit code. */
export async function sandboxCommand(args: string[], d: SandboxCliDeps): Promise<number> {
  const alive = d.alive ?? pidAlive;
  const kill = d.kill ?? ((pid, sig) => process.kill(pid, sig));
  const version = d.version ?? realVersion;
  const sub = args[0] && !args[0].startsWith('-') ? args[0] : 'list';
  const entries = listSandboxes(d.registry, { alive });
  if (sub === 'list') {
    if (args.includes('--json')) {
      d.log(JSON.stringify(entries));
      return 0;
    }
    if (!entries.length) {
      d.log('no sandboxed Kiosko running');
      return 0;
    }
    const now = Date.now();
    for (const e of entries) d.log(`pid ${e.pid}  http://${e.host}:${e.port}/  up ${age(now - e.started)}${e.expires ? `, ends in ${age(Math.max(0, e.expires - now))}` : ', no time limit'}  ${e.dir}`);
    return 0;
  }
  if (sub === 'stop') {
    const which = args.slice(1).filter((a) => !a.startsWith('-'));
    const force = args.includes('--force');
    if (!which.length) {
      d.log('kiosko sandbox stop all|<pid>…');
      return 2;
    }
    const targets = which.includes('all') ? entries : which.map((w) => entries.find((e) => String(e.pid) === w) ?? Number(w));
    let code = 0;
    for (const t of targets) {
      if (typeof t === 'number') {
        d.log(`${Number.isNaN(t) ? 'not a pid' : `no sandbox with pid ${t}`}${Number.isNaN(t) ? '' : ' (kiosko sandbox list)'}`);
        code = 1;
        continue;
      }
      // A pid can be reused: stop it only if it says it is that sandbox (or with --force).
      const v = await version(t);
      if (v?.sandbox?.dir !== t.dir && !force) {
        d.log(`pid ${t.pid}: doesn't answer as the sandbox in ${t.dir} on port ${t.port}; not stopped (--force stops it anyway)`);
        code = 1;
        continue;
      }
      try {
        kill(t.pid, 'SIGTERM');
      } catch (err) {
        d.log(`pid ${t.pid}: ${(err as Error).message}`);
        code = 1;
        continue;
      }
      const until = Date.now() + (d.waitMs ?? 5000);
      while (alive(t.pid) && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
      if (alive(t.pid)) {
        d.log(`pid ${t.pid}: still running after SIGTERM`);
        code = 1;
      } else {
        unregisterSandbox(d.registry, t.pid);
        d.log(`stopped pid ${t.pid} (port ${t.port}, ${t.dir})`);
      }
    }
    return code;
  }
  d.log('kiosko sandbox list [--json] | stop all|<pid>… [--force]');
  return 2;
}

export { sandboxRegistryDir };

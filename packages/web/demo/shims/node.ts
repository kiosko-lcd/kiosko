/**
 * The few Node built-ins that must work in the browser demo, because code
 * calls them while loading or as plain helpers (not to read anything):
 * EventEmitter (the core Runtime is one), POSIX path arithmetic, util's
 * promisify (plugins wrap execFile at import time), os constants.
 *
 * Every other export of every `node:*` module becomes a function that
 * throws "… is not available in the browser demo" (see demo/build.mjs):
 * in demo mode no plugin should read files, run programs or open sockets,
 * and if one does, the demo check catches it.
 */

type Listener = (...args: any[]) => void;

/** Just enough of node:events for the Runtime and its listeners. */
export class EventEmitter {
  private ls = new Map<string | symbol, Listener[]>();
  on(event: string | symbol, fn: Listener): this {
    this.ls.set(event, [...(this.ls.get(event) ?? []), fn]);
    return this;
  }
  addListener(event: string | symbol, fn: Listener): this {
    return this.on(event, fn);
  }
  once(event: string | symbol, fn: Listener): this {
    const once: Listener = (...a) => {
      this.off(event, once);
      fn(...a);
    };
    return this.on(event, once);
  }
  off(event: string | symbol, fn: Listener): this {
    this.ls.set(event, (this.ls.get(event) ?? []).filter((x) => x !== fn));
    return this;
  }
  removeListener(event: string | symbol, fn: Listener): this {
    return this.off(event, fn);
  }
  removeAllListeners(event?: string | symbol): this {
    if (event === undefined) this.ls.clear();
    else this.ls.delete(event);
    return this;
  }
  emit(event: string | symbol, ...args: unknown[]): boolean {
    const list = this.ls.get(event);
    if (!list?.length) return false;
    for (const fn of list) fn(...args);
    return true;
  }
  listenerCount(event: string | symbol): number {
    return this.ls.get(event)?.length ?? 0;
  }
  setMaxListeners(): this {
    return this;
  }
}

// ---------- node:path (POSIX) ----------

function normalizePath(p: string): string {
  const abs = p.startsWith('/');
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop();
      else if (!abs) out.push('..');
    } else out.push(seg);
  }
  const s = (abs ? '/' : '') + out.join('/');
  return s || (abs ? '/' : '.');
}

const path = {
  sep: '/',
  delimiter: ':',
  normalize: normalizePath,
  join: (...parts: string[]) => normalizePath(parts.filter(Boolean).join('/')),
  resolve: (...parts: string[]) => {
    let r = '';
    for (const p of parts) if (p) r = p.startsWith('/') ? p : `${r}/${p}`;
    return normalizePath(r.startsWith('/') ? r : `/${r}`);
  },
  isAbsolute: (p: string) => p.startsWith('/'),
  basename: (p: string, ext?: string) => {
    const b = p.replace(/\/+$/, '').replace(/^.*\//, '');
    return ext && b.endsWith(ext) && b !== ext ? b.slice(0, -ext.length) : b;
  },
  dirname: (p: string) => {
    const s = p.replace(/\/+$/, '');
    if (!s) return p.startsWith('/') ? '/' : '.';
    const i = s.lastIndexOf('/');
    return i < 0 ? '.' : i === 0 ? '/' : s.slice(0, i);
  },
  extname: (p: string) => {
    const b = p.replace(/^.*\//, '');
    const i = b.lastIndexOf('.');
    return i <= 0 ? '' : b.slice(i);
  },
  relative: (from: string, to: string) => {
    const a = normalizePath(from).split('/').filter(Boolean);
    const b = normalizePath(to).split('/').filter(Boolean);
    let i = 0;
    while (i < a.length && a[i] === b[i]) i++;
    return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/');
  },
};

/** Wraps a stub so the throw becomes a rejected promise, as the real promisify would. */
function promisify<T extends (...a: any[]) => unknown>(fn: T): (...a: unknown[]) => Promise<unknown> {
  return (...a) =>
    new Promise((ok, fail) => {
      try {
        fn(...a, (err: unknown, value: unknown) => (err ? fail(err) : ok(value)));
      } catch (err) {
        fail(err);
      }
    });
}

/**
 * Overrides per module: these exports keep working; the rest of each
 * module throws when called. Values here must not read anything.
 */
export const overrides: Record<string, Record<string, unknown>> = {
  events: { EventEmitter, default: EventEmitter },
  path: { ...path, posix: path, default: path },
  'path/posix': { ...path, default: path },
  util: {
    promisify,
    inspect: (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v)),
    format: (...a: unknown[]) => a.map(String).join(' '),
    TextEncoder,
    TextDecoder,
  },
  // The demo has no file system: nothing exists (paths.cache() asks for /dev/shm, for one).
  fs: { existsSync: () => false },
  os: { platform: () => 'browser', homedir: () => '/home/demo', tmpdir: () => '/tmp', EOL: '\n', hostname: () => 'browser' },
  url: {
    fileURLToPath: (u: string | URL) => decodeURIComponent(new URL(String(u)).pathname),
    pathToFileURL: (p: string) => new URL(`file://${encodeURI(p)}`),
    URL,
    URLSearchParams,
  },
  'timers/promises': { setTimeout: (ms: number, value?: unknown) => new Promise((ok) => setTimeout(() => ok(value), ms)) },
  module: {
    createRequire: () =>
      Object.assign(
        (id: string) => {
          throw new Error(`require(${id}) is not available in the browser demo`);
        },
        {
          resolve: (id: string) => {
            throw new Error(`require.resolve(${id}) is not available in the browser demo`);
          },
        },
      ),
  },
};

/**
 * The plugin store's catalogue for the editor (docs/es/tienda.md, §6.2):
 * the copy that comes with Kiosko (assets/store-index.json, so the store
 * works on a machine that has never been online), then the last one
 * downloaded (kept in Kiosko's folder with its ETag), then
 * https://kioskolcd.dev/store/v1/index.json, asked again at start and once
 * a day with the update check. No network, a broken answer or an index
 * that doesn't pass its schema: the copy it had stays. Nothing about the
 * person is sent: a plain GET of a static file.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { validateJson, type JsonSchema, type StoreIndex, type StorePluginFile } from '@kiosko/core';

export const STORE_URL = 'https://kioskolcd.dev/store/v1/';

/** A file shipped next to the code: in the repo (`../assets`, `../../core/schema`) or in the bundle (`assets/`). */
function shipped(...candidates: string[]): string | null {
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

/** The catalogue that comes with this Kiosko, or null. */
export function snapshotIndex(): StoreIndex | null {
  const file = shipped(join(import.meta.dirname, '../assets/store-index.json'), join(import.meta.dirname, 'assets/store-index.json'));
  try {
    return file ? (JSON.parse(readFileSync(file, 'utf8')) as StoreIndex) : null;
  } catch {
    return null;
  }
}

let schema: JsonSchema | null | undefined;
function indexSchema(): JsonSchema | null {
  if (schema !== undefined) return schema;
  const file = shipped(join(import.meta.dirname, '../../core/schema/store-index.json'), join(import.meta.dirname, 'assets/store-index.schema.json'));
  schema = file ? (JSON.parse(readFileSync(file, 'utf8')) as JsonSchema) : null;
  return schema;
}

/** Why an index can't be used, or null. */
export function indexProblem(x: unknown): string | null {
  const i = x as Partial<StoreIndex> | null;
  if (!i || typeof i !== 'object' || i.schema !== 1 || !Array.isArray(i.plugins)) return 'not a Kiosko store index (schema 1)';
  const s = indexSchema();
  const issues = s ? validateJson(s, x) : [];
  return issues.length ? `${issues[0]!.path}: ${issues[0]!.message}${issues.length > 1 ? ` (and ${issues.length - 1} more)` : ''}` : null;
}

export interface StoreState {
  index: StoreIndex | null;
  /** Where it came from. */
  from: 'snapshot' | 'cache' | 'network' | 'none';
  /** When it was last downloaded (epoch ms), if ever. */
  fetchedAt: number | null;
  /** The last refresh's error (offline…), if it failed. */
  error: string | null;
}

export interface StoreOptions {
  /** Where the downloaded copy is kept. */
  cacheDir: string;
  /** The catalogue's folder (default https://kioskolcd.dev/store/v1/; KIOSKO_STORE_URL). */
  url?: string;
  snapshot?: () => StoreIndex | null;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

export class StoreCatalog {
  private state: StoreState;
  private etag: string | undefined;
  private readonly sheets = new Map<string, StorePluginFile>();
  readonly url: string;
  private readonly o: StoreOptions;

  constructor(o: StoreOptions) {
    this.o = o;
    this.url = (o.url ?? process.env.KIOSKO_STORE_URL ?? STORE_URL).replace(/\/?$/, '/');
    this.state = { index: null, from: 'none', fetchedAt: null, error: null };
    // The copy downloaded last time, if it is newer than the one that came with Kiosko.
    const cached = this.readCache();
    const snap = (o.snapshot ?? snapshotIndex)();
    if (cached && (!snap || cached.index.generatedAt >= snap.generatedAt)) {
      this.state = { index: cached.index, from: 'cache', fetchedAt: cached.fetchedAt, error: null };
      this.etag = cached.etag;
    } else if (snap) this.state = { index: snap, from: 'snapshot', fetchedAt: null, error: null };
  }

  private get file() {
    return join(this.o.cacheDir, 'index.json');
  }

  private readCache(): { index: StoreIndex; etag?: string; fetchedAt: number } | null {
    try {
      const c = JSON.parse(readFileSync(this.file, 'utf8')) as { index: StoreIndex; etag?: string; fetchedAt: number };
      return indexProblem(c.index) ? null : c;
    } catch {
      return null;
    }
  }

  current(): StoreState {
    return this.state;
  }

  /** Asks for a newer catalogue (conditionally). Never throws: a failure keeps what there was and says why. */
  async refresh(): Promise<StoreState> {
    const now = this.o.now ?? Date.now;
    try {
      const res = await (this.o.fetch ?? fetch)(`${this.url}index.json`, {
        headers: { accept: 'application/json', 'user-agent': 'Kiosko (+https://kioskolcd.dev)', ...(this.etag && this.state.from !== 'snapshot' ? { 'if-none-match': this.etag } : {}) },
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 15_000),
      });
      if (res.status === 304) {
        this.state = { ...this.state, fetchedAt: now(), error: null };
        this.writeCache();
        return this.state;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const index = (await res.json()) as StoreIndex;
      const problem = indexProblem(index);
      if (problem) throw new Error(`the catalogue doesn't pass its schema: ${problem}`);
      this.etag = res.headers.get('etag') ?? undefined;
      this.state = { index, from: 'network', fetchedAt: now(), error: null };
      this.sheets.clear();
      this.writeCache();
    } catch (err) {
      this.state = { ...this.state, error: err instanceof Error ? (err.name === 'TimeoutError' ? 'timed out' : err.message) : String(err) };
    }
    return this.state;
  }

  private writeCache(): void {
    if (!this.state.index) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ index: this.state.index, ...(this.etag ? { etag: this.etag } : {}), fetchedAt: this.state.fetchedAt ?? 0 }));
      renameSync(tmp, this.file);
    } catch {
      /* a read-only home: the copy in memory does */
    }
  }

  /** A plugin's full record (plugins/<id>.json), or what the index has when it can't be had. */
  async sheet(id: string): Promise<StorePluginFile | null> {
    const p = this.state.index?.plugins.find((x) => x.id === id && !x.hidden);
    if (!p) return null;
    const have = this.sheets.get(id);
    if (have && have.plugin.latest === p.latest) return have;
    try {
      const res = await (this.o.fetch ?? fetch)(`${this.url}plugins/${encodeURIComponent(id)}.json`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(this.o.timeoutMs ?? 15_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const sheet = (await res.json()) as StorePluginFile;
      // The record of what is in the index now: the catalogue's own entry wins over a stale sheet.
      const out = { ...sheet, plugin: p };
      this.sheets.set(id, out);
      return out;
    } catch {
      return { schema: 1, generatedAt: this.state.index!.generatedAt, plugin: p, riskyOptions: [], sources: [] };
    }
  }
}

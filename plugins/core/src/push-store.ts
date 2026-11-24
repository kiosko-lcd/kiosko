/**
 * What scripts push to Kiosko (`POST /api/push/<name>`, see the server):
 * the latest payload of each push name, a short history of them for the
 * charts, and when each stops counting (`ttlMs`). The server writes here
 * and keeps a copy on disk; the `core/push` source hands it to the widgets.
 *
 * Plain data and no Node: it runs in the browser demo too.
 */

export interface PushRecord {
  /** When it arrived (epoch ms). */
  at: number;
  /** The JSON sent, or `{ text }` for plain text. */
  payload: unknown;
}

export interface PushEntry extends PushRecord {
  /** When it stops being shown, from its `ttlMs`. */
  expiresAt?: number;
  /** Earlier payloads, oldest first, the latest included, bounded (see `PUSH_LIMITS`). */
  history: PushRecord[];
}

/** What the `core/push` source gives the widgets: every push name set up, with its latest entry or null. */
export interface PushData {
  hooks: Record<string, PushEntry | null>;
}

export const PUSH_LIMITS = {
  /** Largest body a push may send. */
  maxBytes: 64 * 1024,
  /** Most payloads kept per name for the charts… */
  historyItems: 240,
  /** …and most bytes they may take together. */
  historyBytes: 64 * 1024,
  /** Longest `ttlMs` honoured: 30 days. */
  maxTtlMs: 30 * 24 * 3600_000,
};

/** A push name: what goes in the URL. Lowercase letters, digits, `-` and `_`, 1 to 40. */
export const PUSH_NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/;

const sizeOf = (v: unknown) => {
  try {
    return JSON.stringify(v)?.length ?? 0;
  } catch {
    return Infinity;
  }
};

export class PushStore {
  private names: string[] = [];
  private entries = new Map<string, PushEntry>();
  private listeners = new Set<(d: PushData) => void>();

  /** The push names set up (from the config): payloads of names no longer there are dropped. */
  configure(names: readonly string[]): void {
    const next = [...new Set(names.filter((n) => PUSH_NAME.test(n)))].sort();
    if (next.join('\n') === this.names.join('\n')) return;
    this.names = next;
    for (const k of [...this.entries.keys()]) if (!next.includes(k)) this.entries.delete(k);
    this.changed();
  }

  has(name: string): boolean {
    return this.names.includes(name);
  }

  /** Keeps `payload` as the latest of `name` (which must be set up), with its `ttlMs` if it says one. */
  set(name: string, payload: unknown, now = Date.now()): PushEntry {
    if (!this.has(name)) throw new Error(`unknown push name: ${name}`);
    const ttl = payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as { ttlMs?: unknown }).ttlMs : undefined;
    const ttlMs = typeof ttl === 'number' && Number.isFinite(ttl) && ttl > 0 ? Math.min(ttl, PUSH_LIMITS.maxTtlMs) : undefined;
    const old = this.entries.get(name);
    const history = [...(old?.history ?? []), { at: now, payload }];
    // Oldest out first, never the latest.
    let bytes = history.reduce((s, r) => s + sizeOf(r.payload), 0);
    while (history.length > 1 && (history.length > PUSH_LIMITS.historyItems || bytes > PUSH_LIMITS.historyBytes)) bytes -= sizeOf(history.shift()!.payload);
    const entry: PushEntry = { at: now, payload, ...(ttlMs ? { expiresAt: now + ttlMs } : {}), history };
    this.entries.set(name, entry);
    this.changed();
    return entry;
  }

  /** Forgets the payloads of `name` (`DELETE /api/push/<name>`). */
  clear(name: string): boolean {
    const had = this.entries.delete(name);
    if (had) this.changed();
    return had;
  }

  get(name: string): PushEntry | undefined {
    return this.entries.get(name);
  }

  snapshot(): PushData {
    return { hooks: Object.fromEntries(this.names.map((n) => [n, this.entries.get(n) ?? null])) };
  }

  /** Calls `fn` with a new snapshot on every change; returns what stops it. */
  subscribe(fn: (d: PushData) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** The entries, to keep on disk. */
  dump(): Record<string, PushEntry> {
    return Object.fromEntries(this.entries);
  }

  /** Entries kept on disk, back (those of names not set up are ignored, malformed ones too). */
  load(saved: unknown): void {
    if (!saved || typeof saved !== 'object') return;
    for (const [name, e] of Object.entries(saved as Record<string, unknown>)) {
      if (!this.has(name) || !e || typeof e !== 'object') continue;
      const { at, payload, expiresAt, history } = e as Partial<PushEntry>;
      if (typeof at !== 'number') continue;
      const hist = Array.isArray(history) ? history.filter((r): r is PushRecord => !!r && typeof r === 'object' && typeof (r as PushRecord).at === 'number').slice(-PUSH_LIMITS.historyItems) : [];
      this.entries.set(name, { at, payload, ...(typeof expiresAt === 'number' ? { expiresAt } : {}), history: hist.length ? hist : [{ at, payload }] });
    }
    this.changed();
  }

  private changed(): void {
    if (!this.listeners.size) return;
    const snap = this.snapshot();
    for (const fn of this.listeners) fn(snap);
  }
}

/** The one Kiosko uses: the server writes, the `core/push` source reads. */
export const pushes = new PushStore();

/** An entry that is there and not past its `ttlMs`. */
export const live = (e: PushEntry | null | undefined, now: number): e is PushEntry => !!e && (e.expiresAt === undefined || e.expiresAt > now);

/**
 * Pushes from scripts (docs/rest-webhook.md): a script, cron, CI or Home
 * Assistant tells the panel something.
 *
 *   POST   /api/push/<name>   a JSON (or text, or a form) → the latest of <name>
 *   GET    /api/push/<name>   what <name> has now
 *   DELETE /api/push/<name>   forgets it
 *
 *   curl -X POST -H 'Authorization: Bearer <token>' -d '{"value":21}' http://127.0.0.1:7420/api/push/garage
 *
 * Every push name is set up in the editor (Settings → Push) and has its own
 * random token, sent as `Authorization: Bearer <token>` or `?token=<token>`.
 * Unlike the rest of the API these requests don't need `X-Kiosko: 1`: that
 * header stops a web page the user visits from driving the editor's API
 * (CSRF), and a push already carries a secret such a page can't know. A
 * push can only set what a push name shows, never touch the config.
 *
 * Limits: 64 KB per body, 20 requests in a burst and 5 per second after
 * that per name (429 beyond). The latest payload of each name and a short
 * history (push-store.ts) are kept in memory and in `push.json` in
 * Kiosko's folder, so a restart doesn't blank a tile that is updated once a
 * day.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { Config, Runtime } from '@kiosko/core';
import { PUSH_LIMITS, pushes, type PushStore } from '@kiosko/plugin-core';

/** Shortest token accepted: a hook with a shorter (or no) token lets nobody in. */
export const MIN_TOKEN_LENGTH = 16;
/** Requests a push name may send at once, and how many per second after that. */
export const PUSH_RATE = { burst: 20, perSecond: 5 };

export interface PushApiOptions {
  runtime: Runtime;
  /** Where the payloads are kept between runs; none: memory only (tests, demo). */
  file?: string;
  json(res: ServerResponse, status: number, data: unknown): void;
  store?: PushStore;
  now?: () => number;
}

class TooLarge extends Error {}

async function rawBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) throw new TooLarge();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new TooLarge();
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

/** Numbers in a form (`value=21.5`) as numbers, the rest as text. */
const formValue = (v: string): string | number => (/^\s*-?(\d+\.?\d*|\.\d+)\s*$/.test(v) ? Number(v) : v);

/**
 * What a push body says: JSON whatever its Content-Type (curl -d sends JSON
 * as a form), a form's fields, or plain text as `{ text }`. Not ok: an
 * empty body, or something sent as JSON that isn't.
 */
export function parsePushBody(buf: Buffer, contentType: string | undefined): { ok: true; payload: unknown } | { ok: false; error: string } {
  const text = buf.toString('utf8').replace(/^﻿/, '');
  if (!text.trim()) return { ok: false, error: 'empty body' };
  const type = (contentType ?? '').toLowerCase();
  try {
    return { ok: true, payload: JSON.parse(text) };
  } catch {
    if (type.includes('json')) return { ok: false, error: 'the body is not valid JSON' };
  }
  if (type.startsWith('application/x-www-form-urlencoded') && /^[^\s=&]+=/.test(text)) {
    return { ok: true, payload: Object.fromEntries([...new URLSearchParams(text)].map(([k, v]) => [k, formValue(v)])) };
  }
  return { ok: true, payload: { text: text.trim() } };
}

const digest = (s: string) => createHash('sha256').update(s).digest();

/** Whether `given` is `expected`, in a time that doesn't tell how much of it matched. */
export function sameToken(given: string, expected: string): boolean {
  if (expected.length < MIN_TOKEN_LENGTH || !given) return false;
  return timingSafeEqual(digest(given), digest(expected));
}

/** The token of a request: `Authorization: Bearer …` or `?token=`. */
export function tokenOf(req: IncomingMessage, url: URL): string {
  const auth = req.headers.authorization ?? '';
  const m = /^Bearer\s+(\S+)\s*$/i.exec(auth);
  return m ? m[1]! : (url.searchParams.get('token') ?? '');
}

export function pushApi(o: PushApiOptions) {
  const store = o.store ?? pushes;
  const now = o.now ?? Date.now;
  const buckets = new Map<string, { tokens: number; at: number }>();
  const hooks = (cfg: Config) => cfg.push?.hooks ?? [];

  const sync = (cfg: Config) => store.configure(hooks(cfg).map((h) => h.name));
  sync(o.runtime.config);
  if (o.file && existsSync(o.file)) {
    try {
      store.load(JSON.parse(readFileSync(o.file, 'utf8')));
    } catch {
      // A damaged copy only costs the last payloads.
    }
  }
  const onConfig = (cfg: Config) => sync(cfg);
  o.runtime.on('config', onConfig);

  // Written a moment after the last change, not on every push.
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  const save = () => {
    saveTimer = null;
    if (!o.file) return;
    try {
      const tmp = `${o.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(store.dump()), { mode: 0o600 });
      renameSync(tmp, o.file);
      if (process.platform !== 'win32') chmodSync(o.file, 0o600);
    } catch {
      // Kept in memory anyway.
    }
  };
  const unsubscribe = store.subscribe(() => {
    if (!o.file || saveTimer) return;
    saveTimer = setTimeout(save, 1000);
    saveTimer.unref?.();
  });

  /** One more request of `name`, if its bucket has room. */
  function allowed(name: string): boolean {
    const t = now();
    const b = buckets.get(name) ?? { tokens: PUSH_RATE.burst, at: t };
    b.tokens = Math.min(PUSH_RATE.burst, b.tokens + ((t - b.at) / 1000) * PUSH_RATE.perSecond);
    b.at = t;
    buckets.set(name, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  /** Handles `/api/push/<name>`; false for any other path. */
  async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const m = /^\/api\/push\/([^/]+)\/?$/.exec(url.pathname);
    if (!m) return false;
    const method = req.method ?? 'GET';
    res.setHeader('cache-control', 'no-store');
    let name: string;
    try {
      name = decodeURIComponent(m[1]!).toLowerCase();
    } catch {
      name = '';
    }
    // An unknown name and a wrong token get the same answer: the names aren't listed to strangers.
    const hook = hooks(o.runtime.config).find((h) => h.name === name);
    if (!hook || !sameToken(tokenOf(req, url), hook.token)) {
      req.resume();
      res.setHeader('www-authenticate', 'Bearer realm="kiosko-push"');
      o.json(res, 401, { error: 'unknown push name or wrong token', code: 'unauthorized' });
      return true;
    }
    if (!allowed(name)) {
      req.resume();
      res.setHeader('retry-after', '1');
      o.json(res, 429, { error: `more than ${PUSH_RATE.perSecond} pushes a second`, code: 'rateLimited' });
      return true;
    }
    if (method === 'GET') {
      const e = store.get(name);
      o.json(res, 200, e ? { name, at: e.at, payload: e.payload, ...(e.expiresAt ? { expiresAt: e.expiresAt } : {}) } : { name, at: null, payload: null });
      return true;
    }
    if (method === 'DELETE') {
      store.clear(name);
      o.json(res, 200, { ok: true });
      return true;
    }
    if (method !== 'POST' && method !== 'PUT') {
      req.resume();
      res.setHeader('allow', 'GET, POST, PUT, DELETE');
      o.json(res, 405, { error: 'use POST', code: 'method' });
      return true;
    }
    let buf: Buffer;
    try {
      buf = await rawBody(req, PUSH_LIMITS.maxBytes);
    } catch (err) {
      if (!(err instanceof TooLarge)) throw err;
      res.setHeader('connection', 'close');
      res.once('finish', () => req.destroy());
      o.json(res, 413, { error: `body larger than ${PUSH_LIMITS.maxBytes / 1024} KB`, code: 'tooLarge' });
      return true;
    }
    const parsed = parsePushBody(buf, req.headers['content-type']);
    if (!parsed.ok) {
      o.json(res, 400, { error: parsed.error, code: 'badBody' });
      return true;
    }
    const e = store.set(name, parsed.payload, now());
    o.json(res, 200, { ok: true, name, at: e.at, ...(e.expiresAt ? { expiresAt: e.expiresAt } : {}) });
    return true;
  }

  /** For the editor: when each name last got something. */
  const status = () => hooks(o.runtime.config).map((h) => ({ name: h.name, at: store.get(h.name)?.at ?? null }));

  function close(): void {
    o.runtime.off('config', onConfig);
    unsubscribe();
    if (saveTimer) {
      clearTimeout(saveTimer);
      save();
    }
  }

  return { handle, status, close };
}

/** Where the payloads are kept, in Kiosko's folder. */
export const pushFile = (home: string) => join(home, 'push.json');

/**
 * A small HTTP client for sources and fetches, so every plugin talks to
 * APIs the same polite way:
 *
 *   const http = createHttp({ agent: 'kiosko-plugin-weather/1.2.0' });
 *   const { data } = await http.json<Forecast>(url, { signal: ctx.signal });
 *
 * - Conditional requests: it remembers each URL's ETag / Last-Modified and
 *   body; a 304 gives the body it had, without downloading it again.
 * - Rate limits: a 429 or 503 with `Retry-After` (or GitHub's
 *   `X-RateLimit-Reset`) throws an `HttpError` with `retryAt`, and until
 *   then calls to that host fail at once without contacting it.
 * - The caller's `signal` (Kiosko aborts it after the source's timeout).
 * - A User-Agent naming the plugin and Kiosko, never the person.
 */

export class HttpError extends Error {
  readonly status: number;
  readonly url: string;
  /** When the server says to come back (rate limits), epoch ms. */
  readonly retryAt?: number;
  constructor(message: string, o: { status: number; url: string; retryAt?: number }) {
    super(message);
    this.name = 'HttpError';
    this.status = o.status;
    this.url = o.url;
    if (o.retryAt !== undefined) this.retryAt = o.retryAt;
  }
}

export interface HttpRequest {
  signal?: AbortSignal;
  headers?: Record<string, string>;
  method?: string;
  body?: string;
  /** Don't use or keep the conditional-request cache for this call. */
  noCache?: boolean;
  /**
   * The largest body to read, in bytes: a longer one (by its Content-Length,
   * or as it arrives) throws an `HttpError` and is not kept. For URLs the
   * user types, which may answer with anything. Kiosko 0.2.12 and later.
   */
  maxBytes?: number;
}

export interface HttpResponse<T> {
  data: T;
  status: number;
  /** False when the server said "not modified" and the remembered body was returned. */
  fresh: boolean;
  headers: Headers;
}

export interface HttpClient {
  json<T = unknown>(url: string, req?: HttpRequest): Promise<HttpResponse<T>>;
  text(url: string, req?: HttpRequest): Promise<HttpResponse<string>>;
  /** Until when a host is resting because it rate-limited us (epoch ms), if it is. */
  resting(url: string): number | undefined;
}

/** How long to wait from the response's own words, if it says: `Retry-After` (seconds or a date) or `X-RateLimit-Reset` (epoch seconds). */
export function retryAtOf(headers: Headers, now: number): number | undefined {
  const ra = headers.get('retry-after');
  if (ra) {
    const s = Number(ra);
    if (Number.isFinite(s)) return now + Math.max(0, s) * 1000;
    const at = Date.parse(ra);
    if (Number.isFinite(at)) return at;
  }
  const reset = Number(headers.get('x-ratelimit-reset'));
  if (headers.get('x-ratelimit-remaining') === '0' && Number.isFinite(reset) && reset > 0) return reset * 1000;
  return undefined;
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** The body of `res` as text, or an `HttpError` as soon as it passes `max` bytes (without reading the rest). */
async function limitedText(res: Response, max: number, url: string): Promise<string> {
  const tooBig = () => new HttpError(`response larger than ${max} bytes from ${hostOf(url)}`, { status: res.status, url });
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => undefined);
    throw tooBig();
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      throw tooBig();
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

export function createHttp(o: { agent?: string; fetch?: typeof fetch; now?: () => number; maxCached?: number } = {}): HttpClient {
  const doFetch = o.fetch ?? fetch;
  const now = o.now ?? Date.now;
  const agent = `${o.agent ? `${o.agent} ` : ''}Kiosko (+https://kioskolcd.dev)`;
  const cache = new Map<string, { etag?: string; modified?: string; body: string }>();
  const rest = new Map<string, number>();
  const max = o.maxCached ?? 200;

  async function request(url: string, req: HttpRequest = {}): Promise<HttpResponse<string>> {
    const host = hostOf(url);
    const until = rest.get(host);
    if (until !== undefined) {
      if (until > now()) throw new HttpError(`${host} asked to wait until ${new Date(until).toISOString()}`, { status: 429, url, retryAt: until });
      rest.delete(host);
    }
    const method = req.method ?? 'GET';
    const cacheable = method === 'GET' && !req.noCache;
    const hit = cacheable ? cache.get(url) : undefined;
    const headers: Record<string, string> = { 'User-Agent': agent, ...req.headers };
    if (hit?.etag) headers['If-None-Match'] = hit.etag;
    if (hit?.modified) headers['If-Modified-Since'] = hit.modified;
    const res = await doFetch(url, { method, headers, ...(req.body !== undefined ? { body: req.body } : {}), ...(req.signal ? { signal: req.signal } : {}) });
    if (res.status === 304 && hit) return { data: hit.body, status: 304, fresh: false, headers: res.headers };
    const retryAt = retryAtOf(res.headers, now());
    if (res.status === 429 || res.status === 503 || (res.status === 403 && retryAt !== undefined)) {
      const at = retryAt ?? now() + 60_000;
      rest.set(host, at);
      throw new HttpError(`HTTP ${res.status} from ${host}: rate-limited until ${new Date(at).toISOString()}`, { status: res.status, url, retryAt: at });
    }
    if (!res.ok) throw new HttpError(`HTTP ${res.status} from ${host}`, { status: res.status, url });
    const body = req.maxBytes === undefined ? await res.text() : await limitedText(res, req.maxBytes, url);
    if (cacheable) {
      const etag = res.headers.get('etag') ?? undefined;
      const modified = res.headers.get('last-modified') ?? undefined;
      if (etag || modified) {
        cache.delete(url);
        cache.set(url, { ...(etag ? { etag } : {}), ...(modified ? { modified } : {}), body });
        // Oldest out first.
        while (cache.size > max) cache.delete(cache.keys().next().value!);
      }
    }
    return { data: body, status: res.status, fresh: true, headers: res.headers };
  }

  return {
    text: request,
    async json<T>(url: string, req?: HttpRequest) {
      const r = await request(url, { ...req, headers: { Accept: 'application/json', ...req?.headers } });
      try {
        return { ...r, data: JSON.parse(r.data) as T };
      } catch {
        throw new HttpError(`not JSON from ${hostOf(url)}`, { status: r.status, url });
      }
    },
    resting(url: string) {
      const at = rest.get(hostOf(url));
      return at !== undefined && at > now() ? at : undefined;
    },
  };
}

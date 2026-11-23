/**
 * The network-screens server (docs/browser-screens.md): a second, separate
 * HTTP server, off unless the config switches it on, for browsers showing a
 * Kiosko screen. It is a server object of its own, not the editor's with
 * fewer permissions: it has no route to the editor, its API, the config or
 * the plugins. What it serves, and nothing else (404):
 *
 *   GET /            the viewer page (packages/web/src/viewer, built to dist/viewer)
 *   GET /viewer.js   its code
 *   GET /viewer.css  its look
 *   GET /icon.svg    the icon (the home-screen shortcut)
 *   GET /ws          the WebSocket: pairing and, for a paired viewer, the frames
 *                    (BrowserHub in @kiosko/core does the talking)
 *
 * Limits: so many connections at once, so many WebSockets per address, small
 * messages from the viewers, and a wrong pairing code makes the next one wait
 * (the hub's).
 */
import { readFileSync, existsSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { MAX_VIEWER_MESSAGE, type BrowserHub } from '@kiosko/core';
import { acceptWebSocket } from './ws.ts';

export interface ScreensServerOptions {
  hub: BrowserHub;
  /** Folder with the built viewer (index.html, viewer.js, viewer.css). */
  viewerDir: string;
  log?: (m: string) => void;
  /** Connections at once (HTTP and WebSockets). */
  maxConnections?: number;
  /** WebSockets from one address at once. */
  maxPerAddress?: number;
}

/** The files it serves, by path: the whole list. */
const FILES: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/viewer.js': { file: 'viewer.js', type: 'text/javascript; charset=utf-8' },
  '/viewer.css': { file: 'viewer.css', type: 'text/css; charset=utf-8' },
  '/icon.svg': { file: 'icon.svg', type: 'image/svg+xml' },
};

const HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cross-origin-resource-policy': 'same-origin',
  // Its own script and style only; frames come as blobs; the WebSocket goes back where the page came from.
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; media-src blob: data:; connect-src 'self' ws: wss:; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

export class ScreensServer {
  private readonly o: Required<Omit<ScreensServerOptions, 'log'>> & Pick<ScreensServerOptions, 'log'>;
  private server: Server | null = null;
  private readonly perAddress = new Map<string, number>();
  private readonly sockets = new Set<Duplex>();
  private readonly cache = new Map<string, Buffer>();
  private bound: { host: string; port: number } | null = null;

  constructor(o: ScreensServerOptions) {
    this.o = { maxConnections: 32, maxPerAddress: 4, ...o };
  }

  /** Where it listens now (null: it doesn't). */
  get listening(): { host: string; port: number } | null {
    return this.bound;
  }

  private file(path: string): Buffer | null {
    const f = FILES[path];
    if (!f) return null;
    let b = this.cache.get(f.file);
    if (!b) {
      const p = join(this.o.viewerDir, f.file);
      if (!existsSync(p)) return null;
      b = readFileSync(p);
      this.cache.set(f.file, b);
    }
    return b;
  }

  private request(req: IncomingMessage, res: ServerResponse): void {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    const f = FILES[path];
    const body = (req.method === 'GET' || req.method === 'HEAD') && f ? this.file(path) : null;
    if (!f || !body) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...HEADERS });
      return void res.end(f && (req.method === 'GET' || req.method === 'HEAD') ? 'The viewer is not built. Run `npm run web:build`.\n' : 'Not found\n');
    }
    res.writeHead(200, { 'content-type': f.type, 'content-length': String(body.length), 'cache-control': 'no-cache', ...HEADERS });
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  private upgrade(req: IncomingMessage, sock: Duplex, head: Buffer): void {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    const address = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
    const refuse = (status: string): void => void sock.end(`HTTP/1.1 ${status}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);
    if (path !== '/ws') return refuse('404 Not Found');
    // A page from somewhere else (a site the tablet visits) may not talk to Kiosko: only the viewer, served from here.
    const origin = req.headers.origin;
    if (origin !== undefined) {
      let host = '';
      try {
        host = new URL(origin).host;
      } catch {
        /* not a URL: refused below */
      }
      if (host !== req.headers.host) return refuse('403 Forbidden');
    }
    const n = this.perAddress.get(address) ?? 0;
    if (n >= this.o.maxPerAddress) return refuse('429 Too Many Requests');
    if (head.length) sock.unshift(head);
    const ws = acceptWebSocket(req, sock, { maxMessage: MAX_VIEWER_MESSAGE });
    if (!ws) return;
    this.perAddress.set(address, n + 1);
    this.sockets.add(sock);
    ws.onClose(() => {
      this.sockets.delete(sock);
      const left = (this.perAddress.get(address) ?? 1) - 1;
      if (left > 0) this.perAddress.set(address, left);
      else this.perAddress.delete(address);
    });
    this.o.hub.accept({ address, send: (m) => ws.send(m), close: () => ws.close(), onMessage: (f) => ws.onMessage(f), onClose: (f) => ws.onClose(f) });
  }

  /** Starts listening; rejects if the port is taken (or the address is not this computer's). */
  async listen(host: string, port: number): Promise<void> {
    await this.close();
    this.cache.clear();
    const server = createServer((req, res) => this.request(req, res));
    server.maxConnections = this.o.maxConnections;
    server.headersTimeout = 10_000;
    server.requestTimeout = 15_000;
    server.on('upgrade', (req, sock, head) => this.upgrade(req, sock, head));
    server.on('clientError', (_e, sock) => sock.destroy());
    await new Promise<void>((ok, fail) => {
      server.once('error', fail);
      server.listen(port, host, () => {
        server.off('error', fail);
        ok();
      });
    });
    server.on('error', (e) => this.o.log?.(`network screens: ${e.message}`));
    this.server = server;
    const a = server.address();
    this.bound = { host, port: typeof a === 'object' && a ? a.port : port };
    this.o.hub.setServer(true);
    this.o.log?.(`network screens: listening on ${host}:${this.bound.port}`);
  }

  async close(): Promise<void> {
    const s = this.server;
    if (!s) return;
    this.server = null;
    this.bound = null;
    this.o.hub.setServer(false);
    this.o.hub.closeAll();
    // Upgraded sockets are not the HTTP server's any more: closed by hand.
    for (const sock of this.sockets) sock.destroy();
    this.sockets.clear();
    await new Promise<void>((ok) => {
      s.close(() => ok());
      s.closeAllConnections();
      setTimeout(ok, 2000).unref();
    });
    this.perAddress.clear();
  }
}

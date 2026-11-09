/**
 * The HTTP side: the editor's static files, a small JSON API and a stream of
 * server-sent events (new frames, logs, status). No framework: node:http.
 *
 * It listens on 127.0.0.1 by default. Because the API can install plugins
 * (code), every mutating request must carry `X-Kiosko: 1` (a custom header
 * a foreign web page can't send without a CORS preflight, which we never
 * grant) and the Host header must be the one we listen on (DNS rebinding).
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, extname, join, normalize as normPath, resolve } from 'node:path';
import { THEMES } from '@kiosko/sdk';
import { CATEGORIES } from '@kiosko/sdk';
import { OFFICIAL_PLUGINS } from './builtin.ts';
import { PANEL_PRESETS, discoverTrcc, normalize, paths, resolveLocale, saveConfig, type Config, type FrameInfo, type Runtime, type Screen } from '@kiosko/core';

const require = createRequire(import.meta.url);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

export interface ServerOptions {
  runtime: Runtime;
  host: string;
  port: number;
  configPath: string;
  /** Folder with the built editor (index.html, assets). */
  webDir?: string;
  version: string;
}

function webRoot(): string {
  // The published bundle carries the editor next to the CLI.
  const bundled = join(import.meta.dirname, 'web');
  if (existsSync(join(bundled, 'index.html'))) return bundled;
  try {
    return join(dirname(require.resolve('@kiosko/web/package.json')), 'dist');
  } catch {
    return resolve(import.meta.dirname, '../../web/dist');
  }
}

async function body(req: IncomingMessage, limit = 5 * 1024 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new Error('body too large');
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

function json(res: ServerResponse, status: number, data: unknown): void {
  const s = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(s);
}

function png(res: ServerResponse, buf: Buffer, extra: Record<string, string> = {}): void {
  res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store', 'content-length': String(buf.length), ...extra });
  res.end(buf);
}

/** Screen ids must not leak paths into file names or URLs. */
const safeId = (s: string) => /^[\w.-]{1,80}$/.test(s);

export function startServer(o: ServerOptions) {
  const { runtime } = o;
  const root = o.webDir ?? webRoot();
  const clients = new Set<ServerResponse>();
  const thumbs = new Map<string, Buffer>();
  let restartNeeded = false;
  /** Bumped on every save, so a stale editor tab can't overwrite newer changes. */
  let rev = Date.now();

  const send = (event: string, data: unknown) => {
    const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) c.write(line);
  };
  runtime.on('frame', (f: FrameInfo) => send('frame', { screenId: f.screenId, pageId: f.pageId, at: f.at, interlude: f.interlude, sleeping: f.sleeping, tiles: f.tiles }));
  runtime.on('log', (e) => send('log', e));
  runtime.on('config', () => thumbs.clear());
  const statusTimer = setInterval(() => send('status', runtime.status()), 3000);

  const allowedHosts = new Set([`127.0.0.1:${o.port}`, `localhost:${o.port}`, `[::1]:${o.port}`, `${o.host}:${o.port}`]);

  function state() {
    const locale = resolveLocale(runtime.config);
    return {
      version: o.version,
      rev,
      locale,
      config: runtime.config,
      catalog: runtime.registry.catalog(locale),
      categories: CATEGORIES,
      themes: THEMES,
      presets: PANEL_PRESETS,
      status: runtime.status(),
      paths: { config: o.configPath, plugins: paths.plugins, home: paths.home },
      restartNeeded,
      official: OFFICIAL_PLUGINS,
      demo: runtime.demoMode,
      platform: process.platform,
    };
  }

  function findScreen(cfg: Config, id: string): Screen | undefined {
    return cfg.screens.find((s) => s.id === id);
  }

  async function api(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const p = url.pathname;
    const m = req.method ?? 'GET';
    if (m !== 'GET' && req.headers['x-kiosko'] !== '1') return json(res, 403, { error: 'missing X-Kiosko header' });

    if (p === '/api/state' && m === 'GET') return json(res, 200, state());

    if (p === '/api/config' && m === 'PUT') {
      const b = (await body(req)) as { config?: unknown; baseRev?: number };
      // Old clients send the bare config; new ones say which revision they edited.
      const raw = b && typeof b === 'object' && 'config' in b ? b.config : b;
      if (typeof b?.baseRev === 'number' && b.baseRev !== rev) return json(res, 409, { error: 'the configuration changed elsewhere', rev, config: runtime.config });
      const cfg = normalize(raw);
      saveConfig(cfg, o.configPath);
      rev++;
      runtime.apply(cfg);
      send('config', { rev, by: req.headers['x-kiosko-client'] ?? null });
      return json(res, 200, { ok: true, rev, config: runtime.config });
    }

    if (p === '/api/events' && m === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(`event: hello\ndata: ${JSON.stringify({ version: o.version })}\n\n`);
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
      req.on('close', () => {
        clearInterval(ping);
        clients.delete(res);
      });
      return;
    }

    // Live frame of a screen, as sent to the panel (unrotated).
    let mm = /^\/api\/screens\/([^/]+)\/frame\.(?:jpg|png)$/.exec(p);
    if (mm && m === 'GET') {
      const f = runtime.lastFrame(decodeURIComponent(mm[1]!));
      if (!f) return json(res, 404, { error: 'no frame yet' });
      const buf = f.image();
      res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-store', 'content-length': String(buf.length), 'x-kiosko-at': String(f.at) });
      return void res.end(buf);
    }

    // Preview of a page being edited (not saved), with demo data where needed.
    if (p === '/api/preview' && m === 'POST') {
      const b = (await body(req)) as { screen: Screen; pageId?: string; forceShown?: Record<string, string>; demo?: boolean };
      const cfg = normalize({ screens: [b.screen] });
      const screen = cfg.screens[0]!;
      const page = screen.pages.find((x) => x.id === b.pageId) ?? screen.pages[0];
      if (!page) return json(res, 400, { error: 'no page' });
      const r = runtime.preview(screen, page, { ...(b.forceShown ? { forceShown: b.forceShown } : {}), demo: b.demo ?? true });
      return png(res, r.canvas.toBuffer('image/png'), { 'x-kiosko-tiles': encodeURIComponent(JSON.stringify(r.tiles)) });
    }

    if (p === '/api/thumbnail' && m === 'GET') {
      const type = url.searchParams.get('type') ?? '';
      const w = Math.max(40, Math.min(1920, Number(url.searchParams.get('w')) || 480));
      const h = Math.max(40, Math.min(1080, Number(url.searchParams.get('h')) || 300));
      const key = `${runtime.config.theme}|${type}|${w}x${h}|${runtime.config.locale}`;
      let buf = thumbs.get(key);
      if (!buf) {
        if (!runtime.registry.widget(type)) return json(res, 404, { error: 'unknown widget' });
        buf = runtime.thumbnail(type, w, h);
        thumbs.set(key, buf);
      }
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=60' });
      return void res.end(buf);
    }

    mm = /^\/api\/screens\/([^/]+)\/pin$/.exec(p);
    if (mm && m === 'POST') {
      const b = (await body(req)) as { pageId: string | null };
      runtime.pin(decodeURIComponent(mm[1]!), b.pageId ?? null);
      return json(res, 200, { ok: true });
    }
    mm = /^\/api\/screens\/([^/]+)\/interlude$/.exec(p);
    if (mm && m === 'POST') {
      const b = (await body(req)) as { slotId?: string; stop?: boolean };
      if (b.stop) runtime.stopInterlude(decodeURIComponent(mm[1]!));
      else if (b.slotId) runtime.playInterlude(decodeURIComponent(mm[1]!), b.slotId);
      return json(res, 200, { ok: true });
    }
    mm = /^\/api\/widgets\/([^/]+)\/refresh$/.exec(p);
    if (mm && m === 'POST') {
      runtime.refreshWidget(decodeURIComponent(mm[1]!));
      return json(res, 200, { ok: true });
    }

    if (p === '/api/devices/discover' && m === 'GET') {
      const url0 = url.searchParams.get('url') ?? 'http://127.0.0.1:8099';
      return json(res, 200, { trcc: await discoverTrcc(url0, url.searchParams.get('tokenFile') ?? undefined) });
    }

    if (p === '/api/logs' && m === 'GET') return json(res, 200, runtime.logs.slice(-200));

    if (p === '/api/plugins/install' && m === 'POST') {
      const b = (await body(req)) as { name?: string };
      const name = String(b.name ?? '').trim();
      // Only npm package names (optionally scoped) with an optional version: no URLs, no paths, no flags.
      if (!/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(@[\w.^~<>=-]+)?$/i.test(name)) return json(res, 400, { error: 'not a valid npm package name' });
      mkdirSync(paths.plugins, { recursive: true });
      const pkg = join(paths.plugins, 'package.json');
      if (!existsSync(pkg)) writeFileSync(pkg, JSON.stringify({ name: 'kiosko-user-plugins', private: true, type: 'module' }, null, 2));
      const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      execFile(npm, ['install', '--no-audit', '--no-fund', '--ignore-scripts', name], { cwd: paths.plugins, timeout: 180_000, shell: process.platform === 'win32' }, (err, stdout, stderr) => {
        if (err) return json(res, 500, { error: (stderr || err.message).slice(-2000) });
        restartNeeded = true;
        json(res, 200, { ok: true, output: stdout.slice(-2000), restartNeeded });
      });
      return;
    }

    mm = /^\/api\/plugins\/([^/]+)\/enabled$/.exec(p);
    if (mm && m === 'POST') {
      const id = decodeURIComponent(mm[1]!);
      const b = (await body(req)) as { enabled: boolean };
      const disabled = new Set(runtime.config.plugins.disabled);
      if (b.enabled) disabled.delete(id);
      else disabled.add(id);
      const cfg = { ...runtime.config, plugins: { disabled: [...disabled] } };
      saveConfig(cfg, o.configPath);
      rev++;
      runtime.apply(cfg);
      send('config', { rev, by: null });
      return json(res, 200, state());
    }

    if (p === '/api/screens/export' && m === 'GET') {
      const id = url.searchParams.get('id') ?? '';
      const s = findScreen(runtime.config, id);
      if (!s || !safeId(id)) return json(res, 404, { error: 'unknown screen' });
      res.writeHead(200, { 'content-type': 'application/json', 'content-disposition': `attachment; filename="kiosko-${id}.json"` });
      return void res.end(JSON.stringify({ kiosko: 'screen', version: 1, screen: { ...s, device: { driver: 'virtual' } } }, null, 2));
    }

    return json(res, 404, { error: 'not found' });
  }

  function serveStatic(res: ServerResponse, pathname: string): void {
    const rel = normPath(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
    let file = join(root, rel || 'index.html');
    if (!file.startsWith(root)) return void json(res, 400, { error: 'bad path' });
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, 'index.html');
    if (!existsSync(file)) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      return void res.end('The editor is not built. Run `npm run web:build`.');
    }
    const ext = extname(file);
    res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream', 'cache-control': ext === '.html' ? 'no-cache' : 'max-age=300' });
    res.end(readFileSync(file));
  }

  const server = createServer((req, res) => {
    const host = req.headers.host ?? '';
    if (o.host === '127.0.0.1' || o.host === 'localhost' || o.host === '::1') {
      if (!allowedHosts.has(host)) {
        res.writeHead(421, { 'content-type': 'text/plain' });
        return void res.end('Misdirected request');
      }
    }
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    const url = new URL(req.url ?? '/', `http://${host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) {
      api(req, res, url).catch((err) => {
        if (!res.headersSent) json(res, 500, { error: err instanceof Error ? err.message : String(err) });
      });
      return;
    }
    serveStatic(res, url.pathname);
  });

  server.listen(o.port, o.host);
  return {
    server,
    close() {
      clearInterval(statusTimer);
      for (const c of clients) c.end();
      server.close();
    },
  };
}

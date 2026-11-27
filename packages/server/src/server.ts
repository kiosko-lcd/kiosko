/**
 * The HTTP side: the editor's static files, a small JSON API and a stream of
 * server-sent events (new frames, logs, status). No framework: node:http.
 *
 * It listens on 127.0.0.1 by default. Because the API can install plugins
 * (code), every mutating request must carry `X-Kiosko: 1` (a custom header
 * a foreign web page can't send without a CORS preflight, which we never
 * grant) and the Host header must be the one we listen on (DNS rebinding).
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, openSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, extname, join, normalize as normPath, resolve } from 'node:path';
import { THEMES } from '@kiosko/sdk';
import { CATEGORIES } from '@kiosko/sdk';
import { OFFICIAL_PLUGINS } from './builtin.ts';
import { IntegrityError, installPlugin, reloadPlugin, removePlugin } from './plugins-manage.ts';
import { StoreCatalog } from './store.ts';
import { SDK_VERSION } from '@kiosko/sdk';
import { installableRelease, releaseProblem, type StorePlugin } from '@kiosko/core';
import { HomeAssistantBridge } from './homeassistant.ts';
import { remoteApi, type RemoteApiContext } from './remote-api.ts';
import { pushApi, pushFile } from './push-api.ts';
import { ALERT_LEVELS, type AlertLevel } from '@kiosko/sdk';
import { AlertError, DEFAULT_SNOOZE_MS, PANEL_PRESETS, checkUpdates, discoverRemote, discoverTrcc, discoverUsb, normalize, npmRegistry, paths, resolveLocale, resolveSourceKey, saveConfig, type Config, type FrameInfo, type Runtime, type Screen, type UpdateCheck } from '@kiosko/core';
import { currentInstall, updateBlocker, updateInstructions, type InstallInfo } from './install-kind.ts';
import { KioskoUpdater, UpdateError, readMarker, realRun, restartHow, writeMarker, type Handover, type UpdaterDeps } from './self-update.ts';

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
  /** How a screen's firmware is fetched from this version's GitHub release (tests). Default: fetch. */
  firmwareFetch?: RemoteApiContext['fetch'];
  /**
   * Ask npm once a day for newer versions of the plugins (and of Kiosko).
   * Default: on, except in demo mode or with KIOSKO_NO_UPDATE_CHECK=1.
   */
  checkUpdates?: boolean;
  /** How the update check asks npm (tests). */
  updateCheck?: () => Promise<UpdateCheck>;
  /** Kiosko as a device in Home Assistant (over MQTT), when the config asks for it. Default: on, except in demo mode. */
  homeassistant?: boolean;
  /** The plugin store's catalogue (tests). Default: the copy that comes with Kiosko, the one kept in its folder, then the site's. */
  store?: StoreCatalog;
  /** How this Kiosko was installed (tests). Default: read from its own command line. */
  install?: InstallInfo;
  /** What "Update Kiosko" uses to touch the system (tests: fakes). Default: the real npm, service manager, downloads. */
  selfUpdate?: Partial<UpdaterDeps>;
  /** Kiosko's folder (tests). Default: paths.home. */
  home?: string;
  /**
   * How "Detect panels" (and the setup wizard) look for panels (tests, and trying the editor
   * without touching real ones). Default: ask `trcc serve` at `url` and libusb.
   */
  discover?: (url: string, tokenFile?: string) => Promise<Discovered>;
}

/** The panels "Detect panels" finds: those `trcc serve` drives, the LY ones on USB, the remote screens on the LAN. */
export interface Discovered {
  trcc: Awaited<ReturnType<typeof discoverTrcc>>;
  usb: Awaited<ReturnType<typeof discoverUsb>>;
  remote?: Awaited<ReturnType<typeof discoverRemote>>;
}

export const realDiscover = async (url: string, tokenFile?: string): Promise<Discovered> => {
  const [trcc, usb, remote] = await Promise.all([discoverTrcc(url, tokenFile), discoverUsb(), discoverRemote()]);
  return { trcc, usb, remote };
};

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
  // Newer plugins (and Kiosko) on npm, checked shortly after start and then daily.
  let updates: UpdateCheck | null = null;
  const askNpm = o.updateCheck ?? (() => checkUpdates(runtime.registry.packages(), { kioskoVersion: o.version }));
  const refreshUpdates = async (): Promise<UpdateCheck> => {
    updates = await askNpm();
    send('config', { rev, by: null });
    return updates;
  };
  const checking = o.checkUpdates ?? (!runtime.demoMode && process.env.KIOSKO_NO_UPDATE_CHECK !== '1');
  const updateTimers = checking
    ? [setTimeout(() => void refreshUpdates().catch(() => undefined), 20_000), setInterval(() => void refreshUpdates().catch(() => undefined), 24 * 3600_000)]
    : [];
  for (const t of updateTimers) t.unref?.();
  // The plugin store's catalogue: offline at once (the copy that comes with Kiosko), refreshed with the update check.
  const store = o.store ?? new StoreCatalog({ cacheDir: join(paths.home, 'store') });
  const storeTimers = checking ? [setTimeout(() => void store.refresh(), 15_000), setInterval(() => void store.refresh(), 24 * 3600_000)] : [];
  for (const t of storeTimers) t.unref?.();
  // Updating Kiosko itself (self-update.ts): how it was installed decides how, or whether, the editor can.
  const home = o.home ?? paths.home;
  const install = o.install ?? currentInstall();
  const registryUrl = o.selfUpdate?.registry ?? npmRegistry();
  const blocker = updateBlocker(install, { demo: runtime.demoMode });
  const instance = randomBytes(8).toString('hex');
  const how = o.selfUpdate?.restartHow ?? restartHow(install, { tty: !!process.stdout.isTTY, pid: process.pid });
  const probeHost = o.host === '0.0.0.0' || o.host === '::' ? '127.0.0.1' : o.host.includes(':') ? `[${o.host}]` : o.host;
  const handover: Handover = {
    instance,
    logFile: join(home, 'kiosko.log'),
    release: async () => {
      runtime.stop();
      for (const c of clients) c.end();
      clients.clear();
      await new Promise<void>((ok) => {
        server.close(() => ok());
        server.closeAllConnections();
        setTimeout(ok, 3000).unref();
      });
    },
    reclaim: async () => {
      await new Promise<void>((ok, fail) => {
        server.once('error', fail);
        server.listen(o.port, o.host, () => {
          server.off('error', fail);
          ok();
        });
      });
      runtime.start();
    },
    spawn: () => {
      const out = openSync(join(home, 'kiosko.log'), 'a');
      // The same arguments, but no second browser tab (--open): the editor reconnects by itself.
      const args = process.argv.slice(2).filter((a) => a !== '--open');
      const child = spawn(process.execPath, [...process.execArgv, install.cli, ...args], { detached: true, stdio: ['ignore', out, out], env: process.env, cwd: process.cwd(), windowsHide: true });
      const exited = new Promise((ok) => {
        child.once('exit', ok);
        child.once('error', ok);
      });
      child.unref();
      return { exited, kill: () => void child.kill() };
    },
    probe: async () => {
      const r = await fetch(`http://${probeHost}:${o.port}/api/version`, { signal: AbortSignal.timeout(1500) });
      return r.ok ? ((await r.json()) as { version: string; instance: string }) : null;
    },
    exit: () => {
      close();
      runtime.stop();
      setTimeout(() => process.exit(0), 100);
    },
  };
  const updater = new KioskoUpdater({
    install,
    current: o.version,
    registry: registryUrl,
    node: process.execPath,
    run: realRun,
    fetch: (u, i) => fetch(u, i),
    loaded: () => ({ ids: runtime.registry.list().map((p) => p.def.id), problems: runtime.registry.problems.map((p) => p.message) }),
    log: (m) => runtime.log('kiosko-update', m),
    changed: (st) => send('kiosko-update', st),
    tmpDir: tmpdir(),
    restartHow: how,
    handover,
    mark: (m) => writeMarker(home, m),
    launch: (script) => spawn('cmd.exe', ['/d', '/c', script], { detached: true, stdio: 'ignore', windowsHide: true }).unref(),
    serviceTask: async () => (await realRun('schtasks', ['/Query', '/TN', 'Kiosko'], { timeoutMs: 15_000 })).code === 0,
    port: o.port,
    home,
    ...o.selfUpdate,
  });
  // How the last update went, from the note it left before the restart.
  if (!runtime.demoMode) {
    const m = readMarker(home, o.version);
    if (m) {
      // The steps the previous Kiosko took, then how it ended.
      for (const l of m.lines) runtime.log('kiosko-update', `(before the restart) ${l}`);
      runtime.log('kiosko-update', m.message);
    }
  }
  const kioskoUpdateState = () => ({
    install: { kind: install.kind, service: install.service, dir: install.dir, perUser: install.perUser ?? false, platform: install.platform },
    canUpdate: blocker === null,
    blocker,
    restart: how,
    instructions: updates?.kiosko ? updateInstructions(install, updates.kiosko.latest, registryUrl) : null,
    status: updater.status,
  });
  /** Installs a plugin's release named in the catalogue, checked against its integrity; what it needs from the store first. */
  const installFromStore = async (p: StorePlugin, version: string) => {
    const index = store.current().index!;
    const release = p.releases.find((r) => r.version === version)!;
    const results = [];
    for (const need of p.requires) {
      if (runtime.registry.plugin(need)) continue;
      const dep = index.plugins.find((x) => x.id === need && !x.hidden);
      const r = dep && installableRelease(dep, { sdk: SDK_VERSION, platform: process.platform });
      if (dep && r) results.push(await installPlugin(`${dep.package}@${r.version}`, { registry: runtime.registry, runtime, expectIntegrity: r.integrity }));
    }
    results.push(await installPlugin(`${p.package}@${release.version}`, { registry: runtime.registry, runtime, expectIntegrity: release.integrity }));
    return results;
  };
  /** Bumped on every save, so a stale editor tab can't overwrite newer changes. */
  let rev = Date.now();

  const send = (event: string, data: unknown) => {
    const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    // A client already gone (or the server closing) is skipped: writing after end throws, uncaught.
    for (const c of clients) if (!c.writableEnded && !c.destroyed) c.write(line);
  };
  const onFrame = (f: FrameInfo) => send('frame', { screenId: f.screenId, pageId: f.pageId, at: f.at, interlude: f.interlude, alert: f.alert ?? null, sleeping: f.sleeping, tiles: f.tiles });
  const onAlerts = (alerts: unknown) => send('alerts', alerts);
  const onLog = (e: unknown) => send('log', e);
  runtime.on('frame', onFrame);
  runtime.on('alerts', onAlerts);
  runtime.on('log', onLog);
  runtime.on('config', () => thumbs.clear());
  // Home Assistant, over MQTT: connects only when the config has it switched on.
  const bridge = (o.homeassistant ?? !runtime.demoMode) ? new HomeAssistantBridge(runtime, o.version) : null;
  // Pushes from scripts (push-api.ts): token-authenticated, kept in Kiosko's folder.
  const push = pushApi({ runtime, json, ...(runtime.demoMode ? {} : { file: pushFile(home) }) });
  const fullStatus = () => ({ ...runtime.status(), homeassistant: bridge?.status() ?? { enabled: false, state: 'off', error: null }, push: push.status() });
  const statusTimer = setInterval(() => send('status', fullStatus()), 3000);

  const allowedHosts = new Set([`127.0.0.1:${o.port}`, `localhost:${o.port}`, `[::1]:${o.port}`, `${o.host}:${o.port}`]);

  /**
   * The language the editor speaks to whoever asks: the config's, or with "auto" their browser's (its
   * first Accept-Language, which is the browser's language: web/src/store.ts `locale` takes the same).
   * The catalogue (the library's widget names, the plugins' descriptions, the choices of an option) is
   * text of the editor, so it comes in this language; the panel and what it paints go by resolveLocale.
   */
  function uiLocale(req: IncomingMessage | undefined): string {
    const l = runtime.config.locale;
    if (l && l !== 'auto') return l;
    const first = String(req?.headers['accept-language'] ?? '').split(',')[0]?.split(';')[0]?.trim();
    return first && first !== '*' ? first : resolveLocale(runtime.config);
  }

  function state(req?: IncomingMessage) {
    const locale = resolveLocale(runtime.config);
    return {
      version: o.version,
      rev,
      locale,
      config: runtime.config,
      catalog: runtime.registry.catalog(uiLocale(req)),
      refused: runtime.registry.refused,
      updates: updates && { checkedAt: updates.checkedAt, plugins: updates.plugins, kiosko: updates.kiosko ?? null },
      kioskoUpdate: kioskoUpdateState(),
      categories: CATEGORIES,
      themes: THEMES,
      presets: PANEL_PRESETS,
      status: fullStatus(),
      alerts: runtime.listAlerts(),
      paths: { config: o.configPath, plugins: paths.plugins, home: paths.home },
      restartNeeded,
      official: OFFICIAL_PLUGINS,
      demo: runtime.demoMode,
      platform: process.platform,
    };
  }

  const remote = remoteApi({
    runtime,
    version: o.version,
    ...(o.firmwareFetch ? { fetch: o.firmwareFetch } : {}),
    json,
    body,
    commit: (cfg) => {
      const c = normalize(cfg);
      saveConfig(c, o.configPath);
      rev++;
      runtime.apply(c);
      send('config', { rev, by: null });
    },
  });

  function findScreen(cfg: Config, id: string): Screen | undefined {
    return cfg.screens.find((s) => s.id === id);
  }

  async function api(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const p = url.pathname;
    const m = req.method ?? 'GET';
    // Before the X-Kiosko check: a push carries its own token instead (see push-api.ts).
    if (p.startsWith('/api/push/') && (await push.handle(req, res, url))) return;
    if (m !== 'GET' && req.headers['x-kiosko'] !== '1') return json(res, 403, { error: 'missing X-Kiosko header' });

    if (p === '/api/state' && m === 'GET') return json(res, 200, state(req));

    if (p === '/api/config' && m === 'PUT') {
      const b = (await body(req)) as { config?: unknown; baseRev?: number };
      // Old clients send the bare config; new ones say which revision they edited.
      const raw = b && typeof b === 'object' && 'config' in b ? b.config : b;
      if (typeof b?.baseRev === 'number' && b.baseRev !== rev) return json(res, 409, { error: 'the configuration changed elsewhere', code: 'conflict', rev, config: runtime.config });
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
      const ping = setInterval(() => !res.writableEnded && !res.destroyed && res.write(': ping\n\n'), 20_000);
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
      if (!f) return json(res, 404, { error: 'no frame yet', code: 'noFrame' });
      const buf = await f.image();
      res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-store', 'content-length': String(buf.length), 'x-kiosko-at': String(f.at) });
      return void res.end(buf);
    }

    // Preview of a page being edited (not saved), with demo data where needed.
    if (p === '/api/preview' && m === 'POST') {
      const b = (await body(req)) as { screen: Screen; pageId?: string; forceShown?: Record<string, string>; demo?: boolean };
      const cfg = normalize({ screens: [b.screen] });
      const screen = cfg.screens[0]!;
      const page = screen.pages.find((x) => x.id === b.pageId) ?? screen.pages[0];
      if (!page) return json(res, 400, { error: 'no page', code: 'noPage' });
      const r = runtime.preview(screen, page, { ...(b.forceShown ? { forceShown: b.forceShown } : {}), demo: b.demo ?? true });
      return png(res, r.canvas.toBuffer('image/png'), { 'x-kiosko-tiles': encodeURIComponent(JSON.stringify(r.tiles)) });
    }

    if (p === '/api/thumbnail' && m === 'GET') {
      const type = url.searchParams.get('type') ?? '';
      const w = Math.max(40, Math.min(1920, Number(url.searchParams.get('w')) || 480));
      const h = Math.max(40, Math.min(1080, Number(url.searchParams.get('h')) || 300));
      const look = { theme: url.searchParams.get('theme') || undefined, locale: url.searchParams.get('locale') || undefined };
      const key = `${look.theme ?? runtime.config.theme}|${type}|${w}x${h}|${look.locale ?? runtime.config.locale}`;
      let buf = thumbs.get(key);
      if (!buf) {
        if (!runtime.registry.widget(type)) return json(res, 404, { error: 'unknown widget', code: 'unknownWidget' });
        buf = runtime.thumbnail(type, w, h, {}, undefined, look);
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
      const b = (await body(req)) as { slotId?: string; stop?: boolean; play?: boolean };
      if (b.stop) runtime.stopInterlude(decodeURIComponent(mm[1]!));
      else if (b.slotId) runtime.playInterlude(decodeURIComponent(mm[1]!), b.slotId, !!b.play);
      return json(res, 200, { ok: true });
    }
    // The Play page's buttons, for the interlude being played on that screen: one or several.
    mm = /^\/api\/screens\/([^/]+)\/input$/.exec(p);
    if (mm && m === 'POST') {
      const b = (await body(req)) as { events?: { key: string; pressed: boolean }[] } & { key?: string; pressed?: boolean };
      const events = b.events ?? (b.key ? [{ key: b.key, pressed: !!b.pressed }] : []);
      let taken = false;
      for (const e of events.slice(0, 32)) taken = runtime.press(decodeURIComponent(mm[1]!), e as never) || taken;
      return json(res, 200, { ok: true, playing: taken });
    }
    // Alerts: the active ones, one from outside, seen, snoozed, taken away, a screen's test.
    if (p === '/api/alerts' && m === 'GET') return json(res, 200, { alerts: runtime.listAlerts() });
    if (p === '/api/alerts' && m === 'POST') {
      try {
        return json(res, 200, { ok: true, alert: runtime.postAlert(await body(req, 64 * 1024)) });
      } catch (err) {
        if (err instanceof AlertError || err instanceof SyntaxError) return json(res, 400, { error: err.message, code: 'badAlert' });
        throw err;
      }
    }
    mm = /^\/api\/alerts\/([^/]+)(?:\/(ack|snooze))?$/.exec(p);
    if (mm && (m === 'POST' || m === 'DELETE')) {
      const id = decodeURIComponent(mm[1]!);
      const what = mm[2];
      if (m === 'DELETE' && !what) return runtime.removeAlert(id) ? json(res, 200, { ok: true }) : json(res, 404, { error: 'no such alert from outside', code: 'unknownAlert', params: { id } });
      if (m === 'POST' && what) {
        let r;
        if (what === 'ack') r = runtime.ackAlert(id);
        else {
          const b = (await body(req, 4096)) as { minutes?: number };
          const minutes = Number(b.minutes);
          r = runtime.snoozeAlert(id, Number.isFinite(minutes) && minutes > 0 ? Math.min(1440, minutes) * 60_000 : DEFAULT_SNOOZE_MS);
        }
        if (r === 'unknown') return json(res, 404, { error: 'no such alert', code: 'unknownAlert', params: { id } });
        if (r === 'notDismissible') return json(res, 409, { error: 'this alert cannot be dismissed', code: 'notDismissible', params: { id } });
        return json(res, 200, { ok: true, alerts: runtime.listAlerts() });
      }
    }
    mm = /^\/api\/screens\/([^/]+)\/test-alert$/.exec(p);
    if (mm && m === 'POST') {
      const b = (await body(req, 4096)) as { level?: string };
      const level: AlertLevel = ALERT_LEVELS.includes(b.level as AlertLevel) ? (b.level as AlertLevel) : 'critical';
      const a = runtime.testAlert(decodeURIComponent(mm[1]!), level);
      if (!a) return json(res, 404, { error: 'unknown screen', code: 'unknownScreen' });
      return json(res, 200, { ok: true, alert: a });
    }
    mm = /^\/api\/widgets\/([^/]+)\/refresh$/.exec(p);
    if (mm && m === 'POST') {
      runtime.refreshWidget(decodeURIComponent(mm[1]!));
      return json(res, 200, { ok: true });
    }

    if ((p.startsWith('/api/remote/') || /^\/api\/screens\/[^/]+\/remote\//.test(p)) && (await remote(req, res, p, m))) return;

    if (p === '/api/devices/discover' && m === 'GET') {
      const url0 = url.searchParams.get('url') ?? 'http://127.0.0.1:8099';
      return json(res, 200, await (o.discover ?? realDiscover)(url0, url.searchParams.get('tokenFile') ?? undefined));
    }

    // Who answers here: the update's handover tells the new Kiosko from the old one by it.
    if (p === '/api/version' && m === 'GET') return json(res, 200, { version: o.version, instance });

    // Updating Kiosko itself: how it was installed, what to do, and the button's steps.
    if (p === '/api/kiosko/update' && m === 'GET') return json(res, 200, kioskoUpdateState());
    if (p === '/api/kiosko/update' && m === 'POST') {
      const b = (await body(req, 4096)) as { version?: string };
      if (runtime.demoMode) return json(res, 409, { error: 'not in demo mode', code: 'demo' });
      if (blocker) return json(res, 409, { error: `this Kiosko can't update itself (${blocker}): follow the instructions`, code: 'cantUpdateKiosko', params: { why: blocker } });
      const latest = updates?.kiosko?.latest;
      if (!latest || b.version !== latest) return json(res, 409, { error: `no update of Kiosko to ${String(b.version)}`, code: 'noKioskoUpdate', params: { version: String(b.version) } });
      if (updater.busy) return json(res, 409, { error: 'an update is already under way', code: 'updateBusy' });
      // Runs on its own; the steps come as events (and GET /api/kiosko/update).
      updater.start(latest).catch((err) => runtime.log('kiosko-update', String(err instanceof Error ? err.message : err)));
      return json(res, 202, kioskoUpdateState());
    }
    if (p === '/api/kiosko/update/confirm' && m === 'POST') {
      const b = (await body(req, 4096)) as { version?: string };
      try {
        await updater.confirm(String(b.version));
        return json(res, 200, kioskoUpdateState());
      } catch (err) {
        return json(res, 409, { error: err instanceof Error ? err.message : String(err), code: err instanceof UpdateError ? err.code : 'failed' });
      }
    }
    if (p === '/api/kiosko/update/cancel' && m === 'POST') {
      updater.discard();
      return json(res, 200, kioskoUpdateState());
    }

    if (p === '/api/logs' && m === 'GET') return json(res, 200, runtime.logs.slice(-200));

    // Values to offer for an option, from a source's live data (or its demo data before there is any):
    // of the widget's source profile (`profile`), when it reads one.
    if (p === '/api/choices' && m === 'GET') {
      const source = url.searchParams.get('source') ?? '';
      const list = url.searchParams.get('list') ?? '';
      const key = resolveSourceKey(runtime.config, source, url.searchParams.get('profile'), runtime.registry.source(source));
      return json(res, 200, runtime.registry.choices(source, list, runtime.hub.data(key), uiLocale(req)));
    }

    if (p === '/api/plugins/install' && m === 'POST') {
      const b = (await body(req)) as { name?: string };
      const name = String(b.name ?? '').trim();
      try {
        // Only npm package names (optionally scoped) with an optional version: no URLs, no paths, no flags.
        const r = await installPlugin(name, { registry: runtime.registry, runtime });
        if (r.restart) restartNeeded = true;
        rev++;
        send('config', { rev, by: null });
        return json(res, 200, { ok: true, output: r.output, ids: r.ids, problem: r.problem ?? null, rolledBack: !!r.rolledBack, addedPermissions: r.addedPermissions ?? null, restartNeeded, state: state(req) });
      } catch (err) {
        return json(res, /valid npm/.test(String(err)) ? 400 : 500, { error: err instanceof Error ? err.message : String(err) });
      }
    }

    // The plugin store: the catalogue with what this Kiosko is, a plugin's record, a refresh, and an install of one exact release.
    if (p === '/api/store' && m === 'GET') {
      const st = store.current();
      return json(res, 200, {
        index: st.index && { ...st.index, plugins: st.index.plugins.filter((x) => !x.hidden) },
        from: st.from,
        fetchedAt: st.fetchedAt,
        error: st.error,
        url: store.url,
        online: checking,
        sdk: SDK_VERSION,
        platform: process.platform,
        installed: Object.fromEntries(runtime.registry.list().map(({ def }) => [def.id, def.version])),
      });
    }
    if (p === '/api/store/refresh' && m === 'POST') {
      const st = await store.refresh();
      return json(res, st.error && st.from !== 'network' ? 502 : 200, { from: st.from, fetchedAt: st.fetchedAt, error: st.error });
    }
    mm = /^\/api\/store\/([a-z0-9-]+)$/.exec(p);
    if (mm && m === 'GET') {
      const sheet = await store.sheet(mm[1]!);
      return sheet ? json(res, 200, sheet) : json(res, 404, { error: `no "${mm[1]}" in the store`, code: 'notInStore', params: { id: mm[1]! } });
    }
    if (p === '/api/store/install' && m === 'POST') {
      const b = (await body(req, 4096)) as { id?: string; version?: string; acceptRisk?: boolean };
      const id = String(b.id ?? '');
      const sp = store.current().index?.plugins.find((x) => x.id === id && !x.hidden);
      if (!sp) return json(res, 404, { error: `no "${id}" in the store`, code: 'notInStore', params: { id } });
      const release = sp.releases.find((r) => r.version === b.version);
      if (!release) return json(res, 409, { error: `${sp.package} has no release ${String(b.version)} in the store`, code: 'noRelease', params: { id, version: String(b.version) } });
      if (release.withdrawn) return json(res, 409, { error: `${sp.package}@${release.version} was withdrawn`, code: 'withdrawn', params: { id, version: release.version } });
      const why = releaseProblem({ sdk: release.sdk, platforms: release.platforms ?? sp.platforms }, { sdk: SDK_VERSION, platform: process.platform });
      if (why) return json(res, 409, { error: why.code === 'sdk' ? `written for the plugin API ${why.range}; this Kiosko has ${SDK_VERSION}` : `works on ${why.platforms.join(', ')}, not ${process.platform}`, code: 'cantInstall', params: { id } });
      // Nobody from Kiosko has read an unreviewed plugin: the person said they understand.
      if (sp.tier === 'found' && b.acceptRisk !== true) return json(res, 409, { error: `${sp.package} is unreviewed: confirm you accept the risk`, code: 'acceptRisk', params: { id } });
      try {
        const results = await installFromStore(sp, release.version);
        if (results.some((r) => r.restart)) restartNeeded = true;
        rev++;
        send('config', { rev, by: null });
        const problem = results.map((r) => r.problem).filter(Boolean).join('; ') || null;
        return json(res, 200, { ok: !problem, ids: results.flatMap((r) => r.ids), problem, rolledBack: results.some((r) => r.rolledBack), addedPermissions: results.at(-1)?.addedPermissions ?? null, version: release.version, restartNeeded, state: state(req) });
      } catch (err) {
        return json(res, err instanceof IntegrityError ? 409 : 500, { error: err instanceof Error ? err.message : String(err), ...(err instanceof IntegrityError ? { code: 'integrity', params: { id } } : {}) });
      }
    }

    mm = /^\/api\/plugins\/([^/]+)$/.exec(p);
    if (mm && m === 'DELETE') {
      const id = decodeURIComponent(mm[1]!);
      try {
        const r = await removePlugin(id, { registry: runtime.registry, runtime });
        if (!r.removed) return json(res, 409, { error: `can't remove "${id}": ${r.reason}`, code: 'cantRemove', params: { id, why: r.reason } });
        rev++;
        send('config', { rev, by: null });
        return json(res, 200, state(req));
      } catch (err) {
        return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    }

    if (p === '/api/plugins/updates' && m === 'GET') {
      if (url.searchParams.get('refresh') === '1' || !updates) {
        try {
          await refreshUpdates();
        } catch (err) {
          return json(res, 502, { error: err instanceof Error ? err.message : String(err) });
        }
      }
      return json(res, 200, updates);
    }

    // Installs the newest version of a plugin that fits this Kiosko (from the last check).
    mm = /^\/api\/plugins\/([^/]+)\/update$/.exec(p);
    if (mm && m === 'POST') {
      const id = decodeURIComponent(mm[1]!);
      const u = updates?.plugins.find((x) => x.id === id);
      if (!u?.version) return json(res, 409, u?.blocked ? { error: `can't update "${id}": ${u.blocked}`, code: 'cantUpdate', params: { id, why: u.blocked } } : { error: `no update for "${id}"`, code: 'noUpdate', params: { id } });
      try {
        const r = await installPlugin(`${u.package}@${u.version}`, { registry: runtime.registry, runtime });
        if (!r.problem && updates) updates = { ...updates, plugins: updates.plugins.filter((x) => x.id !== id) };
        if (r.restart) restartNeeded = true;
        rev++;
        send('config', { rev, by: null });
        return json(res, 200, { ok: !r.problem, ids: r.ids, problem: r.problem ?? null, rolledBack: !!r.rolledBack, addedPermissions: r.addedPermissions ?? null, version: u.version, state: state(req) });
      } catch (err) {
        return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    }

    mm = /^\/api\/plugins\/([^/]+)\/reload$/.exec(p);
    if (mm && m === 'POST') {
      const id = decodeURIComponent(mm[1]!);
      const problem = await reloadPlugin(id, { registry: runtime.registry, runtime });
      if (problem) return json(res, 409, { error: problem, code: 'reloadFailed', params: { id, why: problem } });
      rev++;
      send('config', { rev, by: null });
      return json(res, 200, state(req));
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
      return json(res, 200, state(req));
    }

    if (p === '/api/screens/export' && m === 'GET') {
      const id = url.searchParams.get('id') ?? '';
      const s = findScreen(runtime.config, id);
      if (!s || !safeId(id)) return json(res, 404, { error: 'unknown screen', code: 'unknownScreen' });
      res.writeHead(200, { 'content-type': 'application/json', 'content-disposition': `attachment; filename="kiosko-${id}.json"` });
      return void res.end(JSON.stringify({ kiosko: 'screen', version: 1, screen: { ...s, device: { driver: 'virtual' } } }, null, 2));
    }

    return json(res, 404, { error: 'not found', code: 'notFound' });
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
  function close() {
    clearInterval(statusTimer);
    bridge?.stop();
    push.close();
    for (const t of updateTimers) clearTimeout(t);
    for (const t of storeTimers) clearTimeout(t);
    // The runtime outlives the server (tests, a restart of the editor only): stop hearing it.
    runtime.off('frame', onFrame);
    runtime.off('alerts', onAlerts);
    runtime.off('log', onLog);
    for (const c of clients) c.end();
    clients.clear();
    server.close();
  }
  return { server, close, updater };
}

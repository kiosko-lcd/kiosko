/**
 * The editor's side of browser screens (docs/browser-screens.md), on the
 * editor's own server (127.0.0.1): the network-screens server's state, the
 * browsers waiting to be paired, pairing one with the code it shows, and
 * revoking one.
 *
 *   GET  /api/browser                     {enabled, host, port, listening, error, urls, waiting, waitSeconds}
 *   POST /api/browser/pair                {uid, code, screenId?} → {screenId}: the key goes into that
 *                                         screen's config (or a new screen's)
 *   POST /api/screens/:id/browser/unpair  the browser forgets its key (if connected) and so does the config
 *
 * The network-screens server itself is switched on and off in the config
 * (`networkScreens`), like everything else the editor saves. The pairing key
 * is written by the server, never shown.
 */
import { networkInterfaces } from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { BrowserError, isPortrait, newScreen, setPanelSize, setRotation, starterPage, type Config, type Registry, type Runtime, type Screen } from '@kiosko/core';

export interface BrowserApiContext {
  runtime: Runtime;
  commit(cfg: Config): void;
  json(res: ServerResponse, status: number, data: unknown): void;
  body(req: IncomingMessage, limit?: number): Promise<unknown>;
  /** The network-screens server now. */
  state(): { enabled: boolean; host: string; port: number; listening: boolean; error: string | null };
}

/** The addresses a browser on the LAN can open the viewer at. */
export function viewerUrls(host: string, port: number): string[] {
  const at = (h: string) => `http://${h.includes(':') ? `[${h}]` : h}:${port}/`;
  if (host !== '0.0.0.0' && host !== '::') return [at(host)];
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) out.push(at(a.address));
  }
  // Private ranges first (the LAN), container bridges last.
  const rank = (u: string) => (/\/\/192\.168\./.test(u) ? 0 : /\/\/10\./.test(u) ? 1 : /\/\/172\.(1[6-9]|2\d|3[01])\./.test(u) ? 2 : 3);
  return out.sort((a, b) => rank(a) - rank(b));
}

/** The picture a browser of `w`×`h` device pixels wants: its orientation, and its size held landscape. */
function pictureOf(w: number, h: number): { rotate: 0 | 90; native: { width: number; height: number } } {
  return { rotate: h > w ? 90 : 0, native: { width: Math.max(w, h), height: Math.min(w, h) } };
}

/** A new screen for a browser: its size and orientation, its first page. */
export function browserScreen(registry: Registry, info: { uid: string; id: string; w: number; h: number }, key: string, locale: string): Screen {
  const s = newScreen(info.id || 'Browser', info.w, info.h, { driver: 'browser', uid: info.uid, id: info.id, key });
  s.rotate = info.h > info.w ? 90 : 0;
  s.jpegQuality = 80;
  s.pages = [starterPage((t) => !!registry.widget(t), { width: info.w, height: info.h, locale, agents: false })];
  return s;
}

/**
 * Turns and resizes a browser screen to its browser's window, unless it is
 * already about that (a few % either way: an address bar coming and going is
 * not worth new layouts). Returns whether it changed.
 */
export function followViewer(s: Screen, w: number, h: number): boolean {
  if (s.device.driver !== 'browser' || s.device.follow === false) return false;
  const { rotate, native } = pictureOf(w, h);
  const turn = isPortrait({ width: w, height: h }) !== isPortrait(s);
  const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(8, b * 0.06);
  if (!turn && near(w, s.width) && near(h, s.height)) return false;
  if (turn || s.rotate !== rotate) setRotation(s, rotate);
  setPanelSize(s, native.width, native.height);
  return true;
}

export function browserApi(ctx: BrowserApiContext) {
  const fail = (res: ServerResponse, err: unknown) => {
    if (err instanceof BrowserError) return ctx.json(res, err.code === 'wait' ? 429 : err.code === 'gone' ? 404 : 409, { error: err.message, code: `browser.${err.code}`, ...(err.params ? { params: err.params } : {}) });
    throw err;
  };
  const hub = ctx.runtime.browsers;

  // The browser turned (or its window changed): the screen follows, saved like any edit.
  hub.on('resize', ({ uid, w, h }: { uid: string; w: number; h: number }) => {
    const cfg = structuredClone(ctx.runtime.config);
    const s = cfg.screens.find((x) => x.device.driver === 'browser' && x.device.uid === uid);
    if (s && followViewer(s, w, h)) {
      ctx.runtime.log(`screen:${s.name}`, `its browser is ${w}×${h} now: the screen follows`);
      ctx.commit(cfg);
    }
  });

  return async function handle(req: IncomingMessage, res: ServerResponse, p: string, m: string): Promise<boolean> {
    if (p === '/api/browser' && m === 'GET') {
      const st = ctx.state();
      ctx.json(res, 200, { ...st, urls: st.listening ? viewerUrls(st.host, st.port) : [], waiting: hub.waiting(), waitSeconds: hub.waitSeconds() });
      return true;
    }
    if (p === '/api/browser/pair' && m === 'POST') {
      const b = (await ctx.body(req, 4096)) as { uid?: string; code?: string; screenId?: string };
      let paired: Awaited<ReturnType<typeof hub.pair>>;
      try {
        paired = await hub.pair(String(b.uid ?? ''), String(b.code ?? ''));
      } catch (err) {
        return fail(res, err), true;
      }
      const { info, key } = paired;
      const cfg = structuredClone(ctx.runtime.config);
      const hex = key.toString('hex');
      // The key goes to the screen asked for, else to the one that had this browser, else a new one.
      let s = (b.screenId && cfg.screens.find((x) => x.id === b.screenId)) || cfg.screens.find((x) => x.device.driver === 'browser' && x.device.uid === info.uid);
      if (s) {
        const follow = s.device.driver === 'browser' ? s.device.follow : undefined;
        s.device = { driver: 'browser', uid: info.uid, id: info.id, key: hex, ...(follow === false ? { follow } : {}) };
        followViewer(s, info.w, info.h);
      } else {
        s = browserScreen(ctx.runtime.registry, info, hex, ctx.runtime.config.locale === 'auto' ? 'en' : ctx.runtime.config.locale);
        cfg.screens.push(s);
      }
      ctx.commit(cfg);
      // Now that the config has its key, the browser may connect with it.
      paired.finish();
      ctx.json(res, 200, { ok: true, screenId: s.id });
      return true;
    }
    const mm = /^\/api\/screens\/([^/]+)\/browser\/unpair$/.exec(p);
    if (mm && m === 'POST') {
      const id = decodeURIComponent(mm[1]!);
      const cfg = structuredClone(ctx.runtime.config);
      const s = cfg.screens.find((x) => x.id === id);
      if (!s || s.device.driver !== 'browser') return ctx.json(res, 404, { error: 'not a browser screen', code: 'unknownScreen' }), true;
      // Told first (over its session, with the key it has), then the key goes here.
      const told = hub.revoke(s.device.uid);
      delete s.device.key;
      ctx.commit(cfg);
      ctx.json(res, 200, { ok: true, told });
      return true;
    }
    return false;
  };
}

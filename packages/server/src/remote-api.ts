/**
 * The editor's API for Kiosko remote screens (docs/remote-screen.md):
 *
 *   POST   /api/remote/pair              {uid, host?, port?}  the screen shows a code → {pairId, ttl, screen}
 *   POST   /api/remote/pair/:pairId      {code, screenId?}    pairs; the key goes into that screen's
 *                                                           config (or a new screen) → {screenId}
 *   DELETE /api/remote/pair/:pairId                          gives up
 *   POST   /api/screens/:id/remote/unpair                    the screen forgets this Kiosko, and the key is dropped here
 *   POST   /api/screens/:id/remote/ota   (the .bin as body)  firmware update over the session
 *   GET    /api/screens/:id/remote/logs                      its recent log
 *
 * The pairing key is written by the server, never typed or shown.
 */
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Pairing, RemoteDevice, ScreenError, newScreen, otaUpdate, remoteBrowser, screenLogs, starterPage, unpairScreen, type Config, type Registry, type Rotation, type Runtime, type Screen } from '@kiosko/core';

export interface RemoteApiContext {
  runtime: Runtime;
  /** Saves and applies a new config (and tells the editors). */
  commit(cfg: Config): void;
  json(res: ServerResponse, status: number, data: unknown): void;
  body(req: IncomingMessage, limit?: number): Promise<unknown>;
  /** Tests: where a screen is, instead of mDNS. */
  locate?: (uid: string) => { host: string; port: number } | undefined;
}

const PAIR_TTL_MS = 3 * 60_000;

/** Raw body, for the firmware image. */
async function raw(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new ScreenError('tooBig', 'body too large');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

/** A new screen for a remote screen: the size its glass shows at the angle it has now. */
export function remoteScreen(registry: Registry, info: { uid: string; id: string; w: number; h: number; rot: number; max: number }, key: string, locale: string, host?: string): Screen {
  const rot = ([0, 90, 180, 270].includes(info.rot) ? info.rot : 0) as Rotation;
  const quarter = rot === 90 || rot === 270;
  const width = (quarter ? info.h : info.w) || 320, height = (quarter ? info.w : info.h) || 172;
  const s = newScreen(info.id || 'Remote screen', width, height, { driver: 'remote', uid: info.uid, ...(info.id ? { id: info.id } : {}), key, ...(host ? { host } : {}) });
  s.rotate = rot;
  s.jpegQuality = 85;
  s.maxBytes = Math.max(16 * 1024, Math.min(info.max - 1024, 90 * 1024));
  s.pages = [starterPage((t) => !!registry.widget(t), { width, height, locale, agents: false })];
  return s;
}

export function remoteApi(ctx: RemoteApiContext) {
  const pending = new Map<string, { pairing: Pairing; uid: string; host: string; port: number; timer: ReturnType<typeof setTimeout> }>();
  /** Where a screen is: the address given, else what mDNS heard; asked for now if it heard nothing yet. */
  const locate = async (uid: string, host?: string, port?: number) => {
    if (host) return { host, port: port ?? 7428 };
    const t = ctx.locate?.(uid);
    if (t) return t;
    const b = remoteBrowser();
    const f = b.get(uid) ?? (uid ? (await b.browse(2500)).find((x) => x.uid === uid) : undefined);
    return f ? { host: f.address, port: f.port } : undefined;
  };
  const fail = (res: ServerResponse, err: unknown) => {
    if (err instanceof ScreenError) return ctx.json(res, err.code === 'offline' ? 404 : 409, { error: err.message, code: `remote.${err.code}` });
    const e = err as { code?: string; message?: string };
    return ctx.json(res, 502, { error: e?.message ?? String(err), code: 'remote.unreachable' });
  };
  const screenOf = (id: string) => ctx.runtime.config.screens.find((s) => s.id === id);
  const remoteOf = (id: string) => {
    const s = screenOf(id);
    if (!s || s.device.driver !== 'remote') return null;
    const d = ctx.runtime.deviceOf(id);
    return { screen: s, device: s.device, driver: d instanceof RemoteDevice ? d : null };
  };

  return async function handle(req: IncomingMessage, res: ServerResponse, p: string, m: string): Promise<boolean> {
    if (p === '/api/remote/pair' && m === 'POST') {
      const b = (await ctx.body(req, 4096)) as { uid?: string; host?: string; port?: number };
      const uid = String(b.uid ?? '');
      const at = await locate(uid, b.host, b.port);
      if (!at) return ctx.json(res, 404, { error: 'that screen is not on the network', code: 'remote.offline' }), true;
      try {
        const pairing = await Pairing.start(at.host, at.port, `Kiosko on ${hostname()}`.slice(0, 40));
        if (uid && pairing.info.uid !== uid) {
          pairing.cancel();
          return ctx.json(res, 409, { error: 'another screen answers there', code: 'remote.otherScreen' }), true;
        }
        const pairId = randomBytes(12).toString('hex');
        const timer = setTimeout(() => {
          pending.get(pairId)?.pairing.cancel();
          pending.delete(pairId);
        }, PAIR_TTL_MS);
        timer.unref();
        pending.set(pairId, { pairing, uid: pairing.info.uid, host: at.host, port: at.port, timer });
        ctx.json(res, 200, { pairId, ttl: pairing.ttl, screen: pairing.info });
      } catch (err) {
        fail(res, err);
      }
      return true;
    }
    let mm = /^\/api\/remote\/pair\/([0-9a-f]{24})$/.exec(p);
    if (mm && (m === 'POST' || m === 'DELETE')) {
      const job = pending.get(mm[1]!);
      if (!job) return ctx.json(res, 404, { error: 'no such pairing (it expired?)', code: 'remote.pairingOver' }), true;
      pending.delete(mm[1]!);
      clearTimeout(job.timer);
      if (m === 'DELETE') {
        job.pairing.cancel();
        return ctx.json(res, 200, { ok: true }), true;
      }
      const b = (await ctx.body(req, 4096)) as { code?: string; screenId?: string };
      let key: Buffer;
      try {
        key = await job.pairing.finish(String(b.code ?? ''));
      } catch (err) {
        return fail(res, err), true;
      }
      const info = job.pairing.info;
      const cfg = structuredClone(ctx.runtime.config);
      // The key goes to the screen asked for, else to the one that already has this uid, else a new one.
      let s = (b.screenId && cfg.screens.find((x) => x.id === b.screenId)) || cfg.screens.find((x) => x.device.driver === 'remote' && x.device.uid === info.uid);
      const hex = key.toString('hex');
      if (s) {
        const keepHost = s.device.driver === 'remote' ? s.device.host : undefined;
        const keepPort = s.device.driver === 'remote' ? s.device.port : undefined;
        s.device = { driver: 'remote', uid: info.uid, id: info.id, key: hex, ...(keepHost ? { host: keepHost } : {}), ...(keepPort ? { port: keepPort } : {}) };
      } else {
        s = remoteScreen(ctx.runtime.registry, info, hex, ctx.runtime.config.locale === 'auto' ? 'en' : ctx.runtime.config.locale);
        cfg.screens.push(s);
      }
      ctx.commit(cfg);
      return ctx.json(res, 200, { ok: true, screenId: s.id }), true;
    }

    mm = /^\/api\/screens\/([^/]+)\/remote\/(unpair|ota|logs)$/.exec(p);
    if (mm) {
      const id = decodeURIComponent(mm[1]!);
      const r = remoteOf(id);
      if (!r) return ctx.json(res, 404, { error: 'not a remote screen', code: 'unknownScreen' }), true;
      const key = /^[0-9a-f]{64}$/.test(r.device.key ?? '') ? Buffer.from(r.device.key!, 'hex') : null;
      const run = async <R>(fn: (host: string, port: number) => Promise<R>) => {
        if (r.driver) return r.driver.exclusive(fn);
        const at = await locate(r.device.uid, r.device.host, r.device.port);
        if (!at) throw new ScreenError('offline', 'that screen is not on the network');
        return fn(at.host, at.port);
      };
      try {
        if (mm[2] === 'unpair' && m === 'POST') {
          // The screen forgets us if it can be reached; the key goes here either way.
          let told = false;
          if (key) {
            try {
              await run((h, port) => unpairScreen(h, port, key, r.device.uid));
              told = true;
            } catch {
              /* offline: forgotten here only; BOOT held 5 s forgets it there */
            }
          }
          const cfg = structuredClone(ctx.runtime.config);
          const s = cfg.screens.find((x) => x.id === id)!;
          if (s.device.driver === 'remote') delete s.device.key;
          ctx.commit(cfg);
          return ctx.json(res, 200, { ok: true, told }), true;
        }
        if (!key) return ctx.json(res, 409, { error: 'not paired', code: 'remote.notPaired' }), true;
        if (mm[2] === 'logs' && m === 'GET') return ctx.json(res, 200, { text: await run((h, port) => screenLogs(h, port, key, r.device.uid)) }), true;
        if (mm[2] === 'ota' && m === 'POST') {
          const image = await raw(req, 4 * 1024 * 1024);
          await run((h, port) => otaUpdate(h, port, key, r.device.uid, image));
          return ctx.json(res, 200, { ok: true }), true;
        }
      } catch (err) {
        return fail(res, err), true;
      }
    }
    return false;
  };
}

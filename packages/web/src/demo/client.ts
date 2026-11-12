/**
 * Browser demo only: the connection to the in-browser runtime
 * (demo/renderer.ts, built as assets/renderer.js next to app.js). It runs
 * in a module Web Worker so painting never blocks the editor; where a
 * worker can't paint, the page imports the same file and paints itself.
 * `?render=page` forces the latter (for comparing).
 *
 * Nothing here runs until `renderer()` is first called: this module is
 * reachable from the normal build's module graph and must stay inert there.
 */
import type { FromWorker, RendererApi, RendererEvent, ToWorker } from '../../demo/protocol.ts';

let connection: Promise<RendererApi> | null = null;
let listener: ((e: RendererEvent) => void) | null = null;
/** Where painting happens, for the Activity log. */
export let renderMode: 'worker' | 'page' | null = null;

/** Receives the runtime's events (frames, status, logs). */
export function onRendererEvent(fn: (e: RendererEvent) => void): void {
  listener = fn;
}

function dispatch(e: RendererEvent): void {
  listener?.(e);
}

export function renderer(): Promise<RendererApi> {
  connection ??= connect();
  return connection;
}

async function connect(): Promise<RendererApi> {
  const url = new URL('./renderer.js', import.meta.url).href;
  if (typeof Worker !== 'undefined' && new URLSearchParams(location.search).get('render') !== 'page') {
    try {
      const api = await viaWorker(url);
      renderMode = 'worker';
      return api;
    } catch (err) {
      console.warn('Kiosko demo: painting in the page instead of a worker:', err instanceof Error ? err.message : err);
    }
  }
  const mod = (await import(/* the runtime, not bundled here */ url)) as { DemoRenderer: new (emit: (e: RendererEvent) => void) => RendererApi };
  renderMode = 'page';
  return new mod.DemoRenderer(dispatch);
}

function viaWorker(url: string): Promise<RendererApi> {
  return new Promise((ready, fail) => {
    const worker = new Worker(url, { type: 'module', name: 'kiosko-renderer' });
    const pending = new Map<number, { ok: (v: unknown) => void; ko: (e: Error) => void }>();
    let seq = 0;
    let started = false;
    const call = (method: ToWorker['method'], args: unknown[]) =>
      new Promise<unknown>((ok, ko) => {
        const id = ++seq;
        pending.set(id, { ok, ko });
        worker.postMessage({ id, method, args } satisfies ToWorker);
      });
    worker.onmessage = ({ data }: MessageEvent<FromWorker>) => {
      if ('ready' in data) {
        started = true;
        ready({
          init: (stored) => call('init', [stored]),
          apply: (config) => call('apply', [config]),
          state: () => call('state', []),
          preview: (screen, pageId, forceShown, demo) => call('preview', [screen, pageId, forceShown, demo]),
          thumbnail: (type, w, h, look) => call('thumbnail', [type, w, h, look]),
          pin: (screenId, pageId) => call('pin', [screenId, pageId]),
          logs: () => call('logs', []),
          stage: (channels) => call('stage', [channels]),
        } as RendererApi);
      } else if ('unsupported' in data) {
        worker.terminate();
        fail(new Error(data.unsupported));
      } else if ('event' in data) dispatch(data.event);
      else {
        const p = pending.get(data.id);
        pending.delete(data.id);
        if ('error' in data) p?.ko(new Error(data.error));
        else p?.ok(data.result);
      }
    };
    worker.onerror = (e) => {
      e.preventDefault();
      const err = new Error(e.message || 'the demo worker failed to start');
      if (!started) {
        worker.terminate();
        fail(err);
      }
      for (const p of pending.values()) p.ko(err);
      pending.clear();
    };
  });
}

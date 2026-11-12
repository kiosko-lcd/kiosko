/**
 * The browser demo's "server": Kiosko's own runtime (registry, compositor
 * and every bundled plugin) in demo mode, so each widget paints its sample
 * data and nothing is read, run or fetched. It paints the editor's
 * previews and thumbnails, and stands in for the panel loop with a light
 * clock that says which page each screen would show now.
 *
 * Built as assets/renderer.js (see build.mjs). Loaded as a module Web
 * Worker it answers messages (bottom of the file); where workers can't
 * paint (no OffscreenCanvas or fonts there), the page imports it and uses
 * `DemoRenderer` directly. The editor side is src/demo/.
 */
import { PANEL_PRESETS, Registry, Runtime, composeWidget, withLook, isWorking, normalize, pickPage, registerFonts, resolveLocale, whenMatches, type Config, type ThumbnailLook, type Screen } from '@kiosko/core';
import { CATEGORIES, THEMES, themeById } from '@kiosko/sdk';
import serverPackage from '../../server/package.json' with { type: 'json' };
import showcase from '../../../examples/showcase.json' with { type: 'json' };
import { MISSING_OFFICIAL, OFFICIAL_PLUGINS, demoPlugins } from './plugins.ts';
import type { FromWorker, LogEntry, PreviewResult, RendererApi, RendererEvent, RuntimeState, StageChannel, ToWorker } from './protocol.ts';
import { fontsReady, toBlob } from './shims/canvas.ts';
import { Stage } from './stage.ts';

/** How often the stand-in panel loop says what's on each screen (and the editor repaints). */
const FRAME_MS = 4000;

const es = (locale: string) => locale.toLowerCase().startsWith('es');

export class DemoRenderer implements RendererApi {
  private readonly registry = new Registry();
  private runtime: Runtime | null = null;
  private readonly emit: (e: RendererEvent, transfer?: Transferable[]) => void;
  /** The 3D page's panel loop; idle unless that page asks for frames. */
  private readonly show: Stage;
  /** Pages pinned from the editor since the last config change (as `Runtime.pin`). */
  private readonly pinned = new Map<string, string | null>();
  /** Page each screen shows now, per the rotation, and how many "frames" it has had. */
  private readonly onPanel = new Map<string, { pageId: string | null; at: number; frames: number }>();
  private readonly thumbs = new Map<string, Blob>();
  private clock: ReturnType<typeof setInterval> | null = null;

  constructor(emit: (e: RendererEvent, transfer?: Transferable[]) => void) {
    this.emit = emit;
    this.show = new Stage({
      runtime: () => this.rt,
      // A page's canvas is new each time and can be given away; an interlude's is painted on again, so it is copied.
      snap: (canvas, reused) => {
        const c = canvas as unknown as OffscreenCanvas | HTMLCanvasElement;
        return !reused && 'transferToImageBitmap' in c ? c.transferToImageBitmap() : createImageBitmap(c);
      },
      emit: (frame) => this.emit({ name: 'stage', data: frame }, [frame.bitmap]),
    });
    for (const { def, origin } of demoPlugins()) this.registry.add(def, origin);
  }

  private get rt(): Runtime {
    if (!this.runtime) throw new Error('the demo runtime is not started');
    return this.runtime;
  }

  async init(stored: unknown): Promise<{ config: Config; fromShowcase: boolean }> {
    registerFonts();
    await fontsReady();
    const fromShowcase = !stored || typeof stored !== 'object' || !Array.isArray((stored as Config).screens);
    const config = normalize(fromShowcase ? showcase : stored);
    const rt = new Runtime(this.registry, config, { demo: true });
    rt.on('log', (e: LogEntry) => this.emit({ name: 'log', data: e }));
    this.runtime = rt;
    rt.apply(config);
    const n = this.registry.list().length;
    rt.log('demo', `browser demo: ${n} plugins, sample data; nothing is read from this computer`);
    if (MISSING_OFFICIAL.length) rt.log('demo', `official plugins not bundled: ${MISSING_OFFICIAL.join(', ')}`);
    for (const p of this.registry.problems) rt.log('demo', `plugin ${p.origin}: ${p.message}`);
    this.tick();
    this.clock = setInterval(() => this.tick(), FRAME_MS);
    return { config, fromShowcase };
  }

  async apply(raw: unknown): Promise<Config> {
    const config = normalize(raw);
    this.pinned.clear();
    this.rt.apply(config);
    this.tick();
    return config;
  }

  async state(): Promise<RuntimeState> {
    const locale = resolveLocale(this.rt.config);
    return {
      version: serverPackage.version,
      locale,
      catalog: this.registry.catalog(locale),
      // Plain data, typed as the editor reads it from the server's JSON.
      categories: CATEGORIES as unknown as RuntimeState['categories'],
      themes: THEMES as unknown as RuntimeState['themes'],
      presets: PANEL_PRESETS,
      status: this.status(),
      official: OFFICIAL_PLUGINS,
    };
  }

  async preview(screen: Screen, pageId: string, forceShown?: Record<string, string>, demo = true): Promise<PreviewResult> {
    const sc = normalize({ screens: [screen] }).screens[0]!;
    const page = sc.pages.find((p) => p.id === pageId) ?? sc.pages[0];
    if (!page) throw new Error('no page');
    const r = this.rt.preview(sc, page, { ...(forceShown ? { forceShown } : {}), demo });
    const blob = await toBlob(r.canvas as unknown as OffscreenCanvas);
    return { blob, tiles: r.tiles.map((t) => ({ id: t.id, shown: t.shown, ...(t.error ? { error: t.error } : {}) })) };
  }

  /** A widget alone with its demo data, for the library (as GET /api/thumbnail). */
  async thumbnail(type: string, width: number, height: number, look: ThumbnailLook = {}): Promise<Blob> {
    const w = Math.max(40, Math.min(1920, Math.round(width) || 480));
    const h = Math.max(40, Math.min(1080, Math.round(height) || 300));
    const cfg = withLook(this.rt.config, look);
    const key = `${cfg.theme}|${type}|${w}x${h}|${cfg.locale}`;
    let blob = this.thumbs.get(key);
    if (!blob) {
      if (!this.registry.widget(type)) throw new Error('unknown widget');
      const r = composeWidget({ cfg, registry: this.registry, theme: themeById(cfg.theme), type, width: w, height: h });
      // The server keeps quiet here; in the demo a widget that can't paint in a browser should show up in Activity.
      if (r.tiles[0]?.error) this.rt.log(type, `thumbnail failed: ${r.tiles[0].error}`);
      blob = await toBlob(r.canvas as unknown as OffscreenCanvas);
      if (this.thumbs.size > 300) this.thumbs.clear();
      this.thumbs.set(key, blob);
    }
    return blob;
  }

  async pin(screenId: string, pageId: string | null): Promise<void> {
    this.pinned.set(screenId, pageId);
    this.tick();
  }

  async logs(): Promise<LogEntry[]> {
    return this.rt.logs.slice(-200);
  }

  async stage(channels: StageChannel[]): Promise<void> {
    this.show.start(channels);
  }

  /**
   * The panel loop, minus the painting: which page each enabled screen
   * shows now (work hours, rotation, pins). The editor marks it and
   * repaints its preview on each of these, as with a real panel.
   */
  private tick(): void {
    const rt = this.rt;
    const now = Date.now();
    const working = isWorking(rt.config.workday, now);
    for (const s of rt.config.screens) {
      if (!s.enabled) continue;
      const pinned = this.pinned.has(s.id) ? this.pinned.get(s.id)! : (s.pinnedPage ?? null);
      const page = pickPage(
        s.pages.filter((p) => whenMatches(p.when, working)),
        now,
        pinned,
      );
      this.onPanel.set(s.id, { pageId: page?.id ?? null, at: now, frames: (this.onPanel.get(s.id)?.frames ?? 0) + 1 });
      this.emit({ name: 'frame', data: { screenId: s.id, pageId: page?.id ?? null, at: now, interlude: null, sleeping: false } });
    }
    this.emit({ name: 'status', data: this.status() });
  }

  private status(): RuntimeState['status'] {
    const st = this.rt.status();
    const locale = resolveLocale(this.rt.config);
    const noPanel = es(locale) ? 'demo en el navegador: aquí no hay panel' : 'browser demo: no panel here';
    return {
      ...st,
      screens: st.screens.map((s) => {
        const p = this.onPanel.get(s.id);
        const pinned = this.pinned.has(s.id) ? this.pinned.get(s.id)! : s.pinned;
        return {
          ...s,
          page: p?.pageId ?? null,
          pinned,
          lastFrameAt: p?.at ?? null,
          // A virtual panel "gets" each tick's frame, as it would from the real loop.
          device: s.device.driver === 'virtual' ? { ...s.device, framesSent: p?.frames ?? 0, lastSentAt: p?.at ?? null } : { ...s.device, ok: false, message: noPanel },
        };
      }),
    };
  }

  stop(): void {
    this.show.stop();
    if (this.clock) clearInterval(this.clock);
    this.runtime?.stop();
  }
}

// ---------- As a module Web Worker ----------

declare const WorkerGlobalScope: { new (): unknown } | undefined;

interface WorkerScope {
  postMessage(m: FromWorker, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<ToWorker>) => void) | null;
  fonts?: unknown;
}

if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) {
  const scope = self as unknown as WorkerScope;
  // Painting here needs a 2D OffscreenCanvas and fonts in workers; without
  // them the page takes over (src/demo/client.ts).
  const can = typeof OffscreenCanvas !== 'undefined' && typeof FontFace !== 'undefined' && !!scope.fonts && !!new OffscreenCanvas(1, 1).getContext('2d');
  if (!can) scope.postMessage({ unsupported: 'no OffscreenCanvas 2D or FontFace in workers' });
  else {
    const renderer = new DemoRenderer((event, transfer) => scope.postMessage({ event }, transfer ?? []));
    scope.onmessage = async ({ data: { id, method, args } }) => {
      try {
        const result = await (renderer[method] as (...a: unknown[]) => Promise<unknown>).apply(renderer, args);
        scope.postMessage({ id, result });
      } catch (err) {
        scope.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
      }
    };
    scope.postMessage({ ready: true });
  }
}

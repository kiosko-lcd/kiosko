/**
 * The panel loop of the 3D page (panel3d/): paints a screen's pages over and
 * over, as the daemon does for a real panel, and hands each frame on as a
 * picture. Widgets' animations and the screen's interludes play too, with the
 * same code the daemon plays them with, only more often: a visitor should
 * see one within seconds, where a panel on a desk waits minutes.
 *
 * Nothing here knows about 3D, or about workers: `snap` turns a painted
 * canvas into whatever travels (an ImageBitmap in the browser) and `emit`
 * takes it away, so the timing can be tested in Node.
 */
import { CANVAS, baseContext, checkPlan, composePage, normalize, type Animatable, type ComposeResult, type Page, type PlayablePlan, type Runtime, type Screen, type TileCache } from '@kiosko/core';
import { validate } from '@kiosko/sdk';
import type { StageChannel, StageFrame } from './protocol.ts';

/** Animations and interludes are paced for a browser, not for a USB cable. */
const MAX_FPS = 24;
/** A hold (a widget staying still mid-animation) is cut to this: nobody watches a still showcase. */
const MAX_HOLD_MS = 2500;
/** After a question no widget answered with a plan, ask again this soon. */
const ASK_AGAIN_MS = 1500;

type Painted = ComposeResult['canvas'];
type Meta = Pick<StageFrame, 'page' | 'kind' | 'what'>;

export interface StageDeps<P> {
  runtime: () => Runtime;
  /** A painted canvas as something that can be handed on. `reused`: the canvas will be painted on again. */
  snap: (canvas: Painted, reused: boolean) => P | Promise<P>;
  emit: (frame: Omit<StageFrame, 'bitmap'> & { bitmap: P }) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  rnd?: () => number;
}

export class Stage<P = ImageBitmap> {
  /** Bumped to stop every running loop. */
  private generation = 0;
  private readonly d: Required<StageDeps<P>>;

  constructor(deps: StageDeps<P>) {
    this.d = { now: Date.now, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), rnd: Math.random, ...deps };
  }

  /** Starts painting these channels (and stops whatever was being painted). None = stop. */
  start(channels: StageChannel[]): void {
    const gen = ++this.generation;
    for (const ch of channels) {
      void this.run(ch, () => gen === this.generation).catch((err: unknown) => this.d.runtime().log('stage', `channel ${ch.id} stopped: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  stop(): void {
    this.generation++;
  }

  /** The pages a channel goes through: a widget alone, or the screen's (all, or the named ones, in that order). */
  pagesOf(ch: StageChannel, screen: Screen): Page[] {
    if (ch.widget) {
      // A widget made for a small tile would be lost on a whole panel: it is magnified, as its "zoom" setting does.
      const preferred = this.d.runtime().registry.widget(ch.widget.type)?.size?.preferred;
      const fill = preferred ? Math.min((screen.width - 20) / preferred.w, (screen.height - 20) / preferred.h) : 1;
      const zoom = ch.widget.zoom ?? Math.max(1, Math.min(2, Math.floor(fill * 10) / 10));
      const alone = normalize({
        screens: [
          {
            ...screen,
            pages: [
              {
                id: `stage-${ch.id}`,
                name: ch.widget.title ?? ch.widget.type,
                grid: { cols: 24, rows: 6, gap: 10, padding: 10 },
                tiles: [{ id: `stage-${ch.id}-tile`, x: 0, y: 0, w: 24, h: 6, chrome: ch.widget.chrome ?? 'auto', widgets: [{ id: `stage-${ch.id}-widget`, type: ch.widget.type, options: ch.widget.options ?? {}, ...(zoom !== 1 ? { zoom } : {}) }] }],
              },
            ],
          },
        ],
      });
      return alone.screens[0]!.pages;
    }
    const enabled = screen.pages.filter((p) => p.enabled !== false);
    if (!ch.pages?.length) return enabled;
    const wanted = ch.pages.map((w) => enabled.find((p) => p.id === w || p.name.toLowerCase() === w.toLowerCase())).filter((p): p is Page => !!p);
    return wanted.length ? wanted : enabled;
  }

  private async run(ch: StageChannel, alive: () => boolean): Promise<void> {
    const { now, sleep, rnd } = this.d;
    const cache: TileCache = new Map();
    const started = now();
    const between = ([min, max]: [number, number]) => min + rnd() * Math.max(0, max - min);
    const animateMs = ch.animateMs ?? [6000, 12_000];
    // The first animation soon: that things move is the point of this page.
    let animateAt = started + (ch.firstAnimationMs ?? 3000);
    let interludeAt = ch.interludeMs ? started + ch.interludeMs : Infinity;
    let asked = 0;
    let interludes = 0;
    let seq = 0;
    const send = async (canvas: Painted, meta: Meta, reused = false) => {
      const bitmap = await this.d.snap(canvas, reused);
      if (alive()) this.d.emit({ channel: ch.id, seq: ++seq, ...meta, bitmap });
    };

    while (alive()) {
      const rt = this.d.runtime();
      const screen = rt.config.screens.find((s) => s.id === ch.screenId) ?? rt.config.screens[0];
      const pages = screen ? this.pagesOf(ch, screen) : [];
      if (!screen || !pages.length) {
        await sleep(1000);
        continue;
      }
      const t = now();
      const page = pages[Math.floor((t - started) / Math.max(2000, ch.pageMs ?? 15_000)) % pages.length]!;
      const result = this.compose(rt, screen, page, t, cache);
      await send(result.canvas, { page: page.name, kind: 'page', what: null });

      if (t >= interludeAt && screen.interludes.length) {
        const slot = screen.interludes[interludes++ % screen.interludes.length]!;
        await this.interlude(rt, screen, slot, page, send, alive);
        interludeAt = now() + (ch.interludeMs ?? 0);
        // Not right after it: let the page be seen first.
        animateAt = Math.max(animateAt, now() + 2500);
        continue;
      }
      if (t >= animateAt && result.animatable.length) {
        const a = result.animatable[asked++ % result.animatable.length]!;
        const play = this.ask(rt, a);
        if (play) {
          await this.animate(rt, screen, page, a, play, t, cache, send, alive);
          animateAt = now() + between(animateMs);
          continue;
        }
        animateAt = t + ASK_AGAIN_MS;
      }
      // Until the next second: clocks tick on time, and nothing is painted twice in one.
      await sleep(1000 - (now() % 1000) + 5);
    }
  }

  private compose(rt: Runtime, screen: Screen, page: Page, now: number, cache: TileCache, animate?: NonNullable<Parameters<typeof composePage>[0]['animate']>): ComposeResult {
    return composePage({
      cfg: rt.config,
      screen,
      page,
      theme: rt.theme(),
      registry: rt.registry,
      now,
      working: rt.working(now),
      dataOf: (inst) => rt.fetches.data(inst.id),
      sourcesOf: (types) => rt.hub.pick(types),
      demo: true,
      // A render of a panel, not a panel: nothing to protect from burn-in.
      noShift: true,
      log: rt.log,
      cache,
      ...(animate ? { animate } : {}),
    });
  }

  /** The widget's plan for an animation now, if it has one and it is playable. */
  private ask(rt: Runtime, a: Animatable): PlayablePlan | null {
    try {
      const plan = a.ask('idle', this.d.rnd);
      if (!plan) return null;
      const play = checkPlan(plan, MAX_FPS);
      if (typeof play === 'string') {
        rt.log(a.type, `animation ignored: ${play}`);
        return null;
      }
      return play;
    } catch (err) {
      rt.log(a.type, `animation failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /** Plays a widget's animation in its tile: the page as it was at `now`, only that tile moving. */
  private async animate(rt: Runtime, screen: Screen, page: Page, a: Animatable, play: PlayablePlan, now: number, cache: TileCache, send: (c: Painted, m: Meta) => Promise<void>, alive: () => boolean): Promise<void> {
    const { sleep } = this.d;
    const clock = this.d.now;
    const what = `${a.type} · ${play.plan.id}`;
    let start = clock();
    let completed = true;
    for (let i = 1; i < play.frames - 1; i++) {
      if (!alive()) {
        completed = false;
        break;
      }
      const r = this.compose(rt, screen, page, now, cache, [{ tileId: a.tileId, instanceId: a.instanceId, frame: { plan: play.plan, i, t: i / (play.frames - 1) } }]);
      await send(r.canvas, { page: page.name, kind: 'animation', what });
      if (play.hold && i === play.hold.index) {
        const held = Math.min(play.hold.ms, MAX_HOLD_MS);
        await sleep(held);
        start += held;
      }
      // On time: wait for the next frame's moment. Late: skip the frames whose moment has passed.
      const due = Math.floor(((clock() - start) * play.fps) / 1000);
      if (due > i && i < play.frames - 2) i = Math.min(due, play.frames - 2) - 1;
      await sleep(Math.max(0, start + (i * 1000) / play.fps - clock()));
    }
    try {
      a.ended(play.plan, completed);
    } catch {
      /* the widget's bookkeeping must not stop the show */
    }
  }

  /** Plays one of the screen's interludes (a full-screen animation), as `ScreenRunner` does. */
  private async interlude(rt: Runtime, screen: Screen, slot: Screen['interludes'][number], page: Page, send: (c: Painted, m: Meta, reused?: boolean) => Promise<void>, alive: () => boolean): Promise<void> {
    const { sleep } = this.d;
    const clock = this.d.now;
    const def = rt.registry.interlude(slot.type);
    if (!def) return;
    try {
      const now = clock();
      const [plugin] = slot.type.split('/');
      const options = def.options ? validate(def.options, slot.options).value : {};
      const player = await def.prepare({ ...baseContext(rt.config, plugin!, rt.log, now), options, width: screen.width, height: screen.height, seed: Math.floor(now / 60_000), theme: rt.theme(), canvas: CANVAS, sources: rt.hub.pick(def.sources) });
      if (!player || player.frames <= 0) return;
      const fps = Math.max(1, Math.min(def.fps, MAX_FPS));
      const frames = Math.min(player.frames, Math.round(slot.maxSeconds * fps));
      const canvas = CANVAS.createCanvas(screen.width, screen.height);
      const g = canvas.getContext('2d');
      const start = clock();
      // Every frame, in order (a player may build on the one before): when late it plays slower, as on a panel.
      for (let i = 0; i < frames && alive(); i++) {
        g.save();
        try {
          await player.draw(g, i);
        } finally {
          g.restore();
        }
        await send(canvas, { page: page.name, kind: 'interlude', what: slot.type }, true);
        await sleep(Math.max(0, start + ((i + 1) * 1000) / fps - clock()));
      }
    } catch (err) {
      rt.log(slot.type, `interlude failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

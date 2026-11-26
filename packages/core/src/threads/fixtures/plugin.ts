/**
 * A plugin for the threads' tests, loaded from this file by the main thread
 * and again by each screen's thread. Its sources run on the main thread and
 * are fed by the test through `feed`.
 */
import { definePlugin, defineSource, defineWidget, t, type PadEvent } from '@kiosko/sdk';

export class History {
  has(): boolean {
    return true;
  }
}

type Emit = (data: unknown) => void;
/** The test's hand on the sources (main thread only: the threads never run sources). */
export const feed: { color?: Emit; classy?: Emit } = {};

/** How many times this module was loaded in this thread: each thread has its own. */
export const loads = { n: 0 };
loads.n++;

export default definePlugin({
  id: 'tt',
  name: 'Threads test',
  version: '1.0.0',
  sources: [
    { id: 'color', name: 'Color', watch: (_ctx, emit) => ((feed.color = emit), () => void (feed.color = undefined)) },
    { id: 'classy', name: 'Classy', watch: (_ctx, emit) => ((feed.classy = emit), () => void (feed.classy = undefined)) },
    // With profiles: each reads its colour from its options.
    defineSource({ id: 'tint', name: 'Tint', profiles: true, options: t.object({ color: t.string({ default: '#ffffff' }) }), read: async (ctx) => ({ color: ctx.options.color }) }),
  ],
  widgets: [
    defineWidget({
      id: 'fill',
      name: 'Fill',
      chrome: 'bare',
      sources: ['tt/color'],
      render: (g, ctx) => {
        const c = (ctx.sources['tt/color'] as { color?: string } | undefined)?.color ?? '#000000';
        if (c === '#00ff00') ctx.log(`green, loaded ${loads.n} time(s) here`);
        g.fillStyle = c;
        g.fillRect(ctx.box.x, ctx.box.y, ctx.box.w, ctx.box.h);
      },
    }),
    defineWidget({
      id: 'tinted',
      name: 'Tinted',
      chrome: 'bare',
      sources: ['tt/tint'],
      render: (g, ctx) => {
        g.fillStyle = (ctx.sources['tt/tint'] as { color?: string } | undefined)?.color ?? '#000000';
        g.fillRect(ctx.box.x, ctx.box.y, ctx.box.w, ctx.box.h);
      },
    }),
    defineWidget({
      id: 'classy',
      name: 'Classy',
      chrome: 'bare',
      sources: ['tt/classy'],
      render: (g, ctx) => {
        const h = ctx.sources['tt/classy'] as { history?: History } | undefined;
        g.fillStyle = h?.history?.has() ? '#0000ff' : '#000000';
        g.fillRect(ctx.box.x, ctx.box.y, ctx.box.w, ctx.box.h);
      },
    }),
  ],
  interludes: [
    {
      id: 'pad',
      name: 'Pad',
      fps: 20,
      input: true,
      prepare: async (ctx) => {
        let lit = false;
        ctx.input?.on((e: PadEvent) => void (lit = e.pressed));
        return {
          frames: 100_000,
          draw: (g) => {
            g.fillStyle = lit ? '#ffffff' : '#ff0000';
            g.fillRect(0, 0, ctx.width, ctx.height);
          },
        };
      },
    },
  ],
});

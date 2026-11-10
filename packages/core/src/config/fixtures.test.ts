/**
 * A small plugin with every kind of option the config tools care about,
 * shared by their tests (a *.test.ts, so it stays out of the package).
 */
import { defineInterlude, definePlugin, defineSource, defineWidget, listOptions, t, type PluginDefinition } from '@kiosko/sdk';

export const demoPlugin: PluginDefinition = definePlugin({
  id: 'demo',
  name: { en: 'Demo', es: 'Demo' },
  version: '1.0.0',
  widgets: [
    defineWidget({
      id: 'clock',
      name: { en: 'Clock', es: 'Reloj' },
      description: 'A clock.',
      size: { min: { w: 200, h: 100 }, preferred: { w: 400, h: 200 } },
      options: t.object({ format: t.enum(['24h', '12h'] as const), seconds: t.boolean() }),
      render() {},
    }),
    defineWidget({
      id: 'feed',
      name: 'Feed',
      sources: ['demo/remote'],
      options: t.object({
        url: t.string({ format: 'url', risk: 'network' }),
        cmd: t.string({ default: 'tool', risk: 'exec' }),
        file: t.string({ risk: 'path' }),
        src: t.string({ risk: ['network', 'path'] }),
        token: t.string({ secret: true, label: 'Token' }),
      }),
      render() {},
    }),
    defineWidget({
      id: 'list',
      name: 'List',
      size: { min: { w: 200, h: 100 } },
      options: t.object({ ...listOptions({ layouts: ['one-line', 'detailed'] }), projects: t.filter({ label: 'Projects' }) }),
      render() {},
      urgent: () => false,
      takeOver: false,
      empty: () => true,
    }),
  ],
  sources: [
    defineSource({
      id: 'remote',
      name: 'Remote',
      options: t.object({
        host: t.string({ risk: 'network' }),
        token: t.string({ secret: true, label: 'Access token' }),
        urls: t.list(t.string({ secret: true, risk: 'network', label: 'Calendar' })),
        endpoints: t.list(t.object({ name: t.string(), url: t.string({ risk: 'network' }), token: t.string({ secret: true }) })),
      }),
      read: async () => ({}),
      intervalMs: 60_000,
      minIntervalMs: 30_000,
    }),
    defineSource({ id: 'push', name: 'Push', watch: () => () => undefined }),
  ],
  interludes: [defineInterlude({ id: 'blink', name: 'Blink', fps: 10, options: t.object({ color: t.color() }), prepare: async () => null })],
});

export const plugins = [demoPlugin];


import assert from 'node:assert/strict';
import { test } from 'node:test';
import { definePlugin, defineWidget } from '@kiosko/sdk';
import { normalize } from './config/store.ts';
import { Registry } from './registry.ts';
import { Runtime, withLook } from './runtime.ts';

// The editor asks for library thumbnails in the theme and language it is
// showing, which may not have reached the runtime yet (the config is saved a
// moment later). They must be painted in what was asked for.
const seen: { locale: string; theme: string }[] = [];
const reg = new Registry();
reg.add(
  definePlugin({
    id: 'look',
    name: 'Look',
    version: '1',
    widgets: [
      defineWidget({
        id: 'probe',
        name: 'Probe',
        render: (_g, ctx) => {
          seen.push({ locale: ctx.locale, theme: ctx.theme.id });
        },
        demo: () => ({}),
      }),
    ],
  }),
);

test('withLook overrides only what is set', () => {
  const cfg = { theme: 'midnight', locale: 'en', other: 1 };
  assert.deepEqual(withLook(cfg, {}), cfg);
  assert.deepEqual(withLook(cfg, { locale: 'es' }), { theme: 'midnight', locale: 'es', other: 1 });
  assert.deepEqual(withLook(cfg, { theme: 'aurora', locale: '' }), { theme: 'aurora', locale: 'en', other: 1 });
});

test('thumbnail paints in the requested theme and language, not the saved ones', () => {
  const rt = new Runtime(reg, normalize({ locale: 'en', theme: 'midnight' }));
  seen.length = 0;
  rt.thumbnail('look/probe', 100, 60);
  rt.thumbnail('look/probe', 100, 60, {}, undefined, { locale: 'es', theme: 'aurora' });
  assert.deepEqual(seen, [
    { locale: 'en', theme: 'midnight' },
    { locale: 'es', theme: 'aurora' },
  ]);
});

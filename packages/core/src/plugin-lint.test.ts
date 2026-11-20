import assert from 'node:assert/strict';
import { test } from 'node:test';
import { definePlugin, defineSource, defineWidget, listOptions, t } from '@kiosko/sdk';
import { lintOptions, lintPlugin } from './plugin-lint.ts';

const messages = (issues: { where: string; message: string }[]) => issues.map((i) => `${i.where}: ${i.message}`);

test('lintOptions: the option conventions of docs/plugins.md', () => {
  const issues = messages(lintOptions('x/w', t.object({
    holdMin: t.integer({ default: 5 }),
    staleMs: t.integer({ default: 60_000 }),
    wait: t.duration(),
    tempCrit: t.integer({ default: 90, unit: '°C' }),
    diskWarn: t.integer({ default: 85, min: 0, max: 100, unit: '%' }),
    ratio: t.number({ default: 0.8, max: 1, unit: '%' }),
    latestOnly: t.boolean(),
    seconds: t.boolean(),
    takeOver: t.boolean(),
    max: t.integer({ default: 4 }),
    url: t.string(),
    repos: t.list(t.string()),
    latitude: t.number(),
  }), 'widget'));
  const has = (path: string, re: RegExp) => assert.ok(issues.some((m) => m.startsWith(`x/w options.${path}:`) && re.test(m)), `${path} ${re}\n${issues.join('\n')}`);
  has('holdMin', /ending in Ms/);
  has('staleMs', /t\.duration/);
  has('wait', /name it …Ms/);
  has('tempCrit', /never …Crit/);
  has('diskWarn', /add diskAlert/);
  has('ratio', /integers 0–100/);
  has('latestOnly', /onlyLatest/);
  has('seconds', /showSeconds/);
  has('takeOver', /instance's switch/);
  has('max', /max<Things>/);
  has('url', /risk/);
  has('repos', /t\.filter/);
  has('latitude', /ctx\.location/);
  // A source's own refresh options are errors; the same names inside a list item are fine.
  const src = lintOptions('x/s', t.object({ intervalMs: t.duration(), servers: t.list(t.object({ timeoutMs: t.duration() })) }), 'source');
  assert.deepEqual(src.filter((i) => i.level === 'error').map((i) => i.where), ['x/s options.intervalMs']);
});

test('lintOptions: what follows the conventions passes', () => {
  assert.deepEqual(lintOptions('x/w', t.object({
    ...listOptions({ layouts: ['one-line', 'detailed'] }),
    repos: t.filter({ label: 'Repos' }),
    rotateMs: t.duration({ default: 30_000 }),
    tempWarn: t.integer({ default: 80, unit: '°C' }),
    tempAlert: t.integer({ default: 90, unit: '°C' }),
    diskWarn: t.integer({ default: 85, min: 0, max: 100, unit: '%' }),
    diskAlert: t.integer({ default: 95, min: 0, max: 100, unit: '%' }),
    showSeconds: t.boolean(),
    maxProcesses: t.integer({ default: 5 }),
    tileMin: t.integer({ default: 320, unit: 'px' }),
    url: t.string({ format: 'url', risk: 'network' }),
    token: t.string({ secret: true }),
  }), 'widget'), []);
});

test('lintPlugin: contract, languages, requirements, sizes and templates', () => {
  const w = defineWidget({
    id: 'card',
    name: { en: 'Card', es: 'Tarjeta' },
    size: { min: { w: 500, h: 100 }, preferred: { w: 400, h: 200 } },
    sources: ['agents/sessions', 'weather/current', 'x/feed'],
    render() {},
  });
  const s = defineSource({ id: 'feed', name: 'Feed', read: async () => 1 });
  const issues = messages(lintPlugin(definePlugin({
    id: 'x', name: { en: 'X', es: 'X' }, version: '1.0', widgets: [w, w], sources: [s],
    optional: ['weather/current'],
    templates: [{ id: 'main', name: 'Main', wide: [{ x: 0.5, y: 0, w: 0.7, h: 1, widgets: ['card'] }] }],
  })));
  const has = (re: RegExp) => assert.ok(issues.some((m) => re.test(m)), `${re}\n${issues.join('\n')}`);
  has(/^plugin: version "1.0" is not semver/);
  has(/^plugin: say which plugin API/);
  has(/^plugin: it reads data: declare `permissions`/);
  has(/^x\/card: two widgets with the id "card"/);
  has(/^x\/card: size\.min 500×100 is bigger/);
  has(/^x\/card: no `demo`/);
  has(/^x\/card: uses agents\/sessions from another plugin/);
  assert.ok(!issues.some((m) => /uses weather\/current/.test(m)), 'optional ones are fine');
  assert.ok(!issues.some((m) => /uses x\/feed/.test(m)), 'its own are fine');
  has(/^x\/feed: "Feed" has no es \(the plugin speaks en, es\)/);
  has(/^x\/main template: tiles are fractions/);
});

test('lintPlugin: a complete plugin is clean', () => {
  const p = definePlugin({
    id: 'ok', name: { en: 'Ok', es: 'Ok' }, description: { en: 'Fine.', es: 'Bien.' }, version: '1.2.3', sdk: '^0.2.0', languages: ['en', 'es'],
    permissions: { network: ['api.example.com'] },
    widgets: [defineWidget({ id: 'w', name: { en: 'W', es: 'W' }, description: { en: 'A w.', es: 'Una w.' }, icon: 'square', size: { preferred: { w: 300, h: 200 } }, sources: ['ok/s'], render() {}, demo: () => ({}) })],
    sources: [defineSource({ id: 's', name: { en: 'S', es: 'S' }, description: { en: 'A s.', es: 'Una s.' }, read: async () => 1, demo: () => 1 })],
  });
  assert.deepEqual(lintPlugin(p), []);
});

test('lintPlugin: a bare zh is ambiguous, zh-Hant and zh-Hans are not', () => {
  const plugin = (name: Record<string, string> & { en: string }) => definePlugin({ id: 'z', name, description: name, version: '1.0.0', sdk: '^0.2.0' });
  assert.ok(messages(lintPlugin(plugin({ en: 'Clock', zh: '时钟' }))).some((m) => /bare `zh`/.test(m)));
  assert.ok(!messages(lintPlugin(plugin({ en: 'Clock', 'zh-Hant': '時鐘', 'zh-Hans': '时钟' }))).some((m) => /bare `zh`/.test(m)));
});

test('lintPlugin: the languages it declares, against the ones its texts use', () => {
  const plugin = (languages: string[] | undefined, name: Record<string, string> & { en: string } = { en: 'Clock', es: 'Reloj' }) =>
    messages(lintPlugin(definePlugin({ id: 'l', name, description: name, version: '1.0.0', sdk: '^0.2.0', ...(languages ? { languages } : {}) })));
  const has = (msgs: string[], re: RegExp) => assert.ok(msgs.some((m) => re.test(m)), `${re}\n${msgs.join('\n')}`);
  has(plugin(undefined), /declare the languages its texts come in: `languages: \['en', 'es'\]`/);
  assert.deepEqual(plugin(['en', 'es']), []);
  // Declared but missing from a text: said for each text.
  has(plugin(['en', 'es', 'zh-Hant']), /"Clock" has no zh-Hant/);
  // In the texts but not declared.
  has(plugin(['en'], { en: 'Clock', es: 'Reloj' }), /its texts come in es too/);
  has(plugin(['es'], { en: 'Clock', es: 'Reloj' }), /English \(`en`\)/);
  has(plugin(['en', 'es', 'zh-hant'], { en: 'Clock', es: 'Reloj', 'zh-hant': '時鐘' }), /write "zh-hant" as "zh-Hant"/);
  has(plugin(['en', 'not a tag!']), /"not a tag!" is not a language tag/);
  has(plugin(['en', 'zh'], { en: 'Clock', zh: '时钟' }), /bare `zh`/);
});

test('lintPlugin: option labels, help and choice labels need every language too', () => {
  const w = defineWidget({
    id: 'w', name: { en: 'W', fr: 'W' }, description: { en: 'A w.', fr: 'Un w.' }, icon: 'square', size: { preferred: { w: 300, h: 200 } }, render() {}, demo: () => ({}),
    options: t.object({ mode: t.enum(['a', 'b'] as const, { label: { en: 'Mode', fr: 'Mode' }, help: { en: 'How.' }, labels: { a: { en: 'A', fr: 'A' }, b: { en: 'B' } } }) }),
  });
  const msgs = messages(lintPlugin(definePlugin({ id: 'o', name: { en: 'O', fr: 'O' }, description: { en: 'O.', fr: 'O.' }, version: '1.0.0', sdk: '^0.2.0', languages: ['en', 'fr'], widgets: [w] })));
  assert.ok(msgs.some((m) => /o\/w options\.mode: "How\." has no fr/.test(m)), msgs.join('\n'));
  assert.ok(msgs.some((m) => /o\/w options\.mode: "B" has no fr/.test(m)), msgs.join('\n'));
  assert.ok(!msgs.some((m) => /"Mode" has no/.test(m)));
  const odd = messages(lintPlugin(definePlugin({ id: 'x', name: { en: 'X' }, version: '1.0.0', languages: ['en', 'xx'] })));
  assert.ok(odd.some((m) => /"xx" is not a language Intl knows/.test(m)), odd.join('\n'));
});

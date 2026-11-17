import { test } from 'node:test';
import assert from 'node:assert/strict';
import { definePlugin, defineWidget } from './plugin.ts';
import { t } from './schema.ts';
import { checkPlugin, renderWidget, widgetState } from './testing.ts';

const good = defineWidget({
  id: 'good',
  name: 'Good',
  size: { min: { w: 120, h: 60 }, preferred: { w: 300, h: 120 } },
  options: t.object({ who: t.string({ default: 'world' }) }),
  urgent: ({ data }) => data === 'now',
  render(g, { box, options, data, theme, kit, t: tr }) {
    kit.drawTracked(g, `${tr({ en: 'Hello', es: 'Hola' })}, ${options.who}`, box.x, box.y + 20, { size: 16, family: theme.fonts.sans, color: theme.colors.ink });
    if (data) kit.drawTracked(g, String(data), box.x, box.y + 40, { size: 12, family: theme.fonts.sans, color: theme.colors.inkDim });
  },
  demo: () => ({ data: 'later', options: { who: 'panel' } }),
});

const sloppy = defineWidget({
  id: 'sloppy',
  name: 'Sloppy',
  render(g, { box }) {
    g.fillStyle = '#fff';
    g.fillRect(box.x - 10, box.y, 20, 20);
  },
  demo: () => ({}),
});

const broken = defineWidget({ id: 'broken', name: 'Broken', render() { throw new Error('no data'); } });
const blank = defineWidget({ id: 'blank', name: 'Blank', render() {} });

test('renderWidget: texts in order, demo options and data, language, and nothing outside the box', () => {
  const r = renderWidget(good, { size: { w: 300, h: 120 } });
  assert.deepEqual(r.texts, ['Hello, panel', 'later']);
  assert.equal(r.outside, 0);
  assert.equal(r.error, undefined);
  assert.ok(r.png().length > 100);
  assert.deepEqual(renderWidget(good, { locale: 'es', options: { who: 'mundo' }, data: undefined }).texts, ['Hola, mundo']);
  assert.deepEqual(renderWidget(good, { demo: false }).texts, ['Hello, world']);
});

test('renderWidget: what is painted outside the box is counted; a throw is reported, not thrown', () => {
  const r = renderWidget(sloppy, { size: { w: 100, h: 50 } });
  assert.equal(r.outside, 10 * 20);
  assert.equal(renderWidget(broken).error, 'no data');
});

test('widgetState asks urgent, idle, empty and visible with the same inputs', () => {
  assert.equal(widgetState(good, 'urgent'), false);
  assert.equal(widgetState(good, 'urgent', { data: 'now' }), true);
  assert.equal(widgetState(good, 'idle'), undefined);
});

test('checkPlugin: a clean plugin passes; it names what throws, spills over or shows nothing', () => {
  assert.deepEqual(checkPlugin(definePlugin({ id: 'ok', name: 'Ok', version: '1.0.0', widgets: [good] }), { themes: ['midnight'] }), []);
  const issues = checkPlugin(definePlugin({ id: 'bad', name: 'Bad', version: '1.0.0', widgets: [sloppy, broken, blank] }), { themes: ['midnight'], locales: ['en'] });
  const by = (type: string) => issues.filter((i) => i.type === type).map((i) => i.problem);
  assert.ok(by('bad/sloppy').every((p) => /outside its box/.test(p)));
  assert.ok(by('bad/broken').every((p) => p === 'render threw: no data'));
  assert.deepEqual(by('bad/blank'), ['painted nothing with its demo data (add a `demo`)']);
});

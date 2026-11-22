import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from '@kiosko/core';
import type { Config, Screen } from '@kiosko/core/model';
import { looksLikeStarter } from '@kiosko/core/starter';
import { STARTER, STEPS, addsTo, alreadyThere, applySetup, canGoOn, freshState, fromModel, fromTrcc, fromUsb, nextStep, pictureOf, prevStep, readState, templatesFor, tryIt, uniqueName, type BuildContext, type WizardState } from '../src/wizard/logic.ts';

const INSTALLED = new Set(['core/clock', 'core/date', 'core/text', 'weather/forecast', 'agents/sessions', 'agents/summary', 'usage/rail', 'usage/balance', 'vitals/vitals', 'system/health', 'cats/room', 'mirror/compliments']);
const has = (t: string) => INSTALLED.has(t);
const ctx = (locale: string): BuildContext => ({
  has,
  hasInterlude: () => false,
  templates: templatesFor([], has, locale),
  locale,
  pageName: (t) => t.id,
  titleOf: () => undefined,
});
const typesOf = (s: Screen) => s.pages.flatMap((p) => p.tiles.flatMap((t) => t.widgets.map((w) => w.type)));
/** The first run's config, as starterConfig writes it (one virtual screen, its names). */
const starter = (): Config => normalize({ locale: 'auto', screens: [{ id: 'screen-a', name: 'Mi panel', width: 1920, height: 462, device: { driver: 'virtual' }, pages: [{ id: 'page-a', name: 'Inicio', tiles: [{ id: 't1', x: 0, y: 0, w: 4, h: 4, widgets: [{ id: 'w1', type: 'core/clock', options: {} }] }] }] }] });
const fits = (s: Screen) => {
  for (const p of s.pages) for (const t of p.tiles) assert.ok(t.x >= 0 && t.y >= 0 && t.x + t.w <= p.grid.cols && t.y + t.h <= p.grid.rows, `${s.name}: tile out of its grid`);
};

test('steps: in order, and the panel step needs a panel before going on', () => {
  assert.deepEqual([...STEPS], ['welcome', 'panel', 'show', 'touches', 'done']);
  assert.equal(nextStep('welcome'), 'panel');
  assert.equal(nextStep('done'), 'done');
  assert.equal(prevStep('welcome'), 'welcome');
  assert.equal(prevStep('show'), 'panel');
  const s: WizardState = { ...freshState(), step: 'panel' };
  assert.equal(canGoOn(s), false);
  assert.equal(canGoOn({ ...s, panels: [tryIt('Try')] }), true);
  assert.equal(canGoOn({ ...s, step: 'touches' }), true);
});

test('progress kept in the browser comes back as it was; anything else starts afresh', () => {
  const s: WizardState = { v: 1, step: 'show', panels: [fromUsb({ serial: 'A1', key: 'A1', width: 1920, height: 462, location: '1-4' }, 'Desk')], location: { latitude: 40.42, longitude: -3.7, name: 'Madrid' }, theme: 'paper' };
  assert.deepEqual(readState(JSON.stringify(s)), s);
  assert.equal(readState(null), null);
  assert.equal(readState('{'), null);
  assert.equal(readState(JSON.stringify({ ...s, v: 2 })), null);
  assert.equal(readState(JSON.stringify({ ...s, step: 'nowhere' })), null);
  // A panel that isn't one is dropped; with none left, back to choosing one.
  const broken = readState(JSON.stringify({ ...s, panels: [{ id: 'x', name: 'x', width: -1 }] }))!;
  assert.deepEqual(broken.panels, []);
  assert.equal(broken.step, 'panel');
  assert.equal(readState(JSON.stringify({ ...s, location: { latitude: 200, longitude: 0 } }))!.location, undefined);
});

test('found panels: USB with its serial (one held elsewhere has no size: a 9.16″ is assumed), trcc with its key', () => {
  const a = fromUsb({ serial: 'A1', key: 'A1', width: 1920, height: 462, rotate: 0, location: '1-4' }, 'Top');
  assert.deepEqual(a.device, { driver: 'usb', serial: 'A1' });
  assert.equal(a.template, STARTER);
  const held = fromUsb({ serial: 'B2', key: 'B2', width: 0, height: 0, location: '1-5', error: 'LIBUSB_ERROR_BUSY' }, 'Middle');
  assert.deepEqual([held.width, held.height], [1920, 462]);
  const t = fromTrcc({ key: '0416:5408', width: 1280, height: 480 }, 'http://127.0.0.1:8099', 'Side');
  assert.deepEqual(t.device, { driver: 'trcc', url: 'http://127.0.0.1:8099', deviceKey: '0416:5408' });
  assert.equal(uniqueName('Trofeo Vision 9.16″', []), 'Trofeo Vision 9.16″');
  assert.equal(uniqueName('Trofeo Vision 9.16″', ['Trofeo Vision 9.16″', 'Trofeo Vision 9.16″ 2']), 'Trofeo Vision 9.16″ 3');
});

test('orientation: a strip stood on its side gets the turned picture, mounted a quarter on from its firmware’s angle', () => {
  assert.deepEqual(pictureOf({ width: 1920, height: 462, baseRotate: 0, portrait: false }), { width: 1920, height: 462, rotate: 0 });
  assert.deepEqual(pictureOf({ width: 1920, height: 462, baseRotate: 0, portrait: true }), { width: 462, height: 1920, rotate: 90 });
  assert.deepEqual(pictureOf({ width: 1920, height: 462, baseRotate: 270, portrait: true }), { width: 462, height: 1920, rotate: 0 });
  // A panel sold upright (the GPU bracket) laid down.
  assert.deepEqual(pictureOf({ width: 320, height: 960, baseRotate: 0, portrait: false }), { width: 960, height: 320, rotate: 90 });
  const tall = applySetup(starter(), { ...freshState(), panels: [{ ...fromUsb({ serial: 'A1', key: 'A1', width: 1920, height: 462, location: '' }, 'Tall'), portrait: true }] }, ctx('es')).screens[0]!;
  assert.deepEqual([tall.width, tall.height, tall.rotate], [462, 1920, 90]);
  assert.ok(tall.pages[0]!.grid.rows > tall.pages[0]!.grid.cols, 'its page is laid out tall');
  fits(tall);
  for (const t of ctx('es').templates) fits(applySetup(starter(), { ...freshState(), panels: [{ ...tryIt('x'), portrait: true, template: t.id }] }, ctx('es')).screens[0]!);
});

test('the first run’s screen is replaced; somebody’s work is only added to', () => {
  const first = starter();
  assert.ok(looksLikeStarter(first));
  assert.equal(addsTo(first), false);
  const s: WizardState = { ...freshState(), panels: [fromUsb({ serial: 'A1', key: 'A1', width: 1920, height: 462, location: '' }, 'Desk')], location: { latitude: 40.42, longitude: -3.7, name: 'Madrid' }, theme: 'paper' };
  const made = applySetup(first, s, ctx('es'));
  assert.deepEqual(made.screens.map((x) => x.name), ['Desk']);
  assert.deepEqual(made.screens[0]!.device, { driver: 'usb', serial: 'A1' });
  assert.equal(made.setup, 'done');
  assert.deepEqual(made.location, { latitude: 40.42, longitude: -3.7, name: 'Madrid' });
  assert.equal(made.theme, 'paper');
  assert.deepEqual(normalize(made), made, 'what it makes is a config as saved');
  // Run again from Settings on that work: new screens after the ones there, nothing else touched.
  const again = applySetup(made, { ...freshState(), panels: [tryIt('Spare')] }, ctx('es'));
  assert.ok(addsTo(made));
  assert.deepEqual(again.screens.map((x) => x.name), ['Desk', 'Spare']);
  assert.deepEqual(again.screens[0], made.screens[0]);
  assert.deepEqual(again.location, made.location, 'nothing chosen: left as it was');
  assert.ok(alreadyThere(made, fromUsb({ serial: 'A1', key: 'A1', width: 1920, height: 462, location: '' }, 'x')));
  assert.equal(alreadyThere(made, fromUsb({ serial: 'Z9', key: 'Z9', width: 1920, height: 462, location: '' }, 'x')), undefined);
  // The input config is not changed in place.
  assert.equal(first.setup, undefined);
});

test('three panels stacked: three screens, each named and with its own serial', () => {
  const panels = ['A1', 'B2', 'C3'].map((serial, i) => ({ ...fromUsb({ serial, key: serial, width: 1920, height: 462, location: `1-${i}` }, ['Top', 'Middle', 'Bottom'][i]!), template: ['starter', 'clock', 'system'][i]! }));
  const made = applySetup(starter(), { ...freshState(), panels }, ctx('en'));
  assert.deepEqual(made.screens.map((s) => [s.name, s.device.driver === 'usb' && s.device.serial]), [['Top', 'A1'], ['Middle', 'B2'], ['Bottom', 'C3']]);
  assert.equal(new Set(made.screens.map((s) => s.id)).size, 3);
  assert.equal(new Set(made.screens.flatMap((s) => s.pages.flatMap((p) => p.tiles.flatMap((t) => t.widgets.map((w) => w.id))))).size, made.screens.flatMap(typesOf).length, 'widget ids unique in the whole config');
  assert.deepEqual(made.screens.map((s) => s.pages[0]!.name), ['starter', 'clock', 'system']);
  assert.ok(typesOf(made.screens[1]!).includes('core/clock'));
  assert.ok(typesOf(made.screens[2]!).includes('system/health'));
});

test('no panel: a screen seen only in the editor, or a model to design for now and connect later', () => {
  const tried = applySetup(starter(), { ...freshState(), panels: [tryIt('Just trying')] }, ctx('en')).screens[0]!;
  assert.deepEqual([tried.width, tried.height, tried.device.driver], [1920, 462, 'virtual']);
  assert.ok(tried.pages[0]!.tiles.length > 0, 'the editor opens on something');
  const round = applySetup(starter(), { ...freshState(), panels: [fromModel({ id: 'round-480', name: 'Round 480×480 (AIO)', width: 480, height: 480 })] }, ctx('en')).screens[0]!;
  assert.deepEqual([round.width, round.height, round.device.driver], [480, 480, 'virtual']);
  fits(round);
});

test('mainland China: no Claude usage bar on the first page, the providers’ balances in templates instead', () => {
  const page = (locale: string, template: string) => typesOf(applySetup(starter(), { ...freshState(), panels: [{ ...tryIt('x'), template }] }, ctx(locale)).screens[0]!);
  assert.ok(page('en', STARTER).includes('usage/rail'));
  assert.ok(!page('zh-CN', STARTER).includes('usage/rail'));
  assert.ok(page('zh-TW', STARTER).includes('usage/rail'), 'Taiwan is not that market');
  assert.ok(page('en', 'agents').includes('usage/rail'));
  const cn = page('zh-CN', 'agents');
  assert.ok(!cn.includes('usage/rail') && cn.includes('usage/balance'), cn.join());
  // The offer: the first run's page first, never the blank one, only what has something installed.
  const ids = ctx('zh-CN').templates.map((t) => t.id);
  assert.equal(ids[0], STARTER);
  assert.ok(!ids.includes('blank'));
  assert.ok(!ids.includes('news'), 'news is not installed here');
  assert.ok(ids.includes('cats'));
});

test('plugins’ templates: offered in every market today (no market leaves a plugin out)', () => {
  const catalog = [{ id: 'gemini', templates: [{ id: 'gemini/desk', name: 'Gemini', icon: 'sparkles', wide: [{ x: 0, y: 0, w: 1, h: 1, widgets: ['core/clock'] }] }] }];
  // No market leaves a plugin out today (languages.ts): the template is offered everywhere.
  assert.ok(templatesFor(catalog, has, 'zh-CN').some((t) => t.id === 'gemini/desk'));
  assert.ok(templatesFor(catalog, has, 'en').some((t) => t.id === 'gemini/desk'));
});

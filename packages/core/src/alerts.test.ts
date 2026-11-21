import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCanvas } from '@napi-rs/canvas';
import { FONT_FAMILIES } from '@kiosko/sdk';
import { ALERT_ICONS, FLASH_MS, MAX_FRAME_AREA, alertIntensity, alertStepMs, frameWidth, iconFor, paintAlert } from './alert-paint.ts';
import { AlertBoard, AlertError, TEST_ALERT_MS, parseAlert } from './alerts.ts';
import { inQuietHours } from './config/model.ts';

const at = (hh: number, mm = 0) => new Date(2026, 10, 21, hh, mm).getTime();
const NOW = at(12);
const screen = (id: string, alerts?: object) => ({ id, name: id, ...(alerts ? { alerts } : {}) }) as never;

test('alerts: what is kept of one, and what is refused', () => {
  const a = parseAlert({ id: 'smoke', level: 'critical', title: { en: 'Smoke', es: 'Humo' }, text: '  kitchen\n sensor ', ttlMs: 60_000 }, NOW, 'es-ES');
  assert.deepEqual(a, { id: 'smoke', level: 'critical', title: 'Humo', text: 'kitchen sensor', expiresAt: NOW + 60_000, dismissible: true });
  assert.equal(parseAlert({ id: 'x', level: 'info', title: 'T', expiresAt: 5, ttlMs: 9, dismissible: false, icon: ' flame ' }, NOW, 'en').expiresAt, 5);
  assert.equal(parseAlert({ id: 'x', level: 'info', title: 'T', icon: ' flame ' }, NOW, 'en').icon, 'flame');
  assert.equal(parseAlert({ id: 'x', level: 'info', title: 'x'.repeat(500) }, NOW, 'en').title.length, 120);
  for (const bad of [null, 'x', {}, { id: 'x', level: 'loud', title: 'T' }, { id: 'x', level: 'info' }, { id: '', level: 'info', title: 'T' }]) {
    assert.throws(() => parseAlert(bad, NOW, 'en'), AlertError);
  }
});

test('alerts: who published it and the instruction are kept when given, as text, and checked when posted', () => {
  const a = parseAlert({ id: 'tsunami', level: 'critical', title: 'Tsunami', source: { en: 'NWS', es: 'NWS (EE. UU.)' }, detail: '  Move away from\n the coast ' }, NOW, 'es');
  assert.equal(a.source, 'NWS (EE. UU.)');
  assert.equal(a.detail, 'Move away from the coast');
  // Optional: an alert without them is as before.
  assert.deepEqual(Object.keys(parseAlert({ id: 'x', level: 'info', title: 'T', source: '  ', detail: '' }, NOW, 'en')).sort(), ['dismissible', 'expiresAt', 'id', 'level', 'text', 'title']);
  assert.equal(parseAlert({ id: 'x', level: 'info', title: 'T', source: 'x'.repeat(100), detail: 'y'.repeat(500) }, NOW, 'en').source!.length, 40);
  assert.equal(parseAlert({ id: 'x', level: 'info', title: 'T', detail: 'y'.repeat(500) }, NOW, 'en').detail!.length, 240);
  // A plugin's of the wrong type loses the field, not the alert.
  assert.equal(parseAlert({ id: 'x', level: 'info', title: 'T', source: 42 }, NOW, 'en').source, undefined);
  const b = new AlertBoard();
  assert.equal(b.post({ id: 'q', level: 'warn', title: 'Quake', source: 'IGN', detail: 'Stay outside' }, NOW, 'en').source, 'IGN');
  for (const bad of [{ source: 42 }, { detail: ['a'] }, { source: { es: 'sin en' } }]) {
    assert.throws(() => b.post({ id: 'q', level: 'warn', title: 'Quake', ...bad }, NOW, 'en'), (err: AlertError) => err.code === 'badAlert' && /source|detail/.test(err.message));
  }
});

test('alerts: posted ones, their order, ack, snooze, expiry and removal', () => {
  const b = new AlertBoard();
  b.post({ id: 'door', level: 'info', title: 'Doorbell', ttlMs: 30_000 }, NOW, 'en');
  b.post({ id: 'ci', level: 'warn', title: 'CI broken' }, NOW + 1, 'en');
  b.post({ id: 'smoke', level: 'critical', title: 'Smoke', dismissible: false }, NOW + 2, 'en');
  b.post({ id: 'leak', level: 'warn', title: 'Leak' }, NOW + 3, 'en');
  // Highest level first, then the newest.
  assert.deepEqual(b.list(NOW + 10).map((a) => a.id), ['smoke', 'leak', 'ci', 'door']);
  assert.throws(() => b.post({ id: 'a/b', level: 'info', title: 'T' }, NOW, 'en'), /letters, digits/);
  assert.throws(() => b.post({ id: 'z', level: 'info', title: 'T', screens: ['nope'] }, NOW, 'en', ['s1']), /none of those screens/);
  // Without an id, one is made.
  assert.match(b.post({ level: 'info', title: 'Anonymous' }, NOW, 'en').id, /^alert-/);

  assert.equal(b.ack('smoke'), 'notDismissible');
  assert.equal(b.snooze('smoke', 60_000, NOW), 'notDismissible');
  assert.equal(b.ack('nope'), 'unknown');
  assert.equal(b.ack('ci'), 'ok');
  assert.equal(b.snooze('leak', 5 * 60_000, NOW), 'ok');
  const listed = b.list(NOW + 10);
  assert.ok(!listed.some((a) => a.id === 'ci'));
  assert.equal(listed.find((a) => a.id === 'leak')!.snoozedUntil, NOW + 5 * 60_000);
  // Snoozed: not on the screens; back afterwards.
  assert.equal(b.forScreen(screen('s1', { minLevel: 'warn' }), NOW + 10)!.top.id, 'smoke');
  assert.equal(b.forScreen(screen('s1', { minLevel: 'warn' }), NOW + 10)!.more, 0);
  b.prune(NOW + 5 * 60_000 + 1);
  assert.equal(b.list(NOW + 5 * 60_000 + 1).find((a) => a.id === 'leak')!.snoozedUntil, undefined);
  // The doorbell's ttl ran out.
  b.prune(NOW + 31_000);
  assert.ok(!b.list(NOW + 31_000).some((a) => a.id === 'door'));
  assert.equal(b.remove('smoke'), true);
  assert.equal(b.remove('smoke'), false);
  // Ack all: only the dismissible ones.
  b.post({ id: 'stays', level: 'critical', title: 'Stays', dismissible: false }, NOW, 'en');
  assert.equal(b.ackAll(NOW + 40_000), 2);
  assert.deepEqual(b.list(NOW + 40_000).map((a) => a.id), ['stays']);
});

test('alerts: a plugin\'s stay seen while it returns them, and come back with a new id', () => {
  const b = new AlertBoard();
  const sync = (ids: string[], now: number) => b.sync(ids.map((id) => ({ alert: { id, level: 'warn', title: id, ttlMs: 60_000 }, origin: 'widget', from: 'ci/pipeline' })), now, 'en');
  sync(['p1'], NOW);
  sync(['p1'], NOW + 5000);
  const [a] = b.list(NOW + 5000);
  assert.equal(a!.id, 'ci/pipeline:p1');
  // Since and ttl count from when it was first returned.
  assert.equal(a!.since, NOW);
  assert.equal(a!.expiresAt, NOW + 60_000);
  assert.equal(b.ack('ci/pipeline:p1'), 'ok');
  sync(['p1'], NOW + 6000);
  assert.deepEqual(b.list(NOW + 6000), []);
  // Gone and back: shown again.
  sync([], NOW + 7000);
  sync(['p1'], NOW + 8000);
  assert.equal(b.list(NOW + 8000).length, 1);
  // Two instances returning the same id are one alert; a bad one is skipped, with a word in the log.
  const logged: string[] = [];
  const c = new AlertBoard((m) => logged.push(m));
  c.sync([
    { alert: { id: 'x', level: 'info', title: 'X' }, origin: 'widget', from: 'w/a' },
    { alert: { id: 'x', level: 'info', title: 'X' }, origin: 'widget', from: 'w/a' },
    { alert: { id: 'y', level: 'nope' } as never, origin: 'source', from: 's/b' },
  ], NOW, 'en');
  assert.equal(c.list(NOW).length, 1);
  assert.match(logged[0]!, /^s\/b: alert ignored: level/);
});

test('alerts: each screen\'s threshold, quiet hours and switched-off screens let only critical through; tests always show', () => {
  const b = new AlertBoard();
  b.post({ id: 'i', level: 'info', title: 'I' }, NOW, 'en');
  b.post({ id: 'w', level: 'warn', title: 'W' }, NOW, 'en');
  const night = { start: '22:00', end: '07:00' };
  assert.deepEqual(b.forScreen(screen('s'), NOW), { top: b.list(NOW)[0], more: 1 });
  assert.equal(b.forScreen(screen('s', { minLevel: 'warn' }), NOW)!.more, 0);
  assert.equal(b.forScreen(screen('s', { minLevel: 'critical' }), NOW), null);
  assert.equal(b.forScreen(screen('s', { minLevel: 'off' }), NOW), null);
  assert.equal(b.forScreen(screen('s', { minLevel: 'info', quiet: night }), at(23)), null);
  assert.equal(b.forScreen(screen('s'), NOW, true), null);
  b.post({ id: 'c', level: 'critical', title: 'C' }, NOW, 'en');
  assert.equal(b.forScreen(screen('s', { minLevel: 'info', quiet: night }), at(3))!.top.id, 'c');
  assert.equal(b.forScreen(screen('s'), NOW, true)!.top.id, 'c');
  assert.equal(b.forScreen(screen('s', { minLevel: 'off' }), NOW), null);
  // Only on the screens it names.
  b.post({ id: 'hall', level: 'critical', title: 'Door', screens: ['hall'] }, NOW + 1, 'en', ['hall', 'desk']);
  assert.equal(b.forScreen(screen('hall'), NOW + 1)!.top.id, 'hall');
  assert.equal(b.forScreen(screen('desk'), NOW + 1)!.top.id, 'c');
  // A test, on its screen only, whatever its settings, for a while.
  b.test({ id: 'desk', name: 'Desk' }, 'info', NOW, { title: 'Test', text: '' });
  assert.equal(b.forScreen(screen('desk', { minLevel: 'off' }), NOW)!.top.id, 'test:desk');
  assert.equal(b.forScreen(screen('hall', { minLevel: 'off' }), NOW), null);
  assert.equal(b.forScreen(screen('desk', { minLevel: 'off' }), NOW + TEST_ALERT_MS), null);
});

test('quiet hours: within a day and across midnight, start in and end out', () => {
  const day = { start: '13:00', end: '15:30' };
  assert.equal(inQuietHours(day, at(13)), true);
  assert.equal(inQuietHours(day, at(15, 29)), true);
  assert.equal(inQuietHours(day, at(15, 30)), false);
  const night = { start: '22:00', end: '07:00' };
  assert.equal(inQuietHours(night, at(23)), true);
  assert.equal(inQuietHours(night, at(6, 59)), true);
  assert.equal(inQuietHours(night, at(7)), false);
  assert.equal(inQuietHours(night, at(12)), false);
  assert.equal(inQuietHours(undefined, at(23)), false);
  assert.equal(inQuietHours({ start: '08:00', end: '08:00' }, at(8)), false);
});

test('alert flashing stays within WCAG 2.3.1: at most 3 flashes a second, then a slow pulse; the frame stays small', () => {
  for (const fps of [1, 2, 4, 12, 30]) {
    const step = alertStepMs(fps);
    assert.ok(step >= 1000 / Math.max(1, fps) && step >= 500, `step ${step} at ${fps} fps`);
    for (const level of ['info', 'warn', 'critical'] as const) {
      // Big changes of the frame's brightness (> 10%) in every second of the first half minute: a flash is two of them.
      for (let s = 0; s < 30_000; s += 250) {
        let changes = 0;
        for (let t = s + 10; t < s + 1000; t += 10) if (Math.abs(alertIntensity(level, t, step) - alertIntensity(level, t - 10, step)) > 0.1) changes++;
        assert.ok(changes / 2 <= 3, `${level} at ${fps} fps: ${changes} changes in a second`);
      }
    }
  }
  // Warn and critical flash first; info never does.
  assert.equal(alertIntensity('critical', 0, 500), 1);
  assert.ok(alertIntensity('critical', 500, 500) < 0.3);
  assert.ok(alertIntensity('info', 500, 500) > 0.7);
  // Then they only pulse, never darker than about half.
  for (let t = FLASH_MS; t < FLASH_MS + 20_000; t += 500) assert.ok(alertIntensity('critical', t, 500) >= 0.55);
  for (const [w, h] of [[1920, 462], [480, 480], [320, 240], [640, 172], [320, 960]] as const) {
    const b = frameWidth(w, h);
    assert.ok(b >= 2 && (2 * b * (w + h) - 4 * b * b) / (w * h) <= MAX_FRAME_AREA, `${w}×${h}: ${b}`);
  }
});

test('alert icons: known names are drawn, a character or two as text, the rest by level', () => {
  assert.deepEqual(iconFor({ icon: 'flame', level: 'warn' }), { path: 'flame' });
  assert.deepEqual(iconFor({ icon: '震', level: 'critical' }), { glyph: '震' });
  assert.deepEqual(iconFor({ icon: 'unknown-name', level: 'critical' }), { path: 'octagon-alert' });
  assert.deepEqual(iconFor({ level: 'info' }), { path: 'info' });
  assert.ok(Object.keys(ALERT_ICONS).length >= 15);
});

test('an alert is painted over the whole panel: the frame in the level\'s colour, the rest dark', () => {
  const c = createCanvas(640, 160);
  const g = c.getContext('2d');
  const top = { id: 'x', level: 'critical' as const, title: 'Smoke in the kitchen', text: 'Ceiling sensor', origin: 'api' as const, since: NOW, expiresAt: null, dismissible: true };
  paintAlert(g, 640, 160, { top, more: 2 }, { intensity: 1, fonts: FONT_FAMILIES, minPx: 14, sinceText: '12:00' });
  const px = (x: number, y: number) => [...g.getImageData(x, y, 1, 1).data.slice(0, 3)];
  assert.deepEqual(px(1, 1), [0xef, 0x44, 0x44]);
  assert.deepEqual(px(320, 2), [0xef, 0x44, 0x44]);
  const inside = px(60, 150 - frameWidth(640, 160));
  assert.ok(inside[0]! < 60 && inside[1]! < 30, `dark inside: ${inside}`);
  // Dimmed, the frame is far from the full red.
  paintAlert(g, 640, 160, { top, more: 0 }, { intensity: 0.15, fonts: FONT_FAMILIES, minPx: 14 });
  assert.ok(px(1, 1)[0]! < 0x60);
});

/** The lines `paint` draws (character by character, see the kit's drawTracked), with their colour. */
function drawnLines(w: number, h: number, paint: (g: ReturnType<ReturnType<typeof createCanvas>['getContext']>) => void): { text: string; color: string }[] {
  const g = createCanvas(w, h).getContext('2d');
  const lines: { text: string; color: string; y: number }[] = [];
  const fill = g.fillText.bind(g);
  g.fillText = (ch: string, x: number, y: number) => {
    const last = lines.at(-1);
    if (last && last.y === y && last.color === g.fillStyle) last.text += ch;
    else lines.push({ text: ch, color: String(g.fillStyle), y });
    fill(ch, x, y);
  };
  paint(g);
  return lines.map(({ text, color }) => ({ text, color }));
}

test('an alert\'s source goes small in the corner with the time, and its detail under the text in the level\'s colour', () => {
  const top = { id: 'x', level: 'critical' as const, title: 'Tsunami warning', text: 'NTWC · M7.8 off Portugal', source: 'NWS', detail: 'Move away from the coast and go to high ground', origin: 'source' as const, since: NOW, expiresAt: null, dismissible: true };
  const lines = drawnLines(1920, 462, (g) => paintAlert(g, 1920, 462, { top, more: 0 }, { intensity: 1, fonts: FONT_FAMILIES, minPx: 14, sinceText: '14:05' }));
  const texts = lines.map((l) => l.text.replace(/ /g, ''));
  assert.deepEqual(texts, ['NWS·14:05', 'Tsunamiwarning', 'NTWC·M7.8offPortugal', 'Moveawayfromthecoastandgotohighground']);
  const [corner, title, text, detail] = lines;
  assert.equal(title!.color, '#ffffff');
  assert.notEqual(detail!.color, text!.color, 'the instruction stands apart from the text');
  assert.notEqual(corner!.color, title!.color);
  // A long source goes over the time, cut short: the title keeps its room.
  const long = drawnLines(1920, 462, (g) => paintAlert(g, 1920, 462, { top: { ...top, source: 'Agencia Estatal de Meteorología de España' }, more: 0 }, { intensity: 1, fonts: FONT_FAMILIES, minPx: 14, sinceText: '14:05' }));
  assert.match(long[0]!.text, /^Agencia.*…$/);
  assert.equal(long[1]!.text, '14:05');
  assert.equal(long[2]!.text.replace(/ /g, ''), 'Tsunamiwarning');
  // Without them, as before: just the time.
  const plain = drawnLines(1920, 462, (g) => paintAlert(g, 1920, 462, { top: { ...top, source: undefined, detail: undefined }, more: 0 }, { intensity: 1, fonts: FONT_FAMILIES, minPx: 14, sinceText: '14:05' }));
  assert.deepEqual(plain.map((l) => l.text.replace(/ /g, '')), ['14:05', 'Tsunamiwarning', 'NTWC·M7.8offPortugal']);
});

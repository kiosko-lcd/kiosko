import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aqiCategory, parseAir, pollenLevel } from './airquality.ts';
import { phrasesFor, pick, poolFor } from './compliments.ts';
import { daysUntil, upcoming } from './countdown.ts';
import { ago, compass, distanceBearing, parseEmsc } from './earthquakes.ts';
import { choosePlayer, parsePlayer, positionAt } from './nowplaying.ts';
import { cleanText, wikiLang, yearsAgo } from './onthisday.ts';
import { isPng, tilesAround, wetFraction, worldPx } from './rainmap.ts';
import { issuesByDay, parseTaskFile, sortTasks } from './tasks.ts';
import { isEs, placeFor } from './util.ts';
import plugin from './index.ts';

const at = (iso: string) => new Date(iso).getTime();

test('countdown: calendar days, today kept, past ones out, nearest first', () => {
  const now = at('2026-10-10T23:30:00');
  assert.equal(daysUntil('2026-10-10', now), 0);
  assert.equal(daysUntil('2026-10-11', now), 1, 'at 23:30, tomorrow is 1 even if it is half an hour away');
  assert.equal(daysUntil('not a date', now), null);
  const list = upcoming([{ name: 'far', date: '2027-01-25' }, { name: 'past', date: '2026-10-01' }, { name: 'today', date: '2026-10-10' }, { name: 'bad', date: 'x' }], now, 4);
  assert.deepEqual(list.map((e) => e.name), ['today', 'far']);
  assert.equal(upcoming([{ name: 'a', date: '2026-10-11' }, { name: 'b', date: '2026-10-12' }], now, 1).length, 1);
});

test('compliments: by time of day, stable for changeMs, built-in phrases when none are set', () => {
  const p = { morning: ['m'], afternoon: ['t'], evening: ['n'], anytime: ['x'] };
  assert.deepEqual(poolFor(p, 9), ['m', 'x']);
  assert.deepEqual(poolFor(p, 13), ['t', 'x']);
  assert.deepEqual(poolFor(p, 1), ['n', 'x']);
  const t = at('2026-10-10T09:00:00');
  assert.equal(pick(p, t, 30 * 60_000), pick(p, t + 60_000, 30 * 60_000), 'does not change on every repaint');
  assert.equal(pick({ ...p, morning: [], anytime: [] }, t, 60_000), null);
  const empty = { morning: [], afternoon: [], evening: [], anytime: [] };
  assert.ok(phrasesFor(empty, 'es-ES').morning.includes('Buenos días.'));
  assert.ok(phrasesFor(empty, 'en-GB').morning.includes('Good morning.'));
  assert.equal(phrasesFor(p, 'es'), p);
});

test('tasks: open boxes by section (English or Spanish) and by date; late ones go to today', () => {
  const now = at('2026-10-10T12:00:00');
  const d = parseTaskFile(['# Hoy', '- [ ] a', '- [x] done', '## Tomorrow', '- [ ] b', '- [ ] old @2026-10-01', '* [ ] c 📅 2026-10-11', '## Something else', '- [ ] no section', '- [ ] far @2026-12-01'].join('\n'), now);
  assert.deepEqual(d.today, [{ kind: 'task', text: 'a' }, { kind: 'task', text: 'old', late: true }]);
  assert.deepEqual(d.tomorrow, [{ kind: 'task', text: 'b' }, { kind: 'task', text: 'c' }]);
  const i = issuesByDay([{ title: 'x', due_date: '2026-10-09', references: { short: '#1' } }, { title: 'y', due_date: '2026-10-11' }, { title: 'z', due_date: null }], now);
  assert.deepEqual(i.today, [{ kind: 'issue', text: '#1 x', late: true }]);
  assert.deepEqual(i.tomorrow, [{ kind: 'issue', text: 'y' }]);
  const sorted = sortTasks([{ kind: 'task', text: 'r' }, { kind: 'task', text: 'l', late: true }, { kind: 'meeting', text: 'm2', time: '15:00' }, { kind: 'meeting', text: 'm1', time: '09:00' }]);
  assert.deepEqual(sorted.map((s) => s.text), ['m1', 'm2', 'l', 'r']);
});

test('now playing: reads gdbus output (GVariant as text) and picks the player', () => {
  const out = `({'PlaybackStatus': <'Playing'>, 'Position': <int64 80000000>, 'Metadata': <{'mpris:trackid': <objectpath '/x'>, 'mpris:length': <uint64 210000000>, 'xesam:title': <"Don't Stop">, 'xesam:artist': <['Fleetwood Mac', 'Other']>, 'xesam:album': <'Rumours'>, 'mpris:artUrl': <'file:///tmp/a.jpg'>}>},)`;
  const p = parsePlayer(out, 'spotify', 1000);
  assert.deepEqual({ ...p }, { player: 'spotify', status: 'Playing', title: "Don't Stop", artists: ['Fleetwood Mac', 'Other'], album: 'Rumours', artUrl: 'file:///tmp/a.jpg', lengthMs: 210000, positionMs: 80000, at: 1000 });
  const stopped = parsePlayer(`({'PlaybackStatus': <'Stopped'>, 'Metadata': <{'mpris:length': <int64 0>}>},)`, 'chromium', 0);
  assert.equal(stopped.status, 'Stopped');
  const paused = { ...p, player: 'vlc', status: 'Paused' as const };
  assert.equal(choosePlayer([paused, p], '')?.player, 'spotify', 'playing beats paused');
  assert.equal(choosePlayer([paused, { ...p, player: 'chromium' }], 'vlc')?.player, 'chromium', 'a playing one beats a paused preferred one');
  assert.equal(choosePlayer([stopped], ''), null);
  assert.equal(positionAt(p, 6000), 85000);
  assert.equal(positionAt(p, 10_000_000), 210000, 'never past the end');
});

test('air quality: European index bands and pollen levels', () => {
  assert.deepEqual([0, 20, 21, 55, 79, 100, 150].map((a) => aqiCategory(a).level), [0, 0, 1, 2, 3, 4, 5]);
  assert.deepEqual(aqiCategory(25).label, { en: 'Fair', es: 'Razonablemente buena' });
  assert.deepEqual([0.8, 30, 120].map(pollenLevel), ['low', 'moderate', 'high']);
  const d = parseAir({ european_aqi: 33.6, pm2_5: 7, pm10: null, olive_pollen: 12, grass_pollen: 0 });
  assert.equal(d.aqi, 34);
  assert.equal(d.pm10, 0);
  assert.deepEqual(d.pollen, { olive_pollen: 12 });
});

test('on this day: no reference to the front-page photo; language from the option or the locale', () => {
  assert.equal(cleanText('Nace Tita Merello (en la imagen), actriz.'), 'Nace Tita Merello, actriz.');
  assert.equal(cleanText('Apollo 11 lands (pictured) on the Moon.'), 'Apollo 11 lands on the Moon.');
  assert.equal(cleanText('Born in Paris (France)  today.'), 'Born in Paris (France) today.');
  assert.equal(wikiLang('', 'es-ES'), 'es');
  assert.equal(wikiLang('de', 'es-ES'), 'de');
  assert.equal(wikiLang('', 'x'), 'en');
  assert.equal(yearsAgo(1, 'es'), 'hace 1 año');
  assert.equal(yearsAgo(53, 'en'), '53 years ago');
});

test('earthquakes: distance and bearing from home, EMSC newest first, localized words', () => {
  const home = { lat: 38.3452, lon: -0.4810 };
  const ab = distanceBearing(home, { lat: 38.4524, lon: -0.3053 });
  assert.ok(Math.abs(ab.km - 19.7) < 1, `km ${ab.km}`);
  assert.equal(compass(ab.bearing), 'NE');
  assert.equal(compass(359), 'N');
  assert.equal(compass(225, 'es'), 'SO');
  assert.equal(compass(225, 'en'), 'SW');
  assert.equal(compass(270, 'es'), 'O');
  assert.equal(ago(20 * 60_000, 'es'), 'hace 20 min');
  assert.equal(ago(5 * 3_600_000, 'en'), '5 h ago');
  assert.equal(ago(3 * 86_400_000, 'es'), 'hace 3 d');
  const q = parseEmsc({
    features: [
      { id: 'a', properties: { time: '2026-10-07T08:45:12.02Z', mag: 1.6, lat: 38.2003, lon: -2.3007, depth: 0 } },
      { id: 'b', properties: { time: '2026-10-09T19:49:38.92Z', mag: 2.1, lat: 37.4073, lon: -2.2632, depth: -6.2 } },
    ],
  }, home);
  assert.deepEqual(q.map((x) => x.id), ['b', 'a']);
  assert.equal(q[0]!.depth, 6.2);
  assert.equal(compass(q[0]!.bearing, 'es'), 'SO');
  assert.deepEqual(parseEmsc({}, home), []);
});

test('rain radar: world pixels, the tiles that cover the box, wet fraction', () => {
  const p = worldPx(38.3452, -0.4810, 7);
  assert.deepEqual([Math.floor(p.x / 256), Math.floor(p.y / 256)], [63, 49]);
  const tiles = tilesAround(p.x, p.y, 440, 267);
  assert.ok(tiles.length >= 4 && tiles.length <= 9);
  assert.ok(tiles.some((t) => t.x === 63 && t.y === 49));
  for (const t of tiles) assert.ok(t.dx > -256 && t.dx < 440 && t.dy > -256 && t.dy < 267);
  assert.equal(wetFraction(new Uint8Array([0, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 10, 0, 0, 0, 200])), 0.5);
  assert.ok(isPng(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])));
  assert.ok(!isPng(Buffer.from('<html>notice</html>')));
});

test('place: the card coordinates win over the user place; 0,0 means unset', () => {
  const home = { latitude: 40.4, longitude: -3.7 };
  assert.deepEqual(placeFor({ latitude: 0, longitude: 0 }, home), home);
  assert.deepEqual(placeFor({ latitude: 1, longitude: 2 }, home), { latitude: 1, longitude: 2 });
  assert.equal(placeFor({ latitude: 0, longitude: 0 }, undefined), null);
  assert.ok(isEs('es') && isEs('es-MX') && isEs('es_ES') && !isEs('en') && !isEs('est'));
});

test('plugin: every widget has an icon, a category, sizes and demo data', () => {
  assert.equal(plugin.id, 'mirror');
  const ids = (plugin.widgets ?? []).map((w) => w.id);
  assert.deepEqual(ids, ['countdown', 'compliments', 'tasks', 'nowplaying', 'onthisday', 'airquality', 'earthquakes', 'rainmap']);
  for (const w of plugin.widgets ?? []) {
    assert.ok(w.icon && w.category && w.size?.preferred && w.demo, w.id);
    assert.doesNotThrow(() => w.demo!({ options: w.options!.default, now: Date.now(), locale: "en" }), w.id);
  }
});

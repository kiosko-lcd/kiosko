import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXTENT, coatFor } from './cat.ts';
import { type Actor, type LayoutConfig, MARGIN, RIGHT_ZONE, SHELF_TOP, SILL, columnSide, columnZone, layoutScene, placeTags, sharedDirtyFile, tagText } from './layout.ts';
import type { SessionView } from './types.ts';
import { wordsFor } from './words.ts';

const W = 1920;
const MIN = 60_000;
const T0 = Date.parse('2026-11-05T10:42:00');
const CFG: LayoutConfig = { zombieMs: 15 * MIN, side: 'derecha', swapSidesMs: 0 };

const rec = (id: string, state: SessionView['state'], ago: number, extra: Partial<SessionView> = {}): SessionView => ({
  schemaVersion: 1,
  session_id: id,
  provider: 'claude',
  state,
  detail: '',
  project: id,
  cwd: `/repos/${id}`,
  since: T0 - ago,
  updated: T0 - Math.min(ago, 5_000),
  event: 'PreToolUse',
  ...extra,
});

const poseOf = (actors: Actor[], id: string) => actors.find((a) => a.records.some((r) => r.session_id === id));

const SCENARIOS: Record<string, SessionView[]> = {
  claims: [rec('p', 'permission', MIN), rec('e', 'waiting', 3 * MIN), rec('l', 'ready', 6 * MIN), rec('a', 'active', 9 * MIN)],
  pairs: [
    rec('a1', 'active', MIN, { cwd: '/r/x', repo: '/r/x' }), rec('a2', 'active', 2 * MIN, { cwd: '/r/x', repo: '/r/x' }),
    rec('b1', 'active', MIN, { cwd: '/r/y' }), rec('b2', 'waiting', 4 * MIN, { cwd: '/r/y' }), rec('i', 'idle', 40 * MIN),
  ],
  crowd: Array.from({ length: 9 }, (_, i) => rec(`s${i}`, (['active', 'ready', 'waiting'] as const)[i % 3]!, (i + 1) * MIN)),
};

test('cats: what claims you comes forward, what works goes to the back', () => {
  const L = layoutScene(SCENARIOS.claims!, T0, CFG, W);
  const z = (id: string) => poseOf(L.actors, id)!.z;
  assert.ok(z('p') < z('e') && z('e') < z('l') && z('l') < z('a'));
  assert.equal(poseOf(L.actors, 'p')!.pose, 'cartel');
  assert.equal(poseOf(L.actors, 'e')!.pose, 'sentado');
  assert.equal(poseOf(L.actors, 'l')!.pose, 'caja');
  assert.equal(poseOf(L.actors, 'a')!.pose, 'portatil');
});

test('cats: time moves the cat (waiting longer comes closer, working longer goes further)', () => {
  const L = layoutScene([rec('e1', 'waiting', MIN), rec('e9', 'waiting', 12 * MIN), rec('a1', 'active', 10_000), rec('a9', 'active', 9 * MIN)], T0, CFG, W);
  const z = (id: string) => poseOf(L.actors, id)!.z;
  assert.ok(z('e9') < z('e1'));
  assert.ok(z('a9') > z('a1'));
});

test('cats: nobody overlaps on the floor and everything stays in its stretch, with or without a free strip', () => {
  for (const [side, colW, lo, hi] of [['derecha', RIGHT_ZONE, MARGIN, W - RIGHT_ZONE - MARGIN], ['izquierda', RIGHT_ZONE, RIGHT_ZONE + MARGIN, W - MARGIN], ['derecha', 0, MARGIN, W - MARGIN]] as const) {
    for (const [name, sessions] of Object.entries(SCENARIOS)) {
      const L = layoutScene(sessions, T0, { ...CFG, side }, W, colW);
      const spans = L.actors
        .filter((a) => !a.sill)
        .map((a) => [a.x + EXTENT[a.pose]![0] * a.scale, a.x + EXTENT[a.pose]![1] * a.scale] as const)
        .sort((a, b) => a[0] - b[0]);
      for (const [l, r] of spans) assert.ok(l >= lo - 0.5 && r <= hi + 0.5, `${name} (${side}, ${colW}): off the floor (${l}..${r})`);
      for (let i = 1; i < spans.length; i++) assert.ok(spans[i]![0] >= spans[i - 1]![1] - 0.5, `${name} (${side}): overlap`);
    }
  }
});

test('cats: a crop of the room shifts the floor with it', () => {
  const L = layoutScene(SCENARIOS.claims!, T0, CFG, 1000, 0, 400);
  assert.equal(L.zone.lo, 400);
  assert.equal(L.zone.hi, 1400);
  for (const a of L.actors.filter((x) => !x.sill)) assert.ok(a.x + EXTENT[a.pose]![0] * a.scale >= 400 + MARGIN - 0.5);
});

test('cats: the free strip swaps sides every swapSidesMs, unless fixed or 0', () => {
  const H = 60 * MIN;
  const alt = { side: 'alternar' as const, swapSidesMs: H };
  assert.equal(columnSide(0, alt), 'derecha');
  assert.equal(columnSide(H, alt), 'izquierda');
  assert.equal(columnSide(2 * H, alt), 'derecha');
  assert.equal(columnSide(H, { side: 'alternar', swapSidesMs: 0 }), 'derecha');
  assert.equal(columnSide(0, { side: 'izquierda', swapSidesMs: H }), 'izquierda');
  assert.deepEqual(columnZone(W, 'derecha'), { side: 'derecha', w: RIGHT_ZONE, x: W - RIGHT_ZONE, lo: 0, hi: W - RIGHT_ZONE });
  assert.deepEqual(columnZone(W, 'izquierda'), { side: 'izquierda', w: RIGHT_ZONE, x: MARGIN, lo: RIGHT_ZONE, hi: W });
});

test('cats: what does not fit is summed up, the least urgent first', () => {
  const many = [rec('p', 'permission', MIN), ...Array.from({ length: 12 }, (_, i) => rec(`a${i}`, 'active', (i + 1) * 20_000))];
  const L = layoutScene(many, T0, CFG, W);
  assert.ok(L.overflow.length > 0);
  assert.ok(poseOf(L.actors, 'p'), 'a permission is never dropped');
  assert.equal(L.actors.flatMap((a) => a.records).length + L.overflow.length, many.length);
});

test('cats: meetings are not cats', () => {
  const L = layoutScene([rec('a', 'active', MIN), rec('m', 'waiting', MIN, { startsAt: T0 + 5 * MIN, endsAt: T0 + 35 * MIN })], T0, CFG, W);
  assert.equal(L.meetings.length, 1);
  assert.ok(!L.actors.some((a) => a.records.some((r) => r.startsAt !== undefined)));
  assert.equal(L.total, 1);
});

test('cats: the coat comes from the id and doesn\'t change between frames', () => {
  assert.equal(coatFor('abc'), coatFor('abc'));
  const a = layoutScene([rec('x', 'active', MIN), rec('y', 'ready', MIN)], T0, CFG, W);
  const b = layoutScene([rec('y', 'ready', MIN), rec('x', 'active', MIN)], T0 + 30_000, CFG, W);
  assert.equal(poseOf(a.actors, 'x')!.coats[0], poseOf(b.actors, 'x')!.coats[0]);
});

test('cats: pairs by working directory (or repo), never by name', () => {
  const same = { cwd: '/repos/one', project: 'one' };
  const L = layoutScene([rec('a', 'active', MIN, same), rec('b', 'active', 2 * MIN, same)], T0, CFG, W);
  assert.equal(L.actors.length, 1);
  assert.equal(L.actors[0]!.pose, 'corazon');
  assert.notEqual(L.actors[0]!.coats[0], L.actors[0]!.coats[1], 'a pair never repeats a coat');
  const M = layoutScene([rec('a', 'active', MIN, { cwd: '/x/app', project: 'app' }), rec('b', 'active', MIN, { cwd: '/y/app', project: 'app' })], T0, CFG, W);
  assert.equal(M.actors.length, 2);
  const R = layoutScene([rec('a', 'active', MIN, { cwd: '/s/gd', repo: '/s/gd' }), rec('b', 'active', MIN, { cwd: '/s/gd/apps/server', repo: '/s/gd' })], T0, CFG, W);
  assert.equal(R.actors.length, 1);
});

test('cats: the waiting one kneads the working one; the tag says so', () => {
  const same = { cwd: '/repos/one' };
  const L = layoutScene([rec('w', 'active', MIN, same), rec('e', 'waiting', 3 * MIN, same)], T0, CFG, W);
  assert.equal(L.actors[0]!.pose, 'amasa');
  assert.deepEqual(L.actors[0]!.records.map((r) => r.session_id), ['w', 'e']);
  assert.match(tagText(L.actors[0]!, T0, wordsFor('es')).time, /espera 3 min/);
  assert.match(tagText(L.actors[0]!, T0, wordsFor('en')).time, /waiting 3 min/);
});

test('cats: they hiss only while the shared file is still uncommitted', () => {
  const f = '/repos/one/src/a.ts';
  const base = { cwd: '/repos/one', files: [f] };
  const dirty = layoutScene([rec('a', 'active', MIN, { ...base, dirtyFiles: ['src/a.ts'] }), rec('b', 'ready', MIN, { ...base, dirtyFiles: ['src/a.ts'] })], T0, CFG, W);
  assert.equal(dirty.actors[0]!.pose, 'bufido');
  assert.equal(dirty.actors[0]!.file, f);
  const clean = layoutScene([rec('a', 'active', MIN, { ...base, dirtyFiles: [] }), rec('b', 'ready', MIN, { ...base, dirtyFiles: [] })], T0, CFG, W);
  assert.notEqual(clean.actors[0]!.pose, 'bufido');
  const a = rec('a', 'active', MIN, { files: ['/r/src/x.ts', '/r/y.ts'], dirtyFiles: ['src/x.ts'] });
  assert.equal(sharedDirtyFile(a, rec('b', 'active', MIN, { files: ['/r/src/x.ts'] })), '/r/src/x.ts');
  assert.equal(sharedDirtyFile(a, rec('c', 'active', MIN, { files: ['/r/y.ts'] })), undefined);
});

test('cats: an active session silent for half the zombie time is Schrödinger\'s box', () => {
  const quiet = rec('q', 'active', 20 * MIN, { updated: T0 - CFG.zombieMs * 0.6 });
  const L = layoutScene([quiet], T0, CFG, W);
  assert.equal(L.actors[0]!.pose, 'schrodinger');
  assert.equal(L.actors[0]!.tone, 'zombi');
});

test('cats: the first idle one sleeps up on the sill (or the shelf when covered)', () => {
  const alone = layoutScene([rec('i', 'idle', 30 * MIN)], T0, CFG, W);
  assert.equal(alone.actors[0]!.sill, true);
  assert.equal(alone.actors[0]!.x, SILL.x);
  const busy = layoutScene(SCENARIOS.pairs!, T0, CFG, W);
  const napper = busy.actors.find((a) => a.sill)!;
  assert.ok(napper.x === SILL.x || napper.x === SHELF_TOP.x);
});

test('tags: when they collide they move aside before shrinking', () => {
  const [a, b] = placeTags([{ x: 500, y: 300, h: 30, w: 200, minW: 80 }, { x: 520, y: 305, h: 30, w: 200, minW: 80 }], 0, 1500);
  assert.equal(a!.x, 500);
  assert.equal(b!.w, 200, 'the second keeps its width');
  assert.ok(Math.abs(b!.x - a!.x) >= 200 + 8, 'and moves aside');
  const [c, d] = placeTags([{ x: 500, y: 300, h: 30, w: 200, minW: 80 }, { x: 500, y: 340, h: 30, w: 200, minW: 80 }], 0, 1500);
  assert.equal(c!.x, d!.x);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LEVEL, LEVEL_WIDTH, fateFor, gapGroups, pixelSafe, runnerPlayer, simulate } from './platformer.ts';

const W = 1920;
const T = 66;
const GROUND = 6 * T;
/** Half the runner's width and its height, in px (see HERO_PX). */
const HERO_HALF = 42;
const HERO_H = 112;
/** Enough seeds to cover every fate. */
const SEEDS = Array.from({ length: 14 }, (_, i) => i);

test('level: the jump reaches across every gap', () => {
  for (const [from, to] of gapGroups()) assert.ok(to - from + 1 <= 3, `gap ${from}-${to} is ${to - from + 1} tiles wide`);
});

test('level: pipes are one tile tall', () => {
  // At 12 fps the flight stays above 132 px for 1.87 tiles, less than a pipe's 2 of width.
  for (const p of LEVEL.pipes) assert.equal(6 - p.top, 1, `the pipe at column ${p.col} is too tall`);
});

test('fate: `complete` reaches the castle, the others fall', () => {
  for (const seed of SEEDS) {
    const fate = fateFor(seed);
    const frames = simulate(W, seed);
    const died = frames.some((f) => f.phase === 'dies');
    const arrived = frames.some((f) => f.phase === 'hold');
    if (fate.kind === 'complete') assert.ok(arrived && !died, `seed ${seed} should complete the level`);
    else assert.ok(died, `seed ${seed} should fail at a ${fate.kind}`);
  }
});

test('fate: some wins, but few', () => {
  const wins = SEEDS.filter((s) => fateFor(s).kind === 'complete').length;
  assert.ok(wins > 0, 'never winning takes the fun out of winning');
  assert.ok(wins < SEEDS.length / 2, 'always winning makes it routine');
  assert.equal(fateFor(-3).kind, fateFor(-3).kind, 'negative seeds are valid');
});

test('runner: only falls when its fate says so', () => {
  for (const seed of SEEDS) {
    if (fateFor(seed).kind !== 'complete') continue;
    for (const f of simulate(W, seed)) assert.ok(f.heroY <= GROUND + 1, `seed ${seed} fell at frame ${f.index}`);
  }
});

test('runner: never walks on air after a pipe', () => {
  for (const seed of SEEDS) {
    for (const f of simulate(W, seed)) {
      if (f.phase !== 'run' || f.airborne || f.heroY >= GROUND - 1) continue;
      assert.ok(LEVEL.pipes.some((p) => f.heroX >= p.col * T && f.heroX < (p.col + 2) * T), `frame ${f.index} of seed ${seed}: high up, grounded, no pipe below`);
    }
  }
});

test('runner: never goes through bricks', () => {
  for (const seed of SEEDS) {
    for (const f of simulate(W, seed)) {
      if (f.phase !== 'run') continue;
      for (const b of LEVEL.blocks) {
        if (b.kind === '#') continue;
        const overlaps = f.heroX + HERO_HALF > b.col * T + 4 && f.heroX - HERO_HALF < (b.col + 1) * T - 4 && f.heroY > b.row * T + 4 && f.heroY - HERO_H < (b.row + 1) * T - 4;
        assert.ok(!overlaps, `seed ${seed} goes through the block at column ${b.col} at frame ${f.index}`);
      }
    }
  }
});

test('camera: never leaves the level, whatever the view width', () => {
  for (const width of [W, 462, 1280]) {
    for (const seed of SEEDS) for (const f of simulate(width, seed)) assert.ok(f.camera >= 0 && f.camera <= LEVEL_WIDTH - width, `camera out at frame ${f.index}`);
  }
});

test('simulation: deterministic', () => {
  const a = simulate(W, 3).map((f) => `${f.heroX}|${f.heroY}|${f.phase}`);
  const b = simulate(W, 3).map((f) => `${f.heroX}|${f.heroY}|${f.phase}`);
  assert.deepEqual(a, b);
});

test('simulation: long enough to see, short enough not to bore', () => {
  for (const seed of SEEDS) {
    const s = simulate(W, seed).length / 12;
    assert.ok(s > 5 && s < 40, `seed ${seed} lasts ${s.toFixed(1)} s`);
  }
});

test('player: frames for any panel; pixel text drops accents', () => {
  for (const [w, h] of [[1920, 462], [480, 480], [320, 240]] as const) {
    const p = runnerPlayer(w, h, 1);
    assert.ok(p.frames > 50);
  }
  assert.equal(pixelSafe('Otra vez será'), 'OTRA VEZ SERA');
});

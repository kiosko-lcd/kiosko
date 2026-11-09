/**
 * The interlude: an 8-bit platformer run, drawn by hand.
 *
 * Why drawn and not a video: the panel's USB bus compresses every frame, so
 * **the content decides the fps**. Measured at 1920×462:
 *
 *   flat 8-bit art   ->   83 KB per frame  ->  12 fps
 *   photographic     ->  517 KB per frame  ->   5 fps
 *
 * A real video clip crawls; flat colours fly. And a 4.2:1 panel is a poor
 * window for a video but the exact shape of a side-scrolling level.
 *
 * The art is original, in the panel's own palette. The world is designed 7
 * tiles of 66 px tall (462 px); other panels scale it uniformly and see a
 * wider or narrower stretch of the level.
 */
import type { Graphics } from '@tessera/sdk';

/** Tile side, in world pixels. 7 rows of 66 = 462, the panel's exact height. */
const T = 66;
const ROWS = 7;
/** World height. */
export const WORLD_H = ROWS * T;
/** Ground row. Everything else stands on it. */
const GROUND_ROW = 6;

/**
 * The level, in tiles. One row per height, top to bottom.
 *
 *   `#` ground/solid block   `B` brick   `?` surprise block
 *   `P` top-left corner of a pipe (2 wide, down to the ground)
 *   `e` bug (stands on the ground)       `F` flagpole   `C` castle
 *
 * Rules the level must keep, checked by platformer.test.ts: gaps are at most
 * 3 tiles and pipes at most 1 tall, which is what the jump reaches. Break
 * them and the runner falls every time: the interlude becomes a loop of a
 * little man dying.
 */
const MAP: string[] = [
  //        1         2         3         4         5         6         7         8         9
  //234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890
  '                                                                                                    ',
  '                                                                                              C     ',
  '                       B?B?B                                                                        ',
  '     B?B                                                                                            ',
  '                                                                                         F          ',
  '                   e             PP                  e    PP                  e          F          ',
  '#######################################   ######################  #################  ###############',
];

/** Pixels the runner moves per frame. */
const SPEED = 24.75;
/** Gravity and jump push, in px/frame. They reach 3.7 tiles high and 4.1 long. */
const GRAVITY = 16;
const JUMP_V = 88;
/** Bounce after stomping a bug. */
const STOMP_V = 46;

/**
 * Pixels the runner covers during a jump. **Measured** by integrating the
 * same jump the simulation does instead of the continuous `2·v/g`: at 12 fps
 * the integration is coarse and the formula is off by almost a frame, enough
 * for the runner to land a pixel short of a bug's head and get eaten.
 */
function measureJumpReach(): number {
  let y = GROUND_ROW * T;
  let vy = -JUMP_V;
  let frames = 0;
  do {
    vy += GRAVITY;
    y += vy;
    frames++;
  } while (!(vy > 0 && y >= GROUND_ROW * T));
  return frames * SPEED;
}
const JUMP_REACH = measureJumpReach();
/** Bug speed, leftwards. */
const BUG_SPEED = 4;

const COLS = MAP[0]!.length;
export const LEVEL_WIDTH = COLS * T;

/** Castle width and roof height. The simulation needs the width to find the door. */
const CASTLE_W = 5 * T;
const CASTLE_TOP = 2.3 * T;

const SKY = '#5C94FC';
const SKY_DEEP = '#2A5FC8';

interface Pipe {
  col: number;
  top: number;
}
interface Bug {
  col: number;
}
interface Block {
  col: number;
  row: number;
  kind: 'B' | '?' | '#';
}

interface Level {
  blocks: Block[];
  pipes: Pipe[];
  bugs: Bug[];
  /** Columns without ground. */
  gaps: Set<number>;
  flagCol: number;
  castleCol: number;
}

function parseLevel(): Level {
  const blocks: Block[] = [];
  const pipes: Pipe[] = [];
  const bugs: Bug[] = [];
  const gaps = new Set<number>();
  let flagCol = -1;
  let castleCol = -1;

  for (let row = 0; row < ROWS; row++) {
    const line = MAP[row]!.padEnd(COLS, ' ');
    for (let col = 0; col < COLS; col++) {
      const ch = line[col]!;
      if (ch === '#') blocks.push({ col, row, kind: '#' });
      else if (ch === 'B' || ch === '?') blocks.push({ col, row, kind: ch });
      else if (ch === 'P') {
        // Only the top-left corner marks the pipe; the rest is derived.
        if (line[col - 1] !== 'P' && (MAP[row - 1]?.[col] ?? ' ') !== 'P') pipes.push({ col, top: row });
      } else if (ch === 'e') bugs.push({ col });
      else if (ch === 'F' && flagCol < 0) flagCol = col;
      else if (ch === 'C' && castleCol < 0) castleCol = col;
    }
  }
  for (let col = 0; col < COLS; col++) {
    if (MAP[GROUND_ROW]!.padEnd(COLS, ' ')[col] !== '#') gaps.add(col);
  }
  return { blocks, pipes, bugs, gaps, flagCol, castleCol };
}

export const LEVEL = parseLevel();

/** Contiguous gaps grouped as `[first, last]` columns. */
export function gapGroups(): [number, number][] {
  const cols = [...LEVEL.gaps].sort((a, b) => a - b);
  const out: [number, number][] = [];
  for (const c of cols) {
    const last = out[out.length - 1];
    if (last && c === last[1] + 1) last[1] = c;
    else out.push([c, c]);
  }
  return out;
}

/** Y (px) of the surface walked on at a given x. */
function surfaceAt(x: number): number {
  const col = Math.floor(x / T);
  if (col < 0 || col >= COLS) return GROUND_ROW * T;
  // On a pipe you stand on its mouth, not on the ground: falling *into* the
  // cylinder is the detail that gives away a fake game.
  for (const p of LEVEL.pipes) {
    if (col >= p.col && col < p.col + 2) return p.top * T;
  }
  if (LEVEL.gaps.has(col)) return Number.POSITIVE_INFINITY;
  return GROUND_ROW * T;
}

/**
 * Take-off points, worked out from the obstacles. Each obstacle wants its
 * own lead: a gap is jumped from its edge, a pipe from further away to clear
 * its rim. Bugs walk, so they are chased live inside the simulation.
 */
function jumpTriggers(): number[] {
  const t: number[] = [];
  // Pipe: land at least half a tile past it, never on or inside it.
  for (const p of LEVEL.pipes) t.push(p.col * T + 2.6 * T - JUMP_REACH);
  // Gap: take off as late as possible, but never so late the jump falls short.
  for (const [from, to] of gapGroups()) {
    t.push(Math.max(from * T - 0.6 * T, (to + 1) * T + 0.4 * T - JUMP_REACH));
  }
  return t.sort((a, b) => a - b);
}

const TRIGGERS = jumpTriggers();

/** Trigger of each gap by its first column: a fate cancels exactly that one. */
const GAP_TRIGGER = new Map<number, number>(gapGroups().map(([from, to]) => [from, Math.max(from * T - 0.6 * T, (to + 1) * T + 0.4 * T - JUMP_REACH)]));

export type Phase = 'run' | 'slide' | 'walk' | 'hold' | 'dies' | 'retry';

/**
 * How this run ends. The interlude comes back every quarter hour: if it were
 * always the same perfect run, by the third time nobody would look up. So
 * each run is seeded with the slot and the runner fails somewhere different,
 * or now and then makes it, which is what makes making it fun.
 */
export type Fate = { kind: 'complete' } | { kind: 'gap'; col: number } | { kind: 'bug'; index: number };

/** Two wins out of N: rare but not exceptional, the prize for looking at the right moment. */
export function fateFor(seed: number): Fate {
  const stumbles: Fate[] = [
    // The first obstacles are skipped: falling two seconds in leaves no time
    // to even notice there is an animation.
    ...gapGroups()
      .map(([col]) => col)
      .filter((c) => c > 20)
      .map((col) => ({ kind: 'gap', col }) as const),
    ...LEVEL.bugs.map((_b, index) => ({ kind: 'bug', index }) as const).filter((_, i) => LEVEL.bugs[i]!.col > 20),
  ];
  if (stumbles.length === 0) return { kind: 'complete' };
  const n = stumbles.length + 2;
  const pick = ((seed % n) + n) % n;
  return pick < 2 ? { kind: 'complete' } : stumbles[pick - 2]!;
}

export interface Frame {
  /** Left edge of the camera, in world px. */
  camera: number;
  heroX: number;
  /** Y of the feet. */
  heroY: number;
  airborne: boolean;
  phase: Phase;
  /** Stomped bugs: index -> frame it happened. */
  squashed: Map<number, number>;
  /** Position of each bug, in px. */
  bugX: number[];
  /** 0..1, how far the castle flag went up. */
  castleFlag: number;
  coins: number;
  index: number;
}

const SLIDE_FRAMES = 12;
/** Cap of the final walk; the castle door normally ends it first. */
const WALK_FRAMES = 60;
const HOLD_FRAMES = 14;
const CARD_FRAMES = 16;
/** Push of the death jump, the start before falling off the screen. */
const DEATH_V = 58;

/**
 * Simulates the whole run, one frame per step. Deterministic from the seed
 * (no `Math.random`, no clock), so a test can assert the runner only falls
 * where its fate says and not because of a badly aimed jump.
 */
export function simulate(width: number, seed = 0): Frame[] {
  const fate = fateFor(seed);
  const frames: Frame[] = [];
  const flagX = LEVEL.flagCol * T;
  /** Castle door: where the walk ends and the runner disappears inside. */
  const doorX = LEVEL.castleCol * T + CASTLE_W / 2;

  let x = 2 * T;
  let y = GROUND_ROW * T;
  let vy = 0;
  let airborne = false;
  let nextTrigger = 0;
  let coins = 0;
  const squashed = new Map<number, number>();
  const bugX = LEVEL.bugs.map((b) => b.col * T);
  /** Bugs a jump was already launched at; never twice. */
  const attempted = new Set<number>();

  const maxCamera = Math.max(0, LEVEL_WIDTH - width);
  const cameraFor = (hx: number) => Math.max(0, Math.min(maxCamera, hx - width * 0.34));

  let phase: Phase = 'run';
  let index = 0;
  let phaseFrame = 0;
  let castleFlag = 0;
  let camera = cameraFor(x);

  // Safety cap: the level is finite, but a badly edited map must not hang.
  for (let guard = 0; guard < 4000; guard++) {
    if (phase === 'run') {
      x += SPEED;

      // One jump per bug, launched as soon as it is in reach. "In reach", not
      // "exactly at this distance": the runner moves ~25 px a frame and a
      // narrow window is skipped over without being seen.
      const closing = JUMP_REACH * ((SPEED + BUG_SPEED) / SPEED);
      let bugAhead = false;
      for (let i = 0; i < bugX.length; i++) {
        if (squashed.has(i) || attempted.has(i)) continue;
        if (bugX[i]! - x > closing) continue;
        attempted.add(i);
        // This run's fate: no jump here, and the bug wins.
        if (fate.kind === 'bug' && fate.index === i) continue;
        bugAhead = true;
      }

      let staticTrigger = false;
      while (nextTrigger < TRIGGERS.length && x >= TRIGGERS[nextTrigger]!) {
        const skip = fate.kind === 'gap' && TRIGGERS[nextTrigger]! === GAP_TRIGGER.get(fate.col);
        if (!skip) staticTrigger = true;
        nextTrigger++;
      }

      if (!airborne && (staticTrigger || bugAhead)) {
        vy = -JUMP_V;
        airborne = true;
      }

      if (airborne) {
        vy += GRAVITY;
        y += vy;
        if (vy > 0) {
          for (let i = 0; i < bugX.length; i++) {
            if (squashed.has(i)) continue;
            if (Math.abs(bugX[i]! - x) < T * 0.8 && y >= GROUND_ROW * T - T * 0.6) {
              squashed.set(i, index);
              vy = -STOMP_V;
              coins += 100;
            }
          }
        }
        const floor = surfaceAt(x);
        if (vy > 0 && y >= floor) {
          y = floor;
          vy = 0;
          airborne = false;
        }
      }

      // Bumping into a bug on the ground ends the run.
      if (!airborne) {
        for (let i = 0; i < bugX.length; i++) {
          if (squashed.has(i)) continue;
          if (Math.abs(bugX[i]! - x) < T * 0.55) {
            phase = 'dies';
            vy = -DEATH_V;
            phaseFrame = 0;
          }
        }
      }

      // Running out of ground: a gap, or the edge of a pipe just landed on.
      // Without this the runner walks on air at the height of the pipe's mouth.
      if (!airborne && y < surfaceAt(x)) {
        airborne = true;
        vy = 0;
      }
      if (y > ROWS * T) {
        phase = 'dies';
        phaseFrame = 0;
      }

      for (let i = 0; i < bugX.length; i++) {
        if (!squashed.has(i) && bugX[i]! - x < width * 0.7) bugX[i] = bugX[i]! - BUG_SPEED;
      }

      if (phase === 'run' && x >= flagX) {
        x = flagX;
        y = 2.2 * T;
        phase = 'slide';
        phaseFrame = 0;
        coins += 500;
      }
      camera = cameraFor(x);
    } else if (phase === 'dies') {
      // The camera stays put: the runner falls out of the scene, not the other way round.
      vy += GRAVITY;
      y += vy;
      phaseFrame++;
      if (y > ROWS * T + 260) {
        phase = 'retry';
        phaseFrame = 0;
      }
    } else if (phase === 'retry') {
      if (++phaseFrame > CARD_FRAMES) break;
    } else if (phase === 'slide') {
      y = 2.2 * T + (GROUND_ROW * T - 2.2 * T) * (phaseFrame / SLIDE_FRAMES);
      camera = cameraFor(flagX + width * 0.2);
      if (++phaseFrame > SLIDE_FRAMES) {
        phase = 'walk';
        phaseFrame = 0;
        y = GROUND_ROW * T;
      }
    } else if (phase === 'walk') {
      x += SPEED * 0.75;
      camera = cameraFor(flagX + width * 0.2);
      castleFlag = Math.min(1, (x - flagX) / (doorX - flagX));
      if (x >= doorX || ++phaseFrame > WALK_FRAMES) {
        phase = 'hold';
        phaseFrame = 0;
      }
    } else {
      castleFlag = 1;
      if (++phaseFrame > HOLD_FRAMES) break;
    }

    frames.push({ camera, heroX: x, heroY: y, airborne, phase, squashed: new Map(squashed), bugX: [...bugX], castleFlag, coins, index });
    index++;
  }
  return frames;
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

/** HUD and retry-card words, already localized and upper-case friendly. */
export interface RunnerTexts {
  /** Top-left title. */
  title: string;
  world: string;
  time: string;
  retry: string;
  /** Shown under `world`: a release number, so every slot has its own. */
  level?: string;
}

export const DEFAULT_TEXTS: RunnerTexts = { title: 'TESSERA', world: 'RELEASE', time: 'TIME', retry: 'TRY AGAIN', level: 'V1.0' };

/** A release number per seed: "V3.7". */
export function levelFor(seed: number): string {
  const n = Math.abs(Math.floor(seed));
  return `V${(n % 9) + 1}.${Math.floor(n / 9) % 10}`;
}

/**
 * 5×7 font for the HUD. A smoothed typeface next to block sprites looks very
 * wrong, and this way the animation doesn't depend on any font. Each glyph
 * is 7 rows of 5 bits.
 */
const GLYPHS: Record<string, string> = {
  A: '01110 10001 10001 11111 10001 10001 10001',
  B: '11110 10001 10001 11110 10001 10001 11110',
  C: '01110 10001 10000 10000 10000 10001 01110',
  D: '11110 10001 10001 10001 10001 10001 11110',
  E: '11111 10000 10000 11110 10000 10000 11111',
  F: '11111 10000 10000 11110 10000 10000 10000',
  G: '01110 10001 10000 10111 10001 10001 01111',
  H: '10001 10001 10001 11111 10001 10001 10001',
  I: '11111 00100 00100 00100 00100 00100 11111',
  J: '00111 00010 00010 00010 00010 10010 01100',
  K: '10001 10010 10100 11000 10100 10010 10001',
  L: '10000 10000 10000 10000 10000 10000 11111',
  M: '10001 11011 10101 10101 10001 10001 10001',
  N: '10001 11001 10101 10011 10001 10001 10001',
  O: '01110 10001 10001 10001 10001 10001 01110',
  P: '11110 10001 10001 11110 10000 10000 10000',
  Q: '01110 10001 10001 10001 10101 10010 01101',
  R: '11110 10001 10001 11110 10100 10010 10001',
  S: '01111 10000 10000 01110 00001 00001 11110',
  T: '11111 00100 00100 00100 00100 00100 00100',
  U: '10001 10001 10001 10001 10001 10001 01110',
  V: '10001 10001 10001 10001 10001 01010 00100',
  W: '10001 10001 10001 10101 10101 11011 10001',
  X: '10001 10001 01010 00100 01010 10001 10001',
  Y: '10001 10001 01010 00100 00100 00100 00100',
  Z: '11111 00001 00010 00100 01000 10000 11111',
  '0': '01110 10011 10101 10101 11001 10001 01110',
  '1': '00100 01100 00100 00100 00100 00100 01110',
  '2': '01110 10001 00001 00110 01000 10000 11111',
  '3': '11111 00010 00100 00010 00001 10001 01110',
  '4': '00010 00110 01010 10010 11111 00010 00010',
  '5': '11111 10000 11110 00001 00001 10001 01110',
  '6': '00110 01000 10000 11110 10001 10001 01110',
  '7': '11111 00001 00010 00100 01000 01000 01000',
  '8': '01110 10001 10001 01110 10001 10001 01110',
  '9': '01110 10001 10001 01111 00001 00010 01100',
  '?': '01110 10001 00001 00110 00100 00000 00100',
  '<': '00010 00100 01000 10000 01000 00100 00010',
  '>': '01000 00100 00010 00001 00010 00100 01000',
  '/': '00001 00010 00010 00100 01000 01000 10000',
  '!': '00100 00100 00100 00100 00100 00000 00100',
  '.': '00000 00000 00000 00000 00000 00000 00100',
  '-': '00000 00000 00000 11111 00000 00000 00000',
  ' ': '00000 00000 00000 00000 00000 00000 00000',
};

/** Upper-case and strip accents, so "SERÁ" uses the plain A glyph. */
export function pixelSafe(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
}

/** Sprite pixels bleed this much into their neighbours: at fractional panel scales, abutting anti-aliased squares show a grid. */
const SEAM = 0.4;

/** Width of `text` in the pixel font at `px`. */
const pixelWidth = (text: string, px: number) => [...text].length * 6 * px - px;

function drawPixelText(g: Graphics, text: string, x: number, y: number, px: number, color: string): void {
  g.fillStyle = color;
  let cx = x;
  for (const ch of pixelSafe(text)) {
    // A missing letter shows as a box: silently dropping it leaves holes nobody notices.
    const rows = (GLYPHS[ch] ?? '11111 10001 10001 10001 10001 10001 11111').split(' ');
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r]!;
      for (let c = 0; c < row.length; c++) if (row[c] === '1') g.fillRect(cx + c * px, y + r * px, px + SEAM, px + SEAM);
    }
    cx += 6 * px;
  }
}

/** The runner, 12×16, in the panel palette. The genre's archetype, nobody's character. */
const HERO_COLORS: Record<string, string> = {
  A: '#FFB020', // cap and shirt
  S: '#F2C9A0', // skin
  K: '#2A1A12', // eye
  O: '#2E8A82', // overalls
  N: '#1F6259', // overalls shade
  B: '#4A2E1E', // boots
  H: '#8A5A2B', // hair
};

const HERO_BODY = ['....AAAAA...', '...AAAAAAAA.', '...HHSSSKS..', '...HSSSSKSS.', '...HSSSSSSS.', '....SSSSSS..', '.....SSSS...', '..AAAAAAAA..', '.AAAOAAAOAA.', 'AAAAOOOOAAAA', 'AAAAOOOOAAAA'];

const HERO_LEGS = [
  ['.AAAOOOOAAA.', '...OOOOOO...', '...OO..OO...', '..BBB..BBB..', '..BBB..BBB..'],
  ['.AAAOOOOAAA.', '...OOOOOO...', '..OO....OO..', '.BBB......BB', '.BBB......BB'],
  ['.AAAOOOOAAA.', '...OOOOOO...', '....OOOO....', '...BBBBBB...', '...BBBBBB...'],
];

const HERO_LEGS_AIR = ['.AAAOOOOAAA.', '..NOOOOOON..', '.OO......OO.', 'BBB.......BB', 'BBB.........'];

/** The pose of defeat: arms up, crossed eyes, falling out of the level. */
const HERO_DEAD = ['A..........A', 'AA.......AA.', '.AA.AAAAA.A.', '..AAAAAAAA..', '..SKSSSSKS..', '..SSKSSKSS..', '..SKSSSSKS..', '...SSSSSS...', '..AAAAAAAA..', '.AAAOOOOAAA.', '.AAAOOOOAAA.', '..OOOOOOOO..', '..OO....OO..', '..BB....BB..', '.BBB....BBB.', '............'];

/** Sprite pixel side: 12 wide -> ~1.1 tiles. */
const HERO_PX = 7;
const HERO_W = 12 * HERO_PX;
const HERO_H = 16 * HERO_PX;

function drawSprite(g: Graphics, rows: string[], x: number, y: number, px: number, colors: Record<string, string>): void {
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r]!;
    for (let c = 0; c < row.length; c++) {
      const color = colors[row[c]!];
      if (!color) continue;
      g.fillStyle = color;
      g.fillRect(x + c * px, y + r * px, px + SEAM, px + SEAM);
    }
  }
}

function drawHero(g: Graphics, f: Frame): void {
  // In 'hold' it already went in through the castle door.
  if (f.phase === 'hold') return;
  const x = Math.round(f.heroX - f.camera - HERO_W / 2);
  const y = Math.round(f.heroY - HERO_H);
  if (f.phase === 'dies') {
    drawSprite(g, HERO_DEAD, x, y, HERO_PX, HERO_COLORS);
    return;
  }
  const legs = f.airborne || f.phase === 'slide' ? HERO_LEGS_AIR : HERO_LEGS[Math.floor(f.index / 2) % HERO_LEGS.length]!;
  drawSprite(g, HERO_BODY, x, y, HERO_PX, HERO_COLORS);
  drawSprite(g, legs, x, y + HERO_BODY.length * HERO_PX, HERO_PX, HERO_COLORS);
}

/** The black "one life left" card. */
function drawRetryCard(g: Graphics, width: number, height: number, texts: RunnerTexts): void {
  g.fillStyle = '#000000';
  g.fillRect(0, 0, width, height);
  const cx = width / 2;
  const fit = (text: string, px: number) => {
    while (px > 1 && pixelWidth(pixelSafe(text), px) > width * 0.9) px--;
    return px;
  };
  const head = `${texts.world} ${texts.level ?? DEFAULT_TEXTS.level}`;
  const px = fit(head, 6);
  drawPixelText(g, head, cx - pixelWidth(pixelSafe(head), px) / 2, height * 0.26, px, '#FFFFFF');
  // The runner's head and the lives left, centred as a group.
  const headPx = 7;
  const lives = 'X  2';
  const groupW = 12 * headPx + 30 + pixelWidth(lives, px);
  const left = cx - groupW / 2;
  drawSprite(g, HERO_BODY.slice(0, 7), left, height * 0.48, headPx, HERO_COLORS);
  drawPixelText(g, lives, left + 12 * headPx + 30, height * 0.52, px, '#FFFFFF');
  const rpx = fit(texts.retry, 3);
  drawPixelText(g, texts.retry, cx - pixelWidth(pixelSafe(texts.retry), rpx) / 2, height * 0.82, rpx, '#627180');
}

const BUG_COLORS: Record<string, string> = { X: '#B84A3A', D: '#2A1A12', W: '#EFEFEF', F: '#7A2E22' };
const BUG = ['..XXXXXX..', '.XXXXXXXX.', 'XXWDXXDWXX', 'XXWDXXDWXX', 'XXXXXXXXXX', '.XXXXXXXX.', '..FF..FF..', '.FFF..FFF.'];
const BUG_FLAT = ['..........', '..........', '..........', '..........', '..XXXXXX..', '.XXXXXXXX.', 'XXXXXXXXXX', '.FF....FF.'];
const BUG_PX = 6;

function drawBugs(g: Graphics, f: Frame, width: number): void {
  for (let i = 0; i < f.bugX.length; i++) {
    const squashedAt = f.squashed.get(i);
    // A stomped bug lingers a moment and vanishes, as the genre demands.
    if (squashedAt !== undefined && f.index - squashedAt > 8) continue;
    const rows = squashedAt !== undefined ? BUG_FLAT : BUG;
    const x = Math.round(f.bugX[i]! - f.camera - (BUG[0]!.length * BUG_PX) / 2);
    if (x < -100 || x > width + 100) continue;
    drawSprite(g, rows, x, GROUND_ROW * T - rows.length * BUG_PX, BUG_PX, BUG_COLORS);
  }
}

function drawBlock(g: Graphics, b: Block, sx: number, y: number, frameIndex: number): void {
  // Fills overlap the next tile by a pixel: at fractional scales, abutting
  // anti-aliased edges leave a visible seam between blocks.
  if (b.kind === '#') {
    g.fillStyle = '#C84C0C';
    g.fillRect(sx, y, T + 1, T + 1);
    g.fillStyle = '#8A3308';
    // Brick bond: two staggered courses.
    for (let r = 0; r < 2; r++) {
      g.fillRect(sx, y + r * (T / 2) + T / 2 - 3, T, 3);
      g.fillRect(sx + (r % 2 ? T / 4 : (T * 3) / 4) - 1.5, y + r * (T / 2), 3, T / 2);
    }
    return;
  }
  if (b.kind === 'B') {
    g.fillStyle = '#B5651D';
    g.fillRect(sx, y, T + 1, T);
    g.fillStyle = '#7A3E10';
    g.fillRect(sx, y, T, 4);
    g.fillRect(sx, y + T / 2 - 2, T, 4);
    g.fillRect(sx + T / 2 - 2, y + 4, 4, T / 2 - 6);
    g.fillRect(sx + T / 4 - 2, y + T / 2 + 2, 4, T / 2 - 2);
    g.fillRect(sx + (T * 3) / 4 - 2, y + T / 2 + 2, 4, T / 2 - 2);
    return;
  }
  // Code block: a `</>` tile that pulses, the dev twist on the bonus block.
  const lit = Math.floor(frameIndex / 3) % 4;
  g.fillStyle = ['#7C5CFF', '#8F74FF', '#7C5CFF', '#6346E0'][lit]!;
  g.fillRect(sx, y, T + 1, T);
  g.fillStyle = '#2E1A7A';
  g.fillRect(sx, y, T, 4);
  g.fillRect(sx, y + T - 4, T, 4);
  g.fillRect(sx, y, 4, T);
  g.fillRect(sx + T - 4, y, 4, T);
  const tag = '</>';
  drawPixelText(g, tag, sx + (T - pixelWidth(tag, 3)) / 2, y + T / 2 - 10, 3, '#EDE9FF');
}

/** A metal cable duct: something to jump over that belongs in a server room. */
function drawPipe(g: Graphics, p: Pipe, sx: number): void {
  const top = p.top * T;
  const h = (GROUND_ROW - p.top) * T;
  g.fillStyle = '#1E293B';
  g.fillRect(sx - 4, top - 4, 2 * T + 8, h + 4);
  g.fillStyle = '#64748B';
  g.fillRect(sx + 6, top + T * 0.42, 2 * T - 12, h - T * 0.42);
  g.fillRect(sx, top, 2 * T, T * 0.42);
  g.fillStyle = '#94A3B8';
  g.fillRect(sx + 12, top + 6, 14, T * 0.42 - 12);
  g.fillRect(sx + 18, top + T * 0.42, 12, h - T * 0.42);
  g.fillStyle = '#334155';
  g.fillRect(sx + 2 * T - 16, top, 10, T * 0.42);
  g.fillRect(sx + 2 * T - 22, top + T * 0.42, 10, h - T * 0.42);
  // Vent slots on the cap and a status LED.
  g.fillStyle = '#1E293B';
  for (let i = 0; i < 4; i++) g.fillRect(sx + 34 + i * 18, top + 10, 10, 4);
  g.fillStyle = '#34D399';
  g.fillRect(sx + 2 * T - 34, top + 9, 6, 6);
}

/** Clouds and hills at a slower pace, for depth. */
function drawBackdrop(g: Graphics, camera: number, width: number): void {
  const grad = g.createLinearGradient(0, 0, 0, ROWS * T);
  grad.addColorStop(0, SKY_DEEP);
  grad.addColorStop(0.55, SKY);
  g.fillStyle = grad;
  g.fillRect(0, 0, width, ROWS * T);

  const par = camera * 0.35;
  // A green of its own, duller than the pipes': with the same one, a pipe in
  // front of a hill disappeared except for its highlights.
  g.fillStyle = '#1E7C34';
  for (let i = 0; i < 14; i++) {
    const x = ((((i * 640 - par) % (LEVEL_WIDTH * 0.6)) + LEVEL_WIDTH * 0.6) % (LEVEL_WIDTH * 0.6)) - 200;
    const r = i % 2 ? 150 : 96;
    g.beginPath();
    g.arc(x, GROUND_ROW * T, r, Math.PI, 0);
    g.arc(x + r * 0.75, GROUND_ROW * T, r * 0.7, Math.PI, 0);
    g.fill();
  }

  const cpar = camera * 0.18;
  g.fillStyle = '#FFFFFF';
  for (let i = 0; i < 12; i++) {
    const x = ((((i * 730 + 120 - cpar) % (LEVEL_WIDTH * 0.5)) + LEVEL_WIDTH * 0.5) % (LEVEL_WIDTH * 0.5)) - 150;
    const y = 40 + (i % 3) * 46;
    const s = i % 2 ? 1 : 0.75;
    for (const [dx, dy, r] of [
      [0, 0, 26],
      [30, -12, 34],
      [64, 0, 26],
      [32, 10, 30],
    ] as const) {
      g.beginPath();
      g.arc(x + dx * s, y + dy * s, r * s, 0, Math.PI * 2);
      g.fill();
    }
  }
}

function drawFlagAndCastle(g: Graphics, f: Frame, width: number): void {
  // The finish line: a lattice radio mast the runner slides down…
  const poleX = LEVEL.flagCol * T - f.camera + T * 0.4;
  if (poleX > -80 && poleX < width + 80) {
    const top = 1.6 * T;
    const bottom = GROUND_ROW * T;
    g.fillStyle = '#94A3B8';
    g.fillRect(poleX - 6, top, 4, bottom - top);
    g.fillRect(poleX + 10, top, 4, bottom - top);
    g.fillStyle = '#64748B';
    for (let y = top + 10; y < bottom; y += 26) {
      g.fillRect(poleX - 6, y, 20, 3);
      g.save();
      g.translate(poleX - 4, y + 3);
      g.rotate(Math.atan2(23, 16));
      g.fillRect(0, 0, 28, 2);
      g.restore();
    }
    // Beacon on top, blinking.
    g.fillStyle = f.index % 8 < 4 ? '#F5453D' : '#7A1F1B';
    g.fillRect(poleX - 4, top - 14, 16, 14);
    // The pennant comes down with the runner while it slides.
    const drop = f.phase === 'run' ? 0 : Math.min(1, (f.heroY - 2.2 * T) / (GROUND_ROW * T - 2.2 * T));
    const fy = 1.9 * T + drop * (GROUND_ROW * T - 2.9 * T);
    g.fillStyle = '#22D3EE';
    g.beginPath();
    g.moveTo(poleX - 6, fy);
    g.lineTo(poleX - 66, fy + 22);
    g.lineTo(poleX - 6, fy + 44);
    g.closePath();
    g.fill();
  }

  // …and the data centre where the release ships.
  const cx = LEVEL.castleCol * T - f.camera;
  if (cx > -400 && cx < width + 400) {
    const cw = CASTLE_W;
    const top = CASTLE_TOP;
    const ground = GROUND_ROW * T;
    g.fillStyle = '#1E293B';
    g.fillRect(cx, top, cw, ground - top);
    g.fillStyle = '#334155';
    g.fillRect(cx - 8, top - 16, cw + 16, 16);
    // Rows of rack lights.
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 6; col++) {
        const x = cx + 18 + col * ((cw - 36) / 6);
        const y = top + 24 + row * 34;
        g.fillStyle = '#0F172A';
        g.fillRect(x, y, (cw - 36) / 6 - 8, 22);
        const on = (col * 7 + row * 3 + Math.floor(f.index / 3)) % 5;
        g.fillStyle = on === 0 ? '#FFB020' : on < 3 ? '#34D399' : '#14532D';
        g.fillRect(x + 6, y + 8, 8, 6);
      }
    }
    // Door.
    g.fillStyle = '#0F172A';
    g.fillRect(cx + cw / 2 - T * 0.35, ground - T * 1.15, T * 0.7, T * 1.15);
    g.fillStyle = '#38BDF8';
    g.fillRect(cx + cw / 2 + T * 0.2, ground - T * 0.6, 5, 5);
    // Rooftop mast: the release flag goes up at the end.
    const px = cx + cw / 2;
    g.fillStyle = '#94A3B8';
    g.fillRect(px - 3, top - 112, 6, 96);
    if (f.castleFlag > 0) {
      const fy = top - 34 - f.castleFlag * 58;
      g.fillStyle = '#8B5CF6';
      g.fillRect(px + 3, fy, 54, 34);
      g.fillStyle = '#EDE9FF';
      g.fillRect(px + 14, fy + 15, 32, 4);
    }
  }
}

/** HUD text with a shadow: pure white got lost against the clouds. */
function hud(g: Graphics, text: string, x: number, y: number, px: number): void {
  drawPixelText(g, text, x + px, y + px, px, 'rgba(0,0,0,0.45)');
  drawPixelText(g, text, x, y, px, '#FFFFFF');
}

/**
 * Score, world and time. Three columns on a wide view; on a narrow one the
 * world column goes first, then the pixels shrink.
 */
function drawHud(g: Graphics, f: Frame, total: number, width: number, texts: RunnerTexts): void {
  const y = 22;
  const coins = String(f.coins).padStart(6, '0');
  const left = Math.max(0, Math.ceil(((total - f.index) / total) * 400));
  const time = String(left).padStart(3, '0');
  const title = pixelSafe(texts.title);
  const world = pixelSafe(texts.world);
  const timeLabel = pixelSafe(texts.time);
  for (const px of [4, 3, 2]) {
    const leftW = Math.max(pixelWidth(title, px), pixelWidth(coins, px));
    const rightW = Math.max(pixelWidth(timeLabel, px), pixelWidth(time, px));
    const level = pixelSafe(texts.level ?? DEFAULT_TEXTS.level!);
    const worldW = Math.max(pixelWidth(world, px), pixelWidth(level, px));
    const margin = 10 * px;
    const rightC = width - margin - rightW / 2;
    const withWorld = margin + leftW + 2 * margin + worldW + 2 * margin + rightW + margin <= width;
    if (!withWorld && margin + leftW + 2 * margin + rightW + margin > width && px > 2) continue;
    const line2 = y + 9 * px;
    const centre = (t: string, cx: number) => cx - pixelWidth(t, px) / 2;
    hud(g, title, margin, y, px);
    hud(g, coins, margin, line2, px);
    if (withWorld) {
      hud(g, world, centre(world, width / 2), y, px);
      hud(g, level, centre(level, width / 2), line2, px);
    }
    hud(g, timeLabel, centre(timeLabel, rightC), y, px);
    hud(g, time, centre(time, rightC), line2, px);
    return;
  }
}

/** Paints a simulated frame, in world coordinates (`width` × WORLD_H). */
export function drawFrame(g: Graphics, f: Frame, total: number, width: number, texts: RunnerTexts = DEFAULT_TEXTS): void {
  if (f.phase === 'retry') {
    drawRetryCard(g, width, WORLD_H, texts);
    return;
  }
  drawBackdrop(g, f.camera, width);
  for (const b of LEVEL.blocks) {
    const sx = b.col * T - f.camera;
    if (sx < -T || sx > width) continue;
    drawBlock(g, b, sx, b.row * T, f.index);
  }
  for (const p of LEVEL.pipes) {
    const sx = p.col * T - f.camera;
    if (sx < -2 * T || sx > width) continue;
    drawPipe(g, p, sx);
  }
  drawFlagAndCastle(g, f, width);
  drawBugs(g, f, width);
  drawHero(g, f);
  drawHud(g, f, total, width, texts);
}

/**
 * A player for a panel of `width` × `height`: the world is scaled uniformly
 * to the panel's height, and the simulation runs with the view width that
 * gives. Frames are simulated up front (cheap) and painted on demand.
 */
export function runnerPlayer(width: number, height: number, seed: number, texts: RunnerTexts = DEFAULT_TEXTS) {
  const k = height / WORLD_H;
  const view = Math.max(1, Math.ceil(width / k));
  const frames = simulate(view, seed);
  return {
    frames: frames.length,
    fate: fateFor(seed),
    draw(g: Graphics, i: number): void {
      const f = frames[Math.max(0, Math.min(frames.length - 1, i))]!;
      g.fillStyle = '#000000';
      g.fillRect(0, 0, width, height);
      g.save();
      g.scale(k, k);
      drawFrame(g, f, frames.length, view, texts);
      g.restore();
    },
  };
}

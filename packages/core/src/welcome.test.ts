import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createCanvas } from '@napi-rs/canvas';
import { THEMES } from '@kiosko/sdk';
import { normalize } from './config/store.ts';
import { registerFonts } from './fonts.ts';
import { Registry } from './registry.ts';
import { Runtime, type FrameInfo } from './runtime.ts';
import { BOOT_MS, BOOT_WINDOW_MS, CARD_EVERY_MS, cardUrl, editorUrl, paintBoot, paintCard, shapeOf, welcomeDue, welcomeTexts } from './welcome.ts';

process.env.KIOSKO_QUIET = '1';

const screen = { id: 'a', name: 'a', width: 192, height: 46, maxFps: 30, device: { driver: 'virtual' as const }, pages: [{ id: 'p', name: 'Home', tiles: [] }] };
const first = normalize({ setup: 'pending', screens: [screen] });
const normal = normalize({ setup: 'done', screens: [screen] });
const off = normalize({ setup: 'done', bootAnimation: false, screens: [screen] });

test('when it plays: the boot animation at start (unless off; always on a first run), the card only on a first run', () => {
  const at = (cfg: typeof first, o: Partial<{ sinceStartMs: number; now: number; booted: boolean; cardSlot: number }>) => welcomeDue(cfg, { sinceStartMs: 0, now: 5 * CARD_EVERY_MS + 1000, booted: false, cardSlot: -1, ...o });
  assert.equal(at(normal, {}), 'boot');
  assert.equal(at(off, {}), null, 'switched off');
  assert.equal(at(normalize({ ...off, setup: 'pending' }), {}), 'boot', 'a first run says hello anyway');
  assert.equal(at(normal, { sinceStartMs: BOOT_WINDOW_MS + 1 }), null, 'a screen added later goes straight to its pages');
  assert.equal(at(first, { sinceStartMs: BOOT_WINDOW_MS + 1 }), 'card');
  // After the start: the card now and then while the setup is pending, never otherwise.
  assert.equal(at(normal, { booted: true }), null);
  assert.equal(at(first, { booted: true }), 'card');
  assert.equal(at(first, { booted: true, cardSlot: 5 }), null, 'once per slot');
  assert.equal(at(first, { booted: true, now: 5 * CARD_EVERY_MS + 61_000 }), null, 'only in the first minute of its slot');
  assert.equal(at(normalize({ ...first, setup: 'skipped' }), { booted: true }), null);
  // A config from before `setup` that is still the first run's counts as pending.
  const old = normalize({ screens: [{ ...screen, name: 'My panel' }] });
  assert.equal(at(normalize({ ...old, screens: [{ ...old.screens[0]!, pages: [{ id: 'p', name: 'Home', tiles: [] }] }] }), { booted: true }), 'card');
});

test('the card speaks the panel’s language and gives the editor’s address as the config says it listens', () => {
  assert.equal(welcomeTexts('es-ES').running, 'Kiosko está en marcha');
  assert.match(welcomeTexts('zh-CN').open, /副屏/);
  assert.match(welcomeTexts('zh-TW').open, /面板/);
  assert.equal(welcomeTexts('fr').running, 'Kiosko is running', 'English where Kiosko has no words');
  assert.equal(editorUrl({ server: { host: '127.0.0.1', port: 7420 } }), 'http://127.0.0.1:7420');
  assert.equal(editorUrl({ server: { host: '0.0.0.0', port: 7421 } }), 'http://127.0.0.1:7421');
  // Started with --port: the card gives where it really listens, not the config's port.
  assert.equal(cardUrl('http://127.0.0.1:7499', { server: { host: '127.0.0.1', port: 7420 } }), 'http://127.0.0.1:7499');
  assert.equal(cardUrl(undefined, { server: { host: '127.0.0.1', port: 7420 } }), 'http://127.0.0.1:7420');
  assert.equal(new Runtime(new Registry(), first, { editorUrl: 'http://127.0.0.1:7499' }).editorUrl, 'http://127.0.0.1:7499');
  assert.equal(editorUrl({ server: { host: '::1', port: 7420 } }), 'http://[::1]:7420');
});

test('frames of every shape, theme and language paint, and differ as the animation goes', () => {
  registerFonts();
  assert.deepEqual([shapeOf(1920, 462), shapeOf(480, 480), shapeOf(462, 1920), shapeOf(320, 240)], ['wide', 'square', 'tall', 'square']);
  for (const [w, h] of [[1920, 462], [480, 480], [462, 1920], [320, 240], [640, 172]] as const) {
    for (const theme of [THEMES[0]!, THEMES.at(-1)!]) {
      for (const locale of ['en', 'zh-CN']) {
        const c = createCanvas(w, h);
        const g = c.getContext('2d');
        const frames = [0, 600, 1200, 1800, BOOT_MS - 200].map((ms) => {
          paintBoot(g, w, h, ms, { theme, locale, url: 'http://127.0.0.1:7420' });
          return createHash('sha1').update(g.getImageData(0, 0, w, h).data).digest('hex');
        });
        assert.equal(new Set(frames).size, frames.length, `${w}×${h}: the animation moves`);
        paintCard(g, w, h, { theme, locale, url: 'http://127.0.0.1:7420' });
      }
    }
  }
});

test('a screen: boot animation frames first, then its pages; with it off, the pages at once; a first run gets the card', async () => {
  const run = async (cfg: ReturnType<typeof normalize>, ms: number) => {
    const rt = new Runtime(new Registry(), cfg, { welcome: true });
    const seen: (string | null)[] = [];
    rt.on('frame', (f: FrameInfo) => seen.push(f.interlude));
    rt.start();
    await new Promise((r) => setTimeout(r, ms));
    rt.stop();
    return seen;
  };
  const booting = await run(normal, BOOT_MS + 900);
  assert.equal(booting[0], 'kiosko/boot');
  assert.equal(booting.at(-1), null, 'then the page');
  assert.ok(!booting.includes('kiosko/welcome'));
  const plain = await run(off, 400);
  assert.ok(plain.length > 0 && plain.every((x) => x === null), plain.join());
  const welcome = await run(first, BOOT_MS + 900);
  assert.equal(welcome[0], 'kiosko/boot');
  assert.equal(welcome.at(-1), 'kiosko/welcome', 'the card stays');
  // Off by default (tests, the browser demo): nothing before the pages.
  const rt = new Runtime(new Registry(), normal);
  const seen: (string | null)[] = [];
  rt.on('frame', (f: FrameInfo) => seen.push(f.interlude));
  rt.start();
  await new Promise((r) => setTimeout(r, 300));
  rt.stop();
  assert.ok(seen.every((x) => x === null));
});

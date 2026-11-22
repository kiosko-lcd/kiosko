/**
 * What a panel shows when Kiosko starts, before its pages: a short boot
 * animation (the logo's four tiles coming together, the name, a glint), and
 * on a first run a card saying Kiosko is running and how to open the editor,
 * until its setup is done or skipped (`offersSetup`).
 *
 * Part of core, not a plugin: it must work with no plugin installed. It is
 * painted by each screen's runner (on its own thread too) at the screen's
 * own fps, in the theme's colours and the panel's language, and it is cheap:
 * the animation is ~2.4 s of flat shapes, the card a single still frame.
 */
import * as kit from '@loksly/lcd-canvas-kit';
import type { SKRSContext2D } from '@napi-rs/canvas';
import { localize, type Localized } from '@kiosko/sdk/i18n';
import type { Theme } from '@kiosko/sdk';
import type { Config } from './config/model.ts';
import { offersSetup } from './config/starter.ts';

/** How long the boot animation lasts. */
export const BOOT_MS = 2400;
/** The boot animation plays only this soon after Kiosko started (a screen added later, or moved to a thread, goes straight to its pages). */
export const BOOT_WINDOW_MS = 60_000;
/** On a first run, the card comes back this often… */
export const CARD_EVERY_MS = 10 * 60_000;
/** …for this long (the first time, right after the animation, a bit longer). */
export const CARD_MS = 15_000;
export const FIRST_CARD_MS = 30_000;
/** The boot animation's own pace; slower panels play fewer frames of it, never longer. */
export const BOOT_FPS = 15;

export type WelcomeKind = 'boot' | 'card';

/**
 * What the screen shows now instead of its pages, if anything. `booted`:
 * this screen already went through its start; `cardSlot`: the last
 * `CARD_EVERY_MS` slot the card was shown in.
 *
 * - The boot animation: once, at start, if `bootAnimation` isn't off; on a
 *   first run always (it is how the panel says hello).
 * - The card: on a first run, after the animation and then every
 *   `CARD_EVERY_MS`, until the setup is done or skipped.
 */
export function welcomeDue(cfg: Pick<Config, 'screens' | 'setup' | 'bootAnimation'>, s: { sinceStartMs: number; now: number; booted: boolean; cardSlot: number }): WelcomeKind | null {
  const pending = offersSetup(cfg);
  if (!s.booted) {
    if (s.sinceStartMs < BOOT_WINDOW_MS && (cfg.bootAnimation !== false || pending)) return 'boot';
    return pending ? 'card' : null;
  }
  if (!pending) return null;
  const slot = Math.floor(s.now / CARD_EVERY_MS);
  return slot !== s.cardSlot && s.now - slot * CARD_EVERY_MS < 60_000 ? 'card' : null;
}

const TEXTS = {
  running: { en: 'Kiosko is running', es: 'Kiosko está en marcha', de: 'Kiosko läuft', 'zh-Hant': 'Kiosko 已在執行', 'zh-Hans': 'Kiosko 已在运行' },
  open: { en: 'Open the editor to set up this panel:', es: 'Abre el editor para configurar este panel:', de: 'Öffne den Editor, um dieses Panel einzurichten:', 'zh-Hant': '開啟編輯器來設定這塊面板：', 'zh-Hans': '打开编辑器来设置这块副屏：' },
  or: { en: 'or go to', es: 'o entra en', de: 'oder öffne', 'zh-Hant': '或前往', 'zh-Hans': '或访问' },
  hint: { en: 'This card goes away once the setup is done.', es: 'Esta tarjeta se va cuando termines la configuración.', de: 'Diese Karte verschwindet, sobald die Einrichtung fertig ist.', 'zh-Hant': '完成設定後，這張卡片就會消失。', 'zh-Hans': '完成设置后，这张卡片就会消失。' },
} satisfies Record<string, Localized>;

/** The card's words in the panel's language. */
export function welcomeTexts(locale: string): Record<keyof typeof TEXTS, string> {
  return Object.fromEntries(Object.entries(TEXTS).map(([k, v]) => [k, localize(v, locale)])) as Record<keyof typeof TEXTS, string>;
}

/** The editor's address on this machine, as the config says it listens. */
export function editorUrl(cfg: Pick<Config, 'server'>): string {
  const host = !cfg.server.host || cfg.server.host === '0.0.0.0' || cfg.server.host === '::' ? '127.0.0.1' : cfg.server.host;
  return `http://${host.includes(':') ? `[${host}]` : host}:${cfg.server.port}`;
}

/** The address the card gives: where Kiosko really listens when the server says so (`--port`), else the config's. */
export function cardUrl(listening: string | undefined, cfg: Pick<Config, 'server'>): string {
  return listening ?? editorUrl(cfg);
}

export interface WelcomeLook {
  theme: Theme;
  locale: string;
  /** The editor's address (`editorUrl`). */
  url: string;
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const easeOut = (x: number) => 1 - (1 - clamp01(x)) ** 3;
/** A small overshoot, settling: the tiles snap into place. */
const easeBack = (x: number) => {
  const t = clamp01(x) - 1;
  return 1 + 2.2 * t ** 3 + 1.2 * t ** 2;
};

/** The logo's four tiles, in its 64-unit box (the editor's and the site's mark). */
const TILES = [
  { x: 6, y: 6, w: 30, h: 22, grad: true, alpha: 1 },
  { x: 40, y: 6, w: 18, h: 22, grad: false, tone: 1, alpha: 0.55 },
  { x: 6, y: 32, w: 18, h: 26, grad: false, tone: 0, alpha: 0.55 },
  { x: 28, y: 32, w: 30, h: 26, grad: true, alpha: 0.85 },
] as const;

/** The two colours of the mark in a theme: its accent, and its informative colour. */
function brand(theme: Theme): [string, string] {
  return [theme.colors.accent, theme.colors.info];
}

/**
 * The mark at `x, y`, `size` px square. `t` (0..1) brings each tile in, one
 * after the other, from a little smaller and further out; `glint` (0..1)
 * runs a light across it.
 */
function paintMark(g: SKRSContext2D, x: number, y: number, size: number, theme: Theme, t = 1, glint = -1): void {
  const k = size / 64;
  const [c1, c2] = brand(theme);
  TILES.forEach((tile, i) => {
    const p = clamp01((t - i * 0.12) / 0.52);
    if (p <= 0) return;
    const s = 0.55 + 0.45 * easeBack(p);
    const cx = x + (tile.x + tile.w / 2) * k;
    const cy = y + (tile.y + tile.h / 2) * k;
    // Out from the centre of the mark, coming in.
    const dx = (tile.x + tile.w / 2 - 32) * k * 0.6 * (1 - easeOut(p));
    const dy = (tile.y + tile.h / 2 - 32) * k * 0.6 * (1 - easeOut(p));
    const w = tile.w * k * s;
    const h = tile.h * k * s;
    g.save();
    g.globalAlpha = tile.alpha * easeOut(p);
    if (tile.grad) {
      const gr = g.createLinearGradient(x, y, x + size, y + size);
      gr.addColorStop(0, c1);
      gr.addColorStop(1, c2);
      g.fillStyle = gr;
    } else g.fillStyle = 'tone' in tile && tile.tone ? c2 : c1;
    g.beginPath();
    g.roundRect(cx + dx - w / 2, cy + dy - h / 2, w, h, 5 * k * s);
    g.fill();
    g.restore();
  });
  if (glint >= 0 && glint <= 1) {
    // A diagonal band of light crossing the mark, clipped to its tiles.
    g.save();
    g.beginPath();
    for (const tile of TILES) g.roundRect(x + tile.x * k, y + tile.y * k, tile.w * k, tile.h * k, 5 * k);
    g.clip();
    const bx = x - size * 0.6 + glint * size * 2.2;
    const gr = g.createLinearGradient(bx, y, bx + size * 0.5, y + size);
    gr.addColorStop(0, 'rgba(255,255,255,0)');
    gr.addColorStop(0.5, 'rgba(255,255,255,0.45)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr;
    g.fillRect(x, y, size, size);
    g.restore();
  }
}

/** The panel's background: the theme's, with a faint glow of the mark's colour behind `cx, cy`. */
function paintBackground(g: SKRSContext2D, w: number, h: number, theme: Theme, cx: number, cy: number, glow: number): void {
  g.fillStyle = theme.colors.bg;
  g.fillRect(0, 0, w, h);
  if (glow <= 0) return;
  const r = Math.max(w, h) * 0.55;
  const gr = g.createRadialGradient(cx, cy, 0, cx, cy, r);
  const [c1] = brand(theme);
  gr.addColorStop(0, kit.css(kit.hex(c1), 0.16 * glow));
  gr.addColorStop(1, kit.css(kit.hex(c1), 0));
  g.fillStyle = gr;
  g.fillRect(0, 0, w, h);
}

/** The shape a layout is made for: a strip (or wide panel), something squarish, or one standing up. */
export function shapeOf(w: number, h: number): 'wide' | 'square' | 'tall' {
  const r = w / h;
  return r >= 1.6 ? 'wide' : r <= 0.7 ? 'tall' : 'square';
}

/**
 * One frame of the boot animation, `ms` after it started (0..BOOT_MS), on a
 * `w×h` picture: the tiles come together, the name appears beside them (a
 * strip) or under them (square, standing), a glint crosses the mark, and
 * all of it fades into the pages.
 */
export function paintBoot(g: SKRSContext2D, w: number, h: number, ms: number, look: WelcomeLook): void {
  const { theme } = look;
  const shape = shapeOf(w, h);
  const bold = theme.fonts.sansBold;
  const word = 'Kiosko';
  // The mark and the name as a group, centred.
  const mark = shape === 'wide' ? Math.round(h * 0.5) : Math.round(Math.min(w * (shape === 'tall' ? 0.62 : 0.42), h * 0.42));
  let size = Math.round(mark * (shape === 'wide' ? 0.62 : 0.4));
  size = kit.fitSize(g, word, shape === 'wide' ? w * 0.5 : w * 0.86, { size, family: bold }, 10);
  const wordW = kit.measureTracked(g, word, { size, family: bold });
  const gap = Math.round(mark * 0.22);
  const groupW = shape === 'wide' ? mark + gap + wordW : Math.max(mark, wordW);
  const groupH = shape === 'wide' ? mark : mark + gap + size;
  const gx = Math.round((w - groupW) / 2);
  const gy = Math.round((h - groupH) / 2);
  const mx = shape === 'wide' ? gx : Math.round((w - mark) / 2);
  const fade = 1 - clamp01((ms - (BOOT_MS - 380)) / 380);
  paintBackground(g, w, h, theme, mx + mark / 2, gy + mark / 2, easeOut(ms / 900) * fade);
  g.save();
  g.globalAlpha = fade;
  paintMark(g, mx, gy, mark, theme, ms / 1000, (ms - 1350) / 650);
  // The name: wiped in from the mark's side, rising a little.
  const p = easeOut((ms - 650) / 700);
  if (p > 0) {
    const wx = shape === 'wide' ? gx + mark + gap : Math.round((w - wordW) / 2);
    const base = shape === 'wide' ? gy + mark / 2 + size * 0.36 : gy + mark + gap + size * 0.82;
    g.save();
    g.beginPath();
    if (shape === 'wide') g.rect(wx - 2, 0, (wordW + 4) * p, h);
    else g.rect(0, 0, w, h);
    g.clip();
    g.globalAlpha = fade * (shape === 'wide' ? 1 : p);
    kit.drawTracked(g, word, wx, base + (1 - p) * size * 0.25, { size, family: bold, color: theme.colors.ink });
    g.restore();
    // An underline in the mark's colours, growing after the name.
    const u = easeOut((ms - 1150) / 600);
    if (u > 0) {
      const [c1, c2] = brand(theme);
      const gr = g.createLinearGradient(wx, 0, wx + wordW, 0);
      gr.addColorStop(0, c1);
      gr.addColorStop(1, c2);
      g.fillStyle = gr;
      const uh = Math.max(2, Math.round(size * 0.07));
      g.beginPath();
      g.roundRect(wx, base + size * 0.16, wordW * u, uh, uh / 2);
      g.fill();
    }
  }
  g.restore();
}

/**
 * The first run's card: the mark, "Kiosko is running", and how to open the
 * editor (`kiosko editor`, or its address), in the panel's language, laid out
 * for the panel's shape. Still: one frame.
 */
export function paintCard(g: SKRSContext2D, w: number, h: number, look: WelcomeLook): void {
  const { theme } = look;
  const tx = welcomeTexts(look.locale);
  const shape = shapeOf(w, h);
  const pad = Math.round(Math.min(w, h) * 0.08);
  const mark = shape === 'wide' ? Math.round(h * 0.42) : shape === 'tall' ? Math.round(w * 0.5) : Math.round(Math.min(w * 0.3, h * 0.28));
  const gap = Math.round(pad * 0.8);
  const mx = shape === 'wide' ? pad + Math.round(mark * 0.1) : Math.round((w - mark) / 2);
  // The text block: beside the mark on a strip, under it otherwise (the two centred together).
  const bx = shape === 'wide' ? mx + mark + Math.round(mark * 0.35) : pad;
  const bw = w - bx - pad;
  const bh = shape === 'wide' ? h - 2 * pad : h - 2 * pad - mark - gap;
  const bold = theme.fonts.sansBold;
  const sans = theme.fonts.sans;
  const mono = theme.fonts.monoBold;
  const center = shape !== 'wide';
  /** The block at a title size of `k`: its lines and height. */
  const layout = (k: number) => {
    const body = Math.max(9, Math.round(k * 0.5));
    const chip = Math.max(9, Math.round(k * 0.5));
    const hint = Math.max(8, Math.round(k * 0.34));
    const title = kit.wrapLines(g, tx.running, bw, 2, { size: k, family: bold });
    const open = kit.wrapLines(g, tx.open, bw, 3, { size: body, family: sans });
    const cmd = 'kiosko editor';
    const cmdW = kit.measureTracked(g, cmd, { size: chip, family: mono }) + chip * 1.1;
    const orW = kit.measureTracked(g, tx.or, { size: body, family: sans });
    const urlW = kit.measureTracked(g, look.url, { size: chip, family: mono });
    // The command, "or go to" and the address on one line when they fit, else one under another.
    const oneLine = cmdW + body * 0.6 + orW + body * 0.6 + urlW <= bw;
    // Too small to be read from where a panel is looked at: left out.
    const hints = hint >= 10 ? kit.wrapLines(g, tx.hint, bw, 2, { size: hint, family: sans }) : [];
    const lineH = (s: number) => Math.round(s * 1.3);
    const height = title.length * lineH(k) + k * 0.25 + open.length * lineH(body) + body * 0.35 + (oneLine ? chip * 1.9 : chip * 1.9 * 2 + lineH(body)) + hint * 0.6 + hints.length * lineH(hint);
    const fits = urlW <= bw && cmdW <= bw && title.length === 1;
    return { k, body, chip, hint, title, open, cmd, cmdW, orW, urlW, oneLine, hints, height, fits, lineH };
  };
  let k = Math.round(shape === 'wide' ? h * 0.17 : shape === 'tall' ? w * 0.12 : Math.min(w * 0.085, h * 0.11));
  let L = layout(k);
  while (k > 12 && (L.height > bh || !L.fits)) L = layout(--k);
  // At the smallest size the title may take two lines.
  const my = shape === 'wide' ? Math.round((h - mark) / 2) : Math.max(pad, Math.round((h - mark - gap - L.height) / 2));
  paintBackground(g, w, h, theme, mx + mark / 2, my + mark / 2, 1);
  paintMark(g, mx, my, mark, theme);
  let y = shape === 'wide' ? pad + Math.max(0, Math.round((bh - L.height) / 2)) : my + mark + gap;
  const ax = center ? w / 2 : bx;
  const align = center ? 'center' : 'left';
  for (const line of L.title) {
    kit.drawTracked(g, line, ax, y + L.k * 0.95, { size: L.k, family: bold, color: theme.colors.ink, align });
    y += L.lineH(L.k);
  }
  y += L.k * 0.25;
  for (const line of L.open) {
    kit.drawTracked(g, line, ax, y + L.body * 0.95, { size: L.body, family: sans, color: theme.colors.inkDim, align });
    y += L.lineH(L.body);
  }
  y += L.body * 0.35;
  const chipH = Math.round(L.chip * 1.6);
  const drawChip = (x: number, text: string, cw: number) => {
    g.fillStyle = theme.colors.surface;
    g.strokeStyle = theme.colors.surfaceEdge;
    g.lineWidth = 1;
    g.beginPath();
    g.roundRect(x, y, cw, chipH, chipH / 3);
    g.fill();
    g.stroke();
    kit.drawTracked(g, text, x + cw / 2, y + chipH / 2 + L.chip * 0.36, { size: L.chip, family: mono, color: theme.colors.ink, align: 'center' });
  };
  const drawUrl = (x: number) => kit.drawTracked(g, look.url, x, y + chipH / 2 + L.chip * 0.36, { size: L.chip, family: mono, color: theme.colors.accent });
  if (L.oneLine) {
    const total = L.cmdW + L.body * 0.6 + L.orW + L.body * 0.6 + L.urlW;
    let x = center ? Math.round((w - total) / 2) : bx;
    drawChip(x, L.cmd, L.cmdW);
    x += L.cmdW + L.body * 0.6;
    kit.drawTracked(g, tx.or, x, y + chipH / 2 + L.body * 0.36, { size: L.body, family: sans, color: theme.colors.inkDim });
    x += L.orW + L.body * 0.6;
    drawUrl(x);
    y += L.chip * 1.9;
  } else {
    drawChip(center ? Math.round((w - L.cmdW) / 2) : bx, L.cmd, L.cmdW);
    y += L.chip * 1.9;
    kit.drawTracked(g, tx.or, ax, y + L.body * 0.95, { size: L.body, family: sans, color: theme.colors.inkDim, align });
    y += L.lineH(L.body);
    drawUrl(center ? Math.round((w - L.urlW) / 2) : bx);
    y += L.chip * 1.9;
  }
  y += L.hint * 0.6;
  for (const line of L.hints) {
    kit.drawTracked(g, line, ax, y + L.hint * 0.95, { size: L.hint, family: sans, color: theme.colors.inkFaint, align });
    y += L.lineH(L.hint);
  }
}

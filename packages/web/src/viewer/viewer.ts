/**
 * The browser screen's page (docs/browser-screens.md), served by the
 * network-screens server at http://<kiosko>:7429/: a code to pair it, then the
 * screen full-bleed. Tap for full screen, hold (or the corner) for the menu.
 * The talking is client.ts; this draws, keeps the screen awake and follows
 * the window's size.
 */
import { MAX_SIDE } from '@kiosko/core/viewer-kit';
import { ViewerClient, type ViewerState, type WsLike } from './client.ts';
import { textsFor, viewerLang } from './texts.ts';

const lang = viewerLang(navigator.languages?.length ? navigator.languages : [navigator.language || 'en']);
const tx = textsFor(lang);
document.documentElement.lang = lang;
document.title = tx.title;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

// ---- the page ------------------------------------------------------------------

const canvas = el('canvas', 'screen');
const g = canvas.getContext('2d', { alpha: false })!;
const card = el('div', 'card');
const brand = el('div', 'brand', 'KIOSKO');
const message = el('div', 'message');
const code = el('div', 'code');
const steps = el('p', 'steps', tx.steps);
const who = el('p', 'who');
card.append(brand, message, code, steps, who);
const dot = el('div', 'offline-dot');
dot.title = tx.offline;
const corner = el('button', 'corner', '⋯');
corner.setAttribute('aria-label', tx.menu);
const menu = el('div', 'menu');
menu.hidden = true;
const fullBtn = el('button', '', tx.full);
const forgetBtn = el('button', '', tx.forget);
const closeBtn = el('button', '', tx.close);
const awake = el('p', 'awake');
const hint = el('p', 'hint', tx.hint);
menu.append(fullBtn, forgetBtn, closeBtn, awake, hint);
document.body.append(canvas, card, dot, corner, menu);

let hasFrame = false;

/** The picture to ask Kiosko for: the window in device pixels, the longer side at most MAX_SIDE. */
function size(): { w: number; h: number } {
  const cw = Math.max(1, window.innerWidth), ch = Math.max(1, window.innerHeight);
  const scale = Math.min(window.devicePixelRatio || 1, MAX_SIDE / Math.max(cw, ch));
  return { w: Math.round(cw * scale), h: Math.round(ch * scale) };
}

/** What it calls itself in the editor's list. */
function deviceName(): string {
  const ua = navigator.userAgent;
  if (/iPad|Macintosh.*Mobile|Macintosh(?=.*Safari)(?!.*Chrome)/.test(ua) && navigator.maxTouchPoints > 1) return 'iPad';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/Android/.test(ua)) {
    const model = /Android [\d.]+; ([^;)]+?)(?: Build|\))/.exec(ua)?.[1]?.trim();
    return (model && model !== 'K' ? model : /Mobile/.test(ua) ? 'Android phone' : 'Android tablet').slice(0, 32);
  }
  const browser = /Firefox\//.test(ua) ? 'Firefox' : /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'Mac' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} ${os}` : browser;
}

function fitCanvas(): void {
  const s = size();
  if (canvas.width !== s.w || canvas.height !== s.h) {
    canvas.width = s.w;
    canvas.height = s.h;
    redraw();
  }
}

let last: ImageBitmap | HTMLImageElement | null = null;

function redraw(): void {
  g.fillStyle = '#000';
  g.fillRect(0, 0, canvas.width, canvas.height);
  if (!last) return;
  const iw = 'naturalWidth' in last ? last.naturalWidth : last.width;
  const ih = 'naturalHeight' in last ? last.naturalHeight : last.height;
  if (!iw || !ih) return;
  // The whole picture, as big as it fits, centred.
  const k = Math.min(canvas.width / iw, canvas.height / ih);
  const w = Math.round(iw * k), h = Math.round(ih * k);
  g.imageSmoothingQuality = 'high';
  g.drawImage(last, Math.round((canvas.width - w) / 2), Math.round((canvas.height - h) / 2), w, h);
}

async function decode(bytes: Uint8Array): Promise<ImageBitmap | HTMLImageElement> {
  const type = bytes[0] === 0x89 ? 'image/png' : 'image/jpeg';
  const blob = new Blob([bytes as BlobPart], { type });
  if (typeof createImageBitmap === 'function') return createImageBitmap(blob);
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function show(s: ViewerState): void {
  document.body.dataset.state = s.kind;
  const offline = s.kind === 'offline';
  dot.hidden = !(offline && hasFrame);
  card.hidden = (s.kind === 'live' || offline || s.kind === 'connecting') && hasFrame;
  code.hidden = steps.hidden = s.kind !== 'pairing';
  forgetBtn.hidden = !client.paired;
  if (s.kind === 'pairing') {
    message.textContent = tx.pair;
    code.textContent = `${s.code.slice(0, 3)} ${s.code.slice(3)}`;
    who.textContent = `${tx.thisOne}${lang.startsWith('zh') ? '：' : ': '}${deviceName()} · ${client.uid.slice(-4).toUpperCase()}`;
  } else {
    message.textContent = offline ? tx.offline : tx.connecting;
    who.textContent = location.host;
  }
}

const client = new ViewerClient({
  url: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`,
  store: localStorage,
  WebSocket: WebSocket as unknown as new (url: string) => WsLike,
  id: deviceName(),
  size,
  onState: show,
  onFrame: (_n, bytes, done) => {
    // Hidden (another tab, the tablet asleep): taken, not drawn; it asks for the picture again when back.
    if (document.hidden) return done(true);
    const t0 = performance.now();
    decode(bytes).then(
      (img) => {
        if (last && 'close' in last) last.close();
        last = img;
        fitCanvas();
        redraw();
        if (!hasFrame) {
          hasFrame = true;
          show(client.state);
        }
        done(true, performance.now() - t0);
      },
      () => done(false),
    );
  },
});

// ---- size, visibility ----------------------------------------------------------------

let resizeTimer: ReturnType<typeof setTimeout> | null = null;
const resized = () => {
  fitCanvas();
  // Turning a tablet goes through odd sizes: tell Kiosko once it has settled.
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => client.sizeChanged(), 700);
};
window.addEventListener('resize', resized);
window.addEventListener('orientationchange', resized);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  client.wake();
  void keepAwake();
});
// Back from the bfcache, or a phone waking: a new connection if the old one went.
window.addEventListener('pageshow', () => client.wake());
window.addEventListener('online', () => client.wake());

// ---- keeping the screen on -------------------------------------------------------------

type Sentinel = { released: boolean; addEventListener(t: 'release', f: () => void): void };
let lock: Sentinel | null = null;
let video: HTMLVideoElement | null = null;

/**
 * The Wake Lock API where there is one: only in a secure context (https, or
 * http://127.0.0.1 through `adb reverse`). Elsewhere a tiny muted video that
 * keeps playing (what NoSleep.js does), its frames drawn here: browsers keep the
 * screen on while a video plays. Some don't for a muted one: the guide says
 * what else to do (the tablet's own setting, a kiosk browser app).
 */
async function keepAwake(): Promise<void> {
  const wl = (navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<Sentinel> } }).wakeLock;
  if (wl && window.isSecureContext) {
    if (lock && !lock.released) return;
    try {
      lock = await wl.request('screen');
      lock.addEventListener('release', () => (awake.textContent = tx.awakeNone));
      awake.textContent = tx.awakeLock;
      return;
    } catch {
      /* not allowed now (hidden, power saving): the video */
    }
  }
  if (video) {
    if (video.paused) void video.play().catch(() => undefined);
    return;
  }
  const c = el('canvas');
  c.width = c.height = 2;
  const cg = c.getContext('2d')!;
  const capture = (c as HTMLCanvasElement & { captureStream?: (fps: number) => MediaStream }).captureStream;
  if (!capture) {
    awake.textContent = tx.awakeNone;
    return;
  }
  let tick = 0;
  // A frame now and then: a stream that doesn't change may count as paused.
  setInterval(() => {
    cg.fillStyle = tick++ % 2 ? '#000' : '#010101';
    cg.fillRect(0, 0, 2, 2);
  }, 1000);
  video = el('video', 'awake-video');
  video.muted = true;
  video.setAttribute('muted', '');
  video.setAttribute('playsinline', '');
  video.setAttribute('aria-hidden', 'true');
  video.srcObject = capture.call(c, 1);
  document.body.append(video);
  try {
    await video.play();
    awake.textContent = tx.awakeVideo;
  } catch {
    awake.textContent = tx.awakeNone;
  }
}

// ---- touch: full screen, the menu ---------------------------------------------------------

function fullScreen(): void {
  const d = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
  const doc = document as Document & { webkitFullscreenElement?: Element };
  if (document.fullscreenElement || doc.webkitFullscreenElement) return;
  if (d.requestFullscreen) d.requestFullscreen({ navigationUI: 'hide' }).catch(() => undefined);
  else d.webkitRequestFullscreen?.();
}

const openMenu = (open: boolean) => {
  menu.hidden = !open;
  document.body.classList.toggle('menu-open', open);
};

let pressTimer: ReturnType<typeof setTimeout> | null = null;
let longPress = false;
document.addEventListener('pointerdown', (e) => {
  if (menu.contains(e.target as Node) || e.target === corner) return;
  longPress = false;
  pressTimer = setTimeout(() => {
    longPress = true;
    openMenu(true);
  }, 700);
});
const cancelPress = () => pressTimer && clearTimeout(pressTimer);
document.addEventListener('pointercancel', cancelPress);
document.addEventListener('pointerup', (e) => {
  cancelPress();
  if (longPress || menu.contains(e.target as Node) || e.target === corner) return;
  if (!menu.hidden) return openMenu(false);
  fullScreen();
  void keepAwake();
});
document.addEventListener('contextmenu', (e) => e.preventDefault());
corner.addEventListener('click', () => openMenu(menu.hidden));
fullBtn.addEventListener('click', () => {
  openMenu(false);
  fullScreen();
});
closeBtn.addEventListener('click', () => openMenu(false));
forgetBtn.addEventListener('click', () => {
  if (!confirm(tx.forgetAsk)) return;
  openMenu(false);
  hasFrame = false;
  last = null;
  redraw();
  client.forget();
});

fitCanvas();
show(client.state);
client.start();
void keepAwake();

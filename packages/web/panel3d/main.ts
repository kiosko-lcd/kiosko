/**
 * The 3D page (https://kioskolcd.dev/demo/3d/): a panel on a desk, its
 * screen painted live by Kiosko's own runtime running in this browser (the
 * demo's renderer.js), with the widgets' animations and the interludes.
 *
 * What it shows can be chosen in the address, to film a plugin at work:
 *   ?panels=3            a stack of three, a page each
 *   ?page=Cats           only that page of the sample screen
 *   ?widget=cats/room    one widget alone, filling the panel
 *   ?mine=1              the layout made in the editor demo (same browser)
 *   ?turn=10             seconds each page stays, when several take turns (default 18)
 *   ?animate=4           seconds between the widgets' animations (default: 6 to 12)
 *   ?interlude=30        seconds between interludes (default 55; 0 = none)
 *   ?lang=es             the widgets' language (and this page's)
 *   ?clean=1             no captions or buttons (H toggles them)
 *   ?orbit=0             a still camera
 *   ?sway=28,8           how the camera sways: degrees to each side, and seconds there and back
 *   ?az=25&el=11&zoom=1  where the camera starts: degrees to the right and above, and how close
 *   ?q=high|medium|low   fixed quality instead of adapting
 *   ?mirror=0 ?brand=0   no reflection on the desk; no maker's name
 */
import { onRendererEvent, renderer } from '../src/demo/client.ts';
import { DEMO_CONFIG_KEY, type StageChannel, type StageFrame } from '../demo/protocol.ts';
import { Scene3D, type Quality } from './scene.ts';

/** Widgets that move by themselves: their pages go first, so there is something to see at once. */
const LIVELY = new Set(['cats/room']);

interface ScreenLike {
  id: string;
  width: number;
  height: number;
  pages: { id: string; name: string; enabled?: boolean; tiles: { widgets: { type: string }[] }[] }[];
  interludes?: unknown[];
}

const q = new URLSearchParams(location.search);
const lang = (q.get('lang') ?? navigator.language ?? 'en').toLowerCase().startsWith('es') ? 'es' : 'en';
const TEXT = {
  en: {
    tagline: 'A panel on your desk, in 3D. Its screen is painted live, in your browser, by the same code that drives the real one.',
    starting: 'Starting Kiosko in your browser…',
    failed: 'This browser could not start the 3D view',
    one: 'One panel',
    three: 'Three panels',
    orbit: 'Camera sway',
    record: 'Record',
    stop: 'Stop',
    editor: 'Open the editor',
    hint: 'Drag to look around · scroll to zoom · H hides this',
    note: 'Sample data. Thermalright is a trademark of its owner; Kiosko is an independent open-source project.',
    quality: { high: 'High quality', medium: 'Medium quality', low: 'Low quality' },
    interlude: 'interlude',
  },
  es: {
    tagline: 'Un panel en tu mesa, en 3D. Su pantalla la pinta en directo, en tu navegador, el mismo código que mueve el de verdad.',
    starting: 'Arrancando Kiosko en tu navegador…',
    failed: 'Este navegador no ha podido arrancar la vista 3D',
    one: 'Un panel',
    three: 'Tres paneles',
    orbit: 'Vaivén de cámara',
    record: 'Grabar',
    stop: 'Parar',
    editor: 'Abrir el editor',
    hint: 'Arrastra para mirar alrededor · rueda para acercar · H oculta esto',
    note: 'Datos de muestra. Thermalright es una marca de su propietario; Kiosko es un proyecto independiente de código abierto.',
    quality: { high: 'Calidad alta', medium: 'Calidad media', low: 'Calidad baja' },
    interlude: 'interludio',
  },
}[lang];
document.documentElement.lang = lang;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  e.append(...children);
  return e;
}

// ---------- The page around the canvas ----------

const canvas = document.querySelector<HTMLCanvasElement>('#stage')!;
const status = el('div', { class: 'status', role: 'status' }, TEXT.starting);
const now = el('div', { class: 'now', 'aria-live': 'off' });
const quality = el('span', { class: 'quality' });
const one = el('button', { type: 'button' }, TEXT.one);
const three = el('button', { type: 'button' }, TEXT.three);
const sway = el('button', { type: 'button', 'aria-pressed': 'true' }, TEXT.orbit);
const rec = el('button', { type: 'button', class: 'rec' }, TEXT.record);
const hud = el(
  'div',
  { class: 'hud' },
  el('header', {}, el('a', { class: 'brand', href: '../../' }, el('img', { src: '../icon.svg', alt: '', width: '26', height: '26' }), 'Kiosko'), el('p', {}, TEXT.tagline)),
  status,
  el('footer', {}, el('div', { class: 'left' }, now, el('p', { class: 'hint' }, TEXT.hint), el('p', { class: 'note' }, TEXT.note)), el('div', { class: 'controls' }, quality, one, three, sway, rec, el('a', { class: 'button', href: '../' }, TEXT.editor))),
);
document.body.append(hud);
if (q.get('clean') === '1') document.body.classList.add('clean');

// ---------- The scene ----------

const wantsQuality = q.get('q');
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
let count = q.get('widget') ? 1 : q.get('panels') === '3' ? 3 : 1;
/** A number from the address, under the name the scene knows it by (nothing if it isn't there). */
const num = <K extends string>(param: string, key: K): Partial<Record<K, number>> => {
  const v = Number(q.get(param) ?? NaN);
  return (Number.isFinite(v) ? { [key]: v } : {}) as Partial<Record<K, number>>;
};
/** `?sway=degrees,seconds`, when both are numbers worth swaying by. */
const [swayDegrees = NaN, swaySeconds = NaN] = (q.get('sway') ?? '').split(',').map(Number);
const swing = swayDegrees > 0 && swaySeconds > 0 ? { degrees: swayDegrees, seconds: swaySeconds } : null;
let scene: Scene3D;
try {
  scene = new Scene3D(canvas, {
    panels: count,
    brand: q.get('brand') !== '0',
    orbit: q.get('orbit') !== '0' && !reduced,
    quality: wantsQuality === 'high' || wantsQuality === 'medium' || wantsQuality === 'low' ? wantsQuality : 'auto',
    mirror: q.get('mirror') !== '0',
    view: { ...num('az', 'azimuth'), ...num('el', 'elevation'), ...num('zoom', 'zoom') },
    ...(swing ? { sway: swing } : {}),
  });
} catch (err) {
  status.textContent = `${TEXT.failed}: ${err instanceof Error ? err.message : String(err)}`;
  status.classList.add('error');
  throw err;
}
const showQuality = (level: Quality) => (quality.textContent = TEXT.quality[level]);
scene.onQuality = showQuality;
showQuality(scene.quality);
scene.start();

// ---------- What the panels show ----------

let screen: ScreenLike | null = null;
let api: Awaited<ReturnType<typeof renderer>> | null = null;

/** The visitor's own layout from the editor demo, if asked for and it has a bar-shaped screen to show. */
function stored(): unknown {
  if (q.get('mine') !== '1') return null;
  try {
    const saved = JSON.parse(localStorage.getItem(DEMO_CONFIG_KEY) ?? 'null') as { config?: { screens?: ScreenLike[] } } | null;
    return saved?.config?.screens?.some((s) => s.width / s.height > 2.5) ? saved.config : null;
  } catch {
    return null;
  }
}

function channels(): StageChannel[] {
  if (!screen) return [];
  const every = num('interlude', 's').s;
  const interludeMs = screen.interludes?.length ? Math.max(0, every ?? 55) * 1000 : 0;
  const gap = num('animate', 's').s;
  const animateMs: [number, number] | undefined = gap !== undefined ? [Math.max(1, gap) * 1000, Math.max(1, gap) * 1000] : undefined;
  const widget = q.get('widget');
  if (widget) return [{ id: 'p0', screenId: screen.id, widget: { type: widget }, firstAnimationMs: 2500, ...(animateMs ? { animateMs } : {}) }];
  const pages = screen.pages.filter((p) => p.enabled !== false);
  const page = q.get('page');
  if (count === 1) {
    const lively = (p: ScreenLike['pages'][number]) => (p.tiles.some((t) => t.widgets.some((w) => LIVELY.has(w.type))) ? 0 : 1);
    const order = page ? [page] : [...pages].sort((a, b) => lively(a) - lively(b)).map((p) => p.id);
    return [{ id: 'p0', screenId: screen.id, pages: order, pageMs: Math.max(2, num('turn', 's').s ?? 18) * 1000, interludeMs, firstAnimationMs: 2500, ...(animateMs ? { animateMs } : {}) }];
  }
  // A stack: a page each, the first on top (the panels are numbered from the desk up).
  return scene.panels.map((_, i) => {
    const p = pages[(scene.panels.length - 1 - i) % Math.max(1, pages.length)];
    return { id: `p${i}`, screenId: screen!.id, pages: p ? [p.id] : [], firstAnimationMs: 2500 + i * 900, interludeMs: i === scene.panels.length - 1 && interludeMs ? interludeMs + 20_000 : 0, ...(animateMs ? { animateMs } : {}) };
  });
}

function caption(): void {
  const lines = scene.panels
    .map((p) => p.showing)
    .reverse()
    .map((s) => {
      if (!s) return null;
      // An animation's caption is the widget's type (its plan id says nothing to a visitor).
      const moving = s.kind === 'interlude' ? `${TEXT.interlude} · ${s.what}` : s.kind === 'animation' ? (s.what?.split(' · ')[0] ?? null) : null;
      return el('span', { class: moving ? 'chip moving' : 'chip' }, s.page, ...(moving ? [el('em', {}, moving)] : []));
    })
    .filter((x): x is HTMLSpanElement => !!x);
  now.replaceChildren(...lines);
}

let captioned = '';
onRendererEvent((e) => {
  if (e.name !== 'stage') return;
  const frame: StageFrame = e.data;
  const panel = scene.panels[Number(frame.channel.slice(1))];
  if (!panel) return void frame.bitmap.close();
  panel.show(frame, performance.now());
  const key = scene.panels.map((p) => `${p.showing?.page}|${p.showing?.kind}|${p.showing?.what}`).join(';');
  if (key !== captioned) {
    captioned = key;
    caption();
  }
});

async function feed(): Promise<void> {
  await api?.stage(document.hidden ? [] : channels());
}

(async () => {
  api = await renderer();
  const { config } = await api.init(stored());
  const locale = q.get('lang');
  const applied = (locale ? await api.apply({ ...config, locale }) : config) as unknown as { screens: ScreenLike[] };
  // The most bar-shaped screen: that is what the panel on the desk is.
  screen = [...applied.screens].sort((a, b) => b.width / b.height - a.width / a.height)[0] ?? null;
  await feed();
  status.remove();
  document.body.classList.add('ready');
})().catch((err: unknown) => {
  status.textContent = `${TEXT.failed}: ${err instanceof Error ? err.message : String(err)}`;
  status.classList.add('error');
});

// Nobody is looking: stop painting.
document.addEventListener('visibilitychange', () => void feed());

// ---------- Controls ----------

function setCount(n: number): void {
  if (n === count || q.get('widget')) return;
  count = n;
  scene.setPanels(n);
  captioned = '';
  now.replaceChildren();
  marks();
  void feed();
}

let swaying = q.get('orbit') !== '0' && !reduced;
function marks(): void {
  one.setAttribute('aria-pressed', String(count === 1));
  three.setAttribute('aria-pressed', String(count === 3));
  sway.setAttribute('aria-pressed', String(swaying));
}
marks();
if (q.get('widget')) for (const b of [one, three]) b.hidden = true;
one.onclick = () => setCount(1);
three.onclick = () => setCount(3);
sway.onclick = () => {
  swaying = !swaying;
  scene.setOrbit(swaying);
  marks();
};

// Recording: what the canvas shows (no captions), as a video file.
const canRecord = typeof MediaRecorder !== 'undefined' && 'captureStream' in canvas;
let stopRecording: (() => void) | null = null;

/** Films the canvas until `stop()` is called or `ms` have passed; the video, when it ends. */
function record(ms?: number): { done: Promise<Blob>; stop: () => void } {
  const type = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'].find((t) => MediaRecorder.isTypeSupported(t)) ?? '';
  const chunks: Blob[] = [];
  const recorder = new MediaRecorder(canvas.captureStream(60), { ...(type ? { mimeType: type } : {}), videoBitsPerSecond: 16_000_000 });
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const done = new Promise<Blob>((ok) => (recorder.onstop = () => ok(new Blob(chunks, { type: recorder.mimeType }))));
  recorder.start();
  const stop = () => recorder.state !== 'inactive' && recorder.stop();
  if (ms) setTimeout(stop, ms);
  return { done, stop };
}

if (!canRecord) rec.hidden = true;
rec.onclick = () => {
  if (stopRecording) return stopRecording();
  const { done, stop } = record();
  stopRecording = stop;
  rec.textContent = TEXT.stop;
  rec.classList.add('on');
  void done.then((video) => {
    stopRecording = null;
    rec.textContent = TEXT.record;
    rec.classList.remove('on');
    const url = URL.createObjectURL(video);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    el('a', { href: url, download: `kiosko-3d-${stamp}.${video.type.includes('mp4') ? 'mp4' : 'webm'}` }).click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  });
};

// For scripts that film the page (scripts/panel3d-film.mjs): a video of the next `ms`, as a data URL.
Object.assign(window, {
  kiosko3d: {
    film: async (ms: number): Promise<string> => {
      const video = await record(ms).done;
      return new Promise((ok, fail) => {
        const reader = new FileReader();
        reader.onload = () => ok(String(reader.result));
        reader.onerror = () => fail(reader.error);
        reader.readAsDataURL(video);
      });
    },
  },
});

addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === 'h') document.body.classList.toggle('clean');
  else if (k === '1') setCount(1);
  else if (k === '3') setCount(3);
  else if (k === ' ') {
    e.preventDefault();
    sway.click();
  } else if (k === 'r' && canRecord) rec.click();
  else if (k === 'f') void (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen());
});

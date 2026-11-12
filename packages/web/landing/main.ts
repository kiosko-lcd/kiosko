/**
 * The site's front page (https://kioskolcd.dev/): a story told over a panel
 * in 3D (panel3d/). The panel stays on screen while the page's sections
 * scroll past it, and how far the page has been scrolled directs the scene:
 * where the camera is, whether there is one panel or a stack of three, what
 * they show. The pictures on them are painted live by Kiosko's runtime (the
 * demo's renderer.js), started once the page itself is up.
 *
 * One of the sections shows the editor at work: the real one, in a frame,
 * driving itself (src/demo/tour.ts). It announces what it is composing, and
 * the panel here shows it as it happens.
 *
 * Without WebGL the page still reads: the panel is a picture and stays one.
 */
import { onRendererEvent, renderer } from '../src/demo/client.ts';
import { TOUR_CHANNEL, type StageChannel, type TourMessage, type TourOrder } from '../demo/protocol.ts';
import { Scene3D, type Direction } from '../panel3d/scene.ts';

const LANG_KEY = 'kiosko.lang';

type StepId = 'hero' | 'editor' | 'plugins' | 'always' | 'many' | 'cable';

/** Where the scene is while each section is in the middle of the window. */
const POSES: Record<StepId, Direction> = {
  hero: { azimuth: 22, elevation: 10, zoom: 0.8, shiftX: 0, shiftY: 0.25, stack: 0 },
  // Small, to the right and low: under the words, beside the editor's window.
  editor: { azimuth: -14, elevation: 8, zoom: 0.43, shiftX: 0.325, shiftY: 0.2, stack: 0 },
  plugins: { azimuth: -24, elevation: 8, zoom: 0.9, shiftX: 0.2, shiftY: 0.02, stack: 0 },
  always: { azimuth: 24, elevation: 6, zoom: 0.9, shiftX: -0.2, shiftY: 0.02, stack: 0 },
  many: { azimuth: -20, elevation: 9, zoom: 0.94, shiftX: 0.2, shiftY: 0, stack: 1 },
  // From behind: the magnet and the cables.
  cable: { azimuth: 152, elevation: 15, zoom: 0.94, shiftX: -0.2, shiftY: 0, stack: 1 },
};

const smooth = (x: number) => {
  const t = Math.max(0, Math.min(1, x));
  return t * t * (3 - 2 * t);
};
const html = document.documentElement;
const story = document.querySelector<HTMLElement>('#story')!;
const steps = [...story.querySelectorAll<HTMLElement>('.step')].map((el) => ({ el, id: el.dataset.step as StepId }));

// ---------- Language: English unless the visitor (or their browser) says Spanish ----------

const language = () => (html.lang === 'es' ? 'es' : 'en');
document.querySelector<HTMLButtonElement>('.lang')?.addEventListener('click', () => {
  html.lang = language() === 'es' ? 'en' : 'es';
  try {
    localStorage.setItem(LANG_KEY, html.lang);
  } catch {
    /* private mode: it lasts for this visit */
  }
  // The editor on tour changes with the page; what it then announces brings the panel along.
  order({ type: 'lang', lang: language() });
  if (!(active === 'editor' && tour)) void speak();
});

// ---------- The editor's window: the real editor, at its own size, scaled to fit ----------

const view = document.querySelector<HTMLElement>('.view');
const frame = view?.querySelector<HTMLIFrameElement>('iframe') ?? null;
if (view) new ResizeObserver(() => view.style.setProperty('--k', String(view.clientWidth / 1280))).observe(view);

// ---------- The scene ----------

let scene: Scene3D | null = null;
try {
  scene = new Scene3D(document.querySelector<HTMLCanvasElement>('#panel')!, { panels: 3, brand: true, orbit: false, quality: 'auto', mirror: true, directed: true });
} catch (err) {
  // No WebGL here: the picture of the panel stays, and the page reads the same.
  console.warn('Kiosko: no 3D on this browser:', err instanceof Error ? err.message : err);
}

/** Phones and tall windows: the words are above and the panel below, never beside. */
const narrow = () => innerWidth < 820 || innerWidth / innerHeight < 1.05;
function poseOf(id: StepId): Direction {
  const p = POSES[id];
  // As the page's own layout: under the editor's window when they don't fit side by side.
  // A phone's window is narrow for a bar-shaped panel: it gets nearly all of its width.
  const close = innerWidth < 600 ? 1.3 : 1;
  if (id === 'editor') return innerWidth <= 1000 ? { ...p, azimuth: 4, zoom: 0.8 * close, shiftX: 0, shiftY: 0.36 } : p;
  if (id === 'hero') return { ...p, zoom: p.zoom * close * (close > 1 ? 1.1 : 1) };
  if (!narrow()) return p;
  return { ...p, shiftX: 0, shiftY: 0.2, zoom: p.zoom * 0.95 * (p.stack ? 1 : close) };
}

let active: StepId = 'hero';
/** The stack is growing, or grown: the panels above the first need their pictures. */
let stacked = false;

/** Where the story is, from where the page is: the scene goes there, and the active section may change. */
function follow(): void {
  const vh = innerHeight;
  const middle = scrollY + vh / 2;
  // Each section holds its pose while its own middle stretch crosses the window's; between two, it blends.
  const spans = steps.map(({ el }) => {
    const top = el.getBoundingClientRect().top + scrollY;
    return { from: top + vh / 2, to: Math.max(top + vh / 2, top + el.offsetHeight - vh / 2) };
  });
  let i = 0;
  while (i < steps.length - 1 && middle >= spans[i + 1]!.from) i++;
  const next = steps[i + 1];
  const u = next && middle > spans[i]!.to ? smooth((middle - spans[i]!.to) / Math.max(1, spans[i + 1]!.from - spans[i]!.to)) : 0;
  const a = poseOf(steps[i]!.id);
  const b = next ? poseOf(next.id) : a;
  const pose = {} as Direction;
  for (const k of Object.keys(a) as (keyof Direction)[]) pose[k] = a[k] + (b[k] - a[k]) * u;
  scene?.direct(pose);
  const now = u < 0.5 || !next ? steps[i]!.id : next.id;
  const tall = pose.stack > 0.01;
  if (now !== active) {
    active = now;
    stacked = tall;
    enter();
  } else if (tall !== stacked) {
    // The others are on their way down (or gone): they arrive with their pictures on.
    stacked = tall;
    void feed();
  }
}

// ---------- What the panels show ----------

interface ScreenLike {
  id: string;
  width: number;
  height: number;
}
let api: Awaited<ReturnType<typeof renderer>> | null = null;
/** The sample config the runtime started with, and its bar-shaped screen. */
let base: { screens: ScreenLike[] } | null = null;
let bar: ScreenLike | null = null;
/** What the editor on tour is composing, when it has said so. */
let tour: TourMessage | null = null;
let watching = true;

function channels(): StageChannel[] {
  if (!bar || !watching || document.hidden) return [];
  const on = (id: string, pages: string[], more: Partial<StageChannel> = {}): StageChannel => ({ id, screenId: bar!.id, pages, firstAnimationMs: 60_000, ...more });
  // A stack: a page each (the panels are numbered from the desk up).
  const above = stacked ? [on('p1', ['Cats'], { firstAnimationMs: 2500, animateMs: [4000, 7000] }), on('p2', ['Dashboard'])] : [];
  switch (active) {
    case 'hero':
      return [on('p0', ['Cats'], { firstAnimationMs: 1800, animateMs: [3500, 6000] })];
    case 'editor':
      // The page the editor is composing; until it says which, the one from before.
      return [tour ? { id: 'p0', screenId: tour.screenId, pages: [tour.pageId], firstAnimationMs: 60_000 } : on('p0', ['Cats'])];
    case 'plugins':
      return [on('p0', ['News', 'Dashboard', 'Cats'], { pageMs: 4500 })];
    case 'always':
      return [on('p0', ['Dashboard']), ...above];
    default:
      return [on('p0', ['News']), ...above];
  }
}

/** One thing at a time with the runtime: configs and feeds in the order they were asked for. */
let queue: Promise<unknown> = Promise.resolve();
const then = (job: () => Promise<unknown>) => (queue = queue.then(job).catch((err: unknown) => console.warn('Kiosko:', err)));

const feed = () => then(async () => api?.stage(channels()));
/** The sample config in the page's language (the widgets speak it too). */
const speak = () =>
  then(async () => {
    if (!api || !base) return;
    await api.apply({ ...base, locale: language() });
    await api.stage(channels());
  });

let nap: ReturnType<typeof setTimeout> | null = null;
/** "Always on": the panel goes black for a while, then something needs you and it lights up. And again. */
function doze(asleep: boolean): void {
  const p0 = scene?.panels[0];
  if (!p0) return;
  p0.awake = !asleep;
  nap = setTimeout(() => doze(!asleep), asleep ? 2800 : 5200);
}

const tourChannel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(TOUR_CHANNEL) : null;
function order(o: TourOrder): void {
  tourChannel?.postMessage(o);
}

/** A section has taken over: what the panels show, and who is at work, change with it. */
function enter(): void {
  html.dataset.step = active;
  if (nap) clearTimeout(nap);
  nap = null;
  if (scene?.panels[0]) scene.panels[0].awake = true;
  if (active === 'always') doze(true);

  // The editor's frame is loaded when its section comes, and works only while it is the one on screen.
  if (active === 'editor' && frame && !frame.src && frame.dataset.src) frame.src = `${frame.dataset.src}&lang=${language()}`;
  order({ type: active === 'editor' ? 'play' : 'pause' });

  if (active === 'editor' && tour) void mirror();
  else void speak();
}

let mirrored = 0;
/** The editor's page, as it is now, on the panel. */
function mirror(): Promise<unknown> {
  const mine = ++mirrored;
  return then(async () => {
    // Several changes in a row: only the last one is worth painting.
    if (!api || !tour || mine !== mirrored || active !== 'editor') return;
    await api.apply(tour.config);
    await api.stage(channels());
  });
}
tourChannel?.addEventListener('message', (e: MessageEvent<TourMessage>) => {
  if (e.data?.type !== 'config') return;
  tour = e.data;
  if (active === 'editor') void mirror();
  // It started while nobody was looking (the frame is loaded a little early): it waits.
  else order({ type: 'pause' });
});

onRendererEvent((e) => {
  if (e.name !== 'stage') return;
  const panel = scene?.panels[Number(e.data.channel.slice(1))];
  if (panel) panel.show(e.data, performance.now());
  else e.data.bitmap.close();
});

// ---------- Starting up ----------

// The page is followed with or without the scene: the sections take turns either way (the editor's
// frame is loaded when its turn comes), and without 3D the picture of the panel moves aside for them.
let ticking = false;
const onScroll = () => {
  if (ticking) return;
  ticking = true;
  requestAnimationFrame(() => {
    ticking = false;
    follow();
  });
};
addEventListener('scroll', onScroll, { passive: true });
addEventListener('resize', onScroll);
html.dataset.step = active;
follow();

if (scene) {
  const live = scene;
  // The picture the page came with goes on the panel at once; the canvas shows from its first frame.
  const poster = document.querySelector<HTMLImageElement>(`.still img[lang="${language()}"]`);
  if (poster) {
    const put = () => void live.panels[0]!.poster(poster, 'Cats').catch(() => undefined);
    if (poster.complete && poster.naturalWidth) put();
    else poster.addEventListener('load', put, { once: true });
  }
  live.onFrame = () => {
    live.onFrame = null;
    html.classList.add('live3d');
  };
  live.start();

  // Past the story nobody sees the panel: stop drawing it and painting for it.
  new IntersectionObserver(([entry]) => {
    watching = !!entry?.isIntersecting;
    if (watching) live.start();
    else live.stop();
    void feed();
  }).observe(story);
  document.addEventListener('visibilitychange', () => void feed());

  // The runtime (a worker, its plugins and fonts) after the page itself: it is the heavy part.
  const boot = async () => {
    api = await renderer();
    const { config } = await api.init(null);
    base = config as unknown as { screens: ScreenLike[] };
    bar = [...base.screens].sort((a, b) => b.width / b.height - a.width / a.height)[0] ?? null;
    await speak();
  };
  const idle = (window as { requestIdleCallback?: (f: () => void, o?: { timeout: number }) => void }).requestIdleCallback;
  if (idle) idle(() => void boot().catch((err) => console.warn('Kiosko:', err)), { timeout: 1500 });
  else setTimeout(() => void boot().catch((err) => console.warn('Kiosko:', err)), 400);
} else {
  html.classList.add('no3d');
}

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
import { DEMO_CONFIG_KEY, TOUR_CHANNEL, type StageChannel, type TourMessage, type TourOrder } from '../demo/protocol.ts';
import { Scene3D, type Direction } from '../panel3d/scene.ts';
import { readConfig, screensToShow, stackFor, type Problem, type ShownScreen } from './config.ts';

const LANG_KEY = 'kiosko.lang';

type StepId = 'hero' | 'editor' | 'plugins' | 'always' | 'many' | 'cable' | 'yours';

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
  // Back to the front, for the visitor's own config: as many panels as it has screens (poseOf).
  yours: { azimuth: -17, elevation: 9, zoom: 0.78, shiftX: 0.22, shiftY: 0.02, stack: 0 },
};

const smooth = (x: number) => {
  const t = Math.max(0, Math.min(1, x));
  return t * t * (3 - 2 * t);
};
const html = document.documentElement;
/**
 * `?card`: the page as the picture that goes with its link when it is shared (card.jpg, taken by
 * scripts/panel3d-film.mjs --card): the headline and the panel, in English, nothing to click.
 */
const card = new URLSearchParams(location.search).has('card');
if (card) {
  html.classList.add('card');
  html.lang = 'en';
}
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
  if (!(active === 'editor' && tour)) void show();
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
  // The visitor's config: as many panels as it has screens. Two are as wide on the page as one
  // (the width is what limits them); three are as tall as the story's own stack.
  const mine = id === 'yours' && yours ? yours.screens.length : 0;
  const p = mine > 1 ? { ...POSES[id], stack: stackFor(mine), zoom: mine > 2 ? POSES.many.zoom : 0.74 } : POSES[id];
  // As the page's own layout: under the editor's window when they don't fit side by side.
  // A phone's window is narrow for a bar-shaped panel: it gets nearly all of its width.
  const close = innerWidth < 600 ? 1.3 : 1;
  if (id === 'editor') return innerWidth <= 1000 ? { ...p, azimuth: 4, zoom: 0.8 * close, shiftX: 0, shiftY: 0.36 } : p;
  // On the card the panel is most of the picture.
  if (id === 'hero' && card) return { ...p, azimuth: 20, zoom: 0.97, shiftY: 0.175 };
  if (id === 'hero') return { ...p, zoom: p.zoom * close * (close > 1 ? 1.1 : 1) };
  if (!narrow()) return p;
  // The visitor's section has more to read, and buttons: its panels sit lower, and small enough to fit under them.
  if (id === 'yours') return { ...p, shiftX: 0, shiftY: [0.3, 0.33, 0.34][Math.max(0, mine - 1)]!, zoom: [p.zoom * 0.95, 0.66, 0.51][Math.max(0, mine - 1)]! * close };
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

let api: Awaited<ReturnType<typeof renderer>> | null = null;
/** The sample config the runtime started with, and its bar-shaped screen. */
let base: { screens: ShownScreen[] } | null = null;
let bar: ShownScreen | null = null;
/** The visitor's own config, as the runtime read it, and the screens of it that get a panel. */
let yours: { name: string; config: { screens: ShownScreen[] }; screens: ShownScreen[]; fromDemo: boolean } | null = null;
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
    case 'yours':
      // A panel for each of the visitor's screens, the first on top, its pages taking turns. Until
      // there is a config, the sample's.
      if (yours) return yours.screens.map((s, i, all) => ({ id: `p${all.length - 1 - i}`, screenId: s.id, pageMs: 6000, firstAnimationMs: 2500 + i * 900 }));
      return [on('p0', ['Dashboard', 'Cats', 'News'], { pageMs: 5000, firstAnimationMs: 2500 })];
    default:
      return [on('p0', ['News']), ...above];
  }
}

/** One thing at a time with the runtime: configs and feeds in the order they were asked for. */
let queue: Promise<unknown> = Promise.resolve();
const then = (job: () => Promise<unknown>) => (queue = queue.then(job).catch((err: unknown) => console.warn('Kiosko:', err)));

const feed = () => then(async () => api?.stage(channels()));
/**
 * What the runtime holds outside the editor's section: the visitor's config on theirs, and
 * otherwise the sample in the page's language (the widgets speak it too).
 */
const show = () =>
  then(async () => {
    if (!api || !base) return;
    await api.apply(active === 'yours' && yours ? yours.config : { ...base, locale: language() });
    await api.stage(channels());
    slides();
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
  else void show();
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

let booting: Promise<void> | null = null;
/** The runtime (a worker, its plugins and fonts), started once: after the page, or when first needed. */
function boot(): Promise<void> {
  return (booting ??= (async () => {
    api = await renderer();
    const { config } = await api.init(null);
    base = config as unknown as { screens: ShownScreen[] };
    bar = [...base.screens].sort((a, b) => b.width / b.height - a.width / a.height)[0] ?? null;
  })());
}

// ---------- The visitor's own config: dropped on the page or chosen, read here, sent nowhere ----------

const part = <T extends HTMLElement>(name: string) => document.querySelector<T>(`[data-yours="${name}"]`);
const said = part('said');
const loaded = part('loaded');
const fromDemo = part<HTMLButtonElement>('demo');
const picker = part<HTMLInputElement>('file');
/** Far more than a config weighs: anything bigger is some other file. */
const TOO_BIG = 2_000_000;

/** A line under the buttons, in the page's two languages. */
function say(en: string, es: string, bad = false): void {
  if (!said) return;
  const line = (lang: string, text: string) => Object.assign(document.createElement('span'), { lang, textContent: text });
  said.replaceChildren(line('en', en), line('es', es));
  said.classList.toggle('bad', bad);
}

const PROBLEMS: Record<Problem | 'big', [string, string]> = {
  json: ["That file isn't JSON.", 'Ese fichero no es JSON.'],
  shape: ["That JSON isn't a Kiosko config: it has no screens.", 'Ese JSON no es una configuración de Kiosko: no tiene pantallas.'],
  empty: ['That config has no page to show.', 'Esa configuración no tiene ninguna página que enseñar.'],
  big: ['That file is too big to be a config.', 'Ese fichero es demasiado grande para ser una configuración.'],
};

/** What the editor demo keeps in this browser, if anything. */
function kept(): string | null {
  try {
    return localStorage.getItem(DEMO_CONFIG_KEY);
  } catch {
    return null;
  }
}

/** The section says what is on the panel, and offers what can be done with it. */
function tell(): void {
  if (loaded) loaded.hidden = !yours;
  if (fromDemo) fromDemo.hidden = !kept() || !!yours?.fromDemo;
  if (!yours) return void said?.replaceChildren();
  const n = yours.screens.length;
  const pages = yours.screens.reduce((sum, s) => sum + s.pages.filter((p) => p.enabled !== false).length, 0);
  const more = yours.config.screens.length > n;
  say(
    `${yours.name}: ${n} screen${n === 1 ? '' : 's'}${more ? ` (of ${yours.config.screens.length})` : ''}, ${pages} page${pages === 1 ? '' : 's'}, with sample data.`,
    `${yours.name}: ${n} pantalla${n === 1 ? '' : 's'}${more ? ` (de ${yours.config.screens.length})` : ''}, ${pages} página${pages === 1 ? '' : 's'}, con datos de muestra.`,
  );
}

/** A file's text becomes what the panel shows, if it is a config; the page goes to its section. */
async function take(text: string, name: string, demo = false): Promise<void> {
  const read = text.length > TOO_BIG ? { problem: 'big' as const } : readConfig(text);
  if ('problem' in read) return say(...PROBLEMS[read.problem], true);
  let found: typeof yours = null;
  let why = '';
  const failed = (err: unknown) => (why = err instanceof Error ? err.message : String(err));
  // The runtime reads it as the server would on a save; it is applied for good when its section is on.
  await boot()
    .then(() =>
      then(async () => {
        try {
          const config = (await api!.apply(read.config)) as unknown as { screens: ShownScreen[] };
          const screens = screensToShow(config);
          if (screens.length) found = { name, config, screens, fromDemo: demo };
        } catch (err) {
          failed(err);
        }
      }),
    )
    .catch(failed);
  if (found) {
    yours = found;
    tell();
  } else if (why) say(`Kiosko couldn't read that config: ${why}`, `Kiosko no ha podido leer esa configuración: ${why}`, true);
  else say(...PROBLEMS.empty, true);
  // The stack takes the size of the config, and the runtime goes back to what this section shows.
  follow();
  void show();
  if (found) steps.find((step) => step.id === 'yours')?.el.scrollIntoView({ block: 'start' });
}

part('pick')?.addEventListener('click', () => picker?.click());
picker?.addEventListener('change', () => {
  const file = picker.files?.[0];
  picker.value = '';
  if (file) void file.text().then((text) => take(text, file.name));
});
fromDemo?.addEventListener('click', () => {
  const text = kept();
  if (text) void take(text, language() === 'es' ? 'La de la demo' : "The demo's", true);
});
part('reset')?.addEventListener('click', () => {
  yours = null;
  tell();
  follow();
  void show();
});
// Opening it in the editor: the demo starts from what this browser keeps for it.
part('edit')?.addEventListener('click', (e) => {
  if (!yours || yours.fromDemo) return;
  try {
    const before = JSON.parse(kept() ?? 'null') as { rev?: number; config?: unknown } | null;
    const replaces = !!before?.config && JSON.stringify(before.config) !== JSON.stringify(yours.config);
    const sure = language() === 'es' ? 'Esto sustituye lo que hiciste en la demo del editor. ¿Seguir?' : 'This replaces what you made in the editor demo. Go on?';
    if (replaces && !confirm(sure)) return void e.preventDefault();
    localStorage.setItem(DEMO_CONFIG_KEY, JSON.stringify({ rev: (before?.rev ?? 0) + 1, config: yours.config }));
  } catch {
    /* It can't be kept here (private mode, no room): the editor opens with its sample. */
  }
});

// A file dragged over the page, anywhere on it.
const dragsFile = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
let over = 0;
addEventListener('dragenter', (e) => {
  if (!dragsFile(e)) return;
  e.preventDefault();
  over++;
  html.classList.add('dropping');
});
addEventListener('dragover', (e) => {
  if (dragsFile(e)) e.preventDefault();
});
addEventListener('dragleave', (e) => {
  if (!dragsFile(e) || --over > 0) return;
  over = 0;
  html.classList.remove('dropping');
});
addEventListener('drop', (e) => {
  if (!dragsFile(e)) return;
  e.preventDefault();
  over = 0;
  html.classList.remove('dropping');
  const file = e.dataTransfer!.files[0];
  if (file) void (file.size > TOO_BIG ? Promise.resolve(say(...PROBLEMS.big, true)) : file.text().then((text) => take(text, file.name)));
});

// Without 3D the visitor's pages are pictures on the picture of the panel, taking turns.
const stills = [...document.querySelectorAll<HTMLImageElement>('.still img')];
const posters = stills.map((img) => img.getAttribute('src') ?? '');
let slide: ReturnType<typeof setInterval> | null = null;
function slides(): void {
  if (scene) return;
  if (slide) clearInterval(slide);
  slide = null;
  const put = (url: (i: number) => string) =>
    stills.forEach((img, i) => {
      const old = img.getAttribute('src') ?? '';
      if (old === url(i)) return;
      img.src = url(i);
      // One picture for both: let go of it when the last has changed.
      if (i === stills.length - 1 && old.startsWith('blob:')) URL.revokeObjectURL(old);
    });
  const mine = active === 'yours' ? yours : null;
  const screen = mine?.screens[0];
  const pages = screen?.pages.filter((p) => p.enabled !== false) ?? [];
  if (!mine || !screen || !pages.length) return put((i) => posters[i]!);
  let n = 0;
  const next = () =>
    then(async () => {
      if (!api || yours !== mine || active !== 'yours') return;
      const { blob } = await api.preview(screen as unknown as Parameters<typeof api.preview>[0], pages[n++ % pages.length]!.id);
      const url = URL.createObjectURL(blob);
      put(() => url);
    });
  void next();
  if (pages.length > 1) slide = setInterval(() => void next(), 5000);
}

tell();

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

  // The runtime after the page itself: it is the heavy part.
  const begin = () => void boot().then(show).catch((err: unknown) => console.warn('Kiosko:', err));
  const idle = (window as { requestIdleCallback?: (f: () => void, o?: { timeout: number }) => void }).requestIdleCallback;
  if (idle) idle(begin, { timeout: 1500 });
  else setTimeout(begin, 400);
} else {
  html.classList.add('no3d');
}

/**
 * The first-run setup wizard's logic, apart from its looks (Wizard.tsx) so
 * it can be tested in Node: its steps, what is kept between reloads, and the
 * config each set of choices makes. Pure: no DOM, no signals.
 *
 * What it makes goes through the editor's own `edit` (one step to undo) and
 * the config API like any other change. It never throws work away: a config
 * that is still the first run's (`looksLikeStarter`) has its screen
 * replaced; any other only gets new screens added.
 */
import { newId, newScreen, type Config, type DeviceConfig, type Rotation, type Screen } from '@kiosko/core/model';
import { marketOf, offersSetup, starterInterludes, starterPage } from '@kiosko/core/starter';
import { allTemplates, pageFromTemplate, type Frac, type Template } from '../editor/templates.ts';

export const STEPS = ['welcome', 'panel', 'show', 'touches', 'done'] as const;
export type StepId = (typeof STEPS)[number];

/** The first page every panel is offered: what's installed, shown off (core's starterPage). */
export const STARTER = 'starter';
/** A panel the first start already set up keeps the pages it has (its template, until another is chosen). */
export const CURRENT = 'current';

/** A panel the person is setting up: found, picked from the models, or none at all (just trying). */
export interface PanelChoice {
  /** The wizard's own id for it. */
  id: string;
  name: string;
  /** Its size as it reports it, or as sold. */
  width: number;
  height: number;
  /** The angle its firmware asks for (a detected panel), at which it is upright at `width×height`. */
  baseRotate: Rotation;
  /** Stood on its side (taller than wide). */
  portrait: boolean;
  device: DeviceConfig;
  from: 'usb' | 'trcc' | 'remote' | 'model' | 'try';
  /** A model's id (PANEL_PRESETS), when picked from them or recognised by its size. */
  preset?: string;
  /** What tells it apart (a serial, where it is plugged), shown next to it. */
  detail?: string;
  /** The template of its first page: `starter`, a built-in one or a plugin's, or `current` (the pages of `screen`). */
  template: string;
  /** The screen it already is (the first start made one for each panel found). */
  screen?: string;
}

export interface Place {
  latitude: number;
  longitude: number;
  name?: string;
}

/** Everything chosen so far: kept in the browser, so a reload goes on where it was. */
export interface WizardState {
  v: 1;
  step: StepId;
  panels: PanelChoice[];
  /** Weather and sky's place; undefined: left as it is. */
  location?: Place;
  /** The panels' theme; undefined: left as it is. */
  theme?: string;
  /** Once applied: the screens it made (the last step shows them). */
  made?: string[];
}

/** The browser's key for the wizard's progress. */
export const STORAGE_KEY = 'kiosko.setup';

export function freshState(): WizardState {
  return { v: 1, step: 'welcome', panels: [] };
}

const ROTATIONS: readonly number[] = [0, 90, 180, 270];
const DRIVERS = ['virtual', 'usb', 'trcc', 'file', 'remote'];

/** The progress kept in the browser, if it is one this wizard wrote (anything else starts afresh). */
export function readState(raw: string | null): WizardState | null {
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as Partial<WizardState>;
    if (s?.v !== 1 || !STEPS.includes(s.step as StepId) || !Array.isArray(s.panels)) return null;
    const panels = s.panels.filter(
      (p): p is PanelChoice =>
        !!p && typeof p.id === 'string' && typeof p.name === 'string' && p.width > 0 && p.height > 0 && ROTATIONS.includes(p.baseRotate) && typeof p.portrait === 'boolean' && DRIVERS.includes(p.device?.driver) && typeof p.template === 'string',
    );
    const loc = s.location;
    const location = loc && Number.isFinite(loc.latitude) && Number.isFinite(loc.longitude) && Math.abs(loc.latitude) <= 90 && Math.abs(loc.longitude) <= 180 ? loc : undefined;
    // Past the panels with none (a lost entry): back to choosing one.
    const step = panels.length === 0 && STEPS.indexOf(s.step!) > STEPS.indexOf('panel') ? 'panel' : s.step!;
    return { v: 1, step, panels, ...(location ? { location } : {}), ...(typeof s.theme === 'string' ? { theme: s.theme } : {}), ...(Array.isArray(s.made) && s.made.every((x) => typeof x === 'string') ? { made: s.made } : {}) };
  } catch {
    return null;
  }
}

/** Whether the step can be left forwards: the panel step needs a panel (or "just try it"). */
export function canGoOn(s: WizardState): boolean {
  return s.step !== 'panel' || s.panels.length > 0;
}

export function nextStep(step: StepId): StepId {
  return STEPS[Math.min(STEPS.length - 1, STEPS.indexOf(step) + 1)]!;
}

export function prevStep(step: StepId): StepId {
  return STEPS[Math.max(0, STEPS.indexOf(step) - 1)]!;
}

/** A known model of this size, either way round. */
export function presetOf<P extends { id: string; width: number; height: number }>(presets: readonly P[], width: number, height: number): P | undefined {
  return presets.find((p) => (p.width === width && p.height === height) || (p.width === height && p.height === width));
}

/** A panel found on USB (an LY one). Its size needs its hello; one held by another program has none: a Trofeo Vision 9.16 is assumed. */
export function fromUsb(f: { serial: string; key: string; width: number; height: number; rotate?: number; location: string; error?: string }, name: string): PanelChoice {
  const width = f.width || 1920;
  const height = f.height || 462;
  return {
    id: `usb:${f.serial || f.location}`,
    name,
    width,
    height,
    baseRotate: ROTATIONS.includes(f.rotate ?? 0) ? ((f.rotate ?? 0) as Rotation) : 0,
    portrait: false,
    device: { driver: 'usb', ...(f.serial ? { serial: f.serial } : {}) },
    from: 'usb',
    detail: f.serial || f.location,
    template: STARTER,
  };
}

/** A panel `trcc serve` drives. */
export function fromTrcc(f: { key: string; width: number; height: number }, url: string, name: string): PanelChoice {
  return { id: `trcc:${f.key}`, name, width: f.width || 1920, height: f.height || 462, baseRotate: 0, portrait: false, device: { driver: 'trcc', url, deviceKey: f.key }, from: 'trcc', detail: f.key, template: STARTER };
}

/** A model picked to design for now and connect later: a virtual screen of its size. */
export function fromModel(p: { id: string; name: string; width: number; height: number }, name = p.name): PanelChoice {
  return { id: `model:${p.id}:${newId('p')}`, name, width: p.width, height: p.height, baseRotate: 0, portrait: p.height > p.width, device: { driver: 'virtual' }, from: 'model', preset: p.id, template: STARTER };
}

/** No panel: a Trofeo Vision 9.16-sized screen, seen only in the editor. */
export function tryIt(name: string): PanelChoice {
  return { ...fromModel({ id: 'trofeo-916', name, width: 1920, height: 462 }, name), id: 'try', from: 'try' };
}

/**
 * A name for each, told apart when several are the same model: the owner's
 * three Trofeo Visions are "Trofeo Vision 9.16″ 1", "… 2", "… 3" until named.
 */
export function uniqueName(base: string, taken: readonly string[]): string {
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) if (!taken.includes(`${base} ${n}`)) return `${base} ${n}`;
}

/** The picture a panel gets and the angle it is mounted at, for the orientation chosen. */
export function pictureOf(p: Pick<PanelChoice, 'width' | 'height' | 'baseRotate' | 'portrait'>): { width: number; height: number; rotate: Rotation } {
  if (p.height > p.width === p.portrait) return { width: p.width, height: p.height, rotate: p.baseRotate };
  return { width: p.height, height: p.width, rotate: ((p.baseRotate + 90) % 360) as Rotation };
}

/**
 * The market of the panel's language (languages.ts): a widget not offered
 * there is left out of a template, and one that has a stand-in there is
 * swapped for it (in mainland China, Claude's usage bar for the providers'
 * balances).
 */
export function forMarket(t: Template, locale: string | undefined): Template {
  const m = marketOf(locale);
  const swap = (fr: Frac[] | undefined): Frac[] | undefined =>
    fr?.map((f) => ({
      ...f,
      widgets: f.widgets
        .map((w): Frac['widgets'][number] => {
          const [type, opts] = typeof w === 'string' ? [w, undefined] : w;
          const to = m.instead(type);
          return to ? to : opts ? [type, opts] : type;
        })
        .filter((w) => m.offered(typeof w === 'string' ? w : w[0])),
    }));
  return { ...t, wide: swap(t.wide)!, ...(t.square ? { square: swap(t.square)! } : {}), ...(t.tall ? { tall: swap(t.tall)! } : {}) };
}

/**
 * The starting layouts offered, for the panel's language: the first run's
 * page first, then every template with something installed to show (not the
 * blank one: the editor is for that), each fitted to the market.
 */
export function templatesFor(catalog: Parameters<typeof allTemplates>[0], has: (type: string) => boolean, locale: string | undefined): Template[] {
  const m = marketOf(locale);
  const out: Template[] = [{ id: STARTER, icon: 'sparkles', needs: [], wide: [] }];
  for (const t of allTemplates(catalog, has)) {
    if (t.id === 'blank') continue;
    // A plugin's template (`plugin/id`) from a plugin not offered there.
    if (t.id.includes('/') && !m.offered(`${t.id.split('/')[0]}/*`)) continue;
    const fitted = forMarket(t, locale);
    if (![...fitted.wide, ...(fitted.square ?? []), ...(fitted.tall ?? [])].some((f) => f.widgets.some((w) => has(typeof w === 'string' ? w : w[0])))) continue;
    out.push(fitted);
  }
  return out;
}

/** What building screens needs from the editor: what is installed, the templates and its words. */
export interface BuildContext {
  has: (type: string) => boolean;
  hasInterlude: (type: string) => boolean;
  /** As `templatesFor` gives them. */
  templates: readonly Template[];
  /** The panel's language (the market, and the first page's words). */
  locale: string;
  /** A template's name, for the page made from it. */
  pageName: (t: Template) => string;
  /** A widget's name, for its tile's title. */
  titleOf: (type: string) => string | undefined;
  /** Agents are in use here: the first run's page leads with them. Default: if installed. */
  agents?: boolean;
  /** A place is known: the first run's page may show the weather. Default: if installed. */
  weather?: boolean;
  /** The screens there are now (`current` keeps a panel's pages). */
  screens?: readonly Screen[];
}

/** The screen a panel choice makes: its connection, orientation and first page. */
export function buildScreen(p: PanelChoice, ctx: BuildContext): Screen {
  const pic = pictureOf(p);
  const s = newScreen(p.name.trim() || p.detail || 'Kiosko', pic.width, pic.height, p.device);
  // Mounted at its angle without turning the (empty) page: the picture is already the right way round.
  if (pic.rotate) s.rotate = pic.rotate;
  const had = p.template === CURRENT ? ctx.screens?.find((x) => x.id === p.screen) : undefined;
  if (had && had.width === pic.width && had.height === pic.height) {
    // What the first start made for it, as it is: its pages and interludes.
    s.pages = JSON.parse(JSON.stringify(had.pages)) as Screen['pages'];
    s.interludes = JSON.parse(JSON.stringify(had.interludes)) as Screen['interludes'];
    return s;
  }
  const t = ctx.templates.find((x) => x.id === p.template) ?? ctx.templates[0];
  const name = t ? ctx.pageName(t) : undefined;
  s.pages = [!t || t.id === STARTER ? starterPage(ctx.has, { width: pic.width, height: pic.height, locale: ctx.locale, name, ...(ctx.agents === undefined ? {} : { agents: ctx.agents }), ...(ctx.weather === undefined ? {} : { weather: ctx.weather }) }) : pageFromTemplate(t, name!, pic.width, pic.height, ctx.has, ctx.titleOf)];
  s.interludes = starterInterludes(ctx.hasInterlude, ctx.locale);
  return s;
}

/** A screen as a preview needs it: the panel's first page, at its size (POST /api/preview). */
export function previewScreen(p: PanelChoice, template: string, ctx: BuildContext): Screen {
  const s = buildScreen({ ...p, template, device: { driver: 'virtual' } }, ctx);
  s.id = `preview-${p.id}`.replace(/[^\w.-]/g, '-').slice(0, 80);
  return s;
}

/** Whether the config is somebody's work, which the wizard only adds to (not the first run's, untouched). */
export function addsTo(cfg: Pick<Config, 'screens' | 'setup'>): boolean {
  return cfg.screens.length > 0 && !offersSetup(cfg);
}

/**
 * The panels the first start already set up (a screen for each one found),
 * as the wizard's choices: it starts from them, keeping what they show until
 * something else is chosen. Only for a first run's config.
 */
export function fromStarter(cfg: Pick<Config, 'screens' | 'setup'>): PanelChoice[] {
  if (addsTo(cfg)) return [];
  return cfg.screens
    .filter((s) => s.device.driver !== 'virtual')
    .map((s) => {
      // The panel upright at its angle: its picture's size, and the way it stands.
      const portrait = s.height > s.width;
      return { id: `screen:${s.id}`, name: s.name, width: s.width, height: s.height, baseRotate: s.rotate, portrait, device: s.device, from: s.device.driver === 'trcc' ? 'trcc' : s.device.driver === 'remote' ? 'remote' : 'usb', ...(s.device.driver === 'usb' && s.device.serial ? { detail: s.device.serial } : s.device.driver === 'trcc' && s.device.deviceKey ? { detail: s.device.deviceKey } : s.device.driver === 'remote' ? { detail: s.device.id ?? s.device.uid } : {}), template: CURRENT, screen: s.id } satisfies PanelChoice;
    });
}

/**
 * The config once the wizard is through: its screens in place of the first
 * run's (or after the ones there, if somebody made them), the place and the
 * theme if chosen, and `setup` so it is not offered again.
 */
export function applySetup(cfg: Config, s: WizardState, ctx: BuildContext): Config {
  const next = JSON.parse(JSON.stringify(cfg)) as Config;
  const made = s.panels.map((p) => buildScreen(p, ctx));
  next.screens = addsTo(cfg) ? [...next.screens, ...made] : made;
  if (s.location) next.location = { latitude: s.location.latitude, longitude: s.location.longitude, ...(s.location.name ? { name: s.location.name } : {}) };
  if (s.theme) next.theme = s.theme;
  next.setup = 'done';
  return next;
}

/** The panels already on screens of this config (by serial, trcc key or remote screen uid): offered as set up, not again. */
export function alreadyThere(cfg: Pick<Config, 'screens'>, p: Pick<PanelChoice, 'device'>): Screen | undefined {
  const d = p.device;
  return cfg.screens.find(
    (s) =>
      (d.driver === 'usb' && s.device.driver === 'usb' && !!d.serial && s.device.serial === d.serial) ||
      (d.driver === 'trcc' && s.device.driver === 'trcc' && !!d.deviceKey && s.device.deviceKey === d.deviceKey) ||
      (d.driver === 'remote' && s.device.driver === 'remote' && s.device.uid === d.uid),
  );
}

/**
 * A remote screen just paired (pairing put it in the config, key and all): as
 * a choice, so the wizard sets it up like the others; it keeps its pages.
 */
export function fromRemote(s: Screen): PanelChoice {
  const id = s.device.driver === 'remote' ? (s.device.id ?? s.device.uid) : s.name;
  return { id: `screen:${s.id}`, name: s.name, width: s.width, height: s.height, baseRotate: s.rotate, portrait: s.height > s.width, device: s.device, from: 'remote', detail: id, template: CURRENT, screen: s.id };
}

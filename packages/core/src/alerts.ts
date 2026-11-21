/**
 * Alerts: what must be seen from across the room. They come from three
 * places: plugins (a widget's or a source's `alerts`, asked again whenever
 * their data changes), outside (`POST /api/alerts`: a webhook, a script, a
 * Home Assistant automation) and the editor's "Test alert" of a screen.
 *
 * This file keeps the list and decides, per screen, which one takes the
 * panel over (`forScreen`); alert-paint.ts draws it and the runtime sends
 * it. Seen ("ack") and snoozed are remembered here: an alert a plugin keeps
 * returning stays hidden once seen, and shows again when its id changes.
 */
import { ALERT_LEVELS, localize, type Alert, type AlertLevel } from '@kiosko/sdk';
import { inQuietHours, screenAlerts, type Screen } from './config/model.ts';

export type AlertOrigin = 'widget' | 'source' | 'api' | 'test';

/** An alert as Kiosko keeps it: localized, with where it came from and since when. */
export interface ActiveAlert {
  /** `plugin/widget:id` or `plugin/source:id` for a plugin's, as posted for the API's, `test:<screen>` for a test. */
  id: string;
  level: AlertLevel;
  title: string;
  text: string;
  /** Who published it ("IGN", "NWS"), when the alert says. */
  source?: string;
  /** A second line, the authority's instruction, when the alert has one. */
  detail?: string;
  icon?: string;
  origin: AlertOrigin;
  /** The widget or source type that returned it. */
  from?: string;
  /** When Kiosko first saw it. */
  since: number;
  expiresAt: number | null;
  dismissible: boolean;
  /** Only on these screens (an API alert that says so, a test). Missing: all. */
  screens?: string[];
  /** Hidden until then (snoozed). */
  snoozedUntil?: number;
}

/** What takes a screen over: the highest alert, and how many more there are. */
export interface ShownAlert {
  top: ActiveAlert;
  more: number;
}

export class AlertError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

/** An id posted from outside: what fits in a URL and a log line. Plugins' ids get their type in front. */
export const EXTERNAL_ID = /^[A-Za-z0-9_.-]{1,80}$/;
const MAX_TITLE = 120;
const MAX_TEXT = 240;
const MAX_SOURCE = 40;
const MAX_DETAIL = 240;
/** How long the test alert of a screen lasts. */
export const TEST_ALERT_MS = 20_000;
/** Snoozing without saying for how long. */
export const DEFAULT_SNOOZE_MS = 10 * 60_000;

export const levelRank = (l: AlertLevel | 'off'): number => (l === 'off' ? Infinity : ALERT_LEVELS.indexOf(l));
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/** A text an alert may carry: a string or a `Localized` (an object with at least `en`). */
const isText = (x: unknown): boolean => typeof x === 'string' || (!!x && typeof x === 'object' && !Array.isArray(x) && typeof (x as { en?: unknown }).en === 'string');

function text(x: unknown, locale: string): string {
  if (typeof x === 'string') return oneLine(x);
  if (x && typeof x === 'object' && typeof (x as { en?: unknown }).en === 'string') return oneLine(localize(x as never, locale));
  return '';
}

/**
 * Checks an alert (from a plugin or posted) and makes it what is kept, or
 * says what is wrong with it. `ttlMs` counts from `now`.
 */
export function parseAlert(raw: unknown, now: number, locale: string): Omit<ActiveAlert, 'id' | 'origin' | 'since'> & { id: string } {
  if (!raw || typeof raw !== 'object') throw new AlertError('an alert is an object', 'badAlert');
  const a = raw as Partial<Alert> & { screens?: unknown };
  const id = typeof a.id === 'string' ? a.id.trim() : '';
  if (!id || id.length > 120) throw new AlertError('an alert needs an id', 'badAlert');
  if (!ALERT_LEVELS.includes(a.level as AlertLevel)) throw new AlertError(`level must be one of ${ALERT_LEVELS.join(', ')}`, 'badAlert');
  const title = clip(text(a.title, locale), MAX_TITLE);
  if (!title) throw new AlertError('an alert needs a title', 'badAlert');
  const expiresAt = typeof a.expiresAt === 'number' && Number.isFinite(a.expiresAt) ? a.expiresAt : typeof a.ttlMs === 'number' && a.ttlMs > 0 ? now + a.ttlMs : null;
  const icon = typeof a.icon === 'string' && a.icon.trim() ? a.icon.trim().slice(0, 40) : undefined;
  const source = clip(text(a.source, locale), MAX_SOURCE);
  const detail = clip(text(a.detail, locale), MAX_DETAIL);
  return {
    id,
    level: a.level as AlertLevel,
    title,
    text: clip(text(a.text, locale), MAX_TEXT),
    ...(source ? { source } : {}),
    ...(detail ? { detail } : {}),
    ...(icon ? { icon } : {}),
    expiresAt,
    dismissible: a.dismissible !== false,
  };
}

/** Highest level first, then the newest. */
const order = (a: ActiveAlert, b: ActiveAlert) => levelRank(b.level) - levelRank(a.level) || b.since - a.since;

/** A plugin's alert as it comes, with where it came from. */
export interface PluginAlert {
  alert: Alert;
  origin: 'widget' | 'source';
  /** The widget or source type. */
  from: string;
}

export class AlertBoard {
  /** From plugins: rebuilt by `sync`. */
  private fromPlugins = new Map<string, ActiveAlert>();
  /** Posted from outside, and tests: until seen, removed or expired. */
  private posted = new Map<string, ActiveAlert>();
  /** Plugin alerts seen: hidden while the plugin keeps returning them. */
  private seen = new Set<string>();
  private snoozed = new Map<string, number>();
  private readonly log: (msg: string) => void;
  constructor(log: (msg: string) => void = () => undefined) {
    this.log = log;
  }

  /**
   * What the plugins return now. A plugin's alert keeps the `since` (and the
   * `expiresAt` of its `ttlMs`) of when it first came; one that is no longer
   * returned is gone, and so is its "seen".
   */
  sync(list: PluginAlert[], now: number, locale: string): void {
    const next = new Map<string, ActiveAlert>();
    for (const { alert, origin, from } of list) {
      let a;
      try {
        a = parseAlert(alert, now, locale);
      } catch (err) {
        this.log(`${from}: alert ignored: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      const id = `${from}:${a.id}`;
      if (next.has(id)) continue;
      const prev = this.fromPlugins.get(id);
      next.set(id, { ...a, id, origin, from, since: prev?.since ?? now, expiresAt: alert.expiresAt !== undefined ? a.expiresAt : prev?.expiresAt ?? a.expiresAt });
    }
    for (const id of this.fromPlugins.keys()) {
      if (next.has(id)) continue;
      this.seen.delete(id);
      this.snoozed.delete(id);
    }
    this.fromPlugins = next;
  }

  /** An alert from outside (`POST /api/alerts`). The same id again replaces it, and it shows again. */
  post(raw: unknown, now: number, locale: string, screenIds: readonly string[] = []): ActiveAlert {
    const body = raw && typeof raw === 'object' ? { ...(raw as object) } : raw;
    if (body && typeof body === 'object' && !(body as { id?: unknown }).id) (body as { id: string }).id = `alert-${now.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
    // From outside, a wrong type is said rather than dropped (a plugin's just loses the field).
    for (const k of ['source', 'detail'] as const) {
      const v = body && typeof body === 'object' ? (body as Record<string, unknown>)[k] : undefined;
      if (v !== undefined && v !== null && !isText(v)) throw new AlertError(`${k} is a text, or an object of texts by language with at least "en"`, 'badAlert');
    }
    const a = parseAlert(body, now, locale);
    if (!EXTERNAL_ID.test(a.id)) throw new AlertError('the id may have only letters, digits, ".", "_" and "-" (up to 80)', 'badAlert');
    const screens = (raw as { screens?: unknown }).screens;
    let only: string[] | undefined;
    if (screens !== undefined) {
      if (!Array.isArray(screens) || !screens.every((s) => typeof s === 'string')) throw new AlertError('screens is a list of screen ids', 'badAlert');
      only = screens.filter((s) => screenIds.includes(s));
      if (!only.length) throw new AlertError('none of those screens exists', 'badAlert');
    }
    const kept: ActiveAlert = { ...a, origin: 'api', since: now, ...(only ? { screens: only } : {}) };
    this.posted.set(a.id, kept);
    this.snoozed.delete(a.id);
    return kept;
  }

  /** The test alert of a screen: shown there whatever its settings, for `TEST_ALERT_MS`. */
  test(screen: Pick<Screen, 'id' | 'name'>, level: AlertLevel, now: number, words: { title: string; text: string }): ActiveAlert {
    const id = `test:${screen.id}`;
    const a: ActiveAlert = { id, level, title: words.title, text: words.text, icon: level === 'info' ? 'info' : 'triangle-alert', origin: 'test', since: now, expiresAt: now + TEST_ALERT_MS, dismissible: true, screens: [screen.id] };
    this.posted.set(id, a);
    this.snoozed.delete(id);
    return a;
  }

  private find(id: string): ActiveAlert | undefined {
    return this.posted.get(id) ?? this.fromPlugins.get(id);
  }

  /** "Seen": a posted one is gone, a plugin's is hidden while the plugin returns it. */
  ack(id: string): 'ok' | 'unknown' | 'notDismissible' {
    const a = this.find(id);
    if (!a) return 'unknown';
    if (!a.dismissible) return 'notDismissible';
    if (this.posted.delete(id)) this.snoozed.delete(id);
    else this.seen.add(id);
    return 'ok';
  }

  /** Every alert that can be, seen at once (Home Assistant's button). How many. */
  ackAll(now: number): number {
    let n = 0;
    for (const a of this.list(now)) if (a.dismissible && this.ack(a.id) === 'ok') n++;
    return n;
  }

  /** Hidden for `ms`, then back (if still there). */
  snooze(id: string, ms: number, now: number): 'ok' | 'unknown' | 'notDismissible' {
    const a = this.find(id);
    if (!a || this.seen.has(id)) return 'unknown';
    if (!a.dismissible) return 'notDismissible';
    this.snoozed.set(id, now + Math.max(60_000, Math.min(24 * 3600_000, ms)));
    return 'ok';
  }

  /** Takes a posted alert away (its cause is over). */
  remove(id: string): boolean {
    this.snoozed.delete(id);
    return this.posted.delete(id);
  }

  /** Drops what has expired. */
  prune(now: number): void {
    for (const [id, a] of this.posted) if (a.expiresAt !== null && a.expiresAt <= now) this.posted.delete(id);
    for (const [id, until] of this.snoozed) if (until <= now) this.snoozed.delete(id);
  }

  /** Every alert not seen nor expired, the snoozed ones too (with `snoozedUntil`), highest first. */
  list(now: number): ActiveAlert[] {
    const out: ActiveAlert[] = [];
    for (const a of [...this.posted.values(), ...this.fromPlugins.values()]) {
      if (this.seen.has(a.id) || (a.expiresAt !== null && a.expiresAt <= now)) continue;
      const until = this.snoozed.get(a.id);
      out.push(until && until > now ? { ...a, snoozedUntil: until } : a);
    }
    return out.sort(order);
  }

  /**
   * The alert that takes `screen` over now, if any: the highest of those its
   * settings let through (level, quiet hours; only `critical` while `off`),
   * with the count of the others. Its test alert always does.
   */
  forScreen(screen: Pick<Screen, 'id' | 'alerts'>, now: number, off = false): ShownAlert | null {
    const cfg = screenAlerts(screen);
    const onlyCritical = off || inQuietHours(cfg.quiet, now);
    const min = Math.max(levelRank(cfg.minLevel), onlyCritical ? levelRank('critical') : 0);
    const here = this.list(now).filter((a) => !a.snoozedUntil && (!a.screens || a.screens.includes(screen.id)) && (a.origin === 'test' || levelRank(a.level) >= min));
    return here.length ? { top: here[0]!, more: here.length - 1 } : null;
  }
}

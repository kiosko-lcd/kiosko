/**
 * Source profiles: several named configurations of one shared source (news
 * «General», «Technology», «Sports»; two GitHub accounts), each with its own
 * options and read on its own, as if it were another source. Only for
 * sources that declare `profiles: true` (see `SourceDefinition.profiles`).
 *
 *   sources["news/deck"]                  the default profile, as always
 *   sourceProfiles["news/deck"]["tech"]   { name: "Technology", options: { … } }
 *   widget.profile = "tech"               the widget reads that one
 *
 * At run time each profile is a source of its own, addressed by its key:
 * `news/deck` for the default one, `news/deck#tech` for the others. A widget
 * still finds the data under `ctx.sources["news/deck"]`: Kiosko picks the
 * key from the widget's `profile`. A config without `sourceProfiles` works
 * exactly as before: every key is the bare type.
 *
 * Pure (no Node, no SDK runtime): the editor uses it too.
 */
import type { Config, Screen, SourceProfile, Tile, WidgetInstance } from './model.ts';

/** Between the source type and the profile id in a source key: `news/deck#tech`. */
export const PROFILE_SEP = '#';

/** A profile id: short, lowercase, safe in a key, a URL and a file name. */
export const PROFILE_ID_PATTERN = '^[a-z0-9][a-z0-9_-]{0,39}$';
const PROFILE_ID_RE = new RegExp(PROFILE_ID_PATTERN);
export const isProfileId = (id: unknown): id is string => typeof id === 'string' && PROFILE_ID_RE.test(id);

/** What Kiosko needs to know of a source to resolve profiles: whether it accepts them. */
export interface ProfileAware {
  profiles?: boolean;
}

/** Whether a source accepts profiles: only those that say so. */
export const acceptsProfiles = (def: ProfileAware | undefined): boolean => def?.profiles === true;

/** The key a profile of a source runs under: the bare type for the default one. */
export function sourceKey(type: string, profile?: string | null): string {
  return profile ? `${type}${PROFILE_SEP}${profile}` : type;
}

/** The type and the profile (null: the default one) of a source key. */
export function parseSourceKey(key: string): { type: string; profile: string | null } {
  const i = key.indexOf(PROFILE_SEP);
  return i < 0 ? { type: key, profile: null } : { type: key.slice(0, i), profile: key.slice(i + 1) || null };
}

/** The profiles of a source besides the default one (maybe none), by id. */
export function profilesOf(cfg: Pick<Config, 'sourceProfiles'>, type: string): Record<string, SourceProfile> {
  return cfg.sourceProfiles?.[type] ?? {};
}

/**
 * The key a widget with `profile` reads `type` under: that profile's when the
 * source accepts profiles and the config has it, else the default one. A
 * deleted profile falls back to the default: the tile keeps showing something.
 */
export function resolveSourceKey(cfg: Pick<Config, 'sourceProfiles'>, type: string, profile: string | null | undefined, def: ProfileAware | undefined): string {
  if (!profile || !acceptsProfiles(def) || !Object.hasOwn(profilesOf(cfg, type), profile)) return type;
  return sourceKey(type, profile);
}

/** The keys of the sources a widget (or interlude) reads, by type. */
export function sourceKeysOf(cfg: Pick<Config, 'sourceProfiles'>, types: readonly string[] | undefined, profile: string | null | undefined, source: (type: string) => ProfileAware | undefined): [type: string, key: string][] {
  return (types ?? []).map((t) => [t, resolveSourceKey(cfg, t, profile, source(t))]);
}

/** The options a source key runs with, as the user wrote them (validated later). */
export function sourceOptionsOf(cfg: Pick<Config, 'sources' | 'sourceProfiles'>, key: string): Record<string, unknown> {
  const { type, profile } = parseSourceKey(key);
  if (!profile) return cfg.sources[type] ?? {};
  return profilesOf(cfg, type)[profile]?.options ?? {};
}

/**
 * A new profile id from its name: `Tecnología` → `tecnologia`, `tecnologia-2`
 * if taken. Ids never change after: renaming a profile changes its name only.
 */
export function newProfileId(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base =
    name
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'profile';
  let id = base;
  for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
  return id;
}

/** Where a widget instance is, for "used by" lists. */
export interface ProfileUse {
  screen: Screen;
  pageId: string;
  tile: Tile;
  widget: WidgetInstance;
}

/**
 * The widgets that read `type` under profile `id`: those whose `profile` is
 * `id` and whose definition reads the source (`readsSource(widget.type)`).
 */
export function profileUsers(cfg: Pick<Config, 'screens'>, id: string, readsSource: (widgetType: string) => boolean): ProfileUse[] {
  const out: ProfileUse[] = [];
  for (const screen of cfg.screens)
    for (const page of screen.pages)
      for (const tile of page.tiles)
        for (const widget of tile.widgets) if (widget.profile === id && readsSource(widget.type)) out.push({ screen, pageId: page.id, tile, widget });
  return out;
}

/**
 * Removes a profile from a config being edited (in place) and sends the
 * widgets that read it back to the default one. Returns how many it moved.
 */
export function deleteProfile(cfg: Config, type: string, id: string, readsSource: (widgetType: string) => boolean): number {
  const users = profileUsers(cfg, id, readsSource);
  for (const u of users) delete u.widget.profile;
  const list = cfg.sourceProfiles?.[type];
  if (list) {
    delete list[id];
    if (!Object.keys(list).length) delete cfg.sourceProfiles![type];
    if (!Object.keys(cfg.sourceProfiles!).length) delete cfg.sourceProfiles;
  }
  return users.length;
}

/** Cleans what was read from disk: profiles with a valid id, a name and options; empty lists dropped. Undefined when there are none. */
export function normalizeProfiles(raw: unknown): Config['sourceProfiles'] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: NonNullable<Config['sourceProfiles']> = {};
  for (const [type, list] of Object.entries(raw as Record<string, unknown>)) {
    if (!list || typeof list !== 'object' || Array.isArray(list)) continue;
    const clean: Record<string, SourceProfile> = {};
    for (const [id, p] of Object.entries(list as Record<string, unknown>)) {
      if (!isProfileId(id) || !p || typeof p !== 'object' || Array.isArray(p)) continue;
      const { name, options } = p as Partial<SourceProfile>;
      clean[id] = { name: typeof name === 'string' && name.trim() ? name : id, options: options && typeof options === 'object' && !Array.isArray(options) ? options : {} };
    }
    if (Object.keys(clean).length) out[type] = clean;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * The plugin store's catalogue, as published at https://kioskolcd.dev/store/v1/
 * (index.json, plugins/<id>.json, withdrawn.json) and read by the editor.
 * Its JSON Schema is packages/core/schema/store-index.json; the plan is
 * docs/es/tienda.md. What the author says comes from each plugin's
 * kiosko-manifest.json; what the store says (tier, badges, popularity,
 * what fits where) is worked out when the index is built.
 */
import type { Permissions, Platform } from '@kiosko/sdk';

/** A text by language tag; `en` is always there. */
export type Texts = { en: string } & Record<string, string>;

/** The shapes of panel a widget may be painted on, from PANEL_PRESETS. */
export type PanelClassId = 'bar' | 'landscape' | 'square' | 'round' | 'portrait';
export const PANEL_CLASSES: readonly PanelClassId[] = ['bar', 'landscape', 'square', 'round', 'portrait'];

/**
 * How far a plugin is trusted: `official` (kept by Kiosko), `verified` and
 * `listed` (phase 2, from kiosko-lcd/plugin-index), `found` (only found on
 * npm by its keyword: nobody from Kiosko has looked at it).
 */
export type Tier = 'official' | 'verified' | 'listed' | 'found';
export type Badge = 'official' | 'verified' | 'popular' | 'rising' | 'new' | 'tested' | 'bundled' | 'provenance';

export interface StoreRelease {
  version: string;
  /** When it was published (npm's `time`). */
  date: string;
  /** npm's `dist.integrity` (SHA-512): what an install from the store is checked against. */
  integrity: string;
  /** Plugin API range it declares (`kiosko.sdk`). */
  sdk?: string;
  platforms?: Platform[];
  /** npm has a provenance attestation for it (published from CI). */
  provenance?: { repository?: string; workflow?: string };
  /** `npm deprecate`'s message. */
  deprecated?: string;
  /** On the store's list of withdrawn versions. */
  withdrawn?: boolean;
  /** What it declares doing that the release before it didn't (when both manifests are known). */
  addedPermissions?: Permissions;
}

export interface StoreWidget {
  type: string;
  name: Texts;
  description?: Texts;
  icon?: string;
  category?: string;
  min?: { w: number; h: number };
  preferred?: { w: number; h: number };
  /** The panel classes where its minimum size fits. */
  fits?: PanelClassId[];
  /** The ones where its preferred size fits too. */
  ideal?: PanelClassId[];
  /** PANEL_PRESETS ids where it fits as the panel is sold (not turned). */
  presets?: string[];
  animated?: boolean;
  /** A picture, by language tag (`en` first), as a path from the site's root (`gallery/img/weather-forecast.png`). */
  shots?: Record<string, string>;
  /** Its size. */
  shotSize?: { w: number; h: number };
}

export interface StorePlugin {
  id: string;
  package: string;
  name: Texts;
  description?: Texts;
  icon?: string;
  tier: Tier;
  badges: Badge[];
  publisher?: { name?: string; npm?: string[]; github?: string; verified?: boolean };
  /** SPDX expression, or UNLICENSED; `''` when it says none. */
  license: string;
  /** For the licence filter (licenses.ts). */
  licenseKind?: 'permissive' | 'copyleft' | 'other';
  links: { repository?: string; homepage?: string; issues?: string; discussions?: string; docs?: string; funding?: string; npm?: string };
  /** Installed with Kiosko (server/src/official.ts). */
  bundled?: boolean;
  latest: string;
  /** Stable releases, newest first, at most 20. */
  releases: StoreRelease[];
  platforms: Platform[];
  languages: string[];
  categories: string[];
  tags: string[];
  markets?: { only?: string[]; without?: string[]; note?: Texts };
  pricing: { model: 'free' | 'paid' | 'freemium' };
  permissions: Permissions;
  /** How many of its options make it act for the user (run, connect, read) or keep a secret. */
  riskyOptions: number;
  /** Plugin ids it needs, and uses when they are there. */
  requires: string[];
  optional: string[];
  resources?: { memoryMb?: number; cpu?: 'low' | 'medium' | 'high' };
  widgets: StoreWidget[];
  interludes: { type: string; name: Texts; description?: Texts; icon?: string; poster?: string; video?: string }[];
  /** A picture for its card when it has no widget pictures (an interlude's poster, its docs/), from the site's root. */
  cover?: string;
  templates: { id: string; name: Texts; layouts: ('wide' | 'square' | 'tall')[] }[];
  /** Phase 1: npm downloads only, never a score. */
  popularity?: { weekly?: number; stars?: number };
  health: {
    lastRelease?: string;
    archived?: boolean;
    openIssues?: number;
    /** Where its record came from: its npm package, its repository (an official whose package predates the manifest), or nowhere. */
    manifest: 'ok' | 'repository' | 'missing' | 'invalid';
    problems?: string[];
  };
  /** Taken out of the store (an id that steals another's, a manifest that lies). */
  hidden?: boolean;
}

export interface StoreIndex {
  schema: 1;
  generatedAt: string;
  kiosko?: { latest?: string; sdk?: string };
  categories?: { id: string; label: Texts }[];
  /** The panel models widgets are matched against (PANEL_PRESETS), for "fits on" by model. */
  presets?: { id: string; name: string; width: number; height: number; shape?: 'rect' | 'round' }[];
  plugins: StorePlugin[];
}

/** plugins/<id>.json: the card, plus what only its page needs. */
export interface StorePluginFile {
  schema: 1;
  generatedAt: string;
  plugin: StorePlugin;
  /** Its options that act for the user, with their paths (`weather/current: url`). */
  riskyOptions: { path: string; risk: string[]; secret: boolean }[];
  /** Data sources it brings. */
  sources: { type: string; name: Texts; description?: Texts }[];
}

export interface WithdrawnEntry {
  package: string;
  /** An npm range (`>=1.2.0 <1.2.3`). */
  versions: string;
  integrity?: string[];
  severity: 'warn' | 'disable';
  reason: Texts;
  advisory?: string;
  date: string;
}

export interface Withdrawn {
  schema: 1;
  generatedAt: string;
  entries: WithdrawnEntry[];
}

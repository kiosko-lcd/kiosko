/**
 * The config of a first run, made before anyone opens the editor: a screen
 * for each panel found (its model's size, its firmware's angle), each with a
 * page of what works with nothing to set up (core's starterPage), so the
 * panels light up and come alive at once. With no panel found, one virtual
 * screen, as before. It is marked `setup: pending`: the panels show how to
 * open the editor (welcome.ts), and the editor offers its setup wizard,
 * which starts from these screens.
 */
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { localize, type Localized } from '@kiosko/sdk';
import { PANEL_PRESETS, STARTER_NAMES, newPage, newScreen, newTile, newWidget, normalize, starterInterludes, starterPage, type Config, type DeviceConfig, type Registry, type Rotation, type Screen } from '@kiosko/core';
import type { Discovered } from './server.ts';

/** A panel found at the first start, as its screen will be. */
export interface StarterPanel {
  name: string;
  width: number;
  height: number;
  rotate: Rotation;
  device: DeviceConfig;
}

const ROTATIONS: readonly number[] = [0, 90, 180, 270];

/**
 * The panels "Detect panels" found, as screens to make: named after their
 * model (told apart with a number when several are the same), at the size
 * they report (a Trofeo Vision 9.16 when one held by another program can't
 * say) and their firmware's angle.
 */
export function starterPanels(found: Discovered, trccUrl = 'http://127.0.0.1:8099'): StarterPanel[] {
  const out: StarterPanel[] = [];
  const named = (width: number, height: number) => {
    const base = PANEL_PRESETS.find((p) => (p.width === width && p.height === height) || (p.width === height && p.height === width))?.name ?? `${width}×${height}`;
    const same = out.filter((p) => p.name === base || p.name.startsWith(`${base} `)).length;
    if (same === 1) out.find((p) => p.name === base)!.name = `${base} 1`;
    return same ? `${base} ${same + 1}` : base;
  };
  for (const u of found.usb) {
    const width = u.width || 1920;
    const height = u.height || 462;
    out.push({ name: named(width, height), width, height, rotate: (ROTATIONS.includes(u.rotate ?? 0) ? (u.rotate ?? 0) : 0) as Rotation, device: { driver: 'usb', ...(u.serial ? { serial: u.serial } : {}) } });
  }
  for (const t of found.trcc) out.push({ name: named(t.width, t.height), width: t.width, height: t.height, rotate: 0, device: { driver: 'trcc', url: trccUrl, deviceKey: t.key } });
  return out;
}

/**
 * Whether AI agents have been used on this machine, as the agents plugin
 * reads them: its hook's session files, or the agents' own logs it reads
 * (Codex, Qwen Code, Kimi). Only then does the first page lead with them.
 */
export function agentTraces(env: NodeJS.ProcessEnv = process.env, home = homedir()): boolean {
  const dirs = [env.AGENT_SESSIONS_DIR ?? join(env.AIMONITOR_DIR ?? join(home, '.aimonitor'), 'sessions'), join(home, '.codex', 'sessions'), join(home, '.qwen', 'projects'), join(home, '.kimi', 'sessions')];
  return dirs.some((d) => {
    try {
      return existsSync(d) && readdirSync(d).length > 0;
    } catch {
      return false;
    }
  });
}

const CATS_PAGE: Localized = { en: 'Cats room', es: 'Sala de los gatos', de: 'Katzenzimmer', 'zh-Hant': '貓咪房間', 'zh-Hans': '猫咪房间' };

export function starterConfig(
  registry: Registry,
  o: {
    width?: number;
    height?: number;
    locale?: string;
    /** The panels found: a screen for each. None: one virtual screen of `width×height`. */
    panels?: StarterPanel[];
    /** Agents have been used here (`agentTraces`): the agents and the cats room lead. Default: if installed. */
    agents?: boolean;
    /** The weather can be had (a place is known). Default: if installed. */
    weather?: boolean;
  } = {},
): Config {
  const locale = o.locale ?? 'en';
  const has = (t: string) => !!registry.widget(t);
  const one = (name: string, width: number, height: number, device?: DeviceConfig, rotate: Rotation = 0): Screen => {
    const screen = newScreen(name, width, height, device);
    screen.rotate = rotate;
    screen.pages = [starterPage(has, { width, height, locale, agents: o.agents ?? true, weather: o.weather ?? true })];
    // Where agents are in use, the cats room too: a page of its own.
    if ((o.agents ?? true) && has('cats/room')) {
      const cats = newPage(localize(CATS_PAGE, locale), width, height);
      cats.tiles = [newTile({ x: 0, y: 0, w: cats.grid.cols, h: cats.grid.rows }, [newWidget('cats/room')])];
      cats.tiles[0]!.chrome = 'bare';
      screen.pages.push(cats);
    }
    screen.interludes = starterInterludes((t) => !!registry.interlude(t), locale);
    return screen;
  };
  const screens = o.panels?.length
    ? o.panels.map((p) => one(p.name, p.width, p.height, p.device, p.rotate))
    : [one(localize(STARTER_NAMES.screen as Localized, locale), o.width ?? 1920, o.height ?? 462)];
  return normalize({ screens, locale: 'auto', setup: 'pending' });
}

/**
 * Every plugin the browser demo carries, imported statically (there's no
 * plugins folder to scan in a browser): the built-in ones and the bundled
 * official ones, the same set a plain install of `kiosko` loads. The optional
 * ones (see server/src/official.ts) are offered on the Plugins page, as in a
 * real install.
 */
import type { PluginDefinition } from '@kiosko/sdk';
import agents from 'kiosko-plugin-agents';
import calendar from 'kiosko-plugin-calendar';
import calls from 'kiosko-plugin-calls';
import cats from 'kiosko-plugin-cats';
import github from 'kiosko-plugin-github';
import gitlab from 'kiosko-plugin-gitlab';
import gpu from 'kiosko-plugin-gpu';
import homeassistant from 'kiosko-plugin-homeassistant';
import llm from 'kiosko-plugin-llm';
import mirror from 'kiosko-plugin-mirror';
import news from 'kiosko-plugin-news';
import system from 'kiosko-plugin-system';
import timesheet from 'kiosko-plugin-timesheet';
import usage from 'kiosko-plugin-usage';
import vitals from 'kiosko-plugin-vitals';
import weather from 'kiosko-plugin-weather';
import { BUILTIN_PLUGINS, OFFICIAL_PLUGINS } from '../../server/src/builtin.ts';

export { OFFICIAL_PLUGINS };

const OFFICIAL: Record<string, PluginDefinition> = { agents, calendar, calls, cats, github, gitlab, gpu, homeassistant, llm, mirror, news, system, timesheet, usage, vitals, weather };

/** Built-in plugins first, then the official ones in the CLI's order. */
export function demoPlugins(): { def: PluginDefinition; origin: string }[] {
  return [
    ...BUILTIN_PLUGINS.map((def) => ({ def, origin: 'builtin' })),
    ...OFFICIAL_PLUGINS.flatMap((o) => (OFFICIAL[o.id] ? [{ def: OFFICIAL[o.id]!, origin: `npm:${o.npm}` }] : [])),
  ];
}

/** Bundled official plugins this file doesn't import (should be none: the demo check fails otherwise). The optional ones are only offered. */
export const MISSING_OFFICIAL = OFFICIAL_PLUGINS.filter((o) => o.bundled && !OFFICIAL[o.id]).map((o) => o.id);

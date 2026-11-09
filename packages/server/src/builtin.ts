/**
 * The plugins that ship with Tessera. Each lives in `plugins/<name>` and is
 * an ordinary plugin: the same contract as a third-party one.
 */
import type { PluginDefinition } from '@tessera/sdk';
import agents from '@tessera/plugin-agents';
import calendar from '@tessera/plugin-calendar';
import cats from '@tessera/plugin-cats';
import core from '@tessera/plugin-core';
import gitlab from '@tessera/plugin-gitlab';
import legacy from '@tessera/plugin-legacy';
import mirror from '@tessera/plugin-mirror';
import news from '@tessera/plugin-news';
import system from '@tessera/plugin-system';
import usage from '@tessera/plugin-usage';
import vitals from '@tessera/plugin-vitals';
import weather from '@tessera/plugin-weather';

export const BUILTIN_PLUGINS: PluginDefinition[] = [core, agents, cats, system, vitals, usage, weather, calendar, news, mirror, gitlab, legacy];

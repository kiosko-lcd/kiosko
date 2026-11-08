/**
 * Claude Code usage, read with `ccusage` from the local logs: the limit
 * windows of a subscription (or spend against caps on the API), today's
 * tokens by model and the spend of the last 5-hour blocks. Ported from the
 * aimonitor usage rail.
 */
import { definePlugin, defineSource, defineWidget, t } from '@tessera/sdk';
import { execRunner, readUsage, type UsageSnapshot } from './ccusage.ts';
import { USAGE_SOURCE, drawBlocks, drawRail, level, railRatios, usageOf } from './draw.ts';
import { usageMax } from './demo.ts';

export type { UsageSnapshot, UsageWindow, UsageSpend, BlockPoint } from './ccusage.ts';

export const ccusageSource = defineSource({
  id: 'ccusage',
  name: { en: 'Claude Code usage (ccusage)', es: 'Consumo de Claude Code (ccusage)' },
  description: {
    en: 'Runs ccusage every minute. Each run walks the whole Claude Code history (a few seconds of CPU).',
    es: 'Ejecuta ccusage cada minuto. Cada pasada recorre todo el historial de Claude Code (unos segundos de CPU).',
  },
  options: t.object({
    bin: t.string({
      default: 'ccusage',
      label: { en: 'ccusage command', es: 'Comando de ccusage' },
      help: { en: 'Looked up in PATH unless it is a full path. May carry arguments, e.g. "npx ccusage".', es: 'Se busca en el PATH salvo que sea una ruta completa. Puede llevar argumentos, p. ej. "npx ccusage".' },
    }),
    mode: t.enum(['max', 'api'] as const, {
      label: { en: 'Plan', es: 'Plan' },
      labels: { max: { en: 'Subscription: limit windows', es: 'Suscripción: ventanas de límite' }, api: { en: 'API: spend against caps', es: 'API: gasto contra topes' } },
    }),
    dailyCap: t.number({ default: 25, min: 0, step: 1, unit: 'USD', label: { en: 'Daily cap (API)', es: 'Tope diario (API)' } }),
    monthlyCap: t.number({ default: 400, min: 0, step: 10, unit: 'USD', label: { en: 'Monthly cap (API)', es: 'Tope mensual (API)' } }),
    calibration: t.object(
      {
        metric: t.enum(['cost', 'tokens'] as const, { label: { en: 'Measure', es: 'Medida' }, labels: { cost: { en: 'Equivalent cost', es: 'Coste equivalente' }, tokens: { en: 'Tokens', es: 'Tokens' } } }),
        lookbackDays: t.integer({ default: 30, min: 0, max: 365, label: { en: 'Days of history (0 = all)', es: 'Días de histórico (0 = todo)' } }),
        percentile: t.integer({ default: 100, min: 1, max: 100, slider: true, unit: '%', label: { en: 'Percentile that marks 100 %', es: 'Percentil que marca el 100 %' } }),
      },
      {
        advanced: true,
        label: { en: 'Calibration (subscription)', es: 'Calibración (suscripción)' },
        help: {
          en: 'ccusage doesn’t know your plan’s limit, so a full bar is your own busiest block or week.',
          es: 'ccusage no conoce el límite del plan, así que la barra llena es tu bloque o semana más cargados.',
        },
      },
    ),
  }),
  intervalMs: 60_000,
  read: (ctx): Promise<UsageSnapshot> => readUsage(ctx.options, execRunner(ctx.options.bin, ctx.signal), Date.now(), ctx.log),
  demo: ({ now }) => usageMax(now),
});

const thresholds = {
  warn: t.number({ default: 0.6, min: 0, max: 1, step: 0.05, slider: true, label: { en: 'Amber from', es: 'Ámbar desde' } }),
  alert: t.number({ default: 0.85, min: 0, max: 1, step: 0.05, slider: true, label: { en: 'Red from', es: 'Rojo desde' } }),
};

export const railWidget = defineWidget({
  id: 'rail',
  name: { en: 'Usage', es: 'Consumo' },
  description: {
    en: 'Limit windows (or spend against your caps) as bars with their reset time, and today’s tokens by model.',
    es: 'Las ventanas de límite (o el gasto contra tus topes) en barras con su reinicio, y los tokens de hoy por modelo.',
  },
  icon: 'gauge',
  category: 'agents',
  tags: ['claude', 'ccusage', 'tokens', 'cost'],
  size: { min: { w: 220, h: 200 }, preferred: { w: 380, h: 390 } },
  options: t.object({
    bars: t.integer({ default: 2, min: 1, max: 2, label: { en: 'Bars', es: 'Barras' } }),
    models: t.integer({ default: 3, min: 0, max: 8, label: { en: 'Models listed', es: 'Modelos listados' } }),
    ...thresholds,
  }),
  sources: [USAGE_SOURCE],
  redraw: 'minute',
  render(g, ctx) {
    drawRail(g, ctx, ctx.options);
  },
  // Ambient information: only worth lighting the panel for when a bar is in the red.
  idle: ({ sources, options }) => {
    const u = usageOf(sources);
    return !u || !railRatios(u).some((r) => level(r, options) === 'alert');
  },
  demo: ({ now }) => ({ sources: { [USAGE_SOURCE]: usageMax(now) } }),
});

export const blocksWidget = defineWidget({
  id: 'blocks',
  name: { en: 'Spend per 5-hour block', es: 'Gasto por bloque (5 h)' },
  description: {
    en: 'The equivalent cost of the last twelve 5-hour blocks, the running one highlighted: is today unusual?',
    es: 'El coste equivalente de los últimos doce bloques de 5 horas, con el actual destacado: ¿hoy es un día raro?',
  },
  icon: 'bar-chart',
  category: 'agents',
  tags: ['claude', 'ccusage', 'cost', 'sparkline'],
  size: { min: { w: 200, h: 100 }, preferred: { w: 600, h: 200 } },
  sources: [USAGE_SOURCE],
  render(g, ctx) {
    drawBlocks(g, ctx);
  },
  idle: () => true,
  demo: ({ now }) => ({ sources: { [USAGE_SOURCE]: usageMax(now) } }),
});

export default definePlugin({
  id: 'usage',
  name: { en: 'AI usage', es: 'Consumo de IA' },
  version: '0.1.0',
  description: {
    en: 'How much Claude Code you are burning, from ccusage: limit windows or spend, tokens by model, spend per block.',
    es: 'Cuánto Claude Code estás gastando, según ccusage: ventanas de límite o gasto, tokens por modelo y gasto por bloque.',
  },
  author: 'Tessera',
  license: 'MIT',
  icon: 'gauge',
  widgets: [railWidget, blocksWidget],
  sources: [ccusageSource],
});

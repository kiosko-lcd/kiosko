/**
 * The vitals column of aimonitor as a widget: CPU temperature, CPU, RAM and
 * disk figures, per-core bars and the disk fill. It reads the shared
 * `system/vitals` source (plugin `system`), so ten widgets about the CPU
 * don't each read /proc.
 */
import { definePlugin, defineWidget, t } from '@tessera/sdk';
import { drawVitals } from './draw.ts';
import { VITALS_SOURCE, anyAlert, type Vitals } from './vitals.ts';

export type { Vitals } from './vitals.ts';

/**
 * Fixed vitals for the gallery. The disk is at 91 % on purpose: the only
 * vital lit, to check at a glance that the column lights up only when
 * something is out of range.
 */
export const DEMO_VITALS: Vitals = {
  cpuTemp: 71,
  cpuUsage: 0.23,
  cores: [0.62, 0.18, 0.41, 0.07, 0.93, 0.12, 0.05, 0.33, 0.28, 0.02, 0.51, 0.09, 0.16, 0.04, 0.71, 0.11],
  load: 0.23,
  mem: { used: 26 * 1024 ** 3, total: 62 * 1024 ** 3 },
  disk: { used: 240 * 1024 ** 3, total: 265 * 1024 ** 3, path: '/data' },
  uptime: 836 * 3600,
};

export const vitalsWidget = defineWidget({
  id: 'vitals',
  name: { en: 'System vitals', es: 'Vitales del sistema' },
  description: {
    en: 'CPU temperature, CPU, RAM and disk in dim ink that only turns amber or red past your thresholds; per-core bars when wide.',
    es: 'Temperatura de CPU, CPU, RAM y disco en tinta apagada que solo se vuelve ámbar o roja al pasar tus umbrales; barras por núcleo si hay ancho.',
  },
  icon: 'cpu',
  category: 'system',
  tags: ['cpu', 'ram', 'disk', 'temperature'],
  size: { min: { w: 200, h: 160 }, preferred: { w: 600, h: 390 } },
  options: t.object({
    warn: t.number({ default: 0.85, min: 0, max: 1, step: 0.05, slider: true, label: { en: 'Amber from (CPU, RAM, disk)', es: 'Ámbar desde (CPU, RAM, disco)' } }),
    alert: t.number({ default: 0.95, min: 0, max: 1, step: 0.05, slider: true, label: { en: 'Red from (CPU, RAM, disk)', es: 'Rojo desde (CPU, RAM, disco)' } }),
    tempWarn: t.integer({ default: 85, min: 30, max: 120, unit: '°C', label: { en: 'Amber temperature', es: 'Temperatura ámbar' } }),
    tempAlert: t.integer({ default: 95, min: 30, max: 120, unit: '°C', label: { en: 'Red temperature', es: 'Temperatura roja' } }),
    cores: t.boolean({ default: true, label: { en: 'Per-core bars', es: 'Barras por núcleo' } }),
    perCoreMinWidth: t.integer({ default: 420, min: 150, max: 2000, unit: 'px', advanced: true, label: { en: 'Per-core bars from this width', es: 'Barras por núcleo a partir de este ancho' } }),
    disk: t.boolean({ default: true, label: { en: 'Disk bar', es: 'Barra del disco' } }),
  }),
  sources: [VITALS_SOURCE],
  render(g, ctx) {
    drawVitals(g, ctx, ctx.options);
  },
  // Dim by design: only a vital in the red is worth lighting the panel for.
  idle: ({ sources, options }) => !anyAlert(sources[VITALS_SOURCE] as Vitals | undefined, options),
  demo: () => ({ sources: { [VITALS_SOURCE]: DEMO_VITALS } }),
});

export default definePlugin({
  id: 'vitals',
  name: { en: 'Vitals', es: 'Vitales' },
  version: '0.1.0',
  description: {
    en: 'The machine at a glance, quiet until something runs hot or fills up. Needs the system vitals source.',
    es: 'La máquina de un vistazo, callada hasta que algo se calienta o se llena. Necesita la fuente de vitales del sistema.',
  },
  author: 'Tessera',
  license: 'MIT',
  icon: 'cpu',
  widgets: [vitalsWidget],
});

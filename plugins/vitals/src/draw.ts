/**
 * The vitals column of the original dashboard: big figures, per-core bars
 * when there is width, and the disk fill.
 *
 * All the ink is dim while things are fine: what must claim attention is a
 * blocked session, not the disk. Amber or red appear only past the
 * thresholds, and then they do compete, which is exactly the point.
 */
import type { Graphics, Localized, RenderContext, ThemeColors } from '@tessera/sdk';
import { diskRatio, gigabytes, percent, statsOf, vitalLevel, vitalsOf, type Level, type VitalThresholds } from './vitals.ts';

type Ctx = Pick<RenderContext<unknown, unknown>, 'box' | 'theme' | 'kit' | 't' | 'sources'>;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export const TEXT = {
  temp: { en: 'cpu temp', es: 'temp cpu' },
  tempShort: { en: 'temp', es: 'temp' },
  cpu: { en: 'cpu', es: 'cpu' },
  ram: { en: 'ram', es: 'ram' },
  disk: { en: 'disk', es: 'disco' },
  cores: { en: '{n} cores', es: '{n} núcleos' },
  diskBar: { en: 'Disk {path}', es: 'Disco {path}' },
  diskNote: { en: '{used} of {total} · {free} free', es: '{used} de {total} · quedan {free}' },
  noData: { en: 'no system data (needs the system vitals source)', es: 'sin datos del sistema (necesita la fuente de vitales)' },
} satisfies Record<string, Localized>;

const fill = (text: string, vars: Record<string, string | number>) => text.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ''));

export function levelColor(l: Level, c: ThemeColors): string {
  return l === 'alert' ? c.alert : l === 'warn' ? c.warn : c.inkDim;
}

export interface VitalsOptions extends VitalThresholds {
  perCoreMinWidth: number;
  cores: boolean;
  disk: boolean;
}

/** Height a bar takes, with and without its note, at scale 1 (label baseline to next baseline). */
const BAR_SLOT = 68;
const BAR_SLOT_WITH_NOTE = 82;

export function drawVitals(g: Graphics, ctx: Ctx, o: VitalsOptions): void {
  const { box, kit, theme, t } = ctx;
  const c = theme.colors;
  const f = theme.fonts;
  const s = clamp(Math.min(box.h / 300, box.w / 300), 0.55, 1.5);
  const v = vitalsOf(ctx.sources);
  if (!v) {
    const q = { size: Math.max(10, Math.round(15 * s)), family: f.mono, color: c.inkFaint };
    kit.drawClipped(g, t(TEXT.noData), box.x, box.y + q.size * 1.2, box.w, q);
    return;
  }
  const { x, y, w, h } = box;
  const narrow = w < 380 * s;
  const wide = w >= o.perCoreMinWidth * s;

  // 1. Figures, in a row (two per row when narrow).
  const stats = statsOf(v, o);
  const perRow = narrow ? 2 : Math.max(1, Math.min(4, stats.length));
  const statSize = Math.round((wide ? 40 : narrow ? 26 : 32) * s);
  const colW = w / perRow;
  const labelOpts = { size: Math.max(9, Math.round(13 * s)), family: f.sansBold, tracking: 2.4 * s, smallCaps: true, color: c.inkFaint };
  let statsBottom = y;
  stats.forEach((st, i) => {
    const row = Math.floor(i / perRow);
    const baseline = y + statSize * 0.78 + 4 * s + row * (statSize + 30 * s);
    if (baseline + 17 * s > y + h) return;
    const sx = x + (i % perRow) * colW;
    kit.drawClipped(g, st.value, sx, baseline, colW - 6 * s, { size: statSize, family: f.monoBold, color: levelColor(st.level, c), tracking: -0.5 * s });
    const label = st.key === 'temp' ? (narrow ? TEXT.tempShort : TEXT.temp) : TEXT[st.key];
    kit.drawClipped(g, t(label), sx, baseline + 17 * s, colW - 6 * s, labelOpts);
    statsBottom = Math.max(statsBottom, baseline + 24 * s);
  });

  // 2. Per-core bars, only with width to spare and a delta to show (the
  //    first reading has none), then the disk bar if it still fits.
  const bottom = y + h;
  let top = statsBottom + 16 * s;
  const ratio = diskRatio(v);
  const diskWanted = o.disk && ratio !== null;
  const diskNeed = (withNote: boolean) => ((withNote ? BAR_SLOT_WITH_NOTE : BAR_SLOT) - 20) * s + 14 * s;
  const cores = o.cores && wide ? (v.cores ?? []) : [];
  if (cores.length) {
    // A bounded band: an idle machine is sixteen almost empty lanes, and
    // stretching them to the full height trades black for grey for nothing.
    const reserve = diskWanted && bottom - top - 30 * s >= diskNeed(false) + 20 * s ? diskNeed(bottom - top - 30 * s >= diskNeed(true) + 20 * s) + 20 * s : 0;
    const coresH = Math.min(130 * s, bottom - top - reserve);
    if (coresH >= 30 * s) {
      // On the right: under the first figure there is already its own label.
      kit.drawTracked(g, fill(t(TEXT.cores), { n: cores.length }), x + w, top - 6 * s, { size: Math.max(9, Math.round(14 * s)), family: f.sansBold, tracking: 2.4 * s, smallCaps: true, color: c.inkFaint, align: 'right' });
      const barsTop = top + 6 * s;
      const barsH = coresH - 6 * s;
      // Absolute scale against 100 %: normalising to the busiest core would
      // make an idle machine look saturated.
      for (const bar of kit.sparkBars(cores, w, barsH, { gap: Math.max(1, Math.round(3 * s)), max: 1 })) {
        g.fillStyle = c.bg;
        g.fillRect(x + bar.x, barsTop, bar.w, barsH);
        g.fillStyle = levelColor(vitalLevel(cores[bar.index] ?? 0, o), c);
        g.fillRect(x + bar.x, barsTop + bar.y, bar.w, bar.h);
      }
      top = barsTop + barsH + 20 * s;
    }
  }

  // 3. Disk: its fill is nowhere else, and it is the vital that bites first.
  if (diskWanted && v.disk) {
    const bandTop = top + 14 * s;
    if (bandTop - 14 * s + diskNeed(false) <= bottom) {
      const note = bandTop - 14 * s + diskNeed(true) <= bottom ? fill(t(TEXT.diskNote), { used: gigabytes(v.disk.used), total: gigabytes(v.disk.total), free: gigabytes(Math.max(0, v.disk.total - v.disk.used)) }) : null;
      drawBar(g, ctx, x, bandTop, w, fill(t(TEXT.diskBar), { path: v.disk.path }), percent(ratio!), ratio!, note, levelColor(vitalLevel(ratio!, o), c), s);
    }
  }
}

function drawBar(g: Graphics, ctx: Ctx, x: number, y: number, w: number, label: string, right: string, ratio: number, note: string | null, color: string, s: number): void {
  const { kit, theme } = ctx;
  const c = theme.colors;
  const rw = kit.drawTracked(g, right, x + w, y, { size: Math.round(20 * s), family: theme.fonts.monoBold, color, align: 'right' });
  kit.drawClipped(g, label, x, y, Math.max(0, w - rw - 10 * s), { size: Math.round(18 * s), family: theme.fonts.sansBold, tracking: 3 * s, smallCaps: true, color: c.inkDim });
  const barY = Math.round(y + 12 * s);
  const barH = Math.round(16 * s);
  g.fillStyle = c.bg;
  g.fillRect(x, barY, w, barH);
  g.fillStyle = color;
  g.fillRect(x, barY, Math.max(2, Math.round(w * clamp(ratio, 0, 1))), barH);
  g.strokeStyle = c.surfaceEdge;
  g.lineWidth = 1;
  g.strokeRect(x + 0.5, barY + 0.5, w - 1, barH - 1);
  if (note) kit.drawClipped(g, note, x, barY + barH + 20 * s, w, { size: Math.max(9, Math.round(14 * s)), family: theme.fonts.mono, color: c.inkFaint });
}

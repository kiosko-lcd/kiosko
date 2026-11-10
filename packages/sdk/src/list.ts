/**
 * Lists, the same in every widget: two shared options (`rows`, `layout`),
 * one layout helper that decides how many rows fit and how tall they are,
 * and one "+N more" line.
 *
 *   options: t.object({
 *     ...listOptions({ layouts: ['one-line', 'detailed'] }),   // rows, layout
 *     projects: t.filter({ label: 'Projects' }),
 *   }),
 *   render(g, ctx) {
 *     const items = …;
 *     if (!items.length) return drawEmpty(g, ctx, ctx.t({ en: 'Nothing to review', es: 'Nada que revisar' }));
 *     const plan = listLayout(ctx.box, items.length, ctx.options, {
 *       sizes: { 'one-line': { min: 22, max: 46 }, detailed: { min: 50, max: 80 } },
 *       auto: (box, n) => (box.h >= box.w * 0.7 && box.h / n >= 50 ? 'detailed' : 'one-line'),
 *     });
 *     plan.rows.forEach((row, i) => drawItem(items[i], row, plan.layout, plan.textSize));
 *     drawMore(g, ctx, plan);
 *   },
 *
 * `rows` = 0 fits as many rows as the box holds, each between the layout's
 * `min` and `max` px. `rows` = N shows N items, in rows of the box's height
 * divided by N but never taller than `max` (the rest of the box stays empty,
 * below them) nor shorter than `min` (then fewer rows). Items left out are
 * counted in "+N more", a compact line under the last row.
 */
import type { Localized } from './i18n.ts';
import type { Box, Graphics, RenderContext } from './plugin.ts';
import { t, type EnumField, type NumberField } from './schema.ts';

/** How a list row is drawn: one line per item, or a title with details under it. */
export type ListLayout = 'one-line' | 'detailed';
/** The `layout` option: a fixed layout, or `auto` (the widget's own rule). */
export type ListLayoutChoice = 'auto' | ListLayout;

const LAYOUT_LABELS: Record<ListLayoutChoice, Localized> = {
  auto: { en: 'Automatic', es: 'Automático' },
  'one-line': { en: 'One line', es: 'Una línea' },
  detailed: { en: 'Detailed', es: 'Detallado' },
};

const rowsField = (def: number): NumberField =>
  t.integer({
    default: def,
    min: 0,
    max: 30,
    label: { en: 'Rows', es: 'Filas' },
    help: {
      en: '0 = as many as fit. A number shows that many, in rows of a readable size (fewer when the tile is too small for them); the rest are counted in "+N more".',
      es: '0 = las que quepan. Con un número se ven esas, en filas de un tamaño legible (menos si la tesela no da para ellas); el resto se cuenta en «+N más».',
    },
  });

/**
 * The shared list options, to spread into the widget's `t.object({...})`:
 * `rows` (0 = auto, up to 30) and, when the widget draws two layouts,
 * `layout` (`auto` plus those). `rows` is the default of `rows`: 0 unless
 * the widget had a fixed count before.
 */
export function listOptions(o?: { rows?: number }): { rows: NumberField };
export function listOptions<L extends ListLayout>(o: { rows?: number; layouts: readonly [L, L, ...L[]]; layout?: 'auto' | L }): { rows: NumberField; layout: EnumField<'auto' | L> };
export function listOptions(o: { rows?: number; layouts?: readonly ListLayout[]; layout?: ListLayoutChoice } = {}): { rows: NumberField; layout?: EnumField<ListLayoutChoice> } {
  const rows = rowsField(o.rows ?? 0);
  if (!o.layouts || o.layouts.length < 2) return { rows };
  const values = ['auto', ...o.layouts] as ListLayoutChoice[];
  return {
    rows,
    layout: t.enum(values, {
      default: o.layout ?? 'auto',
      label: { en: 'Row layout', es: 'Formato de fila' },
      labels: Object.fromEntries(values.map((v) => [v, LAYOUT_LABELS[v]])),
      help: { en: 'Automatic: the widget picks by the tile\'s shape.', es: 'Automático: el widget elige según la forma de la tesela.' },
    }),
  };
}

/** Row heights of one layout, in px of the widget's box. */
export interface RowSize {
  /** Smallest row that can still be read. */
  min: number;
  /** Tallest row: rows never grow past it, however few they are (the rest of the box stays empty). */
  max: number;
}

export interface ListSpec<L extends ListLayout = ListLayout> {
  /** One entry per layout the widget draws: its row heights. */
  sizes: { [K in L]: RowSize };
  /**
   * The layout `auto` picks: the widget's own rule (e.g. two lines on tall
   * tiles). `count` is how many rows the box is sized for: `rows` when the
   * user set it (and there are that many items), otherwise every item.
   * Default: the first layout in `sizes`.
   */
  auto?: (box: Box, count: number) => L;
  /** In auto mode, size rows as if there were at least this many items, so one item doesn't get a giant row. Default 1. */
  minRows?: number;
  /** Height of the "+N more" line, in px. Default: `moreHeight(rowH)`. Never more than a row. */
  moreH?: number;
}

export interface ListPlan<L extends ListLayout = ListLayout> {
  /** The layout to draw (`auto` already resolved). */
  layout: L;
  /** Height of every row, in px: between the layout's `min` and `max` (less only in a box shorter than one row). */
  rowH: number;
  /** One box per row to draw, top to bottom from the top of the box: item i goes in `rows[i]`. */
  rows: Box[];
  /** Items drawn (`rows.length`). */
  shown: number;
  /** Items left out, counted in "+N more". */
  hidden: number;
  /** Where "+N more" goes, right under the last row; null when everything fits (or a tiny box leaves no room for it). */
  more: Box | null;
  /** Suggested size of a row's main text, px: 60 % of a one-line row, 42 % of a detailed one (its first line). */
  textSize: number;
  /** Suggested size of the secondary text: a detailed row's second line (30 % of the row), or the smaller bits of a one-line row (80 % of `textSize`). */
  detailSize: number;
}

/** Rows may overflow the box by this fraction of a row (the descenders of the last one), as widgets always did. */
const TOLERANCE = 0.1;
/** A "+N more" line shorter than this is left out (its text would be under 8 px). */
const MIN_MORE_H = 12;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Height of the "+N more" line under rows of `rowH` px: 60 % of a row, between 18 and 28 px, never more than a row. */
export function moreHeight(rowH: number): number {
  return Math.min(clamp(Math.round(rowH * 0.6), 18, 28), rowH);
}

/**
 * Plans a list of `count` items in `box` from the shared options (`rows`,
 * `layout`) and the widget's row heights. Pure: no drawing, no canvas.
 *
 * - `rows` 0: rows of `box.h / count` (at least `minRows`), clamped to the
 *   layout's `min`–`max`; as many as fit.
 * - `rows` N: N items in rows of `box.h / N` clamped the same way, so they
 *   never balloon; fewer when N rows don't fit at `min`.
 * - Items left out: a compact "+N more" line (`more`) right under the last
 *   row, reserved only then. A box with room for one row but not for the row
 *   and that line still gets the row, with the line squeezed or left out.
 */
export function listLayout<L extends ListLayout>(box: Box, count: number, options: { rows?: number; layout?: string }, spec: ListSpec<L>): ListPlan<L> {
  const declared = Object.keys(spec.sizes) as L[];
  const n = Math.max(0, Math.floor(count));
  const fixed = Math.max(0, Math.round(options.rows ?? 0));
  const want = options.layout as L | 'auto' | undefined;
  const layout: L = want && want !== 'auto' && declared.includes(want) ? want : (spec.auto?.(box, fixed > 0 ? Math.min(fixed, n) : n) ?? declared[0]!);
  const size = spec.sizes[layout] ?? spec.sizes[declared[0]!];
  const min = Math.max(1, size.min);
  const max = Math.max(min, size.max);
  const h = Math.max(0, box.h);
  const text = (rowH: number) => {
    const textSize = Math.round(rowH * (layout === 'detailed' ? 0.42 : 0.6));
    return { textSize, detailSize: Math.round(layout === 'detailed' ? rowH * 0.3 : textSize * 0.8) };
  };
  if (h <= 0) return { layout, rowH: 0, rows: [], shown: 0, hidden: n, more: null, ...text(0) };

  // Items to show and the rows the height is divided by.
  const target = fixed > 0 ? Math.min(fixed, n) : n;
  const divisor = fixed > 0 ? fixed : Math.max(n, spec.minRows ?? 1, 1);
  const fits = (space: number, rowH: number) => Math.floor(space / rowH + TOLERANCE);
  let rowH = clamp(h / divisor, min, max);
  let shown = Math.min(target, fits(h, rowH));
  let more: Box | null = null;
  if (shown < n) {
    // Items left out: the same rows over a compact "+N more" line.
    let moreH = Math.min(spec.moreH ?? moreHeight(rowH), rowH);
    rowH = clamp((h - moreH) / divisor, min, max);
    shown = Math.min(target, fits(h - moreH, rowH));
    if (shown < 1) {
      // Room for a row but not for the row and the line: the row first (squeezed in a box shorter than one), the line in what's left.
      shown = Math.min(1, n);
      rowH = Math.min(h, min);
      moreH = Math.min(moreH, h - rowH);
    }
    if (moreH >= MIN_MORE_H) more = { x: box.x, y: box.y + shown * rowH, w: box.w, h: moreH };
  }
  const rows = Array.from({ length: shown }, (_, i) => ({ x: box.x, y: box.y + i * rowH, w: box.w, h: rowH }));
  return { layout, rowH, rows, shown, hidden: n - shown, more, ...text(rowH) };
}

/** `"+3 more"` / `"+3 más"`. */
export function moreLabel(n: number, tr: (text: Localized) => string): string {
  return tr({ en: `+${n} more`, es: `+${n} más` });
}

type DrawCtx = Pick<RenderContext<unknown, unknown>, 'kit' | 'theme' | 't'>;

/**
 * Paints "+N more" in the plan's `more` box, dim, the same in every list.
 * `indent` lines it up with the rows' text (after a status dot, say);
 * `align: 'right'` puts it at the right edge instead.
 */
export function drawMore(g: Graphics, ctx: DrawCtx, plan: Pick<ListPlan, 'hidden' | 'more'>, o: { indent?: number; align?: 'left' | 'right' } = {}): void {
  const m = plan.more;
  if (!m || plan.hidden <= 0) return;
  const size = Math.max(8, Math.round(m.h * 0.62));
  const indent = o.indent ?? 0;
  const font = { size, family: ctx.theme.fonts.sans, color: ctx.theme.colors.inkDim };
  const text = ctx.kit.truncate(g, moreLabel(plan.hidden, ctx.t), Math.max(1, m.w - indent), font);
  const y = m.y + (m.h + size * 0.7) / 2;
  if (o.align === 'right') ctx.kit.drawTracked(g, text, m.x + m.w, y, { ...font, align: 'right' });
  else ctx.kit.drawTracked(g, text, m.x + indent, y, font);
}

/**
 * The message of an empty list ("Nothing to review"), dim, at the top left
 * of the box, the same in every list. Paint it unless the user asked to hide
 * the widget when it's empty (see `WidgetDefinition.empty`).
 */
export function drawEmpty(g: Graphics, ctx: DrawCtx & { box: Box }, message: string): void {
  const { box, kit, theme } = ctx;
  const size = Math.max(10, Math.round(Math.min(32, box.h * 0.3)));
  const font = { size, family: theme.fonts.sans, color: theme.colors.inkDim };
  kit.drawTracked(g, kit.truncate(g, message, box.w, font), box.x, box.y + size * 1.1, font);
}

/**
 * Sparkline geometry (bar-style).
 *
 * Pure computation: it does not touch the canvas, so it can be tested without
 * rendering anything. It is drawn with bars rather than a line because the
 * rest of the panel already speaks that language (bar gauges), and at this
 * size a 1 px line on a dark background gets lost.
 */

export interface SparkBar {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Position in the original series. */
  index: number;
  value: number;
}

export interface SparkOptions {
  /** Gap between bars. */
  gap?: number;
  /** Minimum height, so that a zero value still marks its slot. */
  minHeight?: number;
  /**
   * Fixed denominator instead of the series maximum. Needed when the values
   * are already a meaningful ratio: per-core usage is measured against 100 %,
   * and normalising it against the busiest core would make an idle machine
   * look saturated.
   */
  max?: number;
}

/**
 * Lays out `values` in `w` × `h`, with the origin at the top-left corner of
 * the box (bars grow upwards from the bottom).
 *
 * By default the scale is relative to the series maximum: what matters is the
 * shape ("am I way above normal today or the same as usual?"), not the
 * absolute value, which is usually printed next to it in figures. Pass
 * `opts.max` for an absolute scale.
 */
export function sparkBars(values: number[], w: number, h: number, opts: SparkOptions = {}): SparkBar[] {
  const n = values.length;
  if (n === 0 || w <= 0 || h <= 0) return [];

  const gap = opts.gap ?? 2;
  const minHeight = opts.minHeight ?? 1;

  // With many bars the gaps eat up the width; the gap is sacrificed before the
  // bar, since the bar is what carries the data.
  const effGap = n > 1 && (w - gap * (n - 1)) / n < 1 ? 0 : gap;
  const barW = Math.max(1, (w - effGap * (n - 1)) / n);

  const max = opts.max ?? Math.max(...values);
  return values.map((value, index) => {
    // All-zero series: no valid denominator, so every bar is at the minimum. A
    // division by zero would paint NaN and the canvas would silently swallow it.
    const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
    const barH = Math.max(minHeight, Math.round(h * ratio));
    return {
      x: Math.round(index * (barW + effGap)),
      y: Math.round(h - barH),
      w: Math.max(1, Math.round(barW)),
      h: barH,
      index,
      value,
    };
  });
}

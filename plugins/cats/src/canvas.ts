/**
 * The canvas factory of the panel. A plugin must not import its own copy of
 * @napi-rs/canvas (images from another copy can't be drawn on the panel's
 * canvas), so the widget hands over `ctx.canvas` before painting and the
 * scene code creates its offscreen canvases through here.
 */
import type { Canvas, CanvasApi } from '@tessera/sdk';

let api: CanvasApi | null = null;

export function useCanvas(a: CanvasApi): void {
  api = a;
}

export function createCanvas(w: number, h: number): Canvas {
  if (!api) throw new Error('cats: canvas API not set (call useCanvas first)');
  return api.createCanvas(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
}

/**
 * What a screen really does, measured: the frames it sent in the last few
 * seconds (its real fps) and, for the frames it painted, how long painting
 * took on its thread and how long encoding took in the thread pool. Shown in
 * Screens, and the numbers behind the "paint each screen in its own thread"
 * setting (`threads` in the config).
 */

/** The window the fps is counted over. */
export const FPS_WINDOW_MS = 5_000;

export interface ScreenFrameStats {
  /** Frames sent to the panel per second, over the last `FPS_WINDOW_MS`. */
  fps: number;
  /** Average time to paint a frame on the screen's thread (the widgets' code and Skia rasterizing it: both block that thread), in ms; recent frames weigh more. */
  paintMs: number;
  /** Average time to encode a frame (JPEG/PNG, in the thread pool), in ms. */
  encodeMs: number;
  /** Frames painted so far. */
  frames: number;
}

const round = (ms: number) => Math.round(ms * 10) / 10;

export class FrameStats {
  private sent: number[] = [];
  private paint = 0;
  private encode = 0;
  private frames = 0;

  /** A frame painted (`paintMs` on this thread) and encoded (`encodeMs` in the thread pool, waiting included). */
  painted(paintMs: number, encodeMs: number): void {
    this.paint = this.frames ? this.paint * 0.9 + paintMs * 0.1 : paintMs;
    this.encode = this.frames ? this.encode * 0.9 + encodeMs * 0.1 : encodeMs;
    this.frames++;
  }

  /** A frame sent to the panel at `at`. */
  sentAt(at: number): void {
    this.sent.push(at);
    if (this.sent.length > 600) this.sent.splice(0, this.sent.length - 600);
  }

  read(now = Date.now()): ScreenFrameStats {
    const from = now - FPS_WINDOW_MS;
    while (this.sent.length && this.sent[0]! < from) this.sent.shift();
    return { fps: round((this.sent.length * 1000) / FPS_WINDOW_MS), paintMs: round(this.paint), encodeMs: round(this.encode), frames: this.frames };
  }
}

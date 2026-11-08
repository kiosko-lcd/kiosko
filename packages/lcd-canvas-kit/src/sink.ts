/**
 * Where a rendered frame goes. Anything with `send` will do: a USB panel
 * client, a file another process forwards, an HTTP display.
 */
import { renameSync, writeFileSync } from 'node:fs';

export interface FrameSink {
  send(frame: Buffer): Promise<void>;
  close?(): Promise<void>;
}

/**
 * Writes each frame to a file, atomically (temporary file in the same
 * directory, then rename), so that a reader polling it never sees half a frame.
 */
export class FileSink implements FrameSink {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async send(frame: Buffer): Promise<void> {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, frame);
    renameSync(tmp, this.path);
  }
}

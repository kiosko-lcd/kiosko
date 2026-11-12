import {
  ACK_TIMEOUT_MS,
  HANDSHAKE_TIMEOUT_MS,
  REPLY_SIZE,
  WRITE_TIMEOUT_MS,
  frameWrites,
  handshakeRequest,
  isAccepted,
  modelFor,
  parseHandshake,
  prepareFrame,
  type Handshake,
  type PanelModel,
} from './protocol.ts';
import { openTransport, type OpenOptions, type Transport } from './transport.ts';

export interface PanelInfo extends Handshake {
  pid: number;
  serial?: string;
  /** Where it is plugged (`bus-address`). */
  location?: string;
  /** What trcc knows about this model, if anything. */
  model?: PanelModel;
}

/** One connected panel: say hello once, then `send` JPEG frames. Sends never overlap. */
export class LyPanel {
  private queue: Promise<unknown> = Promise.resolve();
  info: PanelInfo | null = null;

  private readonly transport: Transport;
  readonly pid: number;
  private readonly meta: { serial?: string; location?: string };

  constructor(transport: Transport, pid: number, meta: { serial?: string; location?: string } = {}) {
    this.transport = transport;
    this.pid = pid;
    this.meta = meta;
  }

  /** Opens the first (or `serial`) panel and handshakes. */
  static async open(o: OpenOptions = {}): Promise<LyPanel> {
    const { transport, pid, serial, location } = await openTransport(o);
    const panel = new LyPanel(transport, pid, { ...(serial ? { serial } : {}), location });
    try {
      await panel.connect();
    } catch (err) {
      await transport.close();
      throw err;
    }
    return panel;
  }

  async connect(): Promise<PanelInfo> {
    await this.transport.write(handshakeRequest(), HANDSHAKE_TIMEOUT_MS);
    const hs = parseHandshake(await this.transport.read(REPLY_SIZE, HANDSHAKE_TIMEOUT_MS), this.pid);
    const model = modelFor(hs.pm, hs.sub);
    this.info = { ...hs, pid: this.pid, ...this.meta, ...(model ? { model } : {}) };
    return this.info;
  }

  /**
   * Writes one JPEG. Resolves `true` if the panel kept it, `false` if it
   * dropped it (too big: see MAX_FRAME_BYTES). Rejects on a bus error: the
   * caller reconnects.
   */
  send(jpeg: Buffer): Promise<boolean> {
    const run = async () => {
      for (const part of frameWrites(prepareFrame(jpeg, this.pid), this.pid)) await this.transport.write(part, WRITE_TIMEOUT_MS);
      return isAccepted(await this.transport.read(REPLY_SIZE, ACK_TIMEOUT_MS));
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  close(): Promise<void> {
    return this.transport.close();
  }
}

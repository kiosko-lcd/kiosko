/**
 * The `browser` panel driver: a Kiosko screen shown full-screen by a browser
 * (an old tablet, a phone) that connected to the network-screens server and
 * proved it has this screen's key (hub.ts, docs/browser-screens.md).
 *
 * Like a remote screen's driver (remote/device.ts): frames go one at a time,
 * the next when the viewer has ACKed the last, and always the newest (frames
 * painted meanwhile replace each other); whenever the viewer (re)connects it
 * gets the current frame at once. It never connects anywhere: it waits for
 * its viewer. The viewer's size follows the device (STATE); the server turns
 * the screen when it changes (`onResize`).
 *
 * Presence (presence.ts): absent while no paired browser is connected, so
 * nothing is composed, painted or encoded for nobody; present while a
 * session is live. A viewer that comes back within a tick gets the frame
 * kept here at once (an unchanged picture is not painted again, so it must
 * not wait for a new one); after a pause the kept frame is dropped and the
 * runtime's resume brings a full, fresh one.
 */
import type { DeviceConfig } from '../config/model.ts';
import type { DeviceStatus } from '../devices.ts';
import type { PresenceInfo } from '../presence.ts';
import type { BrowserHub, ViewerSession, ViewerSink } from './hub.ts';
import { BT } from './protocol.ts';

export type BrowserConfig = Extract<DeviceConfig, { driver: 'browser' }>;

export interface BrowserStatus {
  online: boolean;
  id: string;
  /** The viewer's address (IP) while connected. */
  address: string | null;
  /** Its picture, device pixels. */
  w: number;
  h: number;
  fps: number;
  /** Sent → ACKed (the viewer decoded and drew it), ms. */
  rttMs: number | null;
  decodeMs: number | null;
  lastFrameAt: number | null;
  /** Frames painted here but replaced by a newer one before they could go. */
  dropped: number;
  since: number | null;
  /** Whether the network-screens server is on (otherwise no browser can come). */
  server: boolean;
}

/** A frame not ACKed in this long: the viewer is stuck (a tab in the background); its session is dropped. */
const STUCK_MS = 20_000;

export class BrowserDevice implements ViewerSink {
  readonly status: DeviceStatus & { browser: BrowserStatus };
  readonly uid: string;
  private readonly cfg: BrowserConfig;
  private readonly log: (m: string) => void;
  private readonly hub: BrowserHub | null;
  private readonly paired: boolean;
  private session: ViewerSession | null = null;
  private latest: Buffer | null = null;
  private latestNum = 0;
  private fresh = false;
  private inflight: { num: number; at: number } | null = null;
  private frameTimes: number[] = [];
  private lastSay = '';
  private closed = false;

  constructor(cfg: BrowserConfig, log: (m: string) => void, hub: BrowserHub | null) {
    this.cfg = cfg;
    this.uid = cfg.uid;
    this.log = log;
    this.hub = hub;
    this.paired = /^[0-9a-f]{64}$/i.test(cfg.key ?? '');
    this.status = {
      driver: 'browser',
      ok: false,
      message: 'waiting for its browser',
      code: 'browserWaiting',
      framesSent: 0,
      lastSentAt: null,
      browser: { online: false, id: cfg.id ?? cfg.uid, address: null, w: 0, h: 0, fps: 0, rttMs: null, decodeMs: null, lastFrameAt: null, dropped: 0, since: null, server: hub?.serverOn ?? false },
    };
    if (!this.paired) this.say(`${this.name()}: not paired yet (Screens → Add screen → Browser)`, false, 'browserNotPaired');
    else if (hub) hub.register(this);
    else this.say(`${this.name()}: browser screens need Kiosko's server`, false, 'browserServerOff');
  }

  private name(): string {
    return this.cfg.id || this.cfg.uid;
  }

  private say(message: string, ok: boolean, code: string, params: Record<string, string | number> = {}): void {
    Object.assign(this.status, { ok, message, code, params: { id: this.name(), ...params } });
    if (code !== this.lastSay) {
      this.lastSay = code;
      this.log(message);
    }
  }

  private idle(): void {
    if (!this.paired) return;
    if (!this.status.browser.server) this.say(`${this.name()}: network screens are off (turn them on in Screens)`, false, 'browserServerOff');
    else this.say(`${this.name()}: waiting for its browser`, false, 'browserWaiting');
  }

  serverChanged(on: boolean): void {
    this.status.browser.server = on;
    if (!this.session) this.idle();
  }

  attach(s: ViewerSession): void {
    if (this.closed) return;
    this.session = s;
    this.inflight = null;
    // Whatever it shows is not ours, or old: the current frame at once.
    this.fresh = !!this.latest;
    const b = this.status.browser;
    Object.assign(b, { online: true, address: s.info.address, w: s.info.w, h: s.info.h, since: Date.now(), id: this.cfg.id || s.info.id });
    this.say(`${this.name()}: showing in a browser at ${s.info.address}`, true, 'browserOnline', { host: s.info.address });
    this.resized();
    this.pump();
  }

  detach(s: ViewerSession): void {
    if (this.session !== s) return;
    this.session = null;
    this.inflight = null;
    Object.assign(this.status.browser, { online: false, fps: 0, address: null, since: null });
    this.frameTimes = [];
    if (!this.closed) this.idle();
  }

  message(s: ViewerSession, type: number, j: Record<string, unknown>): void {
    if (s !== this.session) return;
    if (type === BT.ACK) {
      const f = this.inflight;
      if (!f || j.n !== f.num) return;
      const now = Date.now();
      const b = this.status.browser;
      b.rttMs = now - f.at;
      b.decodeMs = typeof j.dec === 'number' && Number.isFinite(j.dec) ? Math.round(j.dec) : null;
      if (j.ok !== false) {
        this.status.framesSent++;
        this.status.lastSentAt = now;
        b.lastFrameAt = now;
        this.frameTimes.push(now);
        while (this.frameTimes.length && now - this.frameTimes[0]! > 5000) this.frameTimes.shift();
        b.fps = this.frameTimes.length > 1 ? Math.round(((this.frameTimes.length - 1) * 10000) / (now - this.frameTimes[0]!)) / 10 : 0;
      } else this.log(`${this.name()}: the browser could not show frame ${f.num}`);
      this.inflight = null;
      this.pump();
    } else if (type === BT.STATE) {
      const b = this.status.browser;
      if (s.info.w !== b.w || s.info.h !== b.h) {
        b.w = s.info.w;
        b.h = s.info.h;
        this.resized();
      }
      // Back from the background (or a new tab): it needs the picture again.
      if (j.resend === true && this.latest) {
        this.inflight = null;
        this.fresh = true;
        this.pump();
      }
    }
  }

  /** The viewer's size: the server turns or resizes the screen to it (hub event `resize`). */
  private resized(): void {
    const b = this.status.browser;
    if (this.cfg.follow !== false && b.w && b.h) this.hub?.emit('resize', { uid: this.uid, w: b.w, h: b.h });
  }

  private pump(): void {
    const s = this.session;
    if (!s || this.closed) return;
    if (this.inflight) {
      if (Date.now() - this.inflight.at > STUCK_MS) {
        this.log(`${this.name()}: the browser stopped taking frames; waiting for it to come back`);
        s.close();
      }
      return;
    }
    if (!this.fresh || !this.latest) return;
    this.fresh = false;
    const num = this.latestNum;
    const head = Buffer.alloc(4);
    head.writeUInt32BE(num);
    s.send(BT.FRAME, Buffer.concat([head, this.latest]));
    this.inflight = { num, at: Date.now() };
  }

  /** The newest frame (JPEG or PNG, upright): sent when the viewer has taken the last one. Returns at once. */
  async send(frame: Buffer): Promise<void> {
    if (this.latest && this.fresh) this.status.browser.dropped++;
    this.latest = frame;
    this.latestNum = (this.latestNum + 1) >>> 0;
    this.fresh = true;
    this.pump();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    // The session stays (it is the hub's): a new driver for the same screen takes it over.
    if (this.session) this.detach(this.session);
    this.hub?.unregister(this);
  }

  get isConnected(): boolean {
    return !!this.session;
  }

  get presence(): PresenceInfo {
    if (!this.paired) return { state: 'absent', why: `${this.name()} is not paired` };
    if (this.session) return { state: 'present', why: `${this.name()} showing in a browser at ${this.status.browser.address}` };
    if (!this.hub || !this.status.browser.server) return { state: 'absent', why: 'network screens are off' };
    return { state: 'absent', why: `no browser showing ${this.name()}` };
  }

  pausedChanged(paused: boolean): void {
    // Nothing is painted from now on: what is kept would be old when a viewer comes.
    if (paused && !this.session) {
      this.latest = null;
      this.fresh = false;
    }
  }
}

/**
 * The `remote` panel driver: a Kiosko remote screen on the network
 * (firmware/esp32-screen, docs/remote-screen.md).
 *
 * One persistent session per screen. Frames go out one at a time: the next
 * leaves when the screen has ACKed the last, and it is always the newest
 * (frames painted meanwhile replace each other, nothing queues up on a slow
 * link). An unchanged picture is not resent; a ping every few seconds keeps
 * the session. When the screen goes away the driver says "offline" (not an
 * error) and comes back with a growing pause, or at once when the screen
 * announces itself again; on every (re)connection it pushes the screen's
 * settings (Kiosko's rotation is the truth) and the current frame.
 */
import type { DeviceStatus } from '../devices.ts';
import { PORT } from './crypto.ts';
import { ScreenError, T, nextSealed, openSession, sendSealed, type ScreenInfo, type Wire } from './link.ts';
import { browser, type FoundScreen } from './mdns.ts';
import type { Session } from './crypto.ts';

export interface RemoteConfig {
  driver: 'remote';
  /** The screen's stable id (from its MAC), as its announcement and its INFO say. */
  uid: string;
  /** Its name when it was added (shown until it says another). */
  id?: string;
  /** The pairing key, 64 hex digits (secret). */
  key?: string;
  /** Address to use instead of looking it up by mDNS. */
  host?: string;
  port?: number;
  /** Backlight 0-100, pushed on every connection (firmware 0.1.2 on; older ones ignore it). */
  brightness?: number;
  jpegQuality?: number;
}

export interface RemoteStatus {
  online: boolean;
  id: string;
  host: string | null;
  fw: string;
  model: string;
  /** Native size, and the angle it shows at now. */
  w: number;
  h: number;
  rot: number;
  fps: number;
  /** Round trip of the last frame: sent → ACKed, ms. */
  rttMs: number | null;
  decodeMs: number | null;
  lastFrameAt: number | null;
  /** Frames painted here but replaced by a newer one before they could go. */
  dropped: number;
  since: number | null;
  /** The chip's temperature, °C, as the screen last said (firmware 0.1.2 on; null: it doesn't say). */
  tempC: number | null;
  /** Its backlight, 0-100 (firmware 0.1.2 on; null: an older one, without brightness). */
  bright: number | null;
}

/** What the driver needs of the mDNS browser (tests: a fake). */
export interface ScreenFinder {
  get(uid: string): FoundScreen | undefined;
  retain(): void;
  release(): void;
  query(): void;
  on(event: 'found', f: (s: FoundScreen) => void): unknown;
  off(event: 'found', f: (s: FoundScreen) => void): unknown;
}

export interface RemoteDeps {
  /** Screens heard on the LAN. Default: the process's ScreenBrowser. */
  browser?: ScreenFinder;
  open?: typeof openSession;
  /** First pause after a failure, ms (doubles up to `maxRetryMs`). */
  retryMs?: number;
  maxRetryMs?: number;
  pingMs?: number;
  /** What to push on connect besides the rotation. */
  settings?: () => { lang?: string; tz?: string };
  now?: () => number;
}

const ROTATIONS = [0, 90, 180, 270];

/** A brightness to push: 0-100, whole; null when none is set (the screen keeps its own). */
export function brightnessOf(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(100, Math.max(0, Math.round(v))) : null;
}

export class RemoteDevice {
  readonly status: DeviceStatus & { remote: RemoteStatus };
  private readonly cfg: RemoteConfig;
  private readonly log: (m: string) => void;
  private rotate: number;
  private rotDirty = false;
  private readonly deps: Required<Pick<RemoteDeps, 'retryMs' | 'maxRetryMs' | 'pingMs'>> & RemoteDeps;
  private readonly key: Buffer | null;
  private readonly mdns: NonNullable<RemoteDeps['browser']>;
  private latest: Buffer | null = null;
  private latestNum = 0;
  private fresh = false;
  private led: { rgb: string; blink: number } | null = null;
  private ledDirty = false;
  private closed = false;
  private paused = 0;
  private wire: Wire | null = null;
  private failures = 0;
  private lastSay = '';
  private frameTimes: number[] = [];
  private running: Promise<void> | null = null;
  private idle: (() => void)[] = [];
  private connected = false;
  private readonly waiters = new Set<(why: Why) => void>();
  private readonly onFound = (s: FoundScreen) => {
    if (s.uid === this.cfg.uid) this.notify('found');
  };

  constructor(cfg: RemoteConfig, log: (m: string) => void, rotate = 0, deps: RemoteDeps = {}) {
    this.cfg = cfg;
    this.log = log;
    this.rotate = ROTATIONS.includes(rotate) ? rotate : 0;
    this.deps = { retryMs: 1000, maxRetryMs: 30_000, pingMs: 5000, ...deps };
    this.key = /^[0-9a-f]{64}$/i.test(cfg.key ?? '') ? Buffer.from(cfg.key!, 'hex') : null;
    this.mdns = deps.browser ?? browser();
    this.status = {
      driver: 'remote',
      ok: false,
      message: 'connecting…',
      code: 'connecting',
      framesSent: 0,
      lastSentAt: null,
      remote: { online: false, id: cfg.id ?? cfg.uid, host: cfg.host ?? null, fw: '', model: '', w: 0, h: 0, rot: this.rotate, fps: 0, rttMs: null, decodeMs: null, lastFrameAt: null, dropped: 0, since: null, tempC: null, bright: null },
    };
    this.mdns.retain();
    this.mdns.on('found', this.onFound);
    if (!this.key) this.say(`${this.name()}: not paired yet (pair it in the editor: Screens → Detect panels)`, false, 'remoteNotPaired', { id: this.name() });
    else this.running = this.run();
  }

  private name(): string {
    return this.status?.remote.id || this.cfg.id || this.cfg.uid;
  }

  private say(message: string, ok: boolean, code: string, params?: Record<string, string | number>): void {
    Object.assign(this.status, { ok, message, code, params });
    // Transitions only: a screen that stays away is not a log line every few seconds.
    if (code !== this.lastSay) {
      this.lastSay = code;
      this.log(message);
    }
  }

  private notify(why: Why): void {
    for (const w of [...this.waiters]) w(why);
  }

  /** Waits up to `ms` for one of `on` (or close). */
  private wait(ms: number, on: Why[]): Promise<Why | 'time'> {
    return new Promise((resolve) => {
      const done = (why: Why | 'time') => {
        clearTimeout(t);
        this.waiters.delete(hook);
        resolve(why);
      };
      const hook = (why: Why) => {
        if (why === 'close' || on.includes(why)) done(why);
      };
      const t = setTimeout(() => done('time'), Math.max(0, ms));
      this.waiters.add(hook);
      if (this.closed) done('close');
    });
  }

  /** JPEG of the logical (unrotated) picture: the screen turns it. Returns at once. */
  async send(frame: Buffer): Promise<void> {
    if (this.latest && this.fresh) this.status.remote.dropped++;
    this.latest = frame;
    this.latestNum = (this.latestNum + 1) >>> 0;
    this.fresh = true;
    this.notify('frame');
  }

  /** The screen's rotation changed in Kiosko's config: the screen turns at once (and on every reconnection). */
  setRotation(rotate: number): void {
    const r = ROTATIONS.includes(rotate) ? rotate : 0;
    if (r === this.rotate) return;
    this.rotate = r;
    this.rotDirty = true;
    this.notify('frame');
  }

  /** Lights the screen's LED (`rgb` "rrggbb", "000000" off), e.g. for a full-screen alert. */
  setLed(rgb: string, blinkMs = 0): void {
    const next = { rgb: /^[0-9a-f]{6}$/i.test(rgb) ? rgb.toLowerCase() : '000000', blink: Math.max(0, Math.round(blinkMs)) };
    if (this.led && this.led.rgb === next.rgb && this.led.blink === next.blink) return;
    this.led = next;
    this.ledDirty = true;
    this.notify('frame');
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.mdns.off('found', this.onFound);
    this.mdns.release();
    this.wire?.close();
    this.notify('close');
  }

  /** Resolves when the loop is done (tests). */
  async closed_(): Promise<void> {
    await this.running;
  }

  private where(): { host: string; port: number } | null {
    if (this.cfg.host) return { host: this.cfg.host, port: this.cfg.port ?? PORT };
    const f = this.mdns.get(this.cfg.uid);
    return f ? { host: f.address, port: f.port || PORT } : null;
  }

  private async run(): Promise<void> {
    while (!this.closed) {
      if (this.paused) {
        for (const f of this.idle.splice(0)) f();
        await this.wait(60_000, ['resume']);
        continue;
      }
      const at = this.where();
      if (!at) {
        this.offline(`${this.name()} is not on the network (no mDNS announcement yet)`, 'remoteOffline');
        this.mdns.query();
        await this.backoff();
        continue;
      }
      let conn: { wire: Wire; info: ScreenInfo; session: Session };
      try {
        conn = await (this.deps.open ?? openSession)(at.host, at.port, this.key!, this.cfg.uid);
      } catch (err) {
        this.failed(err, at.host);
        await this.backoff(err);
        continue;
      }
      this.failures = 0;
      this.connected = true;
      try {
        await this.serve(conn, at.host);
      } catch (err) {
        if (!this.closed && !this.paused) this.failed(err, at.host);
      } finally {
        conn.wire.close();
        this.wire = null;
        this.connected = false;
        this.status.remote.online = false;
        this.status.remote.fps = 0;
      }
      if (!this.closed && !this.paused) await this.backoff();
    }
    for (const f of this.idle.splice(0)) f();
  }

  private failed(err: unknown, host: string): void {
    const e = err as { code?: string; message?: string };
    const why = e?.message ?? String(err);
    if (err instanceof ScreenError && (e.code === 'badKey' || e.code === 'notPaired')) this.offline(`${this.name()} refuses this Kiosko's key: pair it again`, 'remoteBadKey');
    else if (err instanceof ScreenError && e.code === 'otherScreen') this.offline(`${host}: ${why}`, 'remoteOtherScreen', { host });
    else if (err instanceof ScreenError && e.code === 'busy') this.offline(`${this.name()} is busy (updating?)`, 'remoteBusy');
    else if (err instanceof ScreenError && e.code === 'proto') this.offline(why, 'remoteProto', { why });
    else this.offline(`${this.name()} is offline (${why})`, 'remoteOffline');
  }

  private offline(message: string, code: string, params: Record<string, string | number> = {}): void {
    this.status.remote.online = false;
    this.status.remote.since = null;
    this.say(message, false, code, { id: this.name(), ...params });
  }

  /** A growing pause (with a little jitter); the screen announcing itself cuts it short. */
  private async backoff(err?: unknown): Promise<void> {
    this.failures++;
    const hopeless = err instanceof ScreenError && ['badKey', 'notPaired', 'proto'].includes(err.code);
    const base = hopeless ? 60_000 : Math.min(this.deps.maxRetryMs, this.deps.retryMs * 2 ** Math.min(this.failures - 1, 8));
    await this.wait(Math.round(base * (0.85 + Math.random() * 0.3)), ['found', 'resume', 'pause']);
  }

  private async serve(conn: { wire: Wire; info: ScreenInfo; session: Session }, host: string): Promise<void> {
    const { wire, info, session } = conn;
    this.wire = wire;
    const r = this.status.remote;
    Object.assign(r, { id: info.id || r.id, fw: info.fw, model: info.model, w: info.w, h: info.h, rot: info.rot, host, since: Date.now() });
    const st = await nextSealed(wire, session);
    if (st.type !== T.STATE) throw new Error('the screen did not say its state');
    this.applyState(st.json());
    // Kiosko's screen config is the truth: its rotation (and language, clock) go to the screen.
    const extra = this.deps.settings?.() ?? {};
    const bright = brightnessOf(this.cfg.brightness);
    sendSealed(wire, session, T.SET, { rot: this.rotate, ...extra, ...(bright !== null ? { bright } : {}) });
    this.rotDirty = false;
    this.ledDirty = !!this.led;
    // Whatever it shows now is not ours (or may not be): the current frame at once.
    this.fresh = !!this.latest;
    r.online = true;
    this.say(`${r.id}: online at ${host} (${info.model} ${info.fw})`, true, 'remoteOnline', { id: r.id, host });

    let inflight: { num: number; at: number } | null = null;
    let lastTx = Date.now();
    let lastRx = Date.now();
    let reply: Promise<Awaited<ReturnType<typeof nextSealed>>> | null = null;
    while (!this.closed && !wire.closed && !this.paused) {
      // Send what is due: the LED, the newest frame (one at a time), a ping.
      if (this.rotDirty) {
        this.rotDirty = false;
        sendSealed(wire, session, T.SET, { rot: this.rotate });
        lastTx = Date.now();
      }
      if (this.ledDirty && this.led) {
        this.ledDirty = false;
        sendSealed(wire, session, T.LED, this.led);
        lastTx = Date.now();
      }
      if (!inflight && this.fresh && this.latest) {
        const frame = this.latest;
        if (frame.length + 64 > info.max) {
          this.fresh = false;
          this.say(`${r.id}: a ${Math.round(frame.length / 1024)} KB frame is over the screen's ${Math.round(info.max / 1024)} KB: lower the JPEG quality`, true, 'remoteTooBig', { id: r.id, kb: Math.round(frame.length / 1024), max: Math.round(info.max / 1024) });
        } else {
          this.fresh = false;
          const num = this.latestNum;
          const head = Buffer.alloc(4);
          head.writeUInt32BE(num);
          sendSealed(wire, session, T.FRAME, Buffer.concat([head, frame]));
          inflight = { num, at: Date.now() };
          lastTx = inflight.at;
        }
      }
      if (Date.now() - lastTx >= this.deps.pingMs) {
        sendSealed(wire, session, T.PING, {});
        lastTx = Date.now();
      }
      if (Date.now() - lastRx > 3 * this.deps.pingMs + 1000) throw Object.assign(new Error('the screen stopped answering'), { code: 'ETIMEDOUT' });
      // Wait for the screen, a new frame, or the next ping.
      reply ??= nextSealed(wire, session, 3 * this.deps.pingMs + 1000);
      const waitMs = Math.max(10, this.deps.pingMs - (Date.now() - lastTx));
      const got = await Promise.race([reply.then((m) => ({ m })), this.wait(waitMs, inflight ? ['pause'] : ['frame', 'pause']).then(() => null)]);
      if (this.paused) return;
      if (!got) continue;
      reply = null;
      lastRx = Date.now();
      const { m } = got;
      if (m.type === T.ACK) {
        const a = m.json() as { n?: number; ok?: boolean; dec?: number; rx?: number };
        if (inflight && a.n === inflight.num) {
          const now = Date.now();
          r.rttMs = now - inflight.at;
          r.decodeMs = typeof a.dec === 'number' ? a.dec : null;
          if (a.ok !== false) {
            this.status.framesSent++;
            this.status.lastSentAt = now;
            r.lastFrameAt = now;
            this.frameTimes.push(now);
            while (this.frameTimes.length && now - this.frameTimes[0]! > 5000) this.frameTimes.shift();
            r.fps = this.frameTimes.length > 1 ? Math.round(((this.frameTimes.length - 1) * 10000) / (now - this.frameTimes[0]!)) / 10 : 0;
          } else this.log(`${r.id}: the screen could not show frame ${a.n}`);
          inflight = null;
        }
      } else if (m.type === T.STATE) {
        const j = m.json();
        this.applyState(j);
        if (j.resend === true && this.latest) this.fresh = true;
      } else if (m.type === T.PING) {
        sendSealed(wire, session, T.PONG, {});
      }
      // PONG and the rest: being alive is enough.
    }
  }

  private applyState(j: Record<string, unknown>): void {
    const r = this.status.remote;
    if (typeof j.id === 'string' && j.id) r.id = j.id;
    if (typeof j.rot === 'number') r.rot = j.rot;
    if (typeof j.fw === 'string') r.fw = j.fw;
    if (typeof j.w === 'number') r.w = j.w;
    if (typeof j.h === 'number') r.h = j.h;
    if (typeof j.tempC === 'number' && Number.isFinite(j.tempC)) r.tempC = j.tempC;
    if (typeof j.bright === 'number' && Number.isFinite(j.bright)) r.bright = j.bright;
  }

  /**
   * Runs `fn` while this driver stands aside: its session is closed and it
   * doesn't reconnect until `fn` is done (an update, the logs, unpairing open
   * their own session; the screen takes one at a time).
   */
  async exclusive<R>(fn: (host: string, port: number) => Promise<R>): Promise<R> {
    const at = this.where();
    if (!at) throw new ScreenError('offline', `${this.name()} is not on the network`);
    this.paused++;
    try {
      if (this.running) {
        const idle = new Promise<void>((r) => this.idle.push(r));
        this.wire?.close();
        this.notify('pause');
        await idle;
      }
      return await fn(at.host, at.port);
    } finally {
      this.paused--;
      this.notify('resume');
    }
  }

  get isConnected(): boolean {
    return this.connected;
  }
}

type Why = 'frame' | 'found' | 'close' | 'pause' | 'resume';

/**
 * Panel drivers: how a frame gets to the glass.
 *
 *   virtual  only the editor shows it (no hardware, demos, development)
 *   trcc     `trcc serve` REST API (thermalright-trcc-linux), via @loksly/trcc-client
 *   usb      straight over USB from Node, via @loksly/usb-ly (LY panels)
 *   file     writes `frame.jpg` atomically for an external sender (e.g. a USB
 *            sender bound to a serial number, for several identical panels)
 *   remote   a Kiosko remote screen on the network (remote/device.ts,
 *            docs/remote-screen.md)
 *   browser  a browser showing the screen, connected to the network-screens
 *            server (browser/device.ts, docs/browser-screens.md)
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LyPanel, MAX_FRAME_BYTES, PRODUCT_IDS, VENDOR_ID, DeviceLister, findPanels, loadUsb, modelFor, type SeenDevice } from '@loksly/usb-ly';
import { connectPanel, detectPanel, pinFrame, sendFrame, serverAlive, type TrccOptions } from '@loksly/trcc-client';
import type { DeviceConfig } from './config/model.ts';
import { expandPath } from './paths.ts';
import { PresenceMonitor, probesFor, usbProbe, type Clock, type PresenceInfo, type Probe, type ProbeDeps } from './presence.ts';
import { RemoteDevice, type RemoteDeps, type RemoteStatus } from './remote/device.ts';
import { browser } from './remote/mdns.ts';
import { BrowserDevice, type BrowserStatus } from './browser/device.ts';
import type { BrowserHub } from './browser/hub.ts';
import { confinePath, sandboxAllows } from './sandbox.ts';

export interface DeviceStatus {
  driver: DeviceConfig['driver'];
  ok: boolean;
  /** In English, for the log and the CLI. */
  message: string;
  /**
   * The same, for the editor to say in the user's language (`device.<code>`
   * in packages/web/src/i18n.ts, with `params` filled in). Without a code
   * the editor shows `message`.
   */
  code?: string;
  params?: Record<string, string | number>;
  /** Resolution the hardware reports, if it does. */
  /** What the panel reports: its size as seen at its firmware's own angle (`rotate`, when known). */
  detected?: { width: number; height: number; rotate?: number };
  framesSent: number;
  lastSentAt: number | null;
  /** A remote screen's link: online, where, its firmware, fps and round trip. */
  remote?: RemoteStatus;
  /** A browser screen's viewer: online, where, its size, fps and round trip. */
  browser?: BrowserStatus;
}

/** An error that also says what it is, for the editor (see `DeviceStatus.code`). */
function coded(message: string, code: string, params?: Record<string, string | number>): Error {
  return Object.assign(new Error(message), { code, params });
}

/** The status a failure leaves: its message, and a code the editor can say in the user's language when it is a known one. */
function statusOfError(err: unknown): Pick<DeviceStatus, 'message' | 'code' | 'params'> {
  const message = err instanceof Error ? err.message : String(err);
  const e = err as { code?: unknown; params?: Record<string, string | number>; name?: string } | null;
  if (e && typeof e.code === 'string' && /^[a-z][A-Za-z]+$/.test(e.code)) return { message, code: e.code, params: e.params };
  if (e?.name === 'PanelNotFound' || /no LY panel found|no panel with serial/.test(message)) return { message, code: 'usbNotFound' };
  if (/LIBUSB_ERROR_ACCESS|EACCES|access denied/i.test(message)) return { message, code: 'usbAccess' };
  if (e?.name === 'UsbUnavailable' || /cannot load the "usb" package/.test(message)) return { message, code: 'usbUnavailable' };
  return { message, code: 'error', params: { error: message } };
}

export interface Device {
  readonly status: DeviceStatus;
  /** JPEG or PNG, already rotated for the panel (unless the panel turns it: `deviceRotates`). */
  send(frame: Buffer): Promise<void>;
  close(): void;
  /** Panels with a light of their own (remote screens): "rrggbb" ("000000" off), blinking every `blinkMs`. */
  setLed?(rgb: string, blinkMs?: number): void;
  /**
   * Whether its panel is there (presence.ts): `absent` pauses the screen (no
   * composing, painting nor encoding) until it is back. Undefined or
   * `unknown`: painted as always.
   */
  readonly presence?: PresenceInfo;
  /** Panels that turn the picture themselves (remote screens): the screen's rotation changed. */
  setRotation?(rotate: number): void;
  /** Panels with a backlight Kiosko can dim (remote screens): 0-100 for now, null back to its own (remote/backlight.ts). */
  setDim?(level: number | null): void;
}

export function encodeFor(device: DeviceConfig, jpegQuality: number): 'png' | 'jpeg' {
  if (device.driver === 'file') return device.format ?? 'jpeg';
  // The LY firmware only takes JPEG; so does a remote screen (baseline, decoded in its ROM).
  if (device.driver === 'usb' || device.driver === 'remote') return 'jpeg';
  return jpegQuality > 0 ? 'jpeg' : 'png';
}

class VirtualDevice implements Device {
  status: DeviceStatus = { driver: 'virtual', ok: true, message: 'virtual: shown only in the editor', code: 'virtual', framesSent: 0, lastSentAt: null };
  async send(): Promise<void> {
    this.status.framesSent++;
    this.status.lastSentAt = Date.now();
  }
  close(): void {}
}

/** A real panel's screen in a sandbox that may not touch real panels: painted in the editor only. */
class SandboxedDevice implements Device {
  status: DeviceStatus;
  constructor(driver: DeviceConfig['driver'], allow: string) {
    this.status = { driver, ok: true, message: `sandbox: ${driver} panels are off here (shown only in the editor; --sandbox-allow-${allow} turns them on)`, code: 'sandboxOff', params: { driver, flag: `--sandbox-allow-${allow}` }, framesSent: 0, lastSentAt: null };
  }
  async send(): Promise<void> {
    this.status.framesSent++;
    this.status.lastSentAt = Date.now();
  }
  close(): void {}
}

/**
 * `rename` over a file another process has open fails on Windows with
 * EPERM/EBUSY/EACCES (the sender is reading it right now): it passes in a few
 * milliseconds, so try again a few times before giving up.
 */
export async function renameReplacing(from: string, to: string, rename: (a: string, b: string) => void = renameSync, tries = 8): Promise<void> {
  for (let i = 1; ; i++) {
    try {
      rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (i >= tries || !(code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')) throw err;
      await new Promise((r) => setTimeout(r, 5 * i));
    }
  }
}

export class FileDevice implements Device {
  status: DeviceStatus;
  private readonly dir: string;
  /** Its `presence` probes, when the config has any: the sender's panel can't be seen from here otherwise. */
  private readonly monitor: PresenceMonitor | null;
  constructor(cfg: Extract<DeviceConfig, { driver: 'file' }>, deps: ProbeDeps = {}) {
    // In a sandbox, a folder outside it (a real sender's) is moved inside: its panel never shows the sandbox's frames.
    this.dir = confinePath(expandPath(cfg.dir));
    this.status = { driver: 'file', ok: true, message: `writing ${join(this.dir, 'frame.jpg')}`, code: 'fileWriting', params: { path: join(this.dir, 'frame.jpg') }, framesSent: 0, lastSentAt: null };
    const probes = cfg.presence ? probesFor(cfg.presence, this.dir, deps) : [];
    this.monitor = probes.length ? new PresenceMonitor(probes, deps.clock ? { clock: deps.clock } : {}) : null;
  }
  get presence(): PresenceInfo | undefined {
    return this.monitor?.info;
  }
  async send(frame: Buffer): Promise<void> {
    try {
      mkdirSync(this.dir, { recursive: true });
      const tmp = join(this.dir, '.frame.tmp');
      writeFileSync(tmp, frame);
      // Atomic: the sender never reads half a JPEG.
      await renameReplacing(tmp, join(this.dir, 'frame.jpg'));
      this.status.ok = true;
      this.status.framesSent++;
      this.status.lastSentAt = Date.now();
    } catch (err) {
      this.status.ok = false;
      const error = err instanceof Error ? err.message : String(err);
      Object.assign(this.status, { message: `cannot write in ${this.dir}: ${error}`, code: 'fileError', params: { dir: this.dir, error } });
    }
  }
  close(): void {
    this.monitor?.close();
  }
}

class TrccDevice implements Device {
  status: DeviceStatus = { driver: 'trcc', ok: false, message: 'connecting…', code: 'connecting', framesSent: 0, lastSentAt: null };
  private key: string | null = null;
  private connecting: Promise<void> | null = null;
  private stopPin: (() => void) | null = null;
  private readonly o: TrccOptions;
  private readonly cfg: Extract<DeviceConfig, { driver: 'trcc' }>;
  private readonly log: (m: string) => void;
  constructor(cfg: Extract<DeviceConfig, { driver: 'trcc' }>, log: (m: string) => void) {
    this.cfg = cfg;
    this.log = log;
    this.o = { url: cfg.url, ...(cfg.tokenFile ? { tokenFile: expandPath(cfg.tokenFile) } : {}), timeoutMs: 20_000, deviceKey: cfg.deviceKey ?? '', ...(cfg.serial ? { serial: cfg.serial } : {}) };
  }
  private async connect(): Promise<void> {
    if (!(await serverAlive(this.o))) throw coded(`trcc serve is not answering at ${this.cfg.url}`, 'trccDown', { url: this.cfg.url });
    const panel = await detectPanel(this.o);
    if (!panel) throw coded('trcc serve sees no panel', 'trccNoPanel');
    await connectPanel(this.o, panel.key);
    this.key = panel.key;
    this.status.detected = { width: panel.width, height: panel.height };
    Object.assign(this.status, { message: `panel ${panel.key} ${panel.width}×${panel.height}`, code: 'trccPanel', params: { key: panel.key, width: panel.width, height: panel.height } });
    if (this.cfg.keepalive !== false) this.stopPin = pinFrame(this.o, panel.key, 30, (m) => this.log(m));
  }
  async send(frame: Buffer): Promise<void> {
    try {
      if (!this.key) {
        this.connecting ??= this.connect().finally(() => (this.connecting = null));
        await this.connecting;
      }
      await sendFrame(this.o, this.key!, frame);
      this.status.ok = true;
      this.status.framesSent++;
      this.status.lastSentAt = Date.now();
    } catch (err) {
      this.key = null;
      this.stopPin?.();
      this.stopPin = null;
      this.status.ok = false;
      Object.assign(this.status, statusOfError(err));
    }
  }
  close(): void {
    this.stopPin?.();
  }
}

/**
 * A panel over USB, owned by this process. Two things the firmware asks for:
 * a new frame goes out as soon as it exists, and an unchanged one is sent
 * again every `keepalive` seconds, or the panel falls back to the factory logo
 * after 2-3 s. A bus error drops the connection and reconnects with a growing
 * pause; a panel with the configured serial number that is not there is
 * waited for, never replaced by another one.
 */
export class UsbDevice implements Device {
  status: DeviceStatus = { driver: 'usb', ok: false, message: 'connecting…', code: 'connecting', framesSent: 0, lastSentAt: null };
  private readonly cfg: Extract<DeviceConfig, { driver: 'usb' }>;
  private readonly log: (m: string) => void;
  private readonly rotate: number | undefined;
  private readonly open: (serial?: string) => Promise<LyPanel>;
  private readonly retryMs: number;
  private panel: LyPanel | null = null;
  private latest: Buffer | null = null;
  private fresh = false;
  private lastWrite = 0;
  private retryAt = 0;
  private failures = 0;
  private closed = false;
  private pumping: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastMessage = '';

  /** Whether a matching panel is plugged in (presence.ts), looked at without opening it; null: not looked at (tests with a fake `open`). */
  private readonly monitor: PresenceMonitor | null;

  /**
   * `presence`: how to tell whether the panel is plugged in. Default: USB
   * enumeration (read only) for an LY panel with the configured serial, or
   * none when `open` is a fake (no real bus to look at); null: never.
   */
  constructor(cfg: Extract<DeviceConfig, { driver: 'usb' }>, log: (m: string) => void, o: { rotate?: number; open?: (serial?: string) => Promise<LyPanel>; retryMs?: number; presence?: Probe | null; clock?: Clock } = {}) {
    this.cfg = cfg;
    this.log = log;
    this.rotate = o.rotate;
    this.open = o.open ?? ((serial) => LyPanel.open(serial ? { serial } : {}));
    this.retryMs = o.retryMs ?? 1000;
    const every = Math.round(Math.min(2, Math.max(0.1, cfg.keepalive ?? 1)) * 1000);
    this.timer = setInterval(() => void this.pump(), Math.min(every, 250));
    this.timer.unref();
    const probe = o.presence === null || (o.presence === undefined && o.open) ? null : (o.presence ?? usbProbe({ vendorId: VENDOR_ID, productIds: PRODUCT_IDS, serial: cfg.serial }));
    this.monitor = probe ? new PresenceMonitor([probe], { ...(o.clock ? { clock: o.clock } : {}), onChange: (i) => this.presenceChanged(i) }) : null;
  }

  /** Connected, it is there; else what enumeration says. */
  get presence(): PresenceInfo | undefined {
    if (this.panel) return { state: 'present', why: this.describe() };
    return this.monitor?.info;
  }

  private presenceChanged(i: PresenceInfo): void {
    if (this.closed) return;
    if (i.state === 'absent' && !this.panel) {
      // Nothing to keep re-sending: the runtime paints a fresh frame when it is back.
      this.latest = null;
      this.fresh = false;
      this.say(`${i.why}; waiting for it`, false, 'usbAbsent', { serial: this.cfg.serial ?? '' });
    } else if (i.state === 'present') {
      // Plugged in again: no backoff left over from the failures while it was away.
      this.retryAt = 0;
      this.failures = 0;
      void this.pump();
    }
  }

  private say(message: string, ok: boolean, code?: string, params?: Record<string, string | number>): void {
    this.status.ok = ok;
    this.status.message = message;
    this.status.code = code;
    this.status.params = params;
    if (message !== this.lastMessage) {
      this.lastMessage = message;
      this.log(message);
    }
  }

  private due(now: number): boolean {
    return now - this.lastWrite >= Math.min(2, Math.max(0.1, this.cfg.keepalive ?? 1)) * 1000;
  }

  /** Writes what is pending; concurrent callers share one run. */
  private pump(): Promise<void> {
    if (this.pumping) return this.pumping;
    const run = async () => {
      // An unplugged panel is not knocked on: presence says when it is back.
      while (!this.closed && this.latest && Date.now() >= this.retryAt && (this.fresh || this.due(Date.now())) && (this.panel || this.monitor?.state !== 'absent')) {
        try {
          const frame = this.latest;
          this.fresh = false;
          if (!this.panel) await this.connect();
          const kept = await this.panel!.send(frame);
          this.lastWrite = Date.now();
          this.failures = 0;
          this.status.framesSent++;
          this.status.lastSentAt = this.lastWrite;
          const kb = Math.round(frame.length / 1024), limit = Math.round(MAX_FRAME_BYTES / 1024);
          if (!kept) this.say(`the panel dropped a ${kb} KB frame (limit ${limit} KB): lower the JPEG quality`, false, 'usbDropped', { kb, limit });
          else if (!this.status.ok) this.say(this.describe(), true, 'usbConnected', { panel: this.describe() });
        } catch (err) {
          this.fresh = true; // a reconnected panel has nothing on it
          const p = this.panel;
          this.panel = null;
          void p?.close().catch(() => undefined);
          this.failures++;
          this.retryAt = Date.now() + Math.min(30 * this.retryMs, this.retryMs * 2 ** Math.min(this.failures, 5));
          const why = err instanceof Error ? err.message : String(err);
          const serial = this.cfg.serial && !why.includes(this.cfg.serial) ? ` (serial ${this.cfg.serial})` : '';
          const known = statusOfError(err);
          // `reason`: the code of a known failure, which the editor says in its own words.
          this.say(`${why}${serial}; retrying`, false, 'usbRetrying', { why, reason: known.code && known.code !== 'error' ? known.code : '', serial: this.cfg.serial ?? '' });
        }
      }
    };
    this.pumping = run().finally(() => (this.pumping = null));
    return this.pumping;
  }

  private describe(): string {
    const i = this.panel?.info;
    if (!i) return 'usb';
    return `usb ${i.serial ?? i.location ?? ''} PM ${i.pm} SUB ${i.sub}${i.model ? ` ${i.model.width}×${i.model.height}` : ''}`.replace(/\s+/g, ' ');
  }

  private async connect(): Promise<void> {
    const panel = await this.open(this.cfg.serial);
    this.panel = panel;
    const m = panel.info?.model;
    if (m) {
      this.status.detected = { width: m.width, height: m.height, rotate: m.rotate };
      // The picture is turned in the compositor, before encoding. Upright, the screen's angle must be the firmware's
      // mount angle; on its side (portrait) either quarter turn from it is right, depending on which way the panel
      // stands. Only half a turn away is surely wrong: the picture comes out upside down.
      if (this.rotate !== undefined && (((this.rotate - m.rotate) % 360) + 360) % 360 === 180) this.log(`the panel's firmware expects rotation ${m.rotate}° but this screen has ${this.rotate}°: the picture may come out upside down`);
    }
    this.say(this.describe(), true, 'usbConnected', { panel: this.describe() });
  }

  async send(frame: Buffer): Promise<void> {
    this.latest = frame;
    this.fresh = true;
    await this.pump();
  }

  close(): void {
    this.closed = true;
    this.monitor?.close();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const p = this.panel;
    this.panel = null;
    void p?.close().catch(() => undefined);
  }
}

/**
 * The USB devices with this vendor and product ids plugged in now, serial
 * and where, read only: from sysfs on Linux (nothing is opened), else from
 * libusb (opened for a moment to read the serial, never claimed). For
 * `kiosko doctor` and the editor's "Detect panels" of a Frame file screen
 * (its `presence.usb`). Never throws.
 */
export async function listUsbDevices(vendorId: number = VENDOR_ID, productIds: readonly number[] = PRODUCT_IDS): Promise<{ ok: boolean; devices: SeenDevice[]; error?: string }> {
  try {
    return { ok: true, devices: await new DeviceLister({ usb: loadUsb }).list({ vendorId, productIds }, { serials: true }) };
  } catch (err) {
    return { ok: false, devices: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/** The LY panels plugged in (serial and where), without claiming any: for `kiosko doctor`. */
export async function listUsb(): Promise<{ ok: boolean; panels: { serial?: string; pid: number; location: string; error?: string }[]; error?: string }> {
  const r = await listUsbDevices();
  return { ok: r.ok, panels: r.devices.map((d) => ({ ...(d.serial ? { serial: d.serial } : {}), pid: d.pid, location: d.location, ...(d.error ? { error: d.error } : {}) })), ...(r.error ? { error: r.error } : {}) };
}

/** The LY panels libusb sees right now, for the "add screen" menu. Never throws. */
export async function discoverUsb(): Promise<{ serial: string; key: string; width: number; height: number; rotate?: number; location: string; error?: string }[]> {
  if (!sandboxAllows('usb')) return [];
  try {
    const found = await findPanels(await loadUsb());
    const out = [];
    for (const f of found) {
      // The resolution needs the hello, which needs the device: only if no other process has it.
      let model: { width: number; height: number; rotate?: number } | undefined;
      if (f.serial) {
        try {
          const p = await LyPanel.open({ serial: f.serial });
          model = p.info?.model;
          await p.close();
        } catch {
          /* held by another process, or no driver: listed anyway */
        }
      }
      out.push({ serial: f.serial ?? '', key: f.serial ?? `usb ${f.location}`, width: model?.width ?? 0, height: model?.height ?? 0, ...(model?.rotate !== undefined ? { rotate: model.rotate } : {}), location: f.location, ...(f.error ? { error: f.error } : {}) });
    }
    return out;
  } catch {
    return [];
  }
}

export function openDevice(cfg: DeviceConfig, log: (m: string) => void, rotate?: number, remote?: RemoteDeps & { browsers?: BrowserHub }): Device {
  // A sandbox leaves the real panels alone: those on USB, those `trcc serve` drives, the remote screens.
  // A browser screen is left in: it only talks to the network-screens server, which the sandbox confines.
  if ((cfg.driver === 'usb' || cfg.driver === 'trcc') && !sandboxAllows('usb')) return new SandboxedDevice(cfg.driver, 'usb');
  if (cfg.driver === 'remote' && !sandboxAllows('remote')) return new SandboxedDevice(cfg.driver, 'remote');
  switch (cfg.driver) {
    case 'remote':
      return new RemoteDevice(cfg, log, rotate ?? 0, remote);
    case 'browser':
      return new BrowserDevice(cfg, log, remote?.browsers ?? null);
    case 'trcc':
      return new TrccDevice(cfg, log);
    case 'usb':
      return new UsbDevice(cfg, log, rotate === undefined ? {} : { rotate });
    case 'file':
      return new FileDevice(cfg);
    default:
      return new VirtualDevice();
  }
}

/** Panels `trcc serve` can see right now (for the "add screen" dialog). */
export async function discoverTrcc(url = 'http://127.0.0.1:8099', tokenFile?: string): Promise<{ key: string; width: number; height: number }[]> {
  if (!sandboxAllows('usb')) return [];
  const o = { url, ...(tokenFile ? { tokenFile: expandPath(tokenFile) } : {}), timeoutMs: 3000, deviceKey: '' } as TrccOptions;
  try {
    if (!(await serverAlive(o))) return [];
    const p = await detectPanel(o);
    return p ? [{ key: p.key, width: p.width, height: p.height }] : [];
  } catch {
    return [];
  }
}

/** The remote screens on the LAN right now (mDNS), for "Detect panels" and `kiosko doctor`. Never throws. */
export async function discoverRemote(ms = 1500): Promise<{ uid: string; id: string; model: string; width: number; height: number; rotate: number; fw: string; paired: boolean; address: string; port: number; hostname: string }[]> {
  if (!sandboxAllows('remote')) return [];
  try {
    const found = await browser().browse(ms);
    return found.map((f) => ({ uid: f.uid, id: f.id, model: f.model, width: f.w, height: f.h, rotate: f.rot, fw: f.fw, paired: f.paired, address: f.address, port: f.port, hostname: f.hostname }));
  } catch {
    return [];
  }
}

/** The LED of a screen that has one, for the alert that has the screen: red blinking, amber, blue, or off. */
export function ledFor(level: 'info' | 'warn' | 'critical' | null): [rgb: string, blinkMs: number] {
  if (level === 'critical') return ['ff0000', 400];
  if (level === 'warn') return ['ffa000', 1000];
  if (level === 'info') return ['0060ff', 0];
  return ['000000', 0];
}

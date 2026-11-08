/**
 * Panel drivers: how a frame gets to the glass.
 *
 *   virtual  only the editor shows it (no hardware, demos, development)
 *   trcc     `trcc serve` REST API (thermalright-trcc-linux), via @loksly/trcc-client
 *   file     writes `frame.jpg` atomically for an external sender (e.g. a USB
 *            sender bound to a serial number, for several identical panels)
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { connectPanel, detectPanel, pinFrame, sendFrame, serverAlive, type TrccOptions } from '@loksly/trcc-client';
import type { DeviceConfig } from './config/model.ts';
import { expandPath } from './paths.ts';

export interface DeviceStatus {
  driver: DeviceConfig['driver'];
  ok: boolean;
  message: string;
  /** Resolution the hardware reports, if it does. */
  detected?: { width: number; height: number };
  framesSent: number;
  lastSentAt: number | null;
}

export interface Device {
  readonly status: DeviceStatus;
  /** JPEG or PNG, already rotated for the panel. */
  send(frame: Buffer): Promise<void>;
  close(): void;
}

export function encodeFor(device: DeviceConfig, jpegQuality: number): 'png' | 'jpeg' {
  if (device.driver === 'file') return device.format ?? 'jpeg';
  return jpegQuality > 0 ? 'jpeg' : 'png';
}

class VirtualDevice implements Device {
  status: DeviceStatus = { driver: 'virtual', ok: true, message: 'virtual: shown only in the editor', framesSent: 0, lastSentAt: null };
  async send(): Promise<void> {
    this.status.framesSent++;
    this.status.lastSentAt = Date.now();
  }
  close(): void {}
}

class FileDevice implements Device {
  status: DeviceStatus;
  private readonly dir: string;
  constructor(cfg: Extract<DeviceConfig, { driver: 'file' }>) {
    this.dir = expandPath(cfg.dir);
    this.status = { driver: 'file', ok: true, message: `writing ${join(this.dir, 'frame.jpg')}`, framesSent: 0, lastSentAt: null };
  }
  async send(frame: Buffer): Promise<void> {
    try {
      mkdirSync(this.dir, { recursive: true });
      const tmp = join(this.dir, '.frame.tmp');
      writeFileSync(tmp, frame);
      // Atomic: the sender never reads half a JPEG.
      renameSync(tmp, join(this.dir, 'frame.jpg'));
      this.status.ok = true;
      this.status.framesSent++;
      this.status.lastSentAt = Date.now();
    } catch (err) {
      this.status.ok = false;
      this.status.message = `cannot write in ${this.dir}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  close(): void {}
}

class TrccDevice implements Device {
  status: DeviceStatus = { driver: 'trcc', ok: false, message: 'connecting…', framesSent: 0, lastSentAt: null };
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
    if (!(await serverAlive(this.o))) throw new Error(`trcc serve is not answering at ${this.cfg.url}`);
    const panel = await detectPanel(this.o);
    if (!panel) throw new Error('trcc serve sees no panel');
    await connectPanel(this.o, panel.key);
    this.key = panel.key;
    this.status.detected = { width: panel.width, height: panel.height };
    this.status.message = `panel ${panel.key} ${panel.width}×${panel.height}`;
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
      this.status.message = err instanceof Error ? err.message : String(err);
    }
  }
  close(): void {
    this.stopPin?.();
  }
}

export function openDevice(cfg: DeviceConfig, log: (m: string) => void): Device {
  switch (cfg.driver) {
    case 'trcc':
      return new TrccDevice(cfg, log);
    case 'file':
      return new FileDevice(cfg);
    default:
      return new VirtualDevice();
  }
}

/** Panels `trcc serve` can see right now (for the "add screen" dialog). */
export async function discoverTrcc(url = 'http://127.0.0.1:8099', tokenFile?: string): Promise<{ key: string; width: number; height: number }[]> {
  const o = { url, ...(tokenFile ? { tokenFile: expandPath(tokenFile) } : {}), timeoutMs: 3000, deviceKey: '' } as TrccOptions;
  try {
    if (!(await serverAlive(o))) return [];
    const p = await detectPanel(o);
    return p ? [{ key: p.key, width: p.width, height: p.height }] : [];
  } catch {
    return [];
  }
}

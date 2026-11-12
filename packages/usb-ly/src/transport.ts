/**
 * The USB side: one panel opened by VID/PID (and USB serial number), through
 * libusb (the `usb` npm package, an optional dependency with prebuilt
 * binaries for Linux, macOS and Windows).
 *
 * Windows needs the **WinUSB** driver on the device (Zadig, or an INF), or
 * libusb answers LIBUSB_ERROR_NOT_SUPPORTED when opening it; `usb.useUsbDkBackend()`
 * is the alternative with UsbDK. Linux needs a udev rule giving your user
 * access to 0416:5408.
 */
import type { Device, InEndpoint, Interface, OutEndpoint } from 'usb';
import { ACK_TIMEOUT_MS, PRODUCT_IDS, VENDOR_ID } from './protocol.ts';

/** What the panel code needs from a USB pipe; fakes implement this in tests. */
export interface Transport {
  write(data: Buffer, timeoutMs: number): Promise<void>;
  read(length: number, timeoutMs: number): Promise<Buffer>;
  close(): Promise<void>;
}

/** The part of the `usb` module that is used; tests pass a fake. */
export interface UsbModule {
  getDeviceList(): Device[];
}

export class PanelNotFound extends Error {
  override name = 'PanelNotFound';
}

export class UsbUnavailable extends Error {
  override name = 'UsbUnavailable';
}

/** Loads libusb on demand, so a missing or broken native module never breaks anything that doesn't use USB. */
export async function loadUsb(): Promise<UsbModule> {
  try {
    const m = (await import('usb')) as unknown as { usb?: UsbModule; getDeviceList?: () => Device[]; default?: { getDeviceList?: () => Device[] } };
    const mod = m.getDeviceList ? (m as unknown as UsbModule) : m.default?.getDeviceList ? (m.default as unknown as UsbModule) : m.usb;
    if (!mod?.getDeviceList) throw new Error('the usb module has no getDeviceList');
    return mod;
  } catch (err) {
    throw new UsbUnavailable(`cannot load the "usb" package (libusb): ${err instanceof Error ? err.message : String(err)}. Install it with: npm install usb`);
  }
}

const call = <T>(fn: (cb: (err?: Error | null, value?: T) => void) => void): Promise<T> =>
  new Promise((resolve, reject) => fn((err, value) => (err ? reject(err) : resolve(value as T))));

async function serialOf(device: Device): Promise<string | undefined> {
  const index = device.deviceDescriptor.iSerialNumber;
  if (!index) return undefined;
  const value = await call<string | undefined>((cb) => device.getStringDescriptor(index, (e, v) => cb(e ?? null, v)));
  return value?.trim() || undefined;
}

export interface FoundPanel {
  pid: number;
  /** USB serial number; undefined if the panel has none or it couldn't be read. */
  serial?: string;
  /** Where it is plugged: `bus-address`; changes when it is moved. */
  location: string;
  /** Why the serial could not be read (a driver, permissions). */
  error?: string;
  device: Device;
}

/** Every LY panel libusb sees, with its serial number. Opens each only to read it. */
export async function findPanels(usb: UsbModule, filter: { pid?: number } = {}): Promise<FoundPanel[]> {
  const out: FoundPanel[] = [];
  for (const device of usb.getDeviceList()) {
    const d = device.deviceDescriptor;
    if (d.idVendor !== VENDOR_ID || !PRODUCT_IDS.includes(d.idProduct) || (filter.pid && d.idProduct !== filter.pid)) continue;
    const found: FoundPanel = { pid: d.idProduct, location: `${device.busNumber}-${device.deviceAddress}`, device };
    try {
      device.open();
      try {
        const serial = await serialOf(device);
        if (serial) found.serial = serial;
      } finally {
        device.close();
      }
    } catch (err) {
      found.error = err instanceof Error ? err.message : String(err);
    }
    out.push(found);
  }
  return out;
}

class UsbTransport implements Transport {
  private detached = false;
  private readonly device: Device;
  private readonly iface: Interface;
  private readonly out: OutEndpoint;
  private readonly inp: InEndpoint;

  constructor(device: Device, iface: Interface, out: OutEndpoint, inp: InEndpoint) {
    this.device = device;
    this.iface = iface;
    this.out = out;
    this.inp = inp;
  }

  static async open(found: FoundPanel, os: NodeJS.Platform = process.platform): Promise<UsbTransport> {
    const { device } = found;
    device.open();
    let iface: Interface | undefined;
    let detached = false;
    try {
      // The kernel may have bound a driver (usbhid, usb-storage…) to the interface.
      if (device.configDescriptor?.bConfigurationValue !== 1) await call<void>((cb) => device.setConfiguration(1, (e) => cb(e ?? null)));
      iface = device.interface(0);
      if (os === 'linux' && iface.isKernelDriverActive()) {
        iface.detachKernelDriver();
        detached = true;
      }
      iface.claim();
      const eps = iface.endpoints;
      const out = eps.find((e) => e.direction === 'out') as OutEndpoint | undefined;
      const inp = eps.find((e) => e.direction === 'in') as InEndpoint | undefined;
      if (!out || !inp) throw new Error('the panel has no bulk IN/OUT endpoints on interface 0');
      const t = new UsbTransport(device, iface, out, inp);
      t.detached = detached;
      return t;
    } catch (err) {
      try {
        if (iface && detached) iface.attachKernelDriver();
      } catch {
        /* nothing to give back */
      }
      device.close();
      throw err;
    }
  }

  async write(data: Buffer, timeoutMs: number): Promise<void> {
    this.out.timeout = timeoutMs;
    await call<number>((cb) => this.out.transfer(data, (e, n) => cb(e ?? null, n)));
  }

  async read(length: number, timeoutMs = ACK_TIMEOUT_MS): Promise<Buffer> {
    this.inp.timeout = timeoutMs;
    return call<Buffer>((cb) => this.inp.transfer(length, (e, d) => cb(e ?? null, d)));
  }

  async close(): Promise<void> {
    try {
      await call<void>((cb) => this.iface.release(true, (e) => cb(e ?? null)));
    } catch {
      /* already gone */
    }
    try {
      if (this.detached) this.iface.attachKernelDriver();
    } catch {
      /* the kernel gives it back on replug */
    }
    try {
      this.device.close();
    } catch {
      /* unplugged */
    }
  }
}

export interface OpenOptions {
  /**
   * USB serial number of the panel to use. With several identical panels this
   * is the only thing that tells them apart, and **a serial that is not found
   * is an error, never "the first one"**: taking a twin another process holds
   * would leave it blank. Without it, the first panel is used.
   */
  serial?: string;
  pid?: number;
  usb?: UsbModule;
  os?: NodeJS.Platform;
}

/** Opens one panel. Throws PanelNotFound if it isn't there. */
export async function openTransport(o: OpenOptions = {}): Promise<{ transport: Transport; pid: number; serial?: string; location: string }> {
  const usb = o.usb ?? (await loadUsb());
  const all = await findPanels(usb, o.pid ? { pid: o.pid } : {});
  const found = o.serial ? all.find((p) => p.serial === o.serial) : all[0];
  if (!found) {
    const seen = all.map((p) => p.serial ?? `(${p.error ?? 'no serial'}) at ${p.location}`).join(', ');
    throw new PanelNotFound(o.serial ? `no panel with serial ${o.serial}${all.length ? ` (found: ${seen})` : ' (none plugged in)'}` : 'no LY panel found');
  }
  const transport = await UsbTransport.open(found, o.os);
  return { transport, pid: found.pid, ...(found.serial ? { serial: found.serial } : {}), location: found.location };
}

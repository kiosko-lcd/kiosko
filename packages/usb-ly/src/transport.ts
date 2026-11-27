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
import { readdirSync, readFileSync } from 'node:fs';
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

/** A USB device as enumeration sees it, without opening it. */
export interface SeenDevice {
  vid: number;
  pid: number;
  /** USB serial number; undefined when it has none or it couldn't be read without disturbing anyone. */
  serial?: string;
  /** Where it is plugged: `bus-address`, as `FoundPanel.location`. */
  location: string;
  /** Why the serial is unknown (a driver, permissions, held by another process). */
  error?: string;
}

/** Which devices to list: a vendor and its product ids. */
export interface DeviceFilter {
  vendorId: number;
  productIds: readonly number[];
}

/** The bits of `node:fs` the sysfs reader uses; tests pass a fake tree. */
export interface SysfsFs {
  readdirSync(path: string): string[];
  readFileSync(path: string, enc: 'utf8'): string;
}

/**
 * Linux: the USB devices in sysfs (`/sys/bus/usb/devices`), serial included,
 * without opening a single one: no libusb, no file descriptor on the device,
 * nothing another process holding it could notice. Null when there is no
 * sysfs to read (not Linux, a container without /sys).
 */
export function sysfsDevices(filter: DeviceFilter, root = '/sys/bus/usb/devices', fs?: SysfsFs): SeenDevice[] | null {
  const io = fs ?? sysfsIo;
  let names: string[];
  try {
    names = io.readdirSync(root);
  } catch {
    return null;
  }
  const out: SeenDevice[] = [];
  const read = (dir: string, f: string): string | undefined => {
    try {
      return io.readFileSync(`${root}/${dir}/${f}`, 'utf8').trim();
    } catch {
      return undefined;
    }
  };
  for (const name of names) {
    // Interfaces ("3-9:1.0") have no idVendor; root hubs ("usb3") are never panels.
    if (name.includes(':')) continue;
    const vid = parseInt(read(name, 'idVendor') ?? '', 16);
    const pid = parseInt(read(name, 'idProduct') ?? '', 16);
    if (vid !== filter.vendorId || !filter.productIds.includes(pid)) continue;
    const serial = read(name, 'serial');
    const bus = Number(read(name, 'busnum'));
    const dev = Number(read(name, 'devnum'));
    out.push({ vid, pid, location: Number.isFinite(bus) && Number.isFinite(dev) ? `${bus}-${dev}` : name, ...(serial ? { serial } : {}) });
  }
  return out;
}

const sysfsIo: SysfsFs = { readdirSync: (p) => readdirSync(p), readFileSync: (p, enc) => readFileSync(p, enc) };

/**
 * Lists the devices that match `filter`, as unobtrusively as the platform
 * allows, for telling whether a panel is plugged in (presence) while another
 * process may be driving it:
 *
 * - Linux: sysfs (`sysfsDevices`): nothing is opened, ever.
 * - Elsewhere: libusb's device list; the serial needs the device opened for
 *   a moment (never claimed), and only when `serials` is asked for, once per
 *   plugged device (`bus-address`, which changes on every replug). A device
 *   that can't be opened (another process has it, no WinUSB driver) is listed
 *   without a serial and with the reason.
 */
export class DeviceLister {
  private readonly serials = new Map<string, { serial?: string; error?: string }>();
  private readonly o: { usb?: UsbModule | (() => Promise<UsbModule>); sysfs?: string | null; fs?: SysfsFs; platform?: NodeJS.Platform };
  private usb: UsbModule | null = null;

  constructor(o: { usb?: UsbModule | (() => Promise<UsbModule>); sysfs?: string | null; fs?: SysfsFs; platform?: NodeJS.Platform } = {}) {
    this.o = o;
  }

  /** Synchronous on Linux (sysfs); null there means "ask `list`". */
  listSync(filter: DeviceFilter): SeenDevice[] | null {
    if ((this.o.platform ?? process.platform) !== 'linux' || this.o.sysfs === null) return null;
    return sysfsDevices(filter, this.o.sysfs ?? undefined, this.o.fs);
  }

  /** Throws `UsbUnavailable` when neither sysfs nor libusb can be read. */
  async list(filter: DeviceFilter, o: { serials?: boolean } = {}): Promise<SeenDevice[]> {
    const fromSys = this.listSync(filter);
    if (fromSys) return fromSys;
    const usb = (this.usb ??= typeof this.o.usb === 'function' ? await this.o.usb() : (this.o.usb ?? (await loadUsb())));
    const out: SeenDevice[] = [];
    const seen = new Set<string>();
    for (const device of usb.getDeviceList()) {
      const d = device.deviceDescriptor;
      if (d.idVendor !== filter.vendorId || !filter.productIds.includes(d.idProduct)) continue;
      const location = `${device.busNumber}-${device.deviceAddress}`;
      const key = `${location}/${d.idVendor}:${d.idProduct}`;
      seen.add(key);
      let s = this.serials.get(key);
      if (!s && o.serials) {
        s = {};
        try {
          device.open();
          try {
            const serial = await serialOf(device);
            if (serial) s.serial = serial;
          } finally {
            device.close();
          }
        } catch (err) {
          s.error = err instanceof Error ? err.message : String(err);
        }
        // An error is not cached: the other process may let go of it.
        if (!s.error) this.serials.set(key, s);
      }
      out.push({ vid: d.idVendor, pid: d.idProduct, location, ...(s?.serial ? { serial: s.serial } : {}), ...(s?.error ? { error: s.error } : {}) });
    }
    for (const k of this.serials.keys()) if (!seen.has(k)) this.serials.delete(k);
    return out;
  }
}

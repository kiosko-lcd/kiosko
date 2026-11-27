import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Device } from 'usb';
import { LyPanel } from './panel.ts';
import { CHUNK_SIZE, MAX_FRAME_BYTES, PID_LY, PID_LY1 } from './protocol.ts';
import { DeviceLister, findPanels, openTransport, PanelNotFound, sysfsDevices, type SysfsFs, type Transport, type UsbModule } from './transport.ts';

/** A panel's firmware, as far as the protocol goes: answers the hello, reassembles frames, ACKs. */
class FakeFirmware implements Transport {
  frames: Buffer[] = [];
  writes: number[] = [];
  closed = false;
  failNext = false;
  private pending: Buffer[] = [];
  private reply: Buffer | null = null;
  private expectChunks = 0;
  private got: Buffer[] = [];

  write(data: Buffer): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error('LIBUSB_ERROR_TIMEOUT'));
    }
    this.writes.push(data.length);
    if (data[0] === 0x02 && data[1] === 0xff && data.length === 2048) {
      const r = Buffer.alloc(512);
      r[0] = 3;
      r[1] = 0xff;
      r[8] = 1;
      r[20] = 1;
      r[22] = 4;
      this.reply = r;
      return Promise.resolve();
    }
    this.pending.push(Buffer.from(data));
    const all = Buffer.concat(this.pending);
    const first = all.subarray(0, 16);
    const n = first.readUInt16LE(9);
    const padded = first[8] === 1 ? Math.ceil(n / 4) * 4 : n;
    if (all.length >= padded * CHUNK_SIZE) {
      this.pending = [];
      let payload = Buffer.alloc(0);
      for (let i = 0; i < n; i++) {
        const c = all.subarray(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
        assert.equal(c.readUInt16LE(11), i, 'chunk index');
        assert.equal(c.readUInt16LE(9), n, 'chunk count');
        payload = Buffer.concat([payload, c.subarray(16, 16 + c.readUInt16LE(6))]);
      }
      assert.equal(payload.length, first.readUInt32LE(2), 'total size in every header');
      this.frames.push(payload);
      this.reply = Buffer.alloc(512);
      this.reply[0] = 3;
      this.reply[1] = 0xff;
      // The firmware keeps up to 1032 chunks and drops anything bigger.
      this.reply[8] = n <= 1032 ? 1 : 2;
    }
    return Promise.resolve();
  }

  read(): Promise<Buffer> {
    if (!this.reply) return Promise.reject(new Error('LIBUSB_ERROR_TIMEOUT'));
    const r = this.reply;
    this.reply = null;
    return Promise.resolve(r);
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

const jpeg = (n: number) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 7) & 255));

test('connect: the Trofeo Vision answers PM 65 SUB 5 and trcc knows it as 1920×462, mounted at 180°', async () => {
  const panel = new LyPanel(new FakeFirmware(), PID_LY, { serial: 'ABC' });
  const info = await panel.connect();
  assert.equal(info.pm, 65);
  assert.equal(info.sub, 5);
  assert.deepEqual(info.model, { width: 1920, height: 462, rotate: 180 });
  assert.equal(info.serial, 'ABC');
});

test('send: the firmware reassembles exactly the JPEG, for LY and LY1', async () => {
  for (const pid of [PID_LY, PID_LY1]) {
    const fw = new FakeFirmware();
    const panel = new LyPanel(fw, pid);
    await panel.connect();
    const data = jpeg(70_000);
    assert.equal(await panel.send(data), true);
    assert.deepEqual(fw.frames[0], data);
  }
});

test('send: a frame the firmware drops is reported (false), not thrown', async () => {
  const fw = new FakeFirmware();
  const panel = new LyPanel(fw, PID_LY);
  await panel.connect();
  assert.equal(await panel.send(jpeg(MAX_FRAME_BYTES)), true, 'the measured ceiling is kept');
  assert.equal(await panel.send(jpeg(MAX_FRAME_BYTES + 1)), false, 'one byte more is dropped');
});

test('send: a bus error rejects (the caller reconnects) and the queue keeps working', async () => {
  const fw = new FakeFirmware();
  const panel = new LyPanel(fw, PID_LY);
  await panel.connect();
  fw.failNext = true;
  await assert.rejects(panel.send(jpeg(5000)), /TIMEOUT/);
  assert.equal(await panel.send(jpeg(5000)), true);
});

test('send: concurrent calls are written one after another, never interleaved', async () => {
  const fw = new FakeFirmware();
  const panel = new LyPanel(fw, PID_LY);
  await panel.connect();
  const a = jpeg(30_000);
  const b = Buffer.from(jpeg(31_000).map((x) => x ^ 0xff));
  const results = await Promise.all([panel.send(a), panel.send(b)]);
  assert.deepEqual(results, [true, true]);
  assert.deepEqual(fw.frames, [a, b]);
});

// ---- the libusb side, with fake devices -------------------------------------

function fakeDevice(o: { serial?: string; pid?: number; vid?: number; location?: number; unreadable?: boolean; kernelDriver?: boolean }) {
  const log: string[] = [];
  const iface = {
    endpoints: [
      { direction: 'in', timeout: 0, transfer: () => undefined },
      { direction: 'out', timeout: 0, transfer: () => undefined },
    ],
    isKernelDriverActive: () => !!o.kernelDriver,
    detachKernelDriver: () => log.push('detach'),
    attachKernelDriver: () => log.push('attach'),
    claim: () => log.push('claim'),
    release: (_: boolean, cb: (e?: Error) => void) => {
      log.push('release');
      cb();
    },
  };
  const device = {
    busNumber: 3,
    deviceAddress: o.location ?? 5,
    deviceDescriptor: { idVendor: o.vid ?? 0x0416, idProduct: o.pid ?? PID_LY, iSerialNumber: o.serial ? 3 : 0 },
    configDescriptor: { bConfigurationValue: 1 },
    open: () => {
      if (o.unreadable) throw new Error('LIBUSB_ERROR_NOT_SUPPORTED');
      log.push('open');
    },
    close: () => log.push('close'),
    getStringDescriptor: (_: number, cb: (e?: Error, v?: string) => void) => cb(undefined, o.serial),
    setConfiguration: (_: number, cb: (e?: Error) => void) => cb(),
    interface: () => iface,
  };
  return { device: device as unknown as Device, log };
}

const usbOf = (...devs: { device: Device }[]): UsbModule => ({ getDeviceList: () => devs.map((d) => d.device) });

test('findPanels: only LY panels, with their serial; an unreadable one is listed with the reason (WinUSB missing)', async () => {
  const a = fakeDevice({ serial: 'AAA', location: 5 });
  const other = fakeDevice({ serial: 'ZZZ', vid: 0x046d, pid: 0xc534 });
  const b = fakeDevice({ serial: 'BBB', pid: PID_LY1, location: 7 });
  const c = fakeDevice({ unreadable: true, location: 9 });
  const found = await findPanels(usbOf(a, other, b, c));
  assert.deepEqual(
    found.map((f) => [f.serial, f.pid, f.location, f.error]),
    [['AAA', PID_LY, '3-5', undefined], ['BBB', PID_LY1, '3-7', undefined], [undefined, PID_LY, '3-9', 'LIBUSB_ERROR_NOT_SUPPORTED']],
  );
  assert.ok(a.log.includes('close'), 'the handle used to read the serial is closed again');
});

test('openTransport: with a serial it opens that panel, never a twin', async () => {
  const a = fakeDevice({ serial: 'AAA' });
  const b = fakeDevice({ serial: 'BBB' });
  const t = await openTransport({ serial: 'BBB', usb: usbOf(a, b), os: 'linux' });
  assert.equal(t.serial, 'BBB');
  assert.ok(b.log.includes('claim'));
  assert.ok(!a.log.includes('claim'));
  await assert.rejects(openTransport({ serial: 'NOPE', usb: usbOf(a, b) }), (e: Error) => e instanceof PanelNotFound && /AAA, BBB/.test(e.message));
  await assert.rejects(openTransport({ serial: 'AAA', usb: usbOf() }), /none plugged in/);
});

test('openTransport: without a serial, the first panel', async () => {
  const a = fakeDevice({ serial: 'AAA' });
  const b = fakeDevice({ serial: 'BBB' });
  assert.equal((await openTransport({ usb: usbOf(a, b), os: 'linux' })).serial, 'AAA');
});

test('open and close hand the kernel driver back on Linux, and leave it alone elsewhere', async () => {
  const lin = fakeDevice({ serial: 'A', kernelDriver: true });
  const t = await openTransport({ usb: usbOf(lin), os: 'linux' });
  assert.ok(lin.log.includes('detach'));
  await t.transport.close();
  assert.deepEqual(lin.log.filter((l) => ['detach', 'claim', 'release', 'attach'].includes(l)), ['detach', 'claim', 'release', 'attach']);
  const win = fakeDevice({ serial: 'A', kernelDriver: true });
  await (await openTransport({ usb: usbOf(win), os: 'win32' })).transport.close();
  assert.ok(!win.log.includes('detach') && !win.log.includes('attach'), 'Windows has no kernel driver to detach');
});

/** A /sys/bus/usb/devices of three identical panels (one without a serial), a mouse, a hub and their interfaces. */
function sysfs(tree: Record<string, Record<string, string>>): SysfsFs & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    readdirSync: () => Object.keys(tree),
    readFileSync: (p: string) => {
      reads.push(p);
      const [, dir, file] = /\/([^/]+)\/([^/]+)$/.exec(p)!;
      const v = tree[dir!]?.[file!];
      if (v === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return `${v}\n`;
    },
  };
}

const TREE = {
  usb3: { idVendor: '1d6b', idProduct: '0002', busnum: '3', devnum: '1' },
  '3-4': { idVendor: '0416', idProduct: '5408', serial: '2025ECF47BED', busnum: '3', devnum: '4' },
  '3-4:1.0': { bInterfaceClass: 'ff' },
  '3-5': { idVendor: '0416', idProduct: '5408', busnum: '3', devnum: '7' },
  '3-9': { idVendor: '0416', idProduct: '5408', serial: '202592047DAE', busnum: '3', devnum: '6' },
  '1-2': { idVendor: '046d', idProduct: 'c534', serial: 'MOUSE', busnum: '1', devnum: '2' },
};

test('sysfsDevices: the matching devices with serial and bus-address, from files only (nothing opened)', () => {
  const fs = sysfs(TREE);
  const seen = sysfsDevices({ vendorId: 0x0416, productIds: [PID_LY] }, '/sys/bus/usb/devices', fs);
  assert.deepEqual(seen, [
    { vid: 0x0416, pid: PID_LY, location: '3-4', serial: '2025ECF47BED' },
    { vid: 0x0416, pid: PID_LY, location: '3-7' },
    { vid: 0x0416, pid: PID_LY, location: '3-6', serial: '202592047DAE' },
  ]);
  assert.ok(!fs.reads.some((p) => p.includes(':')), 'interfaces are skipped');
  assert.equal(sysfsDevices({ vendorId: 1, productIds: [1] }, '/nope', { readdirSync: () => { throw new Error('ENOENT'); }, readFileSync: () => '' }), null, 'no sysfs: null');
});

test('DeviceLister: Linux reads sysfs and never loads libusb', async () => {
  const lister = new DeviceLister({ platform: 'linux', fs: sysfs(TREE), usb: () => Promise.reject(new Error('libusb must not be loaded')) });
  const seen = await lister.list({ vendorId: 0x0416, productIds: [PID_LY] }, { serials: true });
  assert.deepEqual(seen.map((d) => d.serial ?? null), ['2025ECF47BED', null, '202592047DAE']);
  assert.ok(lister.listSync({ vendorId: 0x0416, productIds: [PID_LY] }));
});

test('DeviceLister: elsewhere libusb, opened only to read a serial (never claimed), once per plugged device; an unreadable one says why and is tried again', async () => {
  const a = fakeDevice({ serial: 'AAA', location: 5 });
  const b = fakeDevice({ unreadable: true, location: 9 });
  const mouse = fakeDevice({ serial: 'M', vid: 0x046d, pid: 0xc534, location: 2 });
  const lister = new DeviceLister({ platform: 'win32', usb: usbOf(a, b, mouse) });
  const filter = { vendorId: 0x0416, productIds: [PID_LY] };
  assert.equal(lister.listSync(filter), null);
  // Without serials asked for: nothing is opened at all.
  const bare = await lister.list(filter);
  assert.deepEqual(bare.map((d) => [d.location, d.serial]), [['3-5', undefined], ['3-9', undefined]]);
  assert.equal(a.log.length, 0);
  const seen = await lister.list(filter, { serials: true });
  assert.deepEqual(seen.map((d) => [d.location, d.serial, d.error]), [['3-5', 'AAA', undefined], ['3-9', undefined, 'LIBUSB_ERROR_NOT_SUPPORTED']]);
  assert.deepEqual(a.log, ['open', 'close']);
  await lister.list(filter, { serials: true });
  assert.deepEqual(a.log, ['open', 'close'], 'the serial is remembered for that bus-address');
  assert.ok(!a.log.includes('claim') && !mouse.log.length);
});

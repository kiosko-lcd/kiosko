import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LyPanel, MAX_FRAME_BYTES, PID_LY, PanelNotFound, type Transport } from '@loksly/usb-ly';
import { UsbDevice, encodeFor } from './devices.ts';

/** A panel's USB pipe: answers the hello and ACKs frames; counts what it gets. */
class Pipe implements Transport {
  frames = 0;
  fail = false;
  closed = false;
  private reply: Buffer | null = null;
  private bytes = 0;
  private want = 0;
  private n = 0;
  write(d: Buffer): Promise<void> {
    if (this.fail) return Promise.reject(new Error('LIBUSB_ERROR_NO_DEVICE'));
    if (d[0] === 2 && d.length === 2048) {
      this.reply = Buffer.alloc(512);
      this.reply[0] = 3;
      this.reply[1] = 0xff;
      this.reply[8] = 1;
      this.reply[20] = 1;
      this.reply[22] = 4;
      return Promise.resolve();
    }
    if (this.bytes === 0) {
      this.n = d.readUInt16LE(9);
      this.want = Math.ceil(this.n / 4) * 4 * 512;
    }
    this.bytes += d.length;
    if (this.bytes >= this.want) {
      this.bytes = 0;
      this.frames++;
      this.reply = Buffer.alloc(512);
      this.reply[8] = this.n > 1032 ? 2 : 1;
    }
    return Promise.resolve();
  }
  read(): Promise<Buffer> {
    const r = this.reply ?? Buffer.alloc(512);
    this.reply = null;
    return Promise.resolve(r);
  }
  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

const jpeg = (n: number) => Buffer.alloc(n, 7);
/** Waits until `cond` holds (or 3 s): timers under load are never exact. */
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 300 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
}

async function panelOver(pipe: Pipe) {
  const p = new LyPanel(pipe, PID_LY, { serial: 'SER1' });
  await p.connect();
  return p;
}

test('usb: the first frame connects and goes out at once; the status says which panel', async () => {
  const pipe = new Pipe();
  const log: string[] = [];
  const dev = new UsbDevice({ driver: 'usb', serial: 'SER1' }, (m) => log.push(m), { open: () => panelOver(pipe), rotate: 180 });
  await dev.send(jpeg(5000));
  assert.equal(pipe.frames, 1);
  assert.equal(dev.status.ok, true);
  assert.equal(dev.status.framesSent, 1);
  assert.match(dev.status.message, /SER1 PM 65 SUB 5 1920×462/);
  assert.deepEqual(dev.status.detected, { width: 1920, height: 462 });
  assert.equal(log.filter((m) => /rotation/.test(m)).length, 0, 'the screen turns the picture as the firmware wants');
  dev.close();
  assert.equal(pipe.closed, true);
});

test('usb: warns when the screen is mounted differently from what the firmware expects', async () => {
  const log: string[] = [];
  const dev = new UsbDevice({ driver: 'usb' }, (m) => log.push(m), { open: () => panelOver(new Pipe()), rotate: 0 });
  await dev.send(jpeg(1000));
  assert.ok(log.some((m) => /expects rotation 180° but this screen has 0°/.test(m)));
  dev.close();
});

test('usb: an unchanged frame is sent again every keepalive; a new one right away', async () => {
  const pipe = new Pipe();
  const dev = new UsbDevice({ driver: 'usb', keepalive: 0.1 }, () => undefined, { open: () => panelOver(pipe) });
  await dev.send(jpeg(2000));
  await until(() => pipe.frames >= 3);
  assert.ok(pipe.frames >= 3, `keepalive resent the frame (${pipe.frames})`);
  const before = pipe.frames;
  await dev.send(jpeg(3000));
  assert.ok(pipe.frames > before, 'the new frame did not wait for the keepalive');
  dev.close();
});

test('usb: a bus error is reported, the panel is reopened and the frame goes out again', async () => {
  const first = new Pipe();
  const second = new Pipe();
  const pipes = [first, second];
  const log: string[] = [];
  const dev = new UsbDevice({ driver: 'usb', keepalive: 0.1 }, (m) => log.push(m), { open: () => panelOver(pipes.shift()!), retryMs: 20 });
  await dev.send(jpeg(2000));
  first.fail = true;
  await until(() => second.frames >= 1);
  assert.equal(second.frames >= 1, true, 'the new connection got the picture again');
  assert.equal(dev.status.ok, true);
  assert.ok(log.some((m) => /NO_DEVICE.*retrying/.test(m)));
  assert.equal(first.closed, true);
  dev.close();
});

test('usb: a panel that is not there is waited for, and said so, with its serial', async () => {
  let calls = 0;
  const dev = new UsbDevice({ driver: 'usb', serial: 'GONE', keepalive: 0.1 }, () => undefined, {
    open: () => {
      calls++;
      return Promise.reject(new PanelNotFound('no panel with serial GONE (found: AAA, BBB)'));
    },
    retryMs: 20,
  });
  await dev.send(jpeg(1000));
  assert.equal(dev.status.ok, false);
  assert.match(dev.status.message, /no panel with serial GONE.*retrying/);
  await until(() => calls >= 2);
  assert.ok(calls >= 2, 'it keeps trying');
  dev.close();
});

test('usb: a frame over the firmware limit is reported instead of silently showing the old picture', async () => {
  const dev = new UsbDevice({ driver: 'usb' }, () => undefined, { open: () => panelOver(new Pipe()) });
  await dev.send(jpeg(MAX_FRAME_BYTES + 1));
  assert.equal(dev.status.ok, false);
  assert.match(dev.status.message, /dropped a \d+ KB frame.*lower the JPEG quality/);
  await dev.send(jpeg(5000));
  assert.equal(dev.status.ok, true, 'and recovers with the next small one');
  dev.close();
});

test('usb: always JPEG, whatever the quality setting says', () => {
  assert.equal(encodeFor({ driver: 'usb' }, 0), 'jpeg');
  assert.equal(encodeFor({ driver: 'usb' }, 90), 'jpeg');
});

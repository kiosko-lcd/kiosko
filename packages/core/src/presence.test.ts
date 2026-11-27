import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { SeenDevice } from '@loksly/usb-ly';
import { FileDevice } from './devices.ts';
import { ABSENT_MAX_MS, PresenceMonitor, combine, commandProbe, heartbeatProbe, hexId, nextDelay, probesFor, runCommand, usbProbe, usbVerdict, type Clock, type Probe, type UsbList } from './presence.ts';

/** Timers that only move when the test says so. */
class FakeClock implements Clock {
  t = 1_000_000;
  private timers: { at: number; fn: () => void; id: number }[] = [];
  private next = 1;
  now(): number {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.next++;
    this.timers.push({ at: this.t + ms, fn, id });
    return id;
  }
  clearTimeout(h: unknown): void {
    this.timers = this.timers.filter((x) => x.id !== h);
  }
  /** Moves time on, firing what falls due, in order. */
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at);
      const first = this.timers[0];
      if (!first || first.at > end) break;
      this.timers.shift();
      this.t = first.at;
      first.fn();
    }
    this.t = end;
  }
  get pending(): number[] {
    return this.timers.map((x) => x.at - this.t).sort((a, b) => a - b);
  }
}

const LY = { vendorId: 0x0416, productIds: [0x5408] };
const dev = (serial: string | undefined, location: string, error?: string): SeenDevice => ({ vid: 0x0416, pid: 0x5408, location, ...(serial ? { serial } : {}), ...(error ? { error } : {}) });

test('usbVerdict: identical panels told apart by serial; without one, paused only when none is plugged in', () => {
  const three = [dev('AAA', '3-4'), dev('BBB', '3-5'), dev('CCC', '3-9')];
  assert.equal(usbVerdict(three, { ...LY, serial: 'BBB' }).state, 'present');
  // Two of three unplugged: the screens of the missing serials pause, the other doesn't.
  const one = [dev('CCC', '3-9')];
  assert.equal(usbVerdict(one, { ...LY, serial: 'AAA' }).state, 'absent');
  assert.match(usbVerdict(one, { ...LY, serial: 'AAA' }).why, /serial AAA.*plugged in: CCC/);
  assert.equal(usbVerdict(one, { ...LY, serial: 'CCC' }).state, 'present');
  // No serial and an identical panel still there: nobody can tell which one went, so nothing pauses.
  assert.equal(usbVerdict(one, LY).state, 'present');
  assert.equal(usbVerdict([], LY).state, 'absent');
  assert.equal(usbVerdict([], { ...LY, serial: 'AAA' }).state, 'absent');
  // A twin whose serial can't be read may be ours: not paused.
  assert.equal(usbVerdict([dev(undefined, '3-4', 'LIBUSB_ERROR_ACCESS')], { ...LY, serial: 'AAA' }).state, 'unknown');
  // Other products don't count.
  assert.equal(usbVerdict([{ vid: 0x0416, pid: 0x8001, location: '1-1', serial: 'AAA' }], { ...LY, serial: 'AAA' }).state, 'absent');
  // Can't list at all: unknown, painted as always.
  assert.equal(usbVerdict(null, LY).state, 'unknown');
});

test('combine: absent wins, then present, else unknown', () => {
  const p = { state: 'present', why: 'p' } as const;
  const a = { state: 'absent', why: 'a' } as const;
  const u = { state: 'unknown', why: 'u' } as const;
  assert.equal(combine([p, a]).state, 'absent');
  assert.equal(combine([p, u]).state, 'present');
  assert.equal(combine([u]).state, 'unknown');
  assert.equal(combine([]).state, 'unknown');
});

test('nextDelay: an absent panel is looked for after 2, 4, 8, 16 s and then every 30 s', () => {
  const p = usbProbe({ ...LY }, { list: () => [], watch: null });
  assert.deepEqual([1, 2, 3, 4, 5, 6, 20].map((n) => nextDelay(p, 'absent', n)), [2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  assert.equal(nextDelay(p, 'present', 0), 10_000);
  assert.equal(nextDelay(p, 'unknown', 0), ABSENT_MAX_MS);
});

test('usb probe: enumerated synchronously (no frame painted before it knows), backs off with a fake clock, and a hotplug event wakes it at once', () => {
  const clock = new FakeClock();
  let plugged: SeenDevice[] = [dev('CCC', '3-9')];
  let lists = 0;
  const list: UsbList = (f, serials) => {
    lists++;
    assert.equal(serials, true, 'a serial is configured: serials are asked for');
    assert.deepEqual(f, LY);
    return plugged;
  };
  let poke: (() => void) | null = null;
  const changes: string[] = [];
  const m = new PresenceMonitor([usbProbe({ ...LY, serial: 'AAA' }, { list, watch: (p) => ((poke = p), () => (poke = null)) })], { clock, onChange: (i) => changes.push(i.state) });
  assert.equal(m.state, 'absent', 'known before the constructor returns');
  assert.equal(lists, 1);
  // 2 s, 4 s, 8 s, 16 s, 30 s, 30 s: 6 more looks in 90 s.
  for (const step of [1999, 1]) clock.advance(step);
  assert.equal(lists, 2);
  clock.advance(4000);
  assert.equal(lists, 3);
  clock.advance(8000 + 16000 + 30000 + 30000);
  assert.equal(lists, 7);
  assert.deepEqual(clock.pending, [30000]);
  // Plugged in: the hotplug event says so now, not in 30 s.
  plugged = [dev('CCC', '3-9'), dev('AAA', '3-4')];
  poke!();
  assert.equal(m.state, 'present');
  assert.equal(lists, 8);
  assert.deepEqual(clock.pending, [10000], 'present: looked at again every 10 s');
  // Unplugged with no event (a platform without hotplug): noticed at the next look; backoff starts over.
  plugged = [dev('CCC', '3-9')];
  clock.advance(10000);
  assert.equal(m.state, 'absent');
  assert.deepEqual(clock.pending, [2000]);
  assert.deepEqual(changes, ['absent', 'present', 'absent']);
  m.close();
  assert.equal(poke, null, 'the watch stops');
  assert.deepEqual(clock.pending, []);
});

test('usb probe: an async lister (libusb) settles later; a poke during a look looks again right after', async () => {
  const clock = new FakeClock();
  let resolve: ((d: SeenDevice[]) => void) | null = null;
  let lists = 0;
  const list: UsbList = () => {
    lists++;
    return new Promise((r) => (resolve = r));
  };
  const m = new PresenceMonitor([usbProbe({ ...LY }, { list, watch: null })], { clock });
  assert.equal(m.state, 'unknown', 'not known yet: painted as always');
  m.poke();
  assert.equal(lists, 1, 'no second look while one is under way');
  resolve!([]);
  await new Promise((r) => setImmediate(r));
  assert.equal(m.state, 'absent');
  assert.equal(lists, 2, 'the poke during it looks again at once');
  resolve!([dev(undefined, '1-2')]);
  await new Promise((r) => setImmediate(r));
  assert.equal(m.state, 'present', 'no serial configured: any matching device will do');
  m.close();
});

test('heartbeat probe: present while the file is recent, absent when stale or missing; checked every second', () => {
  const clock = new FakeClock();
  let mtime: number | null = clock.t - 1000;
  const stat = () => {
    if (mtime === null) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return { mtimeMs: mtime };
  };
  const m = new PresenceMonitor([heartbeatProbe('/run/x/.heartbeat', 5000, { clock, stat, watch: null })], { clock });
  assert.equal(m.state, 'present');
  clock.advance(3999);
  assert.equal(m.state, 'present');
  clock.advance(2000);
  assert.equal(m.state, 'absent', 'over 5 s old');
  assert.match(m.info.why, /\.heartbeat is \d+ s old/);
  mtime = clock.t;
  clock.advance(1000);
  assert.equal(m.state, 'present', 'touched again: back within a second');
  mtime = null;
  clock.advance(1000);
  assert.equal(m.state, 'absent');
  assert.match(m.info.why, /no heartbeat/);
  m.close();
});

test('heartbeat probe: a real file, relative to the screen\'s folder, and its folder watched', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'kiosko-hb-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const [probe] = probesFor({ heartbeat: { path: '.heartbeat', maxAgeMs: 2000 } }, dir);
  const m = new PresenceMonitor([probe!]);
  t.after(() => m.close());
  assert.equal(m.state, 'absent', 'no file yet');
  writeFileSync(join(dir, '.heartbeat'), '');
  // The folder's watch (or the 1 s poll) notices it.
  const state = (): string => m.state;
  for (let i = 0; i < 400 && state() !== 'present'; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(state(), 'present');
  const old = (Date.now() - 60_000) / 1000;
  utimesSync(join(dir, '.heartbeat'), old, old);
  for (let i = 0; i < 400 && state() !== 'absent'; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(state(), 'absent', 'a minute old: stale');
});

test('command probe: exit 0 present, other codes absent, a program that cannot run unknown; at most every few seconds', async () => {
  const clock = new FakeClock();
  let code: number | null = 1;
  const runs: string[][] = [];
  const run = async (argv: string[]) => (runs.push(argv), code);
  const m = new PresenceMonitor([commandProbe(['lsusb', '-d', '0416:5408'], 60_000, { run })], { clock });
  await new Promise((r) => setImmediate(r));
  assert.equal(m.state, 'absent');
  assert.deepEqual(runs[0], ['lsusb', '-d', '0416:5408']);
  assert.deepEqual(clock.pending, [2000], 'absent: looked at again with the backoff');
  code = 0;
  clock.advance(2000);
  await new Promise((r) => setImmediate(r));
  assert.equal(m.state, 'present');
  assert.deepEqual(clock.pending, [60000], 'present: every everyMs');
  code = null;
  clock.advance(60000);
  await new Promise((r) => setImmediate(r));
  assert.equal(m.state, 'unknown');
  m.close();
  // Never more often than every 5 s, whatever the config says.
  assert.equal(commandProbe(['x'], 100).presentEveryMs, 5000);
});

test('runCommand: real programs (node itself), exit codes and a missing one', async () => {
  assert.equal(await runCommand([process.execPath, '-e', 'process.exit(0)'], 10_000), 0);
  assert.equal(await runCommand([process.execPath, '-e', 'process.exit(3)'], 10_000), 3);
  assert.equal(await runCommand(['/nonexistent/kiosko-probe'], 10_000), null);
});

test('probesFor: the config\'s usb (hex ids), heartbeat and command; an unusable id is left out', () => {
  const ps = probesFor({ usb: { vendorId: '0x0416', productId: '5408', serial: ' AAA ' }, heartbeat: { path: 'hb' }, command: { argv: ['true'] } }, '/tmp/x', { usbList: () => [], usbWatch: null, fileWatch: null, stat: () => ({ mtimeMs: 0 }) });
  assert.deepEqual(ps.map((p) => p.name), ['usb', 'heartbeat', 'command']);
  assert.equal(probesFor({ usb: { vendorId: 'zz', productId: '5408' } }, '/tmp').length, 0);
  assert.equal(hexId('0416'), 0x416);
  assert.equal(hexId('0x5408'), 0x5408);
  assert.ok(Number.isNaN(hexId('12345')));
});

test('file device: no presence in the config means today\'s behaviour (always painted); with one, it says the panel\'s', (t) => {
  const plain = new FileDevice({ driver: 'file', dir: '/tmp/kiosko-none' });
  assert.equal(plain.presence, undefined);
  plain.close();
  let seen: SeenDevice[] = [dev('CCC', '3-9')];
  const clock = new FakeClock();
  const mk = (serial?: string) => new FileDevice({ driver: 'file', dir: '/tmp/kiosko-x', presence: { usb: { vendorId: '0416', productId: '5408', ...(serial ? { serial } : {}) } } }, { clock, usbList: () => seen, usbWatch: null });
  const a = mk('AAA');
  const c = mk('CCC');
  const any = mk();
  t.after(() => [a, c, any].forEach((d) => d.close()));
  assert.equal(a.presence?.state, 'absent');
  assert.equal(c.presence?.state, 'present');
  assert.equal(any.presence?.state, 'present');
  seen = [];
  clock.advance(10_000);
  assert.equal(c.presence?.state, 'absent');
  assert.equal(any.presence?.state, 'absent', 'none plugged in at all: now it is known');
});

/** The real libusb-free path on this machine: never throws, never opens anything (sysfs on Linux). */
test('usb probe: the default lister runs against the real bus without throwing', () => {
  const p: Probe = usbProbe({ vendorId: 0xffff, productIds: [0xfffe] }, { watch: null });
  const r = p.check();
  const check = (i: { state: string }) => assert.ok(['absent', 'unknown'].includes(i.state));
  if (r instanceof Promise) return r.then(check);
  check(r);
});

/**
 * Presence: whether a screen's physical panel is there at all. A screen
 * whose panel is unplugged (or a remote screen that is offline) costs CPU for
 * nothing: its pages are composed, its widgets painted and its frames encoded
 * for no one. The runtime pauses such a screen (see `Runtime.refreshPresence`)
 * and resumes it with a fresh, full frame as soon as the panel is back.
 *
 * A driver says it with `Device.presence`: `present`, `absent` or `unknown`.
 * Only `absent` pauses; `unknown` (no probe, a probe that can't tell) paints
 * as always. The `usb` and `remote` drivers know by themselves; the `file`
 * driver can't see the panel its external sender drives, so it takes probes
 * from the config (`device.presence`):
 *
 *   usb        a USB device with this VID:PID (and serial) is enumerated: read
 *              only, never opened on Linux (sysfs), never claimed anywhere
 *   heartbeat  a file the sender touches while it drives the panel is recent
 *   command    a program that exits 0 when the panel is there (low frequency)
 *
 * Several probes: absent if any says absent; present if any says present and
 * none absent; else unknown.
 *
 * Re-probing is cheap and backs off: an absent panel is looked for again after
 * 2 s, 4 s, 8 s… up to 30 s, but USB hotplug (inotify on /dev/bus/usb, or
 * libusb's hotplug events) and a heartbeat file changing wake it at once.
 */
import { spawn } from 'node:child_process';
import { statSync, watch } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { DeviceLister, loadUsb, type SeenDevice } from '@loksly/usb-ly';
import type { PresenceConfig } from './config/model.ts';
import { expandPath } from './paths.ts';


export type Presence = 'present' | 'absent' | 'unknown';

/** What a device says of its panel, and why (for the log and the editor). */
export interface PresenceInfo {
  state: Presence;
  /** In English, for the log: e.g. "no USB device 0416:5408 with serial 2025ECF47BED". */
  why: string;
}

/** Timers, replaceable by a fake clock in tests. */
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** One way of telling: checked now and then; `watch` (optional) pokes it when something changed. */
export interface Probe {
  readonly name: string;
  check(): PresenceInfo | Promise<PresenceInfo>;
  watch?(poke: () => void): () => void;
  /** While present: how often to look again (to notice it going away when nothing pokes). */
  presentEveryMs: number;
  /** While absent: the first pause, doubled each time up to `absentMaxMs`. */
  absentMinMs: number;
  absentMaxMs: number;
  /** While unknown (the probe can't tell): how often to try again. */
  unknownEveryMs: number;
}

/** First and longest pause between looks for an absent panel. */
export const ABSENT_MIN_MS = 2_000;
export const ABSENT_MAX_MS = 30_000;

/** The pause before the next look, after `absentRuns` absent results in a row. */
export function nextDelay(p: Pick<Probe, 'presentEveryMs' | 'absentMinMs' | 'absentMaxMs' | 'unknownEveryMs'>, state: Presence, absentRuns: number): number {
  if (state === 'present') return p.presentEveryMs;
  if (state === 'unknown') return p.unknownEveryMs;
  return Math.min(p.absentMaxMs, p.absentMinMs * 2 ** Math.max(0, Math.min(absentRuns - 1, 16)));
}

/** Probes' answers into one: absent wins, then present; else unknown. */
export function combine(infos: PresenceInfo[]): PresenceInfo {
  const absent = infos.filter((i) => i.state === 'absent');
  if (absent.length) return { state: 'absent', why: absent.map((i) => i.why).join('; ') };
  const present = infos.filter((i) => i.state === 'present');
  if (present.length) return { state: 'present', why: present.map((i) => i.why).join('; ') };
  return { state: 'unknown', why: infos.map((i) => i.why).join('; ') || 'no probe' };
}

class ProbeLoop {
  info: PresenceInfo = { state: 'unknown', why: 'not checked yet' };
  private absentRuns = 0;
  private timer: unknown = null;
  private running = false;
  private again = false;
  private closed = false;
  private unwatch: (() => void) | null = null;
  private readonly probe: Probe;
  private readonly clock: Clock;
  private readonly changed: () => void;

  constructor(probe: Probe, clock: Clock, changed: () => void) {
    this.probe = probe;
    this.clock = clock;
    this.changed = changed;
    try {
      this.unwatch = probe.watch?.(() => this.poke()) ?? null;
    } catch {
      this.unwatch = null;
    }
    this.run();
  }

  /** Looks again now (a hotplug event, a file changed), unless a look is under way: then right after it. */
  poke(): void {
    if (this.closed) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.run();
  }

  private settle(info: PresenceInfo): void {
    this.running = false;
    if (this.closed) return;
    const was = this.info;
    this.info = info;
    this.absentRuns = info.state === 'absent' ? this.absentRuns + 1 : 0;
    if (was.state !== info.state || was.why !== info.why) this.changed();
    if (this.again) {
      this.again = false;
      this.run();
      return;
    }
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      this.run();
    }, nextDelay(this.probe, info.state, this.absentRuns));
  }

  /** Synchronous probes settle before this returns: a panel absent at start is never painted for. */
  private run(): void {
    if (this.closed) return;
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
    this.running = true;
    let r: PresenceInfo | Promise<PresenceInfo>;
    try {
      r = this.probe.check();
    } catch (err) {
      r = { state: 'unknown', why: `${this.probe.name}: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (r instanceof Promise) r.then((i) => this.settle(i), (err) => this.settle({ state: 'unknown', why: `${this.probe.name}: ${err instanceof Error ? err.message : String(err)}` }));
    else this.settle(r);
  }

  close(): void {
    this.closed = true;
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
    this.unwatch?.();
    this.unwatch = null;
  }
}

/** Runs a device's probes and keeps their combined answer (`info`). */
export class PresenceMonitor {
  private readonly loops: ProbeLoop[];
  private last: PresenceInfo;
  private readonly onChange: ((info: PresenceInfo) => void) | undefined;

  constructor(probes: Probe[], o: { clock?: Clock; onChange?: (info: PresenceInfo) => void } = {}) {
    this.onChange = o.onChange;
    this.last = { state: 'unknown', why: 'not checked yet' };
    const clock = o.clock ?? realClock;
    const loops: ProbeLoop[] = [];
    // Synchronous probes answer while the loops are made: they are combined once all are there.
    for (const p of probes) loops.push(new ProbeLoop(p, clock, () => this.update()));
    this.loops = loops;
    this.update();
  }

  get info(): PresenceInfo {
    return this.last;
  }

  get state(): Presence {
    return this.last.state;
  }

  /** Looks again now, every probe. */
  poke(): void {
    for (const l of this.loops) l.poke();
  }

  private update(): void {
    if (!this.loops) return;
    const next = combine(this.loops.map((l) => l.info));
    const was = this.last;
    this.last = next;
    if (was.state !== next.state || was.why !== next.why) this.onChange?.(next);
  }

  close(): void {
    for (const l of this.loops) l.close();
  }
}

/* ---------- usb ---------- */

const hex4 = (n: number) => n.toString(16).padStart(4, '0');

/** The USB devices seen now (only the wanted VID and PIDs); null: can't be listed. */
export type UsbList = (filter: { vendorId: number; productIds: readonly number[] }, serials: boolean) => SeenDevice[] | null | Promise<SeenDevice[] | null>;

/**
 * Whether the wanted panel is among `seen`. With a serial: present if a
 * device has it; absent only when every matching device has a known, other
 * serial (or there is none); unknown when one's serial can't be read (it may
 * be ours). Without a serial: present if any matching device is there,
 * absent if none: with several identical panels and no serial nobody can
 * tell which one went, so a screen is only paused when all are gone.
 */
export function usbVerdict(seen: SeenDevice[] | null, want: { vendorId: number; productIds: readonly number[]; serial?: string | undefined }): PresenceInfo {
  const what = `${hex4(want.vendorId)}:${want.productIds.map(hex4).join('/')}`;
  if (!seen) return { state: 'unknown', why: `can't list USB devices to look for ${what}` };
  const mine = seen.filter((d) => d.vid === want.vendorId && want.productIds.includes(d.pid));
  if (!want.serial) return mine.length ? { state: 'present', why: `USB ${what} at ${mine.map((d) => d.location).join(', ')}` } : { state: 'absent', why: `no USB device ${what} plugged in` };
  const hit = mine.find((d) => d.serial === want.serial);
  if (hit) return { state: 'present', why: `USB ${what} serial ${want.serial} at ${hit.location}` };
  const unreadable = mine.filter((d) => d.serial === undefined);
  if (unreadable.length) return { state: 'unknown', why: `USB ${what} at ${unreadable.map((d) => d.location).join(', ')} without a readable serial: it may be serial ${want.serial}${unreadable[0]!.error ? ` (${unreadable[0]!.error})` : ''}` };
  return { state: 'absent', why: `no USB device ${what} with serial ${want.serial}${mine.length ? ` (plugged in: ${mine.map((d) => d.serial).join(', ')})` : ''}` };
}

/** The process' device lister (sysfs on Linux, libusb elsewhere), shared by every probe. */
let sharedLister: DeviceLister | null = null;
export const defaultUsbList: UsbList = (filter, serials) => {
  sharedLister ??= new DeviceLister({ usb: loadUsb });
  const sync = sharedLister.listSync(filter);
  if (sync) return sync;
  return sharedLister.list(filter, { serials }).catch(() => null);
};

/** Watches USB plug and unplug: `poke` on every change. Returns how to stop. */
export type UsbWatch = (poke: () => void) => () => void;

/**
 * Linux: inotify on /dev/bus/usb (a node appears and goes with each device);
 * elsewhere libusb's hotplug events where it has them. Without either the
 * probes just poll (with their backoff).
 */
export const defaultUsbWatch: UsbWatch = (poke) => {
  if (process.platform === 'linux') {
    try {
      const w = watch('/dev/bus/usb', { recursive: true, persistent: false }, () => poke());
      w.on('error', () => w.close());
      return () => w.close();
    } catch {
      return () => undefined;
    }
  }
  let stop = () => undefined as void;
  let stopped = false;
  void loadUsb()
    .then((m) => {
      const hp = (m as unknown as { usb?: { on?: Function; off?: Function; unrefHotplugEvents?: () => void } }).usb;
      if (stopped || !hp?.on || !hp.off) return;
      const f = () => poke();
      hp.on.call(hp, 'attach', f);
      hp.on.call(hp, 'detach', f);
      hp.unrefHotplugEvents?.();
      stop = () => {
        hp.off!.call(hp, 'attach', f);
        hp.off!.call(hp, 'detach', f);
      };
    })
    .catch(() => undefined);
  return () => {
    stopped = true;
    stop();
  };
};

/** Hotplug watchers are shared: one inotify watch (or libusb listener) for every USB probe. */
const watchers = new Set<() => void>();
let unwatchAll: (() => void) | null = null;
function sharedWatch(watcher: UsbWatch): UsbWatch {
  return (poke) => {
    watchers.add(poke);
    unwatchAll ??= watcher(() => {
      for (const p of watchers) p();
    });
    return () => {
      watchers.delete(poke);
      if (!watchers.size) {
        unwatchAll?.();
        unwatchAll = null;
      }
    };
  };
}

export function usbProbe(want: { vendorId: number; productIds: readonly number[]; serial?: string | undefined }, o: { list?: UsbList; watch?: UsbWatch | null } = {}): Probe {
  const list = o.list ?? defaultUsbList;
  const w = o.watch === null ? undefined : o.watch ? o.watch : sharedWatch(defaultUsbWatch);
  const filter = { vendorId: want.vendorId, productIds: want.productIds };
  return {
    name: 'usb',
    check: () => {
      const r = list(filter, !!want.serial);
      return r instanceof Promise ? r.then((seen) => usbVerdict(seen, want)) : usbVerdict(r, want);
    },
    ...(w ? { watch: w } : {}),
    // Enumerating is cheap (sysfs) but not free: hotplug says when it changes.
    presentEveryMs: 10_000,
    absentMinMs: ABSENT_MIN_MS,
    absentMaxMs: ABSENT_MAX_MS,
    unknownEveryMs: ABSENT_MAX_MS,
  };
}

/* ---------- heartbeat ---------- */

export const HEARTBEAT_MAX_AGE_MS = 5_000;

/** A file touched by whoever drives the panel: absent when it is missing or older than `maxAgeMs`. */
export function heartbeatProbe(path: string, maxAgeMs = HEARTBEAT_MAX_AGE_MS, o: { clock?: Clock; stat?: (p: string) => { mtimeMs: number }; watch?: ((dir: string, file: string, poke: () => void) => () => void) | null } = {}): Probe {
  const clock = o.clock ?? realClock;
  const stat = o.stat ?? statSync;
  const maxAge = Math.max(500, maxAgeMs);
  const w = o.watch === null ? undefined : (o.watch ?? watchFile);
  return {
    name: 'heartbeat',
    check: () => {
      let mtime: number;
      try {
        mtime = stat(path).mtimeMs;
      } catch {
        return { state: 'absent', why: `no heartbeat at ${path} (is the sender running?)` };
      }
      const age = clock.now() - mtime;
      return age <= maxAge ? { state: 'present', why: `heartbeat ${path} ${Math.max(0, Math.round(age / 100) / 10)} s old` } : { state: 'absent', why: `heartbeat ${path} is ${Math.round(age / 1000)} s old (over ${maxAge / 1000} s)` };
    },
    // A touch wakes it at once; while present it must notice it going stale, so it looks every second or so.
    ...(w ? { watch: (poke: () => void) => w(dirname(path), basename(path), poke) } : {}),
    presentEveryMs: Math.min(1_000, Math.max(250, Math.floor(maxAge / 2))),
    absentMinMs: 1_000,
    absentMaxMs: 1_000,
    unknownEveryMs: 1_000,
  };
}

function watchFile(dir: string, file: string, poke: () => void): () => void {
  try {
    const w = watch(dir, { persistent: false }, (_e, name) => {
      if (!name || String(name) === file) poke();
    });
    w.on('error', () => w.close());
    return () => w.close();
  } catch {
    // The folder doesn't exist yet: polling finds the file when it comes.
    return () => undefined;
  }
}

/* ---------- command ---------- */

export const COMMAND_EVERY_MS = 30_000;
const COMMAND_TIMEOUT_MS = 10_000;

/** Runs a program; resolves with its exit code, or null when it couldn't be run or took too long. */
export type CommandRunner = (argv: string[], timeoutMs: number) => Promise<number | null>;

export const runCommand: CommandRunner = (argv, timeoutMs) =>
  new Promise((resolve) => {
    let done = false;
    const end = (code: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      resolve(code);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(argv[0]!, argv.slice(1), { stdio: 'ignore', windowsHide: true });
    } catch {
      return resolve(null);
    }
    const t = setTimeout(() => {
      child.kill();
      end(null);
    }, timeoutMs);
    child.on('error', () => end(null));
    child.on('exit', (code) => end(code));
  });

export function commandProbe(argv: string[], everyMs = COMMAND_EVERY_MS, o: { run?: CommandRunner } = {}): Probe {
  const run = o.run ?? runCommand;
  const every = Math.max(5_000, everyMs);
  const what = argv.join(' ');
  return {
    name: 'command',
    check: async () => {
      if (!argv.length || !argv[0]) return { state: 'unknown', why: 'presence command is empty' };
      const code = await run(argv, COMMAND_TIMEOUT_MS);
      if (code === null) return { state: 'unknown', why: `\`${what}\` could not be run or took over ${COMMAND_TIMEOUT_MS / 1000} s` };
      return code === 0 ? { state: 'present', why: `\`${what}\` exited 0` } : { state: 'absent', why: `\`${what}\` exited ${code}` };
    },
    presentEveryMs: every,
    absentMinMs: Math.min(every, ABSENT_MIN_MS),
    absentMaxMs: every,
    unknownEveryMs: every,
  };
}

/* ---------- from the config ---------- */

export interface ProbeDeps {
  clock?: Clock;
  usbList?: UsbList;
  usbWatch?: UsbWatch | null;
  stat?: (p: string) => { mtimeMs: number };
  fileWatch?: ((dir: string, file: string, poke: () => void) => () => void) | null;
  run?: CommandRunner;
}

/** A hex id from the config ("0416", "0x0416") as a number; NaN when it isn't one. */
export function hexId(v: string | number): number {
  if (typeof v === 'number') return v;
  const s = v.trim().replace(/^0x/i, '');
  return /^[0-9a-f]{1,4}$/i.test(s) ? parseInt(s, 16) : NaN;
}

/** The probes a file screen's `presence` asks for; `dir`: its folder, for a relative heartbeat. */
export function probesFor(cfg: PresenceConfig, dir: string, deps: ProbeDeps = {}): Probe[] {
  const out: Probe[] = [];
  if (cfg.usb) {
    const vendorId = hexId(cfg.usb.vendorId);
    const productId = hexId(cfg.usb.productId);
    if (Number.isFinite(vendorId) && Number.isFinite(productId)) out.push(usbProbe({ vendorId, productIds: [productId], serial: cfg.usb.serial?.trim() || undefined }, { ...(deps.usbList ? { list: deps.usbList } : {}), ...(deps.usbWatch !== undefined ? { watch: deps.usbWatch } : {}) }));
  }
  if (cfg.heartbeat?.path) {
    const p = expandPath(cfg.heartbeat.path);
    out.push(heartbeatProbe(isAbsolute(p) ? p : join(dir, p), cfg.heartbeat.maxAgeMs, { ...(deps.clock ? { clock: deps.clock } : {}), ...(deps.stat ? { stat: deps.stat } : {}), ...(deps.fileWatch !== undefined ? { watch: deps.fileWatch } : {}) }));
  }
  if (cfg.command?.argv?.length) out.push(commandProbe(cfg.command.argv, cfg.command.everyMs, deps.run ? { run: deps.run } : {}));
  return out;
}

/** What a file screen's `presence` says right now, each probe asked once (for `kiosko doctor`). */
export async function presenceNow(cfg: PresenceConfig, dir: string, deps: ProbeDeps = {}): Promise<PresenceInfo> {
  const probes = probesFor(cfg, expandPath(dir), { usbWatch: null, fileWatch: null, ...deps });
  return combine(await Promise.all(probes.map((p) => Promise.resolve(p.check()))));
}

/**
 * What the main thread and a screen's thread say to each other (see
 * thread-runner.ts for the main side, worker-main.ts for the thread).
 */
import type { PadEvent } from '@kiosko/sdk';
import type { ShownAlert } from '../alerts.ts';
import type { Config, Screen } from '../config/model.ts';
import type { ContextPick } from '../context.ts';
import type { ScreenFrameStats } from '../frame-stats.ts';
import type { FrameInfo } from '../screen-runner.ts';

/** What a thread starts with (its `workerData`). */
export interface ThreadInit {
  config: Config;
  screen: Screen;
  /** The plugins to load, in order (see `Registry.threadPlugins`). */
  plugins: { id: string; origin: string; module: string | null }[];
  demo: boolean;
  maxConcurrent: number;
  playIdleMs: number;
  /** The boot animation and the first run's card (welcome.ts), and when Kiosko started. */
  welcome: boolean;
  startedAt: number;
  /** The editor's real address (Runtime.editorUrl), if known. */
  editorUrl?: string;
  pinned: string | null;
  context: ContextPick | null;
  off: boolean;
  /** Its panel is missing (presence.ts): it paints nothing until told otherwise. */
  paused?: boolean;
  /** Where the measured text widths are kept (see text-widths.ts). */
  textWidths?: string;
}

export type ToThread =
  | { t: 'apply'; config: Config; screen: Screen }
  /** New data of a widget instance's fetch or of a source, packed (see clone.ts); `undefined`: none any more. `failed`: its last fetch or read failed. */
  | { t: 'data'; instance?: string; source?: string; value: unknown; failed?: boolean }
  | { t: 'alert'; shown: ShownAlert | null }
  | { t: 'pin'; page: string | null }
  /** The context page it must show (see context.ts). */
  | { t: 'context'; pick: ContextPick | null }
  | { t: 'off'; off: boolean }
  | { t: 'paused'; paused: boolean }
  | { t: 'play'; slot: string; play: boolean }
  | { t: 'stop' }
  | { t: 'press'; e: PadEvent }
  /** The frame `seq` reached the panel. */
  | { t: 'sent'; seq: number }
  /** The editor wants the picture of the last frame. */
  | { t: 'image'; req: number }
  | { t: 'close' };

/** What the main thread mirrors of a screen painted elsewhere, for `status()`. */
export interface ThreadState {
  page: string | null;
  interlude: { type: string; play: boolean } | null;
  animating: string | null;
  stats: ScreenFrameStats;
  /** The thread's JavaScript heap plus what its objects hold outside it (pictures, buffers), in bytes. */
  heapBytes: number;
}

export type FromThread =
  /** Plugins loaded; `problems`: the ones that could not be. */
  | { t: 'ready'; problems: string[] }
  | { t: 'log'; scope: string; message: string }
  | { t: 'paintTime'; instance: string; type: string; ms: number; now: number }
  | { t: 'frame'; info: Omit<FrameInfo, 'image'> }
  | { t: 'state'; state: ThreadState }
  /** A frame for the panel; answered with `sent`. */
  | { t: 'send'; seq: number; frame: Uint8Array }
  | { t: 'image'; req: number; image: Uint8Array | null };

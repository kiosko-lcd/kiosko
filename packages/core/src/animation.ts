/**
 * When a widget's animation plays. The planning is here, apart from the
 * painting and the sending (runtime.ts), so it can be tested without a
 * screen: which shown widget is asked, and why (`idle`, now and then, or
 * `data`, because what it paints with changed), and what the answer is worth.
 *
 * One animation at a time per screen is the caller's business (it asks
 * only while nothing plays); what is kept here is per widget instance: when
 * it was last asked, when its last animation ended and what it had then.
 */
import type { AnimationPlan } from '@kiosko/sdk';
import type { Animatable } from './compositor.ts';

/** The most frames one animation may have: 30 s at 20 fps. A wrong plan must not eat the CPU. */
export const MAX_FRAMES = 600;

/** Default time between the `idle` questions of a widget. */
export const DEFAULT_GAP = { minMs: 20_000, maxMs: 60_000 };

/** A plan as the runtime plays it: checked, with the screen's fps ceiling applied. */
export interface PlayablePlan {
  plan: AnimationPlan;
  frames: number;
  fps: number;
  interruptible: boolean;
  /** Index (into 0..frames-1) where it holds, and for how long. */
  hold?: { index: number; ms: number };
}

/** Why a plan isn't playable, or the plan ready to play. */
export function checkPlan(plan: unknown, maxFps: number): PlayablePlan | string {
  const p = plan as Partial<AnimationPlan> | null;
  if (!p || typeof p !== 'object') return 'not an object';
  if (typeof p.id !== 'string' || !p.id) return 'no id';
  if (!Number.isInteger(p.frames) || p.frames! < 3) return `frames must be an integer of at least 3 (got ${String(p.frames)})`;
  if (p.frames! > MAX_FRAMES) return `too many frames (${p.frames}, at most ${MAX_FRAMES})`;
  if (typeof p.fps !== 'number' || !(p.fps > 0)) return `fps must be positive (got ${String(p.fps)})`;
  const frames = p.frames!;
  const hold = p.hold && Number.isFinite(p.hold.at) && p.hold.ms > 0 ? { index: Math.max(1, Math.min(frames - 2, Math.round(p.hold.at * (frames - 1)))), ms: p.hold.ms } : undefined;
  return { plan: p as AnimationPlan, frames, fps: Math.max(1, Math.min(p.fps!, maxFps)), interruptible: p.interruptible !== false, ...(hold ? { hold } : {}) };
}

interface Memory {
  data: unknown;
  sources: Record<string, unknown>;
  nextIdleAt: number;
  endedAt: number;
}

export class AnimationScheduler {
  private memory = new Map<string, Memory>();

  private readonly rnd: () => number;
  private readonly onInvalid: (type: string, why: string) => void;

  constructor(rnd: () => number = Math.random, onInvalid: (type: string, why: string) => void = () => undefined) {
    this.rnd = rnd;
    this.onInvalid = onInvalid;
  }

  private gapAfter(a: Animatable, now: number): number {
    const g = a.def.animationGap ?? DEFAULT_GAP;
    const min = Math.max(0, g.minMs), max = Math.max(min, g.maxMs);
    return now + min + this.rnd() * (max - min);
  }

  /**
   * The animation to play now, if any, among the shown widgets that have one.
   * Call it only while nothing is playing. A widget seen for the first time
   * isn't asked: starting up must not set off a gesture.
   */
  next(list: Animatable[], now: number, maxFps: number): { animatable: Animatable; play: PlayablePlan } | null {
    const seen = new Set<string>();
    let found: { animatable: Animatable; play: PlayablePlan } | null = null;
    for (const a of list) {
      seen.add(a.instanceId);
      const m = this.memory.get(a.instanceId);
      if (!m) {
        this.memory.set(a.instanceId, { data: a.data, sources: a.sources, nextIdleAt: this.gapAfter(a, now), endedAt: -Infinity });
        continue;
      }
      const changed = a.data !== m.data || Object.keys(a.sources).some((k) => a.sources[k] !== m.sources[k]);
      const prev = { data: m.data, sources: m.sources };
      m.data = a.data;
      m.sources = a.sources;
      if (found) continue;
      const answer = (trigger: 'idle' | 'data') => {
        const plan = a.ask(trigger, this.rnd, trigger === 'data' ? prev : undefined);
        if (plan === null) return null;
        const ok = checkPlan(plan, maxFps);
        if (typeof ok === 'string') {
          this.onInvalid(a.type, ok);
          return null;
        }
        return ok;
      };
      if (changed && now - m.endedAt >= (a.def.animationCooldownMs ?? 0)) {
        const ok = answer('data');
        if (ok) {
          found = { animatable: a, play: ok };
          continue;
        }
      }
      if (now >= m.nextIdleAt) {
        m.nextIdleAt = this.gapAfter(a, now);
        const ok = answer('idle');
        if (ok) found = { animatable: a, play: ok };
      }
    }
    // Forget the instances that are gone (removed, or no longer shown).
    for (const id of this.memory.keys()) if (!seen.has(id)) this.memory.delete(id);
    return found;
  }

  /** An animation of `instanceId` has just ended (or was cut): its cooldown starts. */
  ended(instanceId: string, now: number, a?: Animatable): void {
    const m = this.memory.get(instanceId);
    if (!m) return;
    m.endedAt = now;
    if (a) m.nextIdleAt = Math.max(m.nextIdleAt, this.gapAfter(a, now));
  }
}

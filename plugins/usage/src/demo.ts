/**
 * Sample usage for the gallery, the editor and the tests (the original
 * fixtures), relative to `now`.
 */
import type { BlockPoint, UsageSnapshot } from './ccusage.ts';

const min = (n: number) => n * 60_000;

/** Twelve 5-hour blocks with a recognisable shape; the last one is running. */
function blocks(now: number): BlockPoint[] {
  const costs = [18.4, 46.2, 3.1, 31.7, 29.5, 1.2, 12.8, 9.4, 22.6, 5.7, 38.9, 14.3];
  return costs.map((cost, i) => ({ cost, startTime: now - (costs.length - 1 - i) * 5 * 3_600_000, active: i === costs.length - 1 }));
}

export function usageMax(now: number): UsageSnapshot {
  return {
    mode: 'max',
    windows: [
      { id: 'block', ratio: 0.42, resetsAt: now + min(134) },
      { id: 'week', ratio: 0.88, resetsAt: now + min(3_180) },
    ],
    blockHistory: blocks(now),
    tokensToday: 4_230_000,
    byModel: [
      { model: 'opus-5', tokens: 2_900_000 },
      { model: 'sonnet-5', tokens: 1_100_000 },
      { model: 'haiku-4.5', tokens: 230_000 },
    ],
  };
}

export function usageApi(now: number): UsageSnapshot {
  return {
    mode: 'api',
    spend: [
      { id: 'day', amount: 11.4, cap: 25 },
      { id: 'month', amount: 268, cap: 400 },
    ],
    blockHistory: blocks(now),
    tokensToday: 4_230_000,
    byModel: [
      { model: 'opus-5', tokens: 2_900_000 },
      { model: 'sonnet-5', tokens: 1_330_000 },
    ],
  };
}

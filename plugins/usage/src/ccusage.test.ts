import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSnapshot, percentile, readUsage, safeRatio, shortModel, type Run, type UsageOptions } from './ccusage.ts';

const now = Date.parse('2026-11-05T10:42:00Z');
const MAX: UsageOptions = { bin: 'ccusage', mode: 'max', dailyCap: 25, monthlyCap: 400, calibration: { metric: 'cost', lookbackDays: 30, percentile: 100 } };
const API: UsageOptions = { ...MAX, mode: 'api' };

const daily = { daily: [{ period: '2026-11-04', totalTokens: 10 }, { period: '2026-11-05', totalTokens: 4_230_000, totalCost: 11.4, modelBreakdowns: [{ modelName: 'claude-sonnet-5', inputTokens: 1_000_000, outputTokens: 100_000 }, { modelName: 'claude-opus-5', inputTokens: 2_000_000, cacheReadTokens: 900_000 }] }] };
const iso = (ms: number) => new Date(ms).toISOString();
const blocks = {
  blocks: [
    { startTime: iso(now - 20 * 3_600_000), costUSD: 10, totalTokens: 100 },
    { isGap: true, startTime: iso(now - 15 * 3_600_000) },
    { startTime: iso(now - 10 * 3_600_000), costUSD: 40, totalTokens: 400 },
    { startTime: iso(now - 2 * 3_600_000), endTime: iso(now + 3 * 3_600_000), costUSD: 20, totalTokens: 50, isActive: true },
  ],
};
const weekly = { weekly: [{ period: '2026-10-19', totalCost: 100 }, { period: '2026-10-26', totalCost: 200 }, { period: '2026-11-02', totalCost: 150 }] };

test('percentile and safeRatio', () => {
  assert.equal(percentile([], 90), 0);
  assert.equal(percentile([5, 1, 3], 100), 5);
  assert.equal(percentile([1, 2, 3, 4], 50), 2);
  assert.equal(safeRatio(5, 0), null);
  assert.equal(safeRatio(15, 10), 1);
  assert.equal(shortModel('claude-opus-5'), 'opus-5');
});

test('subscription mode: windows calibrated against the own history', () => {
  const s = buildSnapshot({ daily, blocks, weekly }, MAX, now);
  assert.equal(s.stale, false);
  assert.equal(s.tokensToday, 4_230_000);
  assert.deepEqual(s.byModel?.map((m) => m.model), ['opus-5', 'sonnet-5']);
  assert.deepEqual(s.windows?.map((w) => [w.id, w.ratio]), [['block', 0.5], ['week', 0.75]]);
  assert.equal(s.windows?.[0]?.resetsAt, now + 3 * 3_600_000);
  assert.equal(s.blockHistory?.length, 3, 'gaps are not blocks');
  assert.equal(s.blockHistory?.at(-1)?.active, true);
});

test('subscription mode: no history, no invented bar', () => {
  const s = buildSnapshot({ daily, blocks: { blocks: [blocks.blocks[3]!] }, weekly: { weekly: [weekly.weekly[2]!] } }, MAX, now);
  assert.deepEqual(s.windows, []);
});

test('API mode: spend against the caps', () => {
  const s = buildSnapshot({ daily, blocks, monthly: { monthly: [{ totalCost: 268 }] } }, API, now);
  assert.deepEqual(s.spend, [
    { id: 'day', amount: 11.4, cap: 25 },
    { id: 'month', amount: 268, cap: 400 },
  ]);
  assert.equal(s.windows, undefined);
});

test('readUsage: a missing binary is a clear error', async () => {
  const run: Run = async () => {
    throw Object.assign(new Error('spawn ccusage ENOENT'), { code: 'ENOENT' });
  };
  await assert.rejects(readUsage(MAX, run, now), /ccusage not found.*npm install -g ccusage/);
});

test('readUsage: one failing command gives a partial, stale snapshot; all failing throws', async () => {
  const reports: Record<string, unknown> = { daily, blocks };
  const partial: Run = async ([cmd]) => {
    if (cmd! in reports) return reports[cmd!];
    throw new Error('boom');
  };
  const s = await readUsage(MAX, partial, now);
  assert.equal(s.stale, true);
  assert.deepEqual(s.windows?.map((w) => w.id), ['block']);
  await assert.rejects(readUsage(MAX, async () => { throw new Error('boom'); }, now), /ccusage failed/);
});

test('readUsage: runs the real ccusage commands with --json', async () => {
  const calls: string[] = [];
  await readUsage(API, async (args) => (calls.push(args.join(' ')), {}), now);
  assert.deepEqual(calls, ['daily --json', 'blocks --json', 'monthly --json']);
});

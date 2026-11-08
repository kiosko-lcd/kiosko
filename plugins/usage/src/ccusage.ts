/**
 * Adapter for `ccusage` (Claude Code usage from its local logs). The only
 * module that knows its JSON; everything else reads `UsageSnapshot`.
 *
 * Split in two: `buildSnapshot` is pure (reports in, snapshot out) and
 * tested; `readUsage` runs the commands.
 */
import { execFile } from 'node:child_process';

/**
 * Shapes `ccusage --json` really returns. Careful: `daily`/`weekly`/`monthly`
 * use `totalCost` and flat counters, while `blocks` uses `costUSD` and nests
 * them in `tokenCounts`. Not the same schema, though it looks like it.
 */
export interface CcusageModelBreakdown {
  modelName?: string;
  cost?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
}

export interface CcusagePeriodRow {
  /** Start of the period, `YYYY-MM-DD`. */
  period?: string;
  totalTokens?: number;
  totalCost?: number;
  modelBreakdowns?: CcusageModelBreakdown[];
}

export interface CcusagePeriodReport {
  daily?: CcusagePeriodRow[];
  weekly?: CcusagePeriodRow[];
  monthly?: CcusagePeriodRow[];
  totals?: { totalCost?: number; totalTokens?: number };
}

export interface CcusageBlock {
  id?: string;
  startTime?: string;
  endTime?: string;
  isActive?: boolean;
  isGap?: boolean;
  totalTokens?: number;
  costUSD?: number;
}

export interface CcusageBlocksReport {
  blocks?: CcusageBlock[];
}

/** A limit window (subscription mode). Ids, not labels: widgets localize them. */
export interface UsageWindow {
  id: 'block' | 'week';
  /** 0..1 against the user's own history (see `calibration`). */
  ratio: number;
  /** Next reset, ms epoch, if known. */
  resetsAt?: number;
}

/** Spend against a cap (API mode). */
export interface UsageSpend {
  id: 'day' | 'month';
  amount: number;
  cap: number;
}

/** A 5-hour billing block, closed or running. */
export interface BlockPoint {
  /** Equivalent cost in USD. */
  cost: number;
  /** Start of the block, ms epoch. */
  startTime: number;
  /** The running block, painted highlighted. */
  active?: boolean;
}

/** Data of the `usage/ccusage` source, independent of ccusage's format. */
export interface UsageSnapshot {
  mode: 'max' | 'api';
  windows?: UsageWindow[];
  spend?: UsageSpend[];
  /** Recent 5-hour blocks, for the sparkline. */
  blockHistory?: BlockPoint[];
  tokensToday?: number;
  byModel?: { model: string; tokens: number }[];
  /** Some command failed: the figures may be partial. */
  stale?: boolean;
}

export interface UsageOptions {
  bin: string;
  mode: 'max' | 'api';
  dailyCap: number;
  monthlyCap: number;
  /**
   * Subscription mode: ccusage exposes usage but **not** the plan's limit,
   * so 100 % of a bar is calibrated against the user's own history. The bar
   * answers "how is this going against my busiest session", not against an
   * Anthropic cap, which is not observable from here.
   */
  calibration: {
    /** `cost` uses the equivalent cost (the best proxy of plan burn). */
    metric: 'cost' | 'tokens';
    /** Days of history to consider; 0 = all. */
    lookbackDays: number;
    /** Percentile of the history that marks 100 %. 100 = absolute maximum. */
    percentile: number;
  };
}

const DAY_MS = 86_400_000;

/** How many 5-hour blocks the sparkline gets: ~2.5 days of context. */
export const SPARK_BLOCKS = 12;

/** Drops the family prefix so the name fits the rail. */
export function shortModel(name: string): string {
  return name.replace(/^claude-/, '');
}

/**
 * Percentile of already filtered values. `p` = 100 is the absolute maximum,
 * the default calibration: 100 % is the busiest session of the user's own
 * history.
 */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

/** Ratio clamped to 0..1; without a denominator there is no bar to paint. */
export function safeRatio(value: number, denom: number): number | null {
  if (!Number.isFinite(denom) || denom <= 0) return null;
  return Math.min(1, Math.max(0, value / denom));
}

/** What the commands returned; a missing report is a failed command. */
export interface Reports {
  daily?: CcusagePeriodReport;
  weekly?: CcusagePeriodReport;
  monthly?: CcusagePeriodReport;
  blocks?: CcusageBlocksReport;
}

/** Reports → snapshot. Pure. */
export function buildSnapshot(r: Reports, o: UsageOptions, now: number): UsageSnapshot {
  const snap: UsageSnapshot = { mode: o.mode, stale: false, tokensToday: 0, byModel: [] };

  // Common footer (today's tokens and the split by model): from `daily` in both modes.
  const dailyRow = r.daily?.daily?.at(-1);
  if (!r.daily) snap.stale = true;
  if (dailyRow) {
    snap.tokensToday = dailyRow.totalTokens ?? 0;
    snap.byModel = (dailyRow.modelBreakdowns ?? [])
      .filter((m) => m.modelName)
      .map((m) => ({ model: shortModel(m.modelName!), tokens: (m.inputTokens ?? 0) + (m.outputTokens ?? 0) + (m.cacheCreationTokens ?? 0) + (m.cacheReadTokens ?? 0) }))
      .sort((a, b) => b.tokens - a.tokens);
  }

  // The sparkline comes from the same blocks the calibration reads.
  const real = (r.blocks?.blocks ?? []).filter((b) => !b.isGap);
  if (!r.blocks) snap.stale = true;
  else snap.blockHistory = real.slice(-SPARK_BLOCKS).map<BlockPoint>((b) => ({ cost: b.costUSD ?? 0, startTime: Date.parse(b.startTime ?? '') || 0, active: b.isActive === true }));

  if (o.mode === 'api') {
    if (!r.monthly) snap.stale = true;
    const monthly = r.monthly?.monthly?.at(-1)?.totalCost ?? r.monthly?.totals?.totalCost ?? 0;
    snap.spend = [
      { id: 'day', amount: dailyRow?.totalCost ?? 0, cap: o.dailyCap },
      { id: 'month', amount: monthly, cap: o.monthlyCap },
    ];
    return snap;
  }

  // Subscription mode. Without enough history the bar is left out rather
  // than inventing a percentage: a false red bar is worse than no bar.
  const { metric, lookbackDays, percentile: p } = o.calibration;
  const cutoff = lookbackDays > 0 ? now - lookbackDays * DAY_MS : 0;
  const windows: UsageWindow[] = [];

  if (r.blocks) {
    const active = real.find((b) => b.isActive);
    const value = (b: CcusageBlock) => (metric === 'cost' ? (b.costUSD ?? 0) : (b.totalTokens ?? 0));
    const history = real
      .filter((b) => !b.isActive && (!cutoff || Date.parse(b.startTime ?? '') >= cutoff))
      .map(value)
      .filter((v) => v > 0);
    const ratio = active ? safeRatio(value(active), percentile(history, p)) : 0;
    if (ratio !== null) windows.push({ id: 'block', ratio, ...(active?.endTime ? { resetsAt: Date.parse(active.endTime) } : {}) });
  }

  if (r.weekly) {
    const weekly = r.weekly.weekly ?? [];
    const current = weekly.at(-1);
    const value = (row: CcusagePeriodRow) => (metric === 'cost' ? (row.totalCost ?? 0) : (row.totalTokens ?? 0));
    const history = weekly
      .slice(0, -1)
      .filter((row) => !cutoff || Date.parse(row.period ?? '') >= cutoff)
      .map(value)
      .filter((v) => v > 0);
    const ratio = current ? safeRatio(value(current), percentile(history, p)) : null;
    if (ratio !== null) {
      const start = Date.parse(current!.period ?? '');
      windows.push({ id: 'week', ratio, ...(Number.isFinite(start) ? { resetsAt: start + 7 * DAY_MS } : {}) });
    }
  } else snap.stale = true;

  snap.windows = windows;
  return snap;
}

/** Runs `ccusage <args> --json` and parses it. */
export type Run = (args: string[]) => Promise<unknown>;

/** The real runner: `bin` may carry arguments (`npx ccusage`). */
export function execRunner(bin: string, signal?: AbortSignal): Run {
  const [cmd = 'ccusage', ...pre] = bin.trim().split(/\s+/).filter(Boolean);
  return (args) =>
    new Promise((resolve, reject) => {
      execFile(cmd, [...pre, ...args], { timeout: 30_000, maxBuffer: 32 * 1024 * 1024, signal }, (err, stdout) => {
        if (err) return reject(err);
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error(`\`${cmd} ${args.join(' ')}\` did not print JSON`));
        }
      });
    });
}

const isMissing = (err: unknown) => (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Runs the commands one after the other (each walks the whole Claude Code
 * history, ~3 s of CPU) and builds the snapshot. A missing binary or every
 * command failing throws, with a message that says what to do; a single
 * failure gives a partial snapshot marked `stale`.
 */
export async function readUsage(o: UsageOptions, run: Run, now = Date.now(), log: (msg: string) => void = () => {}): Promise<UsageSnapshot> {
  const wanted: (keyof Reports)[] = ['daily', 'blocks', o.mode === 'api' ? 'monthly' : 'weekly'];
  const reports: Reports = {};
  const errors: string[] = [];
  for (const cmd of wanted) {
    try {
      reports[cmd] = (await run([cmd, '--json'])) as never;
    } catch (err) {
      if (isMissing(err)) {
        throw new Error(`ccusage not found ("${o.bin}"): install it (npm install -g ccusage) or set its full path in the source options`);
      }
      errors.push(`${cmd}: ${message(err)}`);
      log(`ccusage ${cmd} failed: ${message(err)}`);
    }
  }
  if (errors.length === wanted.length) throw new Error(`ccusage failed: ${errors[0]}`);
  return buildSnapshot(reports, o, now);
}

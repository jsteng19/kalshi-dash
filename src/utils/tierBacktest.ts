import { MatchedTrade, parseTickerComponents } from './processData';

export const TIER_LADDER = [1, 10, 25, 50, 75, 100, 125, 150, 175, 200] as const;
export type Tier = typeof TIER_LADDER[number];

export const RECENT_ACTIVITY_WINDOW = 14;
export const RECENT_ACTIVITY_THRESHOLD = 5;

export const PROMOTE_CONSECUTIVE_REQUIRED = 3;
export const STARTER_DAYS = 3;

// Demote signal selection thresholds. The active window is whichever has
// enough trades to be statistically meaningful; falls back to longer windows
// for low-frequency series.
export const N_TRADES_FOR_R10 = 30;
export const N_TRADES_FOR_R15 = 10;

/**
 * Entry tier when a series first appears. Frequency-aware:
 *   - daily / weekly / sub-day  → rung 2 (10¢ / 10 contracts)
 *   - monthly / annual / one_off / custom → rung 4 (50¢)
 *   - unknown → rung 2 (safer default)
 */
export function entryTierFor(frequency: string | undefined): number {
  switch (frequency) {
    case 'fifteen_min':
    case 'hourly':
    case 'daily':
    case 'weekly':
      return 10;
    case 'monthly':
    case 'annual':
    case 'one_off':
    case 'custom':
      return 50;
    default:
      return 10;
  }
}

export type DemoteSignalLabel = 'r10' | 'r15' | 'r35';

export interface TierSnapshot {
  date: string;
  tier: number;
  prevTier: number;
  r10: number | null;
  r15: number | null;
  r35: number | null;
  // r30 retained for promote signal + display
  r30: number | null;
  signal: DemoteSignalLabel | null;
  consecutivePositive: number;
  moved: 'up' | 'down' | null;
  tradesToday: number;
  active: boolean;
}

export interface SeriesBacktest {
  series: string;
  frequency: string;
  entryTier: number;
  firstTradeDate: string;
  currentTier: number;
  totalTrades: number;
  daysTracked: number;
  lastR30: number | null;
  lastDemoteSignal: number | null;
  lastSignalLabel: DemoteSignalLabel | null;
  recentActivityDays: number;
  history: TierSnapshot[];
}

function dateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function startOfDay(d: Date): Date {
  const r = new Date(d);
  r.setHours(0, 0, 0, 0);
  return r;
}

function addDays(d: Date, days: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + days);
  return r;
}

function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24));
}

function ladderUp(tier: number): number {
  const idx = TIER_LADDER.indexOf(tier as Tier);
  if (idx === -1 || idx === TIER_LADDER.length - 1) return tier;
  return TIER_LADDER[idx + 1];
}

function ladderDown(tier: number): number {
  const idx = TIER_LADDER.indexOf(tier as Tier);
  if (idx === -1 || idx === 0) return tier;
  return TIER_LADDER[idx - 1];
}

/**
 * Sliding-window cost-weighted return helper.
 * Maintains (sumPnl / sumCost) over [windowStart, cursor] day-inclusive.
 */
class SlidingWindow {
  private leftIdx = 0;
  private rightIdx = 0;
  private sumPnl = 0;
  private sumCost = 0;
  private count = 0;

  constructor(
    private readonly sortedTrades: MatchedTrade[],
    private readonly tradeDays: Date[],
    private readonly windowDays: number,
  ) {}

  advanceTo(cursor: Date): { r: number | null; n: number } {
    const windowStart = addDays(cursor, -(this.windowDays - 1));
    while (this.rightIdx < this.sortedTrades.length
        && this.tradeDays[this.rightIdx].getTime() <= cursor.getTime()) {
      this.sumPnl += this.sortedTrades[this.rightIdx].Net_Profit;
      this.sumCost += this.sortedTrades[this.rightIdx].Entry_Cost;
      this.count += 1;
      this.rightIdx += 1;
    }
    while (this.leftIdx < this.rightIdx
        && this.tradeDays[this.leftIdx].getTime() < windowStart.getTime()) {
      this.sumPnl -= this.sortedTrades[this.leftIdx].Net_Profit;
      this.sumCost -= this.sortedTrades[this.leftIdx].Entry_Cost;
      this.count -= 1;
      this.leftIdx += 1;
    }
    const r = this.sumCost > 0 ? this.sumPnl / this.sumCost : null;
    return { r, n: this.count };
  }
}

function pickDemoteSignal(
  r10: number | null, n10: number,
  r15: number | null, n15: number,
  r35: number | null,
): { value: number | null; label: DemoteSignalLabel | null } {
  if (n10 >= N_TRADES_FOR_R10 && r10 !== null) return { value: r10, label: 'r10' };
  if (n15 >= N_TRADES_FOR_R15 && r15 !== null) return { value: r15, label: 'r15' };
  if (r35 !== null) return { value: r35, label: 'r35' };
  return { value: null, label: null };
}

/**
 * Backtest series through the 10-step ladder using frequency-aware entry
 * tier + hybrid demote signal (r10 high-volume dailies / r15 weeklies /
 * r35 monthlies+). Promote still uses r30 for stability.
 *
 * Rules:
 *   - Starter (days 1..STARTER_DAYS): pinned at entryTier(frequency).
 *     Accumulate consecutive-positive counter using r30.
 *   - Day STARTER_DAYS+1 onward:
 *       demoteSignal < 0 → -1 step, counter resets
 *       active AND r30 ≥ 0 AND counter+1 ≥ PROMOTE_CONSECUTIVE_REQUIRED → +1 step, counter resets
 *       active AND r30 ≥ 0 (counter not yet 3) → counter += 1, hold
 *       else → hold
 *   - Clamped to [1, 200].
 *   - Only series with ≥RECENT_ACTIVITY_THRESHOLD trade days in the last
 *     RECENT_ACTIVITY_WINDOW are returned (others are dormant; caller
 *     handles them separately).
 */
export function backtestTiers(
  allMatchedTrades: MatchedTrade[],
  frequencyMap: Map<string, string> = new Map(),
): Map<string, SeriesBacktest> {
  const bySeries = new Map<string, MatchedTrade[]>();
  for (const t of allMatchedTrades) {
    const { series } = parseTickerComponents(t.Ticker);
    if (!bySeries.has(series)) bySeries.set(series, []);
    bySeries.get(series)!.push(t);
  }

  const result = new Map<string, SeriesBacktest>();
  const today = startOfDay(new Date());

  bySeries.forEach((trades, series) => {
    const sorted = [...trades].sort((a, b) => a.Exit_Date.getTime() - b.Exit_Date.getTime());
    const firstTradeDay = startOfDay(sorted[0].Exit_Date);
    const tradeDays = sorted.map(t => startOfDay(t.Exit_Date));

    const recentCutoff = addDays(today, -(RECENT_ACTIVITY_WINDOW - 1));
    const recentTradeDates = new Set<string>();
    for (const td of tradeDays) {
      if (td.getTime() >= recentCutoff.getTime()) {
        recentTradeDates.add(dateKey(td));
      }
    }
    const recentActivityDays = recentTradeDates.size;
    if (recentActivityDays < RECENT_ACTIVITY_THRESHOLD) return;

    const totalDays = daysBetween(firstTradeDay, today);
    const freq = frequencyMap.get(series) ?? 'unknown';
    const entryTier = entryTierFor(freq);

    let tier = entryTier;
    let consecutive = 0;
    const history: TierSnapshot[] = [];

    const w10 = new SlidingWindow(sorted, tradeDays, 10);
    const w15 = new SlidingWindow(sorted, tradeDays, 15);
    const w30 = new SlidingWindow(sorted, tradeDays, 30);
    const w35 = new SlidingWindow(sorted, tradeDays, 35);

    let rightIdxLast = 0;
    for (let dayIdx = 0; dayIdx <= totalDays; dayIdx++) {
      const cursor = addDays(firstTradeDay, dayIdx);

      const { r: r10, n: n10 } = w10.advanceTo(cursor);
      const { r: r15, n: n15 } = w15.advanceTo(cursor);
      const { r: r30 } = w30.advanceTo(cursor);
      const { r: r35 } = w35.advanceTo(cursor);

      // tradesToday derived from how many trades fall on this exact day
      let tradesToday = 0;
      while (rightIdxLast < sorted.length
          && tradeDays[rightIdxLast].getTime() <= cursor.getTime()) {
        if (tradeDays[rightIdxLast].getTime() === cursor.getTime()) tradesToday += 1;
        rightIdxLast += 1;
      }
      const active = tradesToday > 0;

      const { value: demoteSig, label: signalLabel } = pickDemoteSignal(r10, n10, r15, n15, r35);

      let moved: 'up' | 'down' | null = null;
      const prevTier = tier;

      if (dayIdx < STARTER_DAYS) {
        // Pinned at entry tier; accumulate counter for post-starter promote.
        if (active && r30 !== null && r30 >= 0) consecutive += 1;
        else if (demoteSig !== null && demoteSig < 0) consecutive = 0;
      } else {
        if (demoteSig !== null && demoteSig < 0) {
          tier = ladderDown(tier);
          consecutive = 0;
        } else if (active && r30 !== null && r30 >= 0) {
          consecutive += 1;
          if (consecutive >= PROMOTE_CONSECUTIVE_REQUIRED) {
            tier = ladderUp(tier);
            consecutive = 0;
          }
        }
      }

      if (tier > prevTier) moved = 'up';
      else if (tier < prevTier) moved = 'down';

      history.push({
        date: dateKey(cursor),
        tier,
        prevTier,
        r10, r15, r30, r35,
        signal: signalLabel,
        consecutivePositive: consecutive,
        moved,
        tradesToday,
        active,
      });
    }

    const lastSnap = history[history.length - 1];
    const lastSignalValue = lastSnap
      ? (lastSnap.signal === 'r10' ? lastSnap.r10
         : lastSnap.signal === 'r15' ? lastSnap.r15
         : lastSnap.signal === 'r35' ? lastSnap.r35
         : null)
      : null;

    result.set(series, {
      series,
      frequency: freq,
      entryTier,
      firstTradeDate: dateKey(firstTradeDay),
      currentTier: tier,
      totalTrades: sorted.length,
      daysTracked: history.length,
      lastR30: lastSnap ? lastSnap.r30 : null,
      lastDemoteSignal: lastSignalValue,
      lastSignalLabel: lastSnap?.signal ?? null,
      recentActivityDays,
      history,
    });
  });

  return result;
}

/**
 * Count consecutive days the series has been parked at `floor` ending today.
 */
export function consecutiveDaysAtFloor(
  history: { tier: number }[],
  floor: number = 1,
): number {
  let n = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].tier === floor) n++;
    else break;
  }
  return n;
}

/**
 * Days since the most recent promote in history (null if never promoted).
 */
export function daysSinceLastPromote(history: TierSnapshot[]): number | null {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].moved === 'up') {
      const lastDate = new Date(history[i].date + 'T00:00:00');
      const todayStr = new Date().toISOString().slice(0, 10);
      const today = new Date(todayStr + 'T00:00:00');
      return Math.round((today.getTime() - lastDate.getTime()) / (1000 * 60 * 60 * 24));
    }
  }
  return null;
}

/**
 * Summarize how many series landed at each tier.
 */
export function summarizeTierDistribution(
  backtest: Map<string, SeriesBacktest>,
): { tier: number; count: number; series: string[] }[] {
  const buckets = new Map<number, string[]>();
  TIER_LADDER.forEach(t => buckets.set(t, []));

  backtest.forEach(bt => {
    const arr = buckets.get(bt.currentTier) ?? [];
    arr.push(bt.series);
    buckets.set(bt.currentTier, arr);
  });

  return TIER_LADDER.map(tier => ({
    tier,
    count: buckets.get(tier)!.length,
    series: buckets.get(tier)!.sort(),
  }));
}

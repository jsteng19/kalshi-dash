import { MatchedTrade, parseTickerComponents } from './processData';

export const TIER_LADDER = [1, 10, 25, 50, 75, 100, 125, 150, 175, 200, 225, 250, 275, 300] as const;
export type Tier = typeof TIER_LADDER[number];

export const RECENT_ACTIVITY_WINDOW = 14;
export const RECENT_ACTIVITY_THRESHOLD = 5;

export interface TierSnapshot {
  date: string; // YYYY-MM-DD
  tier: number;
  prevTier: number;
  r30: number | null;
  consecutivePositive: number;
  moved: 'up' | 'down' | null;
  tradesToday: number;
  active: boolean;
}

export interface SeriesBacktest {
  series: string;
  frequency: string;
  firstTradeDate: string;
  currentTier: number;
  totalTrades: number;
  daysTracked: number;
  lastR30: number | null;
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
 * Backtest series that are recently active (≥5 trading days in last 14 calendar days)
 * through the 10-step ladder. No frequency labels needed — activity determines routing.
 *
 * Rules:
 *   - Starter: days 1–3 pinned at 1¢, counter still accumulates
 *   - Day 4+: r30 ≥ 0 three active days running → +1 level, counter resets
 *            r30 < 0 any calendar day → -1 level, counter resets
 *            r30 null → hold
 *   - Clamped to ladder bounds [1, 300]
 */
export function backtestTiers(
  allMatchedTrades: MatchedTrade[],
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

    // Count distinct trading days in the recent activity window
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

    let tier = 1;
    let consecutive = 0;
    const history: TierSnapshot[] = [];

    let leftIdx = 0;
    let rightIdx = 0;
    let sumPnl = 0;
    let sumCost = 0;

    for (let dayIdx = 0; dayIdx <= totalDays; dayIdx++) {
      const cursor = addDays(firstTradeDay, dayIdx);
      const windowStart = addDays(cursor, -29);

      const rightIdxBefore = rightIdx;
      while (rightIdx < sorted.length && tradeDays[rightIdx].getTime() <= cursor.getTime()) {
        sumPnl += sorted[rightIdx].Net_Profit;
        sumCost += sorted[rightIdx].Entry_Cost;
        rightIdx++;
      }
      const tradesToday = rightIdx - rightIdxBefore;
      while (leftIdx < rightIdx && tradeDays[leftIdx].getTime() < windowStart.getTime()) {
        sumPnl -= sorted[leftIdx].Net_Profit;
        sumCost -= sorted[leftIdx].Entry_Cost;
        leftIdx++;
      }

      const r30 = sumCost > 0 ? sumPnl / sumCost : null;
      const active = tradesToday > 0;

      let moved: 'up' | 'down' | null = null;
      const prevTier = tier;

      if (dayIdx < 3) {
        if (active && r30 !== null) {
          if (r30 >= 0) consecutive += 1;
          else consecutive = 0;
        }
      } else {
        if (r30 !== null && r30 < 0) {
          tier = ladderDown(tier);
          consecutive = 0;
        } else if (active && r30 !== null && r30 >= 0) {
          consecutive += 1;
          if (consecutive >= 3) {
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
        r30,
        consecutivePositive: consecutive,
        moved,
        tradesToday,
        active,
      });
    }

    const lastSnap = history[history.length - 1];
    result.set(series, {
      series,
      frequency: 'ladder',
      firstTradeDate: dateKey(firstTradeDay),
      currentTier: tier,
      totalTrades: sorted.length,
      daysTracked: history.length,
      lastR30: lastSnap ? lastSnap.r30 : null,
      recentActivityDays,
      history,
    });
  });

  return result;
}

export interface ThreePointSnapshot {
  date: string;
  tier: 1 | 100 | 200;
  r30: number | null;
  cumulativeTrades: number;
  tradesToday: number;
}

export interface ThreePointBacktest {
  series: string;
  firstTradeDate: string;
  currentTier: 1 | 100 | 200;
  totalTrades: number;
  daysTracked: number;
  lastR30: number | null;
  history: ThreePointSnapshot[];
}

function threePointTier(r30: number | null, tradesCount: number): 1 | 100 | 200 {
  if (r30 !== null && r30 >= 0 && tradesCount >= 2) return 200;
  if (r30 !== null && r30 < 0 && tradesCount >= 2) return 1;
  return 100;
}

/**
 * Backtest 3-point tier (1 / 100 / 200) per day for series that don't have
 * enough recent activity to ride the 10-step ladder. Same r30 + trades-count
 * logic as the live classifier; produces a history so we can ask "how many
 * consecutive days has this series been parked at the 1¢ floor?"
 */
export function backtestThreePoint(
  allMatchedTrades: MatchedTrade[],
): Map<string, ThreePointBacktest> {
  const bySeries = new Map<string, MatchedTrade[]>();
  for (const t of allMatchedTrades) {
    const { series } = parseTickerComponents(t.Ticker);
    if (!bySeries.has(series)) bySeries.set(series, []);
    bySeries.get(series)!.push(t);
  }

  const result = new Map<string, ThreePointBacktest>();
  const today = startOfDay(new Date());

  bySeries.forEach((trades, series) => {
    const sorted = [...trades].sort((a, b) => a.Exit_Date.getTime() - b.Exit_Date.getTime());
    const firstTradeDay = startOfDay(sorted[0].Exit_Date);
    const tradeDays = sorted.map(t => startOfDay(t.Exit_Date));
    const totalDays = daysBetween(firstTradeDay, today);

    const history: ThreePointSnapshot[] = [];
    let leftIdx = 0;
    let rightIdx = 0;
    let sumPnl = 0;
    let sumCost = 0;
    let cumulativeTrades = 0;

    for (let dayIdx = 0; dayIdx <= totalDays; dayIdx++) {
      const cursor = addDays(firstTradeDay, dayIdx);
      const windowStart = addDays(cursor, -29);

      const rightIdxBefore = rightIdx;
      while (rightIdx < sorted.length && tradeDays[rightIdx].getTime() <= cursor.getTime()) {
        sumPnl += sorted[rightIdx].Net_Profit;
        sumCost += sorted[rightIdx].Entry_Cost;
        rightIdx++;
      }
      const tradesToday = rightIdx - rightIdxBefore;
      cumulativeTrades += tradesToday;

      while (leftIdx < rightIdx && tradeDays[leftIdx].getTime() < windowStart.getTime()) {
        sumPnl -= sorted[leftIdx].Net_Profit;
        sumCost -= sorted[leftIdx].Entry_Cost;
        leftIdx++;
      }

      const r30 = sumCost > 0 ? sumPnl / sumCost : null;
      const tier = threePointTier(r30, cumulativeTrades);

      history.push({
        date: dateKey(cursor),
        tier,
        r30,
        cumulativeTrades,
        tradesToday,
      });
    }

    const lastSnap = history[history.length - 1];
    result.set(series, {
      series,
      firstTradeDate: dateKey(firstTradeDay),
      currentTier: lastSnap ? lastSnap.tier : 100,
      totalTrades: sorted.length,
      daysTracked: history.length,
      lastR30: lastSnap ? lastSnap.r30 : null,
      history,
    });
  });

  return result;
}

/**
 * Count consecutive days the series has been parked at `floor` ending today.
 * Walks history backward; stops at the first non-floor day.
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

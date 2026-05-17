/**
 * Ladder evaluator — Option B (relative model).
 *
 * KalshiPNL no longer tracks absolute tier numbers. It evaluates per
 * series, per day, whether today should PROMOTE +1 rung, DEMOTE -1 rung,
 * or HOLD. OCT owns the absolute tier value; KalshiPNL emits relative
 * moves applied via SQL CASE-WHEN mapping.
 *
 * Inputs: MatchedTrade[] from CSV.
 * Output: Map<series, SeriesEvaluation> — today's event + full per-day
 *         event history for UI/audit.
 *
 * Rules (per series, per day from first trade day to today):
 *   - active = ≥1 closed trade landed on this day
 *   - r10/r15/r30/r35 = cost-weighted return over trailing N days
 *   - demote signal (hybrid): r10 if n10 ≥ 30, else r15 if n15 ≥ 10, else r35
 *   - PROMOTE: 3 cumulative active days with r30 ≥ 0 (counter persists
 *     across inactive days; only resets on promote or demote). Implicit
 *     3-active-day cooldown between promotes.
 *   - DEMOTE: any ACTIVE day with demote signal < 0. Counter resets.
 *     (Inactive days never fire events — stale signals from old trades
 *     in the trailing window would otherwise produce spurious demotes
 *     every day until those trades fall out of the window.)
 *   - HOLD: otherwise; counter persists across inactive days.
 *
 * The ladder mapping (1, 10, 25, 50, 75, 100, 125, 150, 175, 200) is
 * still defined here for SQL CASE-WHEN generation, but the evaluator
 * itself never references it.
 */

import { MatchedTrade, parseTickerComponents } from './processData';

export const TIER_LADDER = [1, 10, 25, 50, 75, 100, 125, 150, 175, 200] as const;
export type Tier = typeof TIER_LADDER[number];

export const RECENT_ACTIVITY_WINDOW = 14;
export const PROMOTE_CONSECUTIVE_REQUIRED = 3;

// Demote signal selection thresholds.
export const N_TRADES_FOR_R10 = 30;
export const N_TRADES_FOR_R15 = 10;

export type DemoteSignalLabel = 'r10' | 'r15' | 'r35';
export type LadderEvent = 'promote' | 'demote' | 'hold';

export interface DaySnapshot {
  date: string;                          // YYYY-MM-DD
  tradesToday: number;
  active: boolean;
  r10: number | null;
  r15: number | null;
  r30: number | null;
  r35: number | null;
  signal: DemoteSignalLabel | null;
  signalValue: number | null;            // numeric value of the chosen signal
  event: LadderEvent;
  consecutivePositive: number;
}

export interface SeriesEvaluation {
  series: string;
  frequency: string;
  firstTradeDate: string;
  totalTrades: number;
  daysTracked: number;
  recentActivityDays: number;            // distinct trade days in last 14d (UI only)
  // Today's outcome + state
  todayEvent: LadderEvent;
  todayConsecutivePositive: number;
  lastR30: number | null;
  lastSignal: DemoteSignalLabel | null;
  lastSignalValue: number | null;
  lastPromoteDate: string | null;
  lastDemoteDate: string | null;
  history: DaySnapshot[];
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

/**
 * Sliding cost-weighted return over [cursor - (windowDays - 1), cursor].
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
 * Evaluate every series with ≥1 closed trade. No tier tracking — output
 * is per-day events (promote/demote/hold) and the resulting state.
 */
export function evaluateLadder(
  allMatchedTrades: MatchedTrade[],
  frequencyMap: Map<string, string> = new Map(),
): Map<string, SeriesEvaluation> {
  const bySeries = new Map<string, MatchedTrade[]>();
  for (const t of allMatchedTrades) {
    const { series } = parseTickerComponents(t.Ticker);
    if (!bySeries.has(series)) bySeries.set(series, []);
    bySeries.get(series)!.push(t);
  }

  const result = new Map<string, SeriesEvaluation>();
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

    const totalDays = daysBetween(firstTradeDay, today);
    const freq = frequencyMap.get(series) ?? 'unknown';

    let consecutive = 0;
    let lastPromoteDate: string | null = null;
    let lastDemoteDate: string | null = null;
    const history: DaySnapshot[] = [];

    const w10 = new SlidingWindow(sorted, tradeDays, 10);
    const w15 = new SlidingWindow(sorted, tradeDays, 15);
    const w30 = new SlidingWindow(sorted, tradeDays, 30);
    const w35 = new SlidingWindow(sorted, tradeDays, 35);

    let rightIdxLast = 0;
    for (let dayIdx = 0; dayIdx <= totalDays; dayIdx++) {
      const cursor = addDays(firstTradeDay, dayIdx);
      const cursorKey = dateKey(cursor);

      const { r: r10, n: n10 } = w10.advanceTo(cursor);
      const { r: r15, n: n15 } = w15.advanceTo(cursor);
      const { r: r30 } = w30.advanceTo(cursor);
      const { r: r35 } = w35.advanceTo(cursor);

      let tradesToday = 0;
      while (rightIdxLast < sorted.length
          && tradeDays[rightIdxLast].getTime() <= cursor.getTime()) {
        if (tradeDays[rightIdxLast].getTime() === cursor.getTime()) tradesToday += 1;
        rightIdxLast += 1;
      }
      const active = tradesToday > 0;

      const { value: demoteSig, label: signalLabel } = pickDemoteSignal(r10, n10, r15, n15, r35);

      let event: LadderEvent = 'hold';
      // Only fire events on active days — fresh evidence required.
      // Without this guard, a stale negative signal from old trades
      // still in the trailing window would emit DEMOTE every day for
      // the next 35 days, even on quiet/inactive days.
      if (active && demoteSig !== null && demoteSig < 0) {
        event = 'demote';
        consecutive = 0;
        lastDemoteDate = cursorKey;
      } else if (active && r30 !== null && r30 >= 0) {
        consecutive += 1;
        if (consecutive >= PROMOTE_CONSECUTIVE_REQUIRED) {
          event = 'promote';
          consecutive = 0;
          lastPromoteDate = cursorKey;
        }
      }

      history.push({
        date: cursorKey,
        tradesToday,
        active,
        r10, r15, r30, r35,
        signal: signalLabel,
        signalValue: signalLabel === 'r10' ? r10
                    : signalLabel === 'r15' ? r15
                    : signalLabel === 'r35' ? r35
                    : null,
        event,
        consecutivePositive: consecutive,
      });
    }

    const lastSnap = history[history.length - 1];
    result.set(series, {
      series,
      frequency: freq,
      firstTradeDate: dateKey(firstTradeDay),
      totalTrades: sorted.length,
      daysTracked: history.length,
      recentActivityDays,
      todayEvent: lastSnap?.event ?? 'hold',
      todayConsecutivePositive: consecutive,
      lastR30: lastSnap?.r30 ?? null,
      lastSignal: lastSnap?.signal ?? null,
      lastSignalValue: lastSnap?.signalValue ?? null,
      lastPromoteDate,
      lastDemoteDate,
      history,
    });
  });

  return result;
}

/**
 * Generate the SQL CASE-WHEN ladder-up mapping (used in PROMOTE blocks).
 * Each rung maps to the next-higher rung; top rung maps to itself (no-op).
 */
export function ladderUpCase(column: string = 'position_size_cents'): string {
  const parts: string[] = [];
  for (let i = 0; i < TIER_LADDER.length - 1; i++) {
    parts.push(`WHEN ${TIER_LADDER[i]} THEN ${TIER_LADDER[i + 1]}`);
  }
  return `CASE ${column} ${parts.join(' ')} ELSE ${column} END`;
}

/**
 * Generate the SQL CASE-WHEN ladder-down mapping (used in DEMOTE blocks).
 * Each rung maps to the next-lower rung; bottom rung maps to itself.
 */
export function ladderDownCase(column: string = 'position_size_cents'): string {
  const parts: string[] = [];
  for (let i = TIER_LADDER.length - 1; i > 0; i--) {
    parts.push(`WHEN ${TIER_LADDER[i]} THEN ${TIER_LADDER[i - 1]}`);
  }
  return `CASE ${column} ${parts.join(' ')} ELSE ${column} END`;
}

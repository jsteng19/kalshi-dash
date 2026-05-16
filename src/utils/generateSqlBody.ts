/**
 * Pure SQL generation logic — runs in a Worker so the page doesn't freeze
 * on the heavy backtest passes.
 *
 * Output: { sql, snapshots }. Caller posts snapshots[] to
 * /api/tier-history/snapshot for persistence.
 *
 * Rules in effect:
 *   - 10-step ladder is the only classifier (3-point removed).
 *   - Frequency-aware entry tier (rung 2 dailies/weeklies, rung 4 monthlies+).
 *   - Hybrid demote signal: r10 / r15 / r35 based on per-series activity.
 *   - Promote uses r30, 3 consecutive positive days required (implicit
 *     3-day cooldown between promotes).
 *   - Demote is single-day, single-step. -1 step per negative day.
 */

import { MatchedTrade, parseTickerComponents, calculateSeriesStatsFromMatched, SettlementResult } from './processData';
import { backtestTiers, consecutiveDaysAtFloor, entryTierFor, TIER_LADDER, SeriesBacktest, DemoteSignalLabel } from './tierBacktest';
import type { SnapshotInput } from '@/lib/tierHistory';

export interface GenerateSqlInput {
  allMatchedTrades: MatchedTrade[];
  frequencyMap: Map<string, string>;
  // categoryMap kept for parity with caller; not currently consulted in
  // the SQL emitter beyond settlement_strategy categorization upstream.
  categoryMap?: Map<string, string>;
  settlementMap: Map<string, SettlementResult>;
}

export interface GenerateSqlOutput {
  sql: string;
  snapshots: SnapshotInput[];
}

const STINKER_FLOOR_DAYS = 10;

function fmtPct(v: number): string {
  return (v >= 0 ? '+' : '') + (v * 100).toFixed(1) + '%';
}

function fmtTier(t: number): string {
  return `${t}¢`;
}

function rStr(label: DemoteSignalLabel | 'r30', r: number | null): string {
  return r !== null ? `${label} ${fmtPct(r)}` : `no ${label}`;
}

function stinkerThresh(freq?: string): { days: number; trades: number } {
  switch (freq) {
    case 'hourly':
    case 'fifteen_min': return { days: 30, trades: 50 };
    case 'daily':       return { days: 30, trades: 30 };
    case 'weekly':      return { days: 45, trades: 20 };
    case 'monthly':     return { days: 60, trades: 6 };
    case 'annual':      return { days: 90, trades: 10 };
    case 'one_off':
    case 'custom':      return { days: 90, trades: 5 };
    default:            return { days: 90, trades: 30 };
  }
}

function todayDateKey(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function generateSqlBody(input: GenerateSqlInput): GenerateSqlOutput {
  const { allMatchedTrades, frequencyMap, settlementMap } = input;
  const today = new Date();
  const MS_PER_DAY = 1000 * 60 * 60 * 24;

  const lastTradeDateMap = new Map<string, Date>();
  const firstTradeDateMap = new Map<string, Date>();
  allMatchedTrades.forEach(t => {
    const { series } = parseTickerComponents(t.Ticker);
    const last = lastTradeDateMap.get(series);
    if (!last || t.Exit_Date > last) lastTradeDateMap.set(series, t.Exit_Date);
    const first = firstTradeDateMap.get(series);
    if (!first || t.Exit_Date < first) firstTradeDateMap.set(series, t.Exit_Date);
  });

  const startOfToday = new Date(today);
  startOfToday.setHours(0, 0, 0, 0);

  const allSeriesStats = calculateSeriesStatsFromMatched(allMatchedTrades);
  const backtest = backtestTiers(allMatchedTrades, frequencyMap);

  type BucketEntry = { series: string; comment: string };
  const tierBuckets = new Map<number, BucketEntry[]>();
  TIER_LADDER.forEach(t => tierBuckets.set(t, []));

  const toDelete: string[] = [];
  const stinkers: string[] = [];
  const dormantHold: string[] = []; // existing dormant series we leave alone
  const snapshots: SnapshotInput[] = [];
  const today_s = todayDateKey();

  allSeriesStats.forEach((stats, series) => {
    const lastDate = lastTradeDateMap.get(series);
    const firstDate = firstTradeDateMap.get(series);
    const daysSinceLast = lastDate ? Math.floor((startOfToday.getTime() - lastDate.getTime()) / MS_PER_DAY) : Infinity;
    const daysSinceFirst = firstDate ? Math.floor((startOfToday.getTime() - firstDate.getTime()) / MS_PER_DAY) : 0;

    if (daysSinceLast > 60) {
      toDelete.push(series);
      return;
    }

    const bt = backtest.get(series);
    if (bt) {
      bucketActive(series, stats, bt, daysSinceFirst);
    } else {
      bucketDormant(series, stats, daysSinceFirst);
    }
  });

  function bucketActive(
    series: string,
    stats: { tradesCount: number; pnl: number },
    bt: SeriesBacktest,
    daysSinceFirst: number,
  ) {
    const fr = frequencyMap?.get(series);
    const th = stinkerThresh(fr);
    const daysAtFloor = bt.currentTier === 1 ? consecutiveDaysAtFloor(bt.history, 1) : 0;
    if (daysSinceFirst >= th.days && stats.tradesCount >= th.trades && stats.pnl < 0 && daysAtFloor >= STINKER_FLOOR_DAYS) {
      stinkers.push(series);
    }

    // `bt` is only returned by backtestTiers when recentActivityDays ≥ 5,
    // which guarantees at least one snapshot in history. Safe to take last.
    const last = bt.history[bt.history.length - 1];
    const sigLabel = last.signal;
    const sigValue = sigLabel === 'r10' ? last.r10
                    : sigLabel === 'r15' ? last.r15
                    : sigLabel === 'r35' ? last.r35
                    : null;

    let comment: string;
    const lastActiveSnap = [...bt.history].reverse().find(h => h.active);
    const lastTradeDate = lastActiveSnap?.date ?? last.date;
    const lastTradeDaysAgo = Math.round((new Date(today_s + 'T00:00:00').getTime() - new Date(lastTradeDate + 'T00:00:00').getTime()) / MS_PER_DAY);
    const lastTradeStr = lastTradeDaysAgo === 0 ? 'last trade today'
                       : lastTradeDaysAgo === 1 ? 'last trade yesterday'
                       : `last trade ${lastTradeDaysAgo} days ago`;

    const recentMove = [...bt.history].reverse().find(h => h.moved !== null);
    const recentMoveDaysAgo = recentMove
      ? Math.round((new Date(today_s + 'T00:00:00').getTime() - new Date(recentMove.date + 'T00:00:00').getTime()) / MS_PER_DAY)
      : null;

    const signalStr = sigLabel
      ? rStr(sigLabel, sigValue)
      : rStr('r30', last.r30);

    if (bt.daysTracked <= 3) {
      comment = `starter day ${bt.daysTracked} @ ${fmtTier(bt.entryTier)} (${bt.recentActivityDays}d/14d)`;
    } else if (recentMove && recentMoveDaysAgo !== null && recentMoveDaysAgo <= 3) {
      const when = recentMoveDaysAgo === 0 ? 'today'
                 : recentMoveDaysAgo === 1 ? 'yesterday'
                 : `${recentMoveDaysAgo} days ago`;
      const arrow = recentMove.moved === 'up' ? '↑' : '↓';
      const verb = recentMove.moved === 'up' ? 'promoted' : 'demoted';
      comment = `${arrow} ${verb} from ${fmtTier(recentMove.prevTier)} ${when} (${signalStr})`;
    } else {
      comment = `${lastTradeStr} (${signalStr})`;
    }

    tierBuckets.get(bt.currentTier)!.push({ series, comment });

    snapshots.push({
      date: today_s,
      series,
      tier: bt.currentTier,
      prev_tier: last.prevTier,
      moved: last.moved ?? 'hold',
      r10: last.r10,
      r15: last.r15,
      r35: last.r35,
      signal: last.signal,
      trades_today: last.tradesToday,
      reason: comment,
    });
  }

  function bucketDormant(
    series: string,
    stats: { tradesCount: number; pnl: number },
    daysSinceFirst: number,
  ) {
    const freq = frequencyMap.get(series);
    const entry = entryTierFor(freq);

    if (daysSinceFirst < 7) {
      // Brand-new dormant series — bucket into the entry-tier UPDATE so
      // OCT installs it at the right starting size.
      tierBuckets.get(entry)!.push({
        series,
        comment: `starter day ${daysSinceFirst + 1} @ ${fmtTier(entry)} (freq=${freq ?? 'unknown'})`,
      });
      snapshots.push({
        date: today_s,
        series,
        tier: entry,
        prev_tier: null,
        moved: 'hold',
        r10: null, r15: null, r35: null,
        signal: null,
        trades_today: stats.tradesCount,
        reason: `starter @ ${fmtTier(entry)} freq=${freq ?? 'unknown'}`,
      });
      return;
    }

    // Existing but dormant (<5 trade days in last 14). Hold at last-known
    // tier — no UPDATE emitted, no snapshot (we don't know what to write
    // without history; reconcile happens next time activity returns).
    dormantHold.push(series);
  }

  // -------------------------------- emit -------------------------------- //

  const emitInBlock = (entries: BucketEntry[]): string => {
    const sorted = [...entries].sort((a, b) => a.series.localeCompare(b.series));
    return sorted.map((e, i) => {
      const isLast = i === sorted.length - 1;
      return `  '${e.series}'${isLast ? '' : ','} -- ${e.comment}`;
    }).join('\n');
  };
  const toIn = (arr: string[]) => arr.map(s => `'${s}'`).join(',\n  ');
  const parts: string[] = [];

  if (toDelete.length) {
    parts.push(
      `-- Inactive series (no trades in 60+ days) — ${toDelete.length} series\n` +
      `-- Row-age guard (created_at < 60d ago) protects rows freshly re-added by\n` +
      `-- the discovery cron; they need 60 days to attempt their first trade\n` +
      `-- before sweep eligibility. Symmetric with the 60-day no-trades rule.\n` +
      `DELETE FROM one_cent_series_filters\nWHERE series_ticker IN (\n  ${toIn(toDelete)}\n)\nAND created_at < NOW() - INTERVAL 60 DAY;`
    );
  }

  TIER_LADDER.forEach(tier => {
    const bucket = tierBuckets.get(tier)!;
    if (!bucket.length) return;
    parts.push(
      `-- ${fmtTier(tier)} tier (10-step ladder) — ${bucket.length} series\n` +
      `UPDATE one_cent_series_filters SET position_size_cents = ${tier} WHERE series_ticker IN (\n${emitInBlock(bucket)}\n);`
    );
  });

  if (dormantHold.length) {
    parts.push(
      `-- Dormant (no UPDATE issued) — ${dormantHold.length} series\n` +
      `-- These series have <5 trade days in last 14. Holding at whatever\n` +
      `-- size the OCT DB currently has them at. Will reconcile next time\n` +
      `-- they become active.\n` +
      `-- ${dormantHold.slice(0, 20).join(', ')}${dormantHold.length > 20 ? ', ...' : ''}`
    );
  }

  if (stinkers.length) {
    parts.push(
      `-- Disable stinkers: per-frequency thresholds (hourly/daily 30d, weekly 45d, monthly 60d, annual/one_off/custom 90d), all-time negative, parked at 1¢ for ${STINKER_FLOOR_DAYS}+ consecutive days — ${stinkers.length} series\n` +
      `-- Weather markets excluded by category check\n` +
      `UPDATE one_cent_series_filters\nSET enabled = 0\nWHERE series_ticker IN (\n  ${toIn(stinkers)}\n)\nAND category != 'Climate and Weather';`
    );
  }

  if (settlementMap && settlementMap.size > 0) {
    const seriesEarlyExits = new Map<string, MatchedTrade[]>();
    allMatchedTrades
      .filter(t => t.Exit_Price > 0 && t.Exit_Price < 100)
      .forEach(t => {
        const { series } = parseTickerComponents(t.Ticker);
        if (!seriesEarlyExits.has(series)) seriesEarlyExits.set(series, []);
        seriesEarlyExits.get(series)!.push(t);
      });

    const settlementStrategy: string[] = [];
    const limitStrategy: string[] = [];

    seriesEarlyExits.forEach((trades, series) => {
      let knownActualPnl = 0;
      let whatIfPnl = 0;
      let knownCount = 0;
      for (const t of trades) {
        const result = settlementMap.get(t.Ticker);
        if (result === 'no') {
          knownActualPnl += t.Net_Profit;
          whatIfPnl += (100 - t.Entry_Price) * t.Contracts / 100;
          knownCount++;
        } else if (result === 'yes') {
          knownActualPnl += t.Net_Profit;
          whatIfPnl += -t.Entry_Cost;
          knownCount++;
        }
      }
      if (knownCount === 0) return;
      if (whatIfPnl > knownActualPnl) {
        settlementStrategy.push(series);
      } else {
        limitStrategy.push(series);
      }
    });

    if (settlementStrategy.length) {
      parts.push(
        `-- Sell strategy: settlement (holding to settlement was better) — ${settlementStrategy.length} series\n` +
        `UPDATE one_cent_series_filters\nSET sell_strategy = 'settlement'\nWHERE series_ticker IN (\n  ${toIn(settlementStrategy)}\n);`
      );
    }
    if (limitStrategy.length) {
      parts.push(
        `-- Sell strategy: limit (early exit was better) — ${limitStrategy.length} series\n` +
        `UPDATE one_cent_series_filters\nSET sell_strategy = 'limit'\nWHERE series_ticker IN (\n  ${toIn(limitStrategy)}\n);`
      );
    }
  }

  const dateHeader = `-- Generated ${today.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`;
  const sql = [dateHeader, ...parts].join('\n\n');
  return { sql, snapshots };
}

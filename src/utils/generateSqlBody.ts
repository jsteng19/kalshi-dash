/**
 * Pure SQL generation logic — runs in a Worker so the page doesn't freeze
 * on the heavy backtest passes. Mirror of the previous inline generateSQL
 * in SeriesStatsTable; same outputs, same comments format.
 */

import { MatchedTrade, parseTickerComponents, calculateSeriesStatsFromMatched, SettlementResult } from './processData';
import { backtestTiers, backtestThreePoint, consecutiveDaysAtFloor, TIER_LADDER } from './tierBacktest';

export interface GenerateSqlInput {
  allMatchedTrades: MatchedTrade[];
  frequencyMap: Map<string, string>;
  // categoryMap kept for parity with caller; not currently consulted in
  // the SQL emitter beyond settlement_strategy categorization upstream.
  categoryMap?: Map<string, string>;
  settlementMap: Map<string, SettlementResult>;
}

export function generateSqlBody({
  allMatchedTrades,
  frequencyMap,
  settlementMap,
}: GenerateSqlInput): string {
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

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const recent30dStats = calculateSeriesStatsFromMatched(
    allMatchedTrades.filter(t => t.Exit_Date >= thirtyDaysAgo)
  );
  const sql30dMap = new Map<string, number>();
  recent30dStats.forEach((stats, series) => {
    if (stats.totalCost > 0) sql30dMap.set(series, stats.pnl / stats.totalCost);
  });

  const startOfToday = new Date(today);
  startOfToday.setHours(0, 0, 0, 0);
  const yesterdayWindowStart = new Date(startOfToday);
  yesterdayWindowStart.setDate(yesterdayWindowStart.getDate() - 30);
  const yesterday30dStats = calculateSeriesStatsFromMatched(
    allMatchedTrades.filter(t => t.Exit_Date >= yesterdayWindowStart && t.Exit_Date < startOfToday)
  );
  const ySql30dMap = new Map<string, number>();
  yesterday30dStats.forEach((stats, series) => {
    if (stats.totalCost > 0) ySql30dMap.set(series, stats.pnl / stats.totalCost);
  });
  const yAllSeriesStats = calculateSeriesStatsFromMatched(
    allMatchedTrades.filter(t => t.Exit_Date < startOfToday)
  );

  const allSeriesStats = calculateSeriesStatsFromMatched(allMatchedTrades);

  const fourteenDaysAgo = new Date(startOfToday);
  fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14);
  const trades14dCount = new Map<string, number>();
  for (const t of allMatchedTrades) {
    if (t.Exit_Date < fourteenDaysAgo) continue;
    const { series } = parseTickerComponents(t.Ticker);
    trades14dCount.set(series, (trades14dCount.get(series) ?? 0) + 1);
  }

  const threePointTier = (r30: number | null, tradesCount: number): 1 | 100 | 200 => {
    if (r30 !== null && r30 >= 0 && tradesCount >= 2) return 200;
    if (r30 !== null && r30 < 0 && tradesCount >= 2) return 1;
    return 100;
  };

  const backtest = backtestTiers(allMatchedTrades);
  const tpBacktest = backtestThreePoint(allMatchedTrades);
  const STINKER_FLOOR_DAYS = 10;

  const fmtPct = (v: number) => (v >= 0 ? '+' : '') + (v * 100).toFixed(1) + '%';
  const fmtTier = (t: number) => `${t}¢`;
  const r30Str = (r: number | null) => r !== null ? `r30 ${fmtPct(r)}` : 'no r30';

  const toDelete: string[] = [];
  const stinkers: string[] = [];

  const stinkerThresh = (freq?: string): { days: number; trades: number } => {
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
  };

  type BucketEntry = { series: string; comment: string };
  const tierBuckets = new Map<number, BucketEntry[]>();
  TIER_LADDER.forEach(t => tierBuckets.set(t, []));

  const threePointTop: BucketEntry[] = [];
  const threePointMid: BucketEntry[] = [];
  const threePointLow: BucketEntry[] = [];

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
      const fr = frequencyMap?.get(series);
      const th = stinkerThresh(fr);
      const daysAtFloor = bt.currentTier === 1 ? consecutiveDaysAtFloor(bt.history, 1) : 0;
      if (daysSinceFirst >= th.days && stats.tradesCount >= th.trades && stats.pnl < 0 && daysAtFloor >= STINKER_FLOOR_DAYS) {
        stinkers.push(series);
      }

      const last = bt.history[bt.history.length - 1];
      let comment: string;

      const todayStr = new Date().toLocaleDateString('en-CA');
      const lastActiveSnap = [...bt.history].reverse().find(h => h.active);
      const lastTradeDate = lastActiveSnap?.date ?? bt.history[bt.history.length - 1].date;
      const lastTradeDaysAgo = Math.round((new Date(todayStr + 'T00:00:00').getTime() - new Date(lastTradeDate + 'T00:00:00').getTime()) / (1000 * 60 * 60 * 24));
      const lastTradeStr = lastTradeDaysAgo === 0 ? 'last trade today' : lastTradeDaysAgo === 1 ? 'last trade yesterday' : `last trade ${lastTradeDaysAgo} days ago`;

      const recentMove = [...bt.history].reverse().find(h => h.moved !== null);
      const recentMoveDaysAgo = recentMove ? Math.round((new Date(todayStr + 'T00:00:00').getTime() - new Date(recentMove.date + 'T00:00:00').getTime()) / (1000 * 60 * 60 * 24)) : null;

      if (bt.daysTracked <= 3) {
        comment = `starter day ${bt.daysTracked} (${bt.recentActivityDays}d/14d)`;
      } else if (recentMove && recentMoveDaysAgo !== null && recentMoveDaysAgo <= 3) {
        const when = recentMoveDaysAgo === 0 ? 'today' : recentMoveDaysAgo === 1 ? 'yesterday' : `${recentMoveDaysAgo} days ago`;
        const arrow = recentMove.moved === 'up' ? '↑' : '↓';
        const verb = recentMove.moved === 'up' ? 'promoted' : 'demoted';
        comment = `${arrow} ${verb} from ${fmtTier(recentMove.prevTier)} ${when} (${r30Str(last.r30)})`;
      } else {
        comment = `${lastTradeStr} (${r30Str(last.r30)})`;
      }

      tierBuckets.get(bt.currentTier)!.push({ series, comment });
    } else {
      if (daysSinceFirst < 7) {
        threePointLow.push({ series, comment: `starter day ${daysSinceFirst + 1} (${stats.tradesCount} trades, <5d/14d activity)` });
        return;
      }

      const r30 = sql30dMap.get(series) ?? null;

      let todayTier = threePointTier(r30, stats.tradesCount);
      const yR30 = ySql30dMap.get(series) ?? null;
      const yStats = yAllSeriesStats.get(series);
      const yDaysSinceFirst = firstDate
        ? (startOfToday.getTime() - firstDate.getTime()) / MS_PER_DAY
        : 0;
      const yTier = (yStats && yDaysSinceFirst >= 7)
        ? threePointTier(yR30, yStats.tradesCount)
        : null;

      const recent14d = trades14dCount.get(series) ?? 0;
      let promotionBlocked = false;
      if (yTier !== null && todayTier > yTier && recent14d === 0) {
        todayTier = yTier;
        promotionBlocked = true;
      }

      let movePrefix = '';
      if (yTier !== null && yTier !== todayTier) {
        const arrow = todayTier > yTier ? '↑' : '↓';
        const verb = todayTier > yTier ? 'promoted' : 'demoted';
        movePrefix = `${arrow} ${verb} from ${yTier}¢ today · `;
      } else if (promotionBlocked) {
        movePrefix = `hold ${yTier}¢ (promotion blocked: no trade in 14d) · `;
      }

      const baseR30 = r30 !== null ? r30Str(r30) : '<2 trades or no 30d data';
      const comment = `${movePrefix}3pt: ${baseR30}`;

      if (todayTier === 200) {
        threePointTop.push({ series, comment });
      } else if (todayTier === 1) {
        threePointLow.push({ series, comment });
      } else {
        threePointMid.push({ series, comment });
      }

      const fr3 = frequencyMap?.get(series);
      const th3 = stinkerThresh(fr3);
      const tpBt = tpBacktest.get(series);
      const daysAtFloor3 = (tpBt && todayTier === 1) ? consecutiveDaysAtFloor(tpBt.history, 1) : 0;
      if (daysSinceFirst >= th3.days && stats.tradesCount >= th3.trades && stats.pnl < 0 && daysAtFloor3 >= STINKER_FLOOR_DAYS) {
        stinkers.push(series);
      }
    }
  });

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
      `DELETE FROM one_cent_series_filters\nWHERE series_ticker IN (\n  ${toIn(toDelete)}\n);`
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

  if (threePointTop.length) {
    parts.push(
      `-- 200¢ (3-point: positive 30d, 2+ trades) — ${threePointTop.length} series\n` +
      `UPDATE one_cent_series_filters SET position_size_cents = 200 WHERE series_ticker IN (\n${emitInBlock(threePointTop)}\n);`
    );
  }
  if (threePointMid.length) {
    parts.push(
      `-- 100¢ (3-point: insufficient data) — ${threePointMid.length} series\n` +
      `UPDATE one_cent_series_filters SET position_size_cents = 100 WHERE series_ticker IN (\n${emitInBlock(threePointMid)}\n);`
    );
  }
  if (threePointLow.length) {
    parts.push(
      `-- 1¢ (3-point: negative 30d, 2+ trades) — ${threePointLow.length} series\n` +
      `UPDATE one_cent_series_filters SET position_size_cents = 1 WHERE series_ticker IN (\n${emitInBlock(threePointLow)}\n);`
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
  return [dateHeader, ...parts].join('\n\n');
}

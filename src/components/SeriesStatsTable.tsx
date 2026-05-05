'use client';

import React, { useMemo, useState } from 'react';
import { MatchedTrade, calculateSeriesStatsFromMatched, parseTickerComponents, SettlementResult } from '@/utils/processData';
import { backtestTiers, backtestThreePoint, consecutiveDaysAtFloor, summarizeTierDistribution, TIER_LADDER, RECENT_ACTIVITY_WINDOW, RECENT_ACTIVITY_THRESHOLD, SeriesBacktest } from '@/utils/tierBacktest';

interface SeriesStatsTableProps {
  matchedTrades: MatchedTrade[];
  recentMatchedTrades: MatchedTrade[];
  allMatchedTrades: MatchedTrade[];
  frequencyMap?: Map<string, string>;
  categoryMap?: Map<string, string>;
  settlementMap?: Map<string, SettlementResult>;
  selectedSeries: string | null;
  onSeriesSelect: (series: string | null) => void;
  seriesFilter?: string;
  onSeriesFilterChange?: (value: string) => void;
}

type SortField = 'series' | 'pnl' | 'proceeds' | 'cost' | 'fees' | 'trades' | 'winRate' | 'avgReturn' | 'trailing30d';
type SortDirection = 'asc' | 'desc';
type BacktestSortField = 'series' | 'activity' | 'firstTrade' | 'days' | 'trades' | 'currentTier' | 'lastR30';

export default function SeriesStatsTable({ matchedTrades, recentMatchedTrades, allMatchedTrades, frequencyMap, categoryMap, settlementMap, selectedSeries, onSeriesSelect, seriesFilter, onSeriesFilterChange }: SeriesStatsTableProps) {
  const [sortField, setSortField] = useState<SortField>('pnl');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [sqlModal, setSqlModal] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [backtestModal, setBacktestModal] = useState<Map<string, SeriesBacktest> | null>(null);
  const [backtestSelectedSeries, setBacktestSelectedSeries] = useState<string | null>(null);
  const [backtestSortField, setBacktestSortField] = useState<BacktestSortField>('currentTier');
  const [backtestSortDirection, setBacktestSortDirection] = useState<SortDirection>('desc');

  const handleBacktestSort = (field: BacktestSortField) => {
    if (backtestSortField === field) {
      setBacktestSortDirection(prev => prev === 'asc' ? 'desc' : 'asc');
    } else {
      setBacktestSortField(field);
      setBacktestSortDirection('desc');
    }
  };

  const BacktestSortIcon = ({ field }: { field: BacktestSortField }) => {
    if (backtestSortField !== field) return <span className="ml-1 text-gray-300">↕</span>;
    return <span className="ml-1">{backtestSortDirection === 'asc' ? '↑' : '↓'}</span>;
  };

  const trailing30dMap = useMemo(() => {
    const statsMap = calculateSeriesStatsFromMatched(recentMatchedTrades);
    const result = new Map<string, number>();
    statsMap.forEach((stats, series) => {
      if (stats.totalCost > 0) result.set(series, stats.pnl / stats.totalCost);
    });
    return result;
  }, [recentMatchedTrades]);

  const seriesData = useMemo(() => {
    const statsMap = calculateSeriesStatsFromMatched(matchedTrades);

    return Array.from(statsMap.values()).map(stats => ({
      series: stats.series,
      pnl: stats.pnl,
      proceeds: stats.totalCost + stats.pnl + stats.totalFees,
      totalCost: stats.totalCost,
      fees: stats.totalFees,
      tradesCount: stats.tradesCount,
      avgReturn: stats.totalCost > 0 ? stats.pnl / stats.totalCost : 0,
      winRate: stats.tradesCount > 0 ? stats.winCount / stats.tradesCount : 0,
      trailing30dAvgReturn: trailing30dMap.has(stats.series) ? trailing30dMap.get(stats.series)! : null,
    }));
  }, [matchedTrades, trailing30dMap]);

  const sortedData = useMemo(() => {
    return [...seriesData].sort((a, b) => {
      if (a.trailing30dAvgReturn === null && b.trailing30dAvgReturn === null && sortField === 'trailing30d') return 0;
      if (sortField === 'trailing30d') {
        if (a.trailing30dAvgReturn === null) return 1;
        if (b.trailing30dAvgReturn === null) return -1;
        return sortDirection === 'asc'
          ? a.trailing30dAvgReturn - b.trailing30dAvgReturn
          : b.trailing30dAvgReturn - a.trailing30dAvgReturn;
      }

      let aVal: number | string;
      let bVal: number | string;

      switch (sortField) {
        case 'series': aVal = a.series; bVal = b.series; break;
        case 'pnl': aVal = a.pnl; bVal = b.pnl; break;
        case 'proceeds': aVal = a.proceeds; bVal = b.proceeds; break;
        case 'cost': aVal = a.totalCost; bVal = b.totalCost; break;
        case 'fees': aVal = a.fees; bVal = b.fees; break;
        case 'trades': aVal = a.tradesCount; bVal = b.tradesCount; break;
        case 'avgReturn': aVal = a.avgReturn; bVal = b.avgReturn; break;
        case 'winRate': aVal = a.winRate; bVal = b.winRate; break;
        default: aVal = a.pnl; bVal = b.pnl;
      }

      if (typeof aVal === 'string' && typeof bVal === 'string') {
        return sortDirection === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
      }

      return sortDirection === 'asc'
        ? (aVal as number) - (bVal as number)
        : (bVal as number) - (aVal as number);
    });
  }, [seriesData, sortField, sortDirection]);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(prev => prev === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('desc');
    }
  };

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  };

  const formatPercent = (value: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'percent',
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    }).format(value);
  };

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) return <span className="ml-1 text-gray-300">↕</span>;
    return <span className="ml-1">{sortDirection === 'asc' ? '↑' : '↓'}</span>;
  };

  const generateSQL = () => {
    const today = new Date();
    const MS_PER_DAY = 1000 * 60 * 60 * 24;

    // All computations below use allMatchedTrades only — fully independent of view filters

    // Most recent and earliest Exit_Date per series
    const lastTradeDateMap = new Map<string, Date>();
    const firstTradeDateMap = new Map<string, Date>();
    allMatchedTrades.forEach(t => {
      const { series } = parseTickerComponents(t.Ticker);
      const last = lastTradeDateMap.get(series);
      if (!last || t.Exit_Date > last) lastTradeDateMap.set(series, t.Exit_Date);
      const first = firstTradeDateMap.get(series);
      if (!first || t.Exit_Date < first) firstTradeDateMap.set(series, t.Exit_Date);
    });

    // Unfiltered 30d return map (recomputed here to ignore any active view filters)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const recent30dStats = calculateSeriesStatsFromMatched(
      allMatchedTrades.filter(t => t.Exit_Date >= thirtyDaysAgo)
    );
    const sql30dMap = new Map<string, number>();
    recent30dStats.forEach((stats, series) => {
      if (stats.totalCost > 0) sql30dMap.set(series, stats.pnl / stats.totalCost);
    });

    // Yesterday's r30 (30-day window ending at end-of-yesterday). Used to detect
    // 3-point bucket movement (promoted/demoted) since yesterday's SQL run.
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
    // All-time stats as of yesterday (for tradesCount / pnl in 3-point check)
    const yAllSeriesStats = calculateSeriesStatsFromMatched(
      allMatchedTrades.filter(t => t.Exit_Date < startOfToday)
    );

    // All-time stats for tradesCount and pnl
    const allSeriesStats = calculateSeriesStatsFromMatched(allMatchedTrades);

    // Trades per series in last 14 calendar days. Used by the 3-point system
    // to gate promotions: no recent activity → no promotion (stale r30 guard).
    const fourteenDaysAgo = new Date(startOfToday);
    fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14);
    const trades14dCount = new Map<string, number>();
    for (const t of allMatchedTrades) {
      if (t.Exit_Date < fourteenDaysAgo) continue;
      const { series } = parseTickerComponents(t.Ticker);
      trades14dCount.set(series, (trades14dCount.get(series) ?? 0) + 1);
    }

    // Given r30 and all-time stats, return the 3-point bucket tier (1/100/200).
    // Mirrors the bucket assignment below; null = too new (daysSinceFirst<7).
    const threePointTier = (r30: number | null, tradesCount: number): 1 | 100 | 200 => {
      if (r30 !== null && r30 >= 0 && tradesCount >= 2) return 200;
      if (r30 !== null && r30 < 0 && tradesCount >= 2) return 1;
      return 100;
    };

    // Run activity-based backtest: ≥5 trading days in last 14 → 10-step ladder
    const backtest = backtestTiers(allMatchedTrades);
    // Parallel 3-point tier history for everything else (low-activity series).
    // Used to enforce the "must sit at 1¢ for N days before disable" guardrail.
    const tpBacktest = backtestThreePoint(allMatchedTrades);
    const STINKER_FLOOR_DAYS = 10;

    const fmtPct = (v: number) => (v >= 0 ? '+' : '') + (v * 100).toFixed(1) + '%';
    const fmtTier = (t: number) => `${t}¢`;
    const r30Str = (r: number | null) => r !== null ? `r30 ${fmtPct(r)}` : 'no r30';

    const toDelete: string[] = [];
    const stinkers: string[] = [];

    // Per-frequency stinker thresholds. Disable a series when it has been
    // around at least `days` AND traded at least `trades` times AND has
    // negative all-time P&L AND is currently sitting at the 1¢ floor (so
    // we don't kill series that are mid-recovery up the ladder). Weather
    // is additionally excluded in the emitted SQL.
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
        default:            return { days: 90, trades: 30 };  // unknown → conservative old behavior
      }
    };

    type BucketEntry = { series: string; comment: string };
    const tierBuckets = new Map<number, BucketEntry[]>();
    TIER_LADDER.forEach(t => tierBuckets.set(t, []));

    // 3-point system for low-activity series (1¢ / 100¢ / 200¢)
    const threePointTop: BucketEntry[] = [];        // 200¢
    const threePointMid: BucketEntry[] = [];        // 100¢
    const threePointLow: BucketEntry[] = [];        // 1¢

    allSeriesStats.forEach((stats, series) => {
      const lastDate = lastTradeDateMap.get(series);
      const firstDate = firstTradeDateMap.get(series);
      // Use whole-day deltas so a trade that closed 60 days ago (at any time of
      // day) counts as exactly 60, not 60.x. Otherwise the DELETE threshold
      // fires one day early on the boundary.
      const daysSinceLast = lastDate ? Math.floor((startOfToday.getTime() - lastDate.getTime()) / MS_PER_DAY) : Infinity;
      const daysSinceFirst = firstDate ? Math.floor((startOfToday.getTime() - firstDate.getTime()) / MS_PER_DAY) : 0;

      // DELETE: no trades in more than 60 full days
      if (daysSinceLast > 60) {
        toDelete.push(series);
        return;
      }

      const bt = backtest.get(series);

      if (bt) {
        // ≥5 trading days in last 14 → 10-step ladder
        // Stinker: per-frequency age + trade-count + negative all-time + parked
        // at 1¢ for STINKER_FLOOR_DAYS+ consecutive days. Floor-days guardrail
        // gives a cooling-off window so a single bad day on r30 doesn't kill a
        // series that might bounce back.
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
        // <5 trading days in last 14 → 3-point system (1¢ / 100¢ / 200¢)
        // Stinker check is applied AFTER tier determination below so the 1¢
        // guardrail can use todayTier === 1.
        if (daysSinceFirst < 7) {
          threePointLow.push({ series, comment: `starter day ${daysSinceFirst + 1} (${stats.tradesCount} trades, <5d/14d activity)` });
          return;
        }

        const r30 = sql30dMap.get(series) ?? null;

        // Detect movement since yesterday: compare today's bucket to yesterday's.
        let todayTier = threePointTier(r30, stats.tradesCount);
        const yR30 = ySql30dMap.get(series) ?? null;
        const yStats = yAllSeriesStats.get(series);
        const yDaysSinceFirst = firstDate
          ? (startOfToday.getTime() - firstDate.getTime()) / MS_PER_DAY
          : 0;
        const yTier = (yStats && yDaysSinceFirst >= 7)
          ? threePointTier(yR30, yStats.tradesCount)
          : null;

        // Promotion gate: require ≥1 trade in last 14 days for any UP move.
        // Guards against stale r30 (30d window still has old positive trades
        // but no recent activity, e.g. a series that went dormant). Demotions
        // not gated — down-moves are risk signals.
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

        // Stinker check (3-point branch). Per-frequency age + trade-count +
        // negative all-time + parked at 1¢ for STINKER_FLOOR_DAYS+ consecutive
        // days (using the parallel 3-point backtest history).
        const fr3 = frequencyMap?.get(series);
        const th3 = stinkerThresh(fr3);
        const tpBt = tpBacktest.get(series);
        const daysAtFloor3 = (tpBt && todayTier === 1) ? consecutiveDaysAtFloor(tpBt.history, 1) : 0;
        if (daysSinceFirst >= th3.days && stats.tradesCount >= th3.trades && stats.pnl < 0 && daysAtFloor3 >= STINKER_FLOOR_DAYS) {
          stinkers.push(series);
        }
      }
    });

    // SQL helpers
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

    // 10-step ladder tiers (≥5 trading days in last 14), ascending 1¢ → 200¢
    TIER_LADDER.forEach(tier => {
      const bucket = tierBuckets.get(tier)!;
      if (!bucket.length) return;
      parts.push(
        `-- ${fmtTier(tier)} tier (10-step ladder) — ${bucket.length} series\n` +
        `UPDATE one_cent_series_filters SET position_size_cents = ${tier} WHERE series_ticker IN (\n${emitInBlock(bucket)}\n);`
      );
    });

    // 3-point system (<5 trading days in last 14)
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

    // Sell strategy: per-series analysis based on settlement outcomes
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
    setSqlModal([dateHeader, ...parts].join('\n\n'));
  };

  const handleCopy = () => {
    if (!sqlModal) return;
    navigator.clipboard.writeText(sqlModal);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const runBacktest = () => {
    if (!frequencyMap || !categoryMap) return;
    const result = backtestTiers(allMatchedTrades);
    setBacktestModal(result);
    setBacktestSelectedSeries(null);
  };

  if (seriesData.length === 0 && !onSeriesFilterChange) return null;

  return (
    <div className="mt-6">
      <div className="flex items-center justify-between mb-4 gap-3">
        <h2 className="text-xl font-semibold shrink-0">Series Performance</h2>
        <div className="flex items-center gap-3">
          {seriesData.length > 0 && (() => {
            const missingFrequency = !frequencyMap || frequencyMap.size === 0;
            const missingCategory = !categoryMap || categoryMap.size === 0;
            const missingSettlement = !settlementMap || settlementMap.size === 0;
            const sqlDisabled = missingFrequency || missingSettlement;
            const backtestDisabled = missingFrequency || missingCategory;
            const sqlTooltip = sqlDisabled
              ? [missingFrequency && 'frequency data', missingSettlement && 'settlement data'].filter(Boolean).join(' and ') + ' not yet loaded'
              : '';
            const backtestTooltip = backtestDisabled
              ? [missingFrequency && 'frequency data', missingCategory && 'category data'].filter(Boolean).join(' and ') + ' not yet loaded'
              : 'Simulate ladder tier path for each series from first trade to today';
            return (
              <>
                <button
                  onClick={runBacktest}
                  disabled={backtestDisabled}
                  title={backtestTooltip}
                  className={`px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${backtestDisabled ? 'bg-gray-300 text-gray-500 cursor-not-allowed' : 'bg-purple-600 text-white hover:bg-purple-700'}`}
                >
                  Run Backtest
                </button>
                <button
                  onClick={generateSQL}
                  disabled={sqlDisabled}
                  title={sqlTooltip}
                  className={`px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${sqlDisabled ? 'bg-gray-300 text-gray-500 cursor-not-allowed' : 'bg-gray-800 text-white hover:bg-gray-700'}`}
                >
                  Generate SQL
                </button>
              </>
            );
          })()}
          {onSeriesFilterChange && (
            <div className="relative">
              <input
                type="text"
                value={seriesFilter || ''}
                onChange={(e) => onSeriesFilterChange(e.target.value)}
                placeholder="Filter series name..."
                className="w-48 px-3 py-1.5 text-sm border border-gray-300 rounded-full focus:outline-none focus:ring-2 focus:ring-orange-300 focus:border-orange-400"
              />
              {seriesFilter && (
                <button
                  onClick={() => onSeriesFilterChange('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              )}
            </div>
          )}
          {selectedSeries && (
            <button
              onClick={() => onSeriesSelect(null)}
              className="flex items-center gap-2 px-3 py-1.5 bg-blue-50 text-blue-700 rounded-full text-sm font-medium hover:bg-blue-100 transition-colors"
            >
              <span>Filtering: {selectedSeries}</span>
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
      </div>
      <div className="bg-white shadow rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100" onClick={() => handleSort('series')}>
                  Series <SortIcon field="series" />
                </th>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100" onClick={() => handleSort('proceeds')}>
                  Proceeds <SortIcon field="proceeds" />
                </th>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100" onClick={() => handleSort('cost')}>
                  Cost <SortIcon field="cost" />
                </th>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100" onClick={() => handleSort('fees')}>
                  Fees <SortIcon field="fees" />
                </th>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100" onClick={() => handleSort('pnl')}>
                  Net Profit <SortIcon field="pnl" />
                </th>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100" onClick={() => handleSort('trades')}>
                  Trades <SortIcon field="trades" />
                </th>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100" onClick={() => handleSort('winRate')}>
                  Win Rate <SortIcon field="winRate" />
                </th>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100" onClick={() => handleSort('avgReturn')}>
                  Avg Return <SortIcon field="avgReturn" />
                </th>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100" onClick={() => handleSort('trailing30d')} title="Avg return over the last 30 days">
                  30d Return <SortIcon field="trailing30d" />
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {sortedData.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-6 py-8 text-center text-sm text-gray-400">
                    No series match the current filter
                  </td>
                </tr>
              )}
              {sortedData.map((row) => (
                <tr
                  key={row.series}
                  onClick={() => selectedSeries === row.series ? onSeriesSelect(null) : onSeriesSelect(row.series)}
                  className={`cursor-pointer transition-colors ${selectedSeries === row.series ? 'bg-blue-50 hover:bg-blue-100' : 'hover:bg-gray-50'}`}
                >
                  <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">{row.series}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{formatCurrency(row.proceeds)}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{formatCurrency(row.totalCost)}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{formatCurrency(row.fees)}</td>
                  <td className={`px-6 py-4 whitespace-nowrap text-sm font-medium ${row.pnl >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                    {formatCurrency(row.pnl)}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{row.tradesCount}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{formatPercent(row.winRate)}</td>
                  <td className={`px-6 py-4 whitespace-nowrap text-sm ${row.avgReturn >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                    {formatPercent(row.avgReturn)}
                  </td>
                  <td className={`px-6 py-4 whitespace-nowrap text-sm font-medium ${
                    row.trailing30dAvgReturn === null
                      ? 'text-gray-300'
                      : row.trailing30dAvgReturn >= 0
                        ? 'text-green-600'
                        : 'text-red-600'
                  }`}>
                    {row.trailing30dAvgReturn === null ? '—' : formatPercent(row.trailing30dAvgReturn)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="px-6 py-3 bg-gray-50 text-xs text-gray-500">
          Click a row to filter all data to that series. Click again to clear filter.
        </div>
      </div>

      {backtestModal !== null && (() => {
        const distribution = summarizeTierDistribution(backtestModal);
        const selected = backtestSelectedSeries ? backtestModal.get(backtestSelectedSeries) : null;
        const allSorted = Array.from(backtestModal.values()).sort((a, b) => {
          const dir = backtestSortDirection === 'asc' ? 1 : -1;
          switch (backtestSortField) {
            case 'series': return dir * a.series.localeCompare(b.series);
            case 'activity': return dir * (a.recentActivityDays - b.recentActivityDays);
            case 'firstTrade': return dir * a.firstTradeDate.localeCompare(b.firstTradeDate);
            case 'days': return dir * (a.daysTracked - b.daysTracked);
            case 'trades': return dir * (a.totalTrades - b.totalTrades);
            case 'currentTier':
              if (a.currentTier !== b.currentTier) return dir * (a.currentTier - b.currentTier);
              return a.series.localeCompare(b.series);
            case 'lastR30': {
              if (a.lastR30 === null && b.lastR30 === null) return 0;
              if (a.lastR30 === null) return 1;
              if (b.lastR30 === null) return -1;
              return dir * (a.lastR30 - b.lastR30);
            }
          }
        });
        return (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-xl shadow-2xl w-full max-w-5xl flex flex-col max-h-[85vh]">
              <div className="flex items-center justify-between px-6 py-4 border-b">
                <h3 className="text-lg font-semibold">Ladder Backtest — {backtestModal.size} series</h3>
                <button onClick={() => { setBacktestModal(null); setBacktestSelectedSeries(null); }} className="text-gray-400 hover:text-gray-600 text-xl leading-none">✕</button>
              </div>
              <div className="px-6 py-3 border-b bg-gray-50 text-xs text-gray-600">
                Activity-based: ≥{RECENT_ACTIVITY_THRESHOLD} trading days in last {RECENT_ACTIVITY_WINDOW} → {TIER_LADDER.length}-step ladder ({TIER_LADDER.map(t => t === 1 ? '1¢' : `${t}¢`).join(' → ')}). 3 consecutive r30 ≥ 0 → +1. Any r30 &lt; 0 → -1. Days 1–3 pinned at 1¢. Others → 3-point (1¢/100¢/200¢).
              </div>
              <div className="grid gap-px bg-gray-200 border-b shrink-0" style={{gridTemplateColumns: `repeat(${TIER_LADDER.length}, minmax(0, 1fr))`}}>
                {distribution.map(d => (
                  <div key={d.tier} className="bg-white px-2 py-2 text-center">
                    <div className="text-xs text-gray-500">{d.tier === 1 ? '1¢' : `${d.tier}¢`}</div>
                    <div className={`text-lg font-semibold ${d.count === 0 ? 'text-gray-300' : 'text-gray-900'}`}>{d.count}</div>
                  </div>
                ))}
              </div>
              {selected ? (
                <>
                  <div className="px-6 pt-4 pb-2 shrink-0 border-b">
                    <button onClick={() => setBacktestSelectedSeries(null)} className="text-sm text-blue-600 hover:underline mb-3">← Back to all series</button>
                    <div className="mb-3">
                      <h4 className="text-lg font-semibold">{selected.series}</h4>
                      <div className="text-xs text-gray-500">
                        Recent activity: <span className="font-medium">{selected.recentActivityDays}d/{RECENT_ACTIVITY_WINDOW}d</span> · First trade: {selected.firstTradeDate} · {selected.totalTrades} trades · {selected.daysTracked} days tracked · Current tier: <span className="font-semibold">{selected.currentTier === 1 ? '1¢' : `${selected.currentTier}¢`}</span>
                      </div>
                    </div>
                    <table className="min-w-full text-xs">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="px-3 py-2 text-left font-medium text-gray-500">Date</th>
                          <th className="px-3 py-2 text-left font-medium text-gray-500">Tier</th>
                          <th className="px-3 py-2 text-left font-medium text-gray-500">r30</th>
                          <th className="px-3 py-2 text-left font-medium text-gray-500">Streak</th>
                          <th className="px-3 py-2 text-left font-medium text-gray-500">Move</th>
                        </tr>
                      </thead>
                    </table>
                  </div>
                  <div className="flex-1 overflow-auto px-6 pb-4">
                    <table className="min-w-full text-xs">
                      <tbody className="divide-y divide-gray-100">
                        {[...selected.history].reverse().map((h, i) => (
                          <tr key={i} className={h.moved ? 'bg-yellow-50' : ''}>
                            <td className="px-3 py-1 font-mono text-gray-700">{h.date}</td>
                            <td className="px-3 py-1 font-semibold">{h.tier === 1 ? '1¢' : `${h.tier}¢`}</td>
                            <td className={`px-3 py-1 ${h.r30 === null ? 'text-gray-300' : h.r30 >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                              {h.r30 === null ? '—' : formatPercent(h.r30)}
                            </td>
                            <td className="px-3 py-1 text-gray-500">{h.consecutivePositive}</td>
                            <td className={`px-3 py-1 font-medium ${h.moved === 'up' ? 'text-green-700' : h.moved === 'down' ? 'text-red-700' : 'text-gray-400'}`}>
                              {h.moved === 'up' ? '↑ promoted' : h.moved === 'down' ? '↓ demoted' : '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              ) : (
                <>
                  <div className="shrink-0 border-b">
                    <table className="min-w-full text-xs">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="px-3 py-2 text-left font-medium text-gray-500 cursor-pointer select-none hover:bg-gray-100" onClick={() => handleBacktestSort('series')}>Series<BacktestSortIcon field="series" /></th>
                          <th className="px-3 py-2 text-left font-medium text-gray-500 cursor-pointer select-none hover:bg-gray-100" onClick={() => handleBacktestSort('activity')}>Activity<BacktestSortIcon field="activity" /></th>
                          <th className="px-3 py-2 text-left font-medium text-gray-500 cursor-pointer select-none hover:bg-gray-100" onClick={() => handleBacktestSort('firstTrade')}>First Trade<BacktestSortIcon field="firstTrade" /></th>
                          <th className="px-3 py-2 text-left font-medium text-gray-500 cursor-pointer select-none hover:bg-gray-100" onClick={() => handleBacktestSort('days')}>Days<BacktestSortIcon field="days" /></th>
                          <th className="px-3 py-2 text-left font-medium text-gray-500 cursor-pointer select-none hover:bg-gray-100" onClick={() => handleBacktestSort('trades')}>Trades<BacktestSortIcon field="trades" /></th>
                          <th className="px-3 py-2 text-left font-medium text-gray-500 cursor-pointer select-none hover:bg-gray-100" onClick={() => handleBacktestSort('currentTier')}>Current Tier<BacktestSortIcon field="currentTier" /></th>
                          <th className="px-3 py-2 text-left font-medium text-gray-500 cursor-pointer select-none hover:bg-gray-100" onClick={() => handleBacktestSort('lastR30')}>Last r30<BacktestSortIcon field="lastR30" /></th>
                        </tr>
                      </thead>
                    </table>
                  </div>
                  <div className="flex-1 overflow-auto">
                    <table className="min-w-full text-xs">
                      <tbody className="divide-y divide-gray-100">
                        {allSorted.map(bt => (
                          <tr key={bt.series} className="hover:bg-blue-50 cursor-pointer" onClick={() => setBacktestSelectedSeries(bt.series)}>
                            <td className="px-3 py-1 font-medium text-blue-700">{bt.series}</td>
                            <td className="px-3 py-1 text-gray-500">{bt.recentActivityDays}d/{RECENT_ACTIVITY_WINDOW}d</td>
                            <td className="px-3 py-1 font-mono text-gray-500">{bt.firstTradeDate}</td>
                            <td className="px-3 py-1 text-gray-500">{bt.daysTracked}</td>
                            <td className="px-3 py-1 text-gray-500">{bt.totalTrades}</td>
                            <td className="px-3 py-1 font-semibold">{bt.currentTier === 1 ? '1¢' : `${bt.currentTier}¢`}</td>
                            <td className={`px-3 py-1 ${bt.lastR30 === null ? 'text-gray-300' : bt.lastR30 >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                              {bt.lastR30 === null ? '—' : formatPercent(bt.lastR30)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
              <div className="px-6 py-3 border-t text-xs text-gray-500 bg-gray-50">
                Click a series to see its day-by-day tier history. Click Back to return.
              </div>
            </div>
          </div>
        );
      })()}

      {sqlModal !== null && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl flex flex-col max-h-[80vh]">
            <div className="flex items-center justify-between px-6 py-4 border-b">
              <h3 className="text-lg font-semibold">Position Size SQL</h3>
              <button onClick={() => setSqlModal(null)} className="text-gray-400 hover:text-gray-600 text-xl leading-none">✕</button>
            </div>
            <div className="px-6 py-2 text-xs text-gray-500 border-b bg-gray-50">
              <span className="font-medium text-gray-700">{TIER_LADDER.length}-step ladder</span> (≥{RECENT_ACTIVITY_THRESHOLD}d/{RECENT_ACTIVITY_WINDOW}d active): {TIER_LADDER.map(t => t === 1 ? '1¢' : `${t}¢`).join('→')}. Days 1–3 at 1¢; 3 consecutive r30 ≥ 0 days → +1 level, any r30 &lt; 0 → -1 level. &nbsp;·&nbsp;
              <span className="font-medium text-gray-700">3-point</span> (low activity): 200¢ (positive 30d + 2+ trades), 100¢ (insufficient data), 1¢ (negative 30d + 2+ trades). &nbsp;·&nbsp;
              <span className="font-medium text-gray-700">DELETE</span> — no trades in 60+ days. &nbsp;·&nbsp;
              <span className="font-medium text-gray-700">Disabled stinkers</span> — per-frequency thresholds (hourly/daily 30d/30t, weekly 45d/20t, monthly 60d/6t, annual/one_off 90d), all-time negative, parked at 1¢ for 10+ consecutive days, non-weather.
            </div>
            <textarea
              readOnly
              value={sqlModal}
              className="flex-1 p-4 font-mono text-xs text-gray-800 resize-none focus:outline-none overflow-auto min-h-0"
            />
            <div className="flex justify-end gap-3 px-6 py-4 border-t">
              <button
                onClick={handleCopy}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${copied ? 'bg-green-600 text-white' : 'bg-blue-600 text-white hover:bg-blue-700'}`}
              >
                {copied ? 'Copied!' : 'Copy to clipboard'}
              </button>
              <button
                onClick={() => setSqlModal(null)}
                className="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg text-sm font-medium hover:bg-gray-200"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

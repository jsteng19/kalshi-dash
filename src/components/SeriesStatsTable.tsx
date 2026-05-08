'use client';

import React, { useMemo, useState, useDeferredValue } from 'react';
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
  const [generatingSQL, setGeneratingSQL] = useState(false);

  // Defer heavy props so the table render + filter input stay snappy when the
  // user types. React renders the OLD seriesData immediately, then schedules
  // recompute at low priority; UI never freezes mid-keystroke.
  const deferredMatched = useDeferredValue(matchedTrades);
  const deferredRecent = useDeferredValue(recentMatchedTrades);

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
    const statsMap = calculateSeriesStatsFromMatched(deferredRecent);
    const result = new Map<string, number>();
    statsMap.forEach((stats, series) => {
      if (stats.totalCost > 0) result.set(series, stats.pnl / stats.totalCost);
    });
    return result;
  }, [deferredRecent]);

  const seriesData = useMemo(() => {
    const statsMap = calculateSeriesStatsFromMatched(deferredMatched);

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
  }, [deferredMatched, trailing30dMap]);

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
    if (!frequencyMap) return;
    setGeneratingSQL(true);
    const worker = new Worker(
      new URL('../workers/generateSql.worker.ts', import.meta.url)
    );
    worker.onmessage = (e: MessageEvent<{ ok: true; sql: string } | { ok: false; error: string }>) => {
      setGeneratingSQL(false);
      worker.terminate();
      if (e.data.ok) setSqlModal(e.data.sql);
      else console.error('generateSQL worker:', e.data.error);
    };
    worker.onerror = (err) => {
      setGeneratingSQL(false);
      worker.terminate();
      console.error('generateSQL worker errored:', err.message);
    };
    worker.postMessage({
      allMatchedTrades,
      frequencyMap,
      categoryMap,
      settlementMap: settlementMap ?? new Map(),
    });
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
                  disabled={sqlDisabled || generatingSQL}
                  title={sqlTooltip}
                  className={`px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${sqlDisabled || generatingSQL ? 'bg-gray-300 text-gray-500 cursor-not-allowed' : 'bg-gray-800 text-white hover:bg-gray-700'}`}
                >
                  {generatingSQL ? 'Generating…' : 'Generate SQL'}
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

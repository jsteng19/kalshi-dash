'use client';

import React from 'react';
import { Trade } from '@/utils/processData';

interface OverviewProps {
  stats: {
    uniqueTickers: number;
    totalTrades: number;
    yesNoBreakdown: { Yes: number; No: number };
    totalFees: number;
    totalProfit: number;
    avgContractPurchasePrice: number;
    avgContractFinalPrice: number;
    weightedHoldingPeriod: number;
    winRate: number;
    settledWinRate: number;
  };
  trades: Trade[];
}

const StatCard = ({ title, value, tooltip, className = '' }: { title: string; value: string | number; tooltip: string; className?: string }) => (
  <div className={`bg-white shadow rounded-lg p-4 relative group ${className}`}>
    <h3 className="text-sm font-medium text-gray-500">{title}</h3>
    <p className="mt-1 text-2xl font-semibold text-gray-900">{value}</p>
    <div className="absolute invisible group-hover:visible bg-gray-800 text-white text-xs rounded p-2 z-10 w-64 -top-2 left-1/2 transform -translate-x-1/2 -translate-y-full">
      {tooltip}
      <div className="absolute bottom-0 left-1/2 transform -translate-x-1/2 translate-y-1/2 rotate-45 w-2 h-2 bg-gray-800"></div>
    </div>
  </div>
);

export default function Overview({ stats, trades }: OverviewProps) {
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
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  };

  const formatCents = (value: number) => {
    return (value / 100).toFixed(2) + '¢';
  };

  const formatDays = (value: number) => {
    return value.toFixed(1) + ' days';
  };

  // Filter to exit trades (settlements or trades with non-zero realized revenue)
  const exitTrades = trades.filter(t => 
    t.Type === 'settlement' || t.Realized_Revenue > 0
  );

  const totalRisked = exitTrades.reduce((sum, trade) => {
    if (trade.Type === 'settlement') {
      return sum + trade.Realized_Cost;
    }
    return sum + (trade.Realized_Cost - trade.Average_Price * trade.Realized_Revenue / 100);
  }, 0);
  const avgPnlPerDollarRisked = exitTrades.reduce((sum, trade) => {
    return sum + trade.Realized_Profit;
  }, 0) / totalRisked;

  // Calculate profit by ticker using original trades
  const profitByTicker = trades.reduce((acc, trade) => {
    acc[trade.Ticker] = (acc[trade.Ticker] || 0) + trade.Realized_Profit;
    return acc;
  }, {} as Record<string, number>);

  // Find best and worst tickers
  const entries = Object.entries(profitByTicker);
  const [maxTicker, maxProfit] = entries.length
    ? entries.reduce(([t, p], [t2, p2]) => (p2 > p ? [t2, p2] : [t, p]))
    : ['N/A', 0];
  const [minTicker, minProfit] = entries.length
    ? entries.reduce(([t, p], [t2, p2]) => (p2 < p ? [t2, p2] : [t, p]))
    : ['N/A', 0];

  // Find highest ROI trade and its ROI value
  const [highestROITrade, highestROI] = exitTrades.reduce<[Trade | null, number]>((best, trade) => {
    // Skip trades with zero or negative investment
    if (trade.Realized_Cost <= 0) return best;
    
    // Calculate investment amount based on trade type
    const investment = trade.Type === 'settlement' 
      ? trade.Realized_Cost
      : trade.Realized_Cost - (trade.Average_Price * trade.Realized_Revenue / 100);
    
    // Skip if investment is zero or negative
    if (investment <= 0) return best;
    
    const currentROI = trade.Realized_Profit / investment;
    
    // Get previous best ROI for comparison
    const [bestTrade, bestROI] = best;
    
    return currentROI > bestROI ? [trade, currentROI] : best;
  }, [null, -Infinity]);

  return (
    <div className="mt-6">
      <h2 className="text-xl font-semibold mb-4">Trading Overview</h2>
      <div className="grid gap-6">
        {/* Overall Performance */}
        <div>
          <h3 className="text-lg font-medium text-gray-700 mb-3">Overall Performance</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard 
              title="Total Profit" 
              value={formatCurrency(stats.totalProfit)} 
              tooltip="Total profit from all trades"
              className="border-l-4 border-green-500"
            />
            <StatCard 
              title="Total Fees" 
              value={formatCurrency(stats.totalFees)} 
              tooltip="Total fees paid for all trades"
              className="border-l-4 border-red-500"
            />
            <StatCard 
              title="Win Rate" 
              value={formatPercent(stats.winRate)} 
              tooltip="Percentage of trades that resulted in a profit"
              className="border-l-4 border-blue-500"
            />
            <StatCard 
              title="Avg PNL/$ Risked" 
              value={formatPercent(avgPnlPerDollarRisked)} 
              tooltip="Average profit/loss per dollar of capital risked across all trades"
              className="border-l-4 border-purple-500"
            />
          </div>
        </div>

        {/* Trading Activity */}
        <div>
          <h3 className="text-lg font-medium text-gray-700 mb-3">Trading Activity</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard 
              title="Total Trades" 
              value={trades.length} 
              tooltip="Total number of trades executed"
            />
            <StatCard 
              title="Unique Tickers" 
              value={stats.uniqueTickers} 
              tooltip="Number of different tickers traded"
            />
            <StatCard 
              title="Average Hold Time" 
              value={formatDays(stats.weightedHoldingPeriod)} 
              tooltip="Average contract holding period"
            />
            <StatCard 
              title="Settlement Win Rate" 
              value={formatPercent(stats.settledWinRate)} 
              tooltip="Win rate for trades held to settlement"
            />
          </div>
        </div>

        {/* Entries and Exits */}
        <div>
          <h3 className="text-lg font-medium text-gray-700 mb-3">Entries and Exits</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-2 gap-4">
            <StatCard 
              title="Avg Entry Price" 
              value={formatCents(stats.avgContractPurchasePrice)} 
              tooltip="Average price paid per contract when entering positions"
            />
            <StatCard 
              title="Avg Exit Price" 
              value={formatCents(stats.avgContractFinalPrice)} 
              tooltip="Average price received per contract when positioned are sold or settled"
            />
          </div>
        </div>

        {/* Notable Trades */}
        <div>
          <h3 className="text-lg font-medium text-gray-700 mb-3">Notable Trades</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <StatCard 
              title="Biggest Win" 
              value={`${formatCurrency(maxProfit)} (${maxTicker})`} 
              tooltip={`Net profit for ${maxTicker}`} 
              className="border-l-4 border-green-400"
            />
            <StatCard 
              title="Biggest Loss" 
              value={`${formatCurrency(minProfit)} (${minTicker})`} 
              tooltip={`Net profit for ${minTicker}`} 
              className="border-l-4 border-red-400"
            />
            <StatCard 
              title="Highest ROI" 
              value={`${formatPercent(highestROI || 0)} (${highestROITrade?.Ticker || 'N/A'})`}
              tooltip={`${formatCurrency(highestROITrade?.Realized_Profit || 0)} profit on ${formatCurrency((highestROITrade?.Realized_Cost || 0))} risked`}
              className="border-l-4 border-blue-400"
            />
          </div>
        </div>
      </div>
    </div>
  );
} 
'use client';

import React, { useState, useMemo, useEffect } from 'react';
import { MatchedTrade } from '@/utils/processData';

interface RiskAdjustedReturnsProps {
  matchedTrades: MatchedTrade[];
}

interface RiskMetrics {
  totalReturn: number;
  standardDeviation: number;
  annualizedSharpe: number;
  tradingDays: number;
  avgDailyReturn: number;
  annualizedReturn: number;
  annualizedVolatility: number;
  initialCapital: number;
}

const calculateRiskMetrics = (matchedTrades: MatchedTrade[], initialCapital: number): RiskMetrics => {
  if (matchedTrades.length === 0 || initialCapital <= 0) {
    return {
      totalReturn: 0,
      standardDeviation: 0,
      annualizedSharpe: 0,
      tradingDays: 0,
      avgDailyReturn: 0,
      annualizedReturn: 0,
      annualizedVolatility: 0,
      initialCapital,
    };
  }

  // Get date range
  const startDate = new Date(matchedTrades.reduce((min, t) => Math.min(min, t.Entry_Date.getTime()), Infinity));
  const endDate = new Date(matchedTrades.reduce((max, t) => Math.max(max, t.Exit_Date.getTime()), -Infinity));
  
  // Aggregate P&L by exit date in a single O(N) pass
  const dailyPnl = new Map<string, number>();
  for (const trade of matchedTrades) {
    const key = trade.Exit_Date.toISOString().split('T')[0];
    dailyPnl.set(key, (dailyPnl.get(key) ?? 0) + trade.Realized_Profit);
  }

  // Sweep date range once to build portfolio values — O(D) where D = number of days
  let cumulativeProfit = 0;
  const portfolioValueArray: { date: Date; value: number }[] = [];
  const sweepDate = new Date(startDate);
  sweepDate.setHours(0, 0, 0, 0);
  while (sweepDate <= endDate) {
    const key = sweepDate.toISOString().split('T')[0];
    cumulativeProfit += dailyPnl.get(key) ?? 0;
    portfolioValueArray.push({ date: new Date(sweepDate), value: initialCapital + cumulativeProfit });
    sweepDate.setDate(sweepDate.getDate() + 1);
  }

  // Calculate daily returns from portfolio values
  const dailyReturns: number[] = [];

  for (let i = 1; i < portfolioValueArray.length; i++) {
    const todayValue = portfolioValueArray[i].value;
    const yesterdayValue = portfolioValueArray[i - 1].value;
    
    if (yesterdayValue > 0) {
      const dailyReturn = (todayValue - yesterdayValue) / initialCapital;
      dailyReturns.push(dailyReturn);
    }
  }

  // Filter to only days with non-zero returns (trading activity)
  const activeDailyReturns = dailyReturns.filter(ret => Math.abs(ret) > 0);

  if (activeDailyReturns.length === 0) {
    return {
      totalReturn: 0,
      standardDeviation: 0,
      annualizedSharpe: 0,
      tradingDays: 0,
      avgDailyReturn: 0,
      annualizedReturn: 0,
      annualizedVolatility: 0,
      initialCapital,
    };
  }

  // Calculate metrics using all daily returns (including zero-return days)
  const avgDailyReturn = dailyReturns.reduce((sum, ret) => sum + ret, 0) / dailyReturns.length;
  
  // Calculate standard deviation using all daily returns
  const variance = dailyReturns.reduce((sum, ret) => sum + Math.pow(ret - avgDailyReturn, 2), 0) / (dailyReturns.length - 1);
  const standardDeviation = Math.sqrt(variance);

  // Calculate total return from initial to final portfolio value
  const finalValue = portfolioValueArray[portfolioValueArray.length - 1].value;
  const totalReturn = (finalValue - initialCapital) / initialCapital;

  // Calculate trading period metrics for annualization
  const tradingDays = activeDailyReturns.length;
  const totalDays = dailyReturns.length;
  const expectedYearlyTradingDays = 252; // Standard trading days per year

  // Annualize metrics
  const annualizedReturn = avgDailyReturn * expectedYearlyTradingDays;
  const annualizedVolatility = standardDeviation * Math.sqrt(expectedYearlyTradingDays);
  
  // Calculate Sharpe ratio
  const excessReturn = avgDailyReturn;
  const sharpeRatio = standardDeviation !== 0 ? excessReturn / standardDeviation : 0;
  const annualizedSharpe = sharpeRatio * Math.sqrt(expectedYearlyTradingDays);

  return {
    totalReturn,
    standardDeviation,
    annualizedSharpe,
    tradingDays,
    avgDailyReturn,
    annualizedReturn,
    annualizedVolatility,
    initialCapital,
  };
};

export default function RiskAdjustedReturns({ matchedTrades }: RiskAdjustedReturnsProps) {
  const [inputCapital, setInputCapital] = useState<number>(10000);
  const [debouncedCapital, setDebouncedCapital] = useState<number>(10000);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedCapital(inputCapital), 400);
    return () => clearTimeout(timer);
  }, [inputCapital]);

  const metrics = useMemo(
    () => calculateRiskMetrics(matchedTrades, debouncedCapital),
    [matchedTrades, debouncedCapital]
  );

  const formatPercent = (value: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'percent',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  };

  const formatNumber = (value: number, decimals: number = 4) => {
    return value.toFixed(decimals);
  };

  return (
    <div className="mt-6">
      <h2 className="text-xl font-semibold mb-4">Risk Adjusted Returns</h2>
      <div className="bg-white shadow rounded-lg p-6">
        {/* Capital Input */}
        <div className="mb-6 p-4 bg-gray-50 rounded-lg">
          <label htmlFor="totalCapital" className="block text-sm font-medium text-gray-700 mb-2">
            Total Account Capital
          </label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-500">$</span>
            <input
              id="totalCapital"
              type="number"
              value={inputCapital}
              onChange={(e) => setInputCapital(Number(e.target.value) || 0)}
              className="pl-8 pr-4 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              placeholder="10000"
              min="1"
            />
          </div>
        </div>
        
        <div className="text-sm text-gray-600 mb-4">
          Portfolio Value Method - Daily returns calculated from portfolio value changes, using initial capital of ${metrics.initialCapital.toLocaleString()}
        </div>
        
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {/* Total Return */}
          <div className="text-center">
            <div className="text-2xl font-bold text-blue-600">
              {formatPercent(metrics.totalReturn)}
            </div>
            <div className="text-sm text-gray-500 mt-1">Total Return</div>
            <div className="text-xs text-gray-400 mt-1">
              Based on ${metrics.initialCapital.toLocaleString()} initial capital
            </div>
          </div>

          {/* Standard Deviation */}
          <div className="text-center">
            <div className="text-2xl font-bold text-yellow-600">
              {formatPercent(metrics.standardDeviation)}
            </div>
            <div className="text-sm text-gray-500 mt-1">Daily Volatility</div>
            <div className="text-xs text-gray-400 mt-1">
              Standard deviation of daily returns
            </div>
          </div>

          {/* Annualized Sharpe Ratio */}
          <div className="text-center">
            <div className={`text-2xl font-bold ${metrics.annualizedSharpe >= 1 ? 'text-green-600' : metrics.annualizedSharpe >= 0 ? 'text-yellow-600' : 'text-red-600'}`}>
              {formatNumber(metrics.annualizedSharpe, 2)}
            </div>
            <div className="text-sm text-gray-500 mt-1">Annualized Sharpe Ratio</div>
            <div className="text-xs text-gray-400 mt-1">
              Risk-adjusted return measure
            </div>
          </div>
        </div>

        {/* Additional Metrics */}
        <div className="mt-6 pt-6 border-t border-gray-200">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <div>
              <div className="text-gray-500">Trading Days</div>
              <div className="font-semibold">{metrics.tradingDays}</div>
            </div>
            <div>
              <div className="text-gray-500">Avg Daily Return</div>
              <div className="font-semibold">{formatPercent(metrics.avgDailyReturn)}</div>
            </div>
            <div>
              <div className="text-gray-500">Annualized Return</div>
              <div className="font-semibold">{formatPercent(metrics.annualizedReturn)}</div>
            </div>
            <div>
              <div className="text-gray-500">Annualized Volatility</div>
              <div className="font-semibold">{formatPercent(metrics.annualizedVolatility)}</div>
            </div>
          </div>
        </div>


      </div>
    </div>
  );
} 
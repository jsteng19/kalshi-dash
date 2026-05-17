'use client';

import React, { useState, useRef, useEffect } from 'react';
import { MatchedTrade, parseTickerComponents } from '@/utils/processData';

interface TradeNarrativeProps {
  matchedTrades: MatchedTrade[];
  basicStats: {
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
  categoryMap: Map<string, string>;
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

export default function TradeNarrative({ matchedTrades, basicStats, categoryMap }: TradeNarrativeProps) {
  const [collapsed, setCollapsed] = useState(true);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const buildStatsPayload = () => {
    const seriesMap = new Map<string, { pnl: number; trades: number; wins: number; cost: number }>();
    const categoryAgg = new Map<string, { pnl: number; trades: number; wins: number; series: Set<string> }>();

    matchedTrades.forEach(t => {
      const { series } = parseTickerComponents(t.Ticker);

      const s = seriesMap.get(series) || { pnl: 0, trades: 0, wins: 0, cost: 0 };
      s.pnl += t.Net_Profit;
      s.trades++;
      s.cost += t.Entry_Cost;
      if (t.Net_Profit > 0) s.wins++;
      seriesMap.set(series, s);

      const cat = categoryMap.get(series) || 'Uncategorized';
      const c = categoryAgg.get(cat) || { pnl: 0, trades: 0, wins: 0, series: new Set<string>() };
      c.pnl += t.Net_Profit;
      c.trades++;
      if (t.Net_Profit > 0) c.wins++;
      c.series.add(series);
      categoryAgg.set(cat, c);
    });

    const seriesArr = Array.from(seriesMap.entries())
      .map(([name, s]) => ({ name, ...s, roi: s.cost > 0 ? s.pnl / s.cost : 0, winRate: s.trades > 0 ? s.wins / s.trades : 0 }))
      .sort((a, b) => b.pnl - a.pnl);

    const top5 = seriesArr.slice(0, 5).map(s => ({
      series: s.name, pnl: +s.pnl.toFixed(2), trades: s.trades,
      roi: +(s.roi * 100).toFixed(1) + '%', winRate: +(s.winRate * 100).toFixed(1) + '%',
    }));

    const bottom5 = seriesArr.slice(-5).reverse().map(s => ({
      series: s.name, pnl: +s.pnl.toFixed(2), trades: s.trades,
      roi: +(s.roi * 100).toFixed(1) + '%', winRate: +(s.winRate * 100).toFixed(1) + '%',
    }));

    const categories = Array.from(categoryAgg.entries())
      .map(([name, c]) => ({
        category: name, pnl: +c.pnl.toFixed(2), trades: c.trades,
        seriesCount: c.series.size, winRate: +(c.trades > 0 ? (c.wins / c.trades) * 100 : 0).toFixed(1) + '%',
      }))
      .sort((a, b) => b.pnl - a.pnl);

    return {
      overview: {
        totalPnl: +basicStats.totalProfit.toFixed(2),
        totalTrades: basicStats.totalTrades,
        totalFees: +basicStats.totalFees.toFixed(2),
        winRate: +(basicStats.winRate * 100).toFixed(1) + '%',
        settledWinRate: +(basicStats.settledWinRate * 100).toFixed(1) + '%',
        avgHoldingPeriodDays: +basicStats.weightedHoldingPeriod.toFixed(2),
        avgEntryPrice: +basicStats.avgContractPurchasePrice.toFixed(1),
        avgExitPrice: +basicStats.avgContractFinalPrice.toFixed(1),
        uniqueMarkets: basicStats.uniqueTickers,
        totalSeries: seriesMap.size,
      },
      categoryBreakdown: categories,
      top5Series: top5,
      bottom5Series: bottom5,
    };
  };

  const sendMessage = async () => {
    const question = input.trim();
    if (!question || loading) return;

    setInput('');
    setError(null);

    const newMessages: Message[] = [...messages, { role: 'user', content: question }];
    setMessages(newMessages);
    setLoading(true);

    try {
      const resp = await fetch('/api/narrative', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          stats: buildStatsPayload(),
          messages: newMessages,
        }),
      });

      if (!resp.ok) {
        const data = await resp.json();
        throw new Error(data.error || `HTTP ${resp.status}`);
      }

      const data = await resp.json();
      setMessages([...newMessages, { role: 'assistant', content: data.narrative }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      inputRef.current?.focus();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  return (
    <div className="mt-6">
      <button
        type="button"
        onClick={() => setCollapsed(c => !c)}
        className="flex items-center gap-2 mb-4 text-xl font-semibold hover:text-blue-700 transition-colors"
      >
        <span className={`inline-block transition-transform ${collapsed ? '' : 'rotate-90'}`}>▶</span>
        AI Trading Q&amp;A
      </button>
      {!collapsed && (
      <div className="bg-white shadow rounded-lg overflow-hidden">
        {/* Messages area */}
        <div className="h-72 overflow-y-auto p-4 space-y-3">
          {messages.length === 0 && (
            <div className="flex items-center justify-center h-full">
              <p className="text-sm text-gray-400">Ask a question about your trading data...</p>
            </div>
          )}
          {messages.map((msg, i) => (
            <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[80%] rounded-lg px-4 py-2 text-sm ${
                msg.role === 'user'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 text-gray-700'
              }`}>
                {msg.content.split('\n\n').map((p, j) => (
                  <p key={j} className={j > 0 ? 'mt-2' : ''}>{p}</p>
                ))}
              </div>
            </div>
          ))}
          {loading && (
            <div className="flex justify-start">
              <div className="bg-gray-100 rounded-lg px-4 py-2">
                <div className="flex items-center gap-1">
                  <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }}></div>
                  <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }}></div>
                  <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }}></div>
                </div>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Error */}
        {error && (
          <div className="px-4 py-2 bg-red-50 text-sm text-red-700 border-t border-red-200">
            {error}
          </div>
        )}

        {/* Input area */}
        <div className="border-t border-gray-200 p-3 flex gap-2">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="e.g. Which categories am I most profitable in?"
            disabled={loading}
            className="flex-1 px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-300 focus:border-blue-400 disabled:opacity-50"
          />
          <button
            onClick={sendMessage}
            disabled={loading || !input.trim()}
            className="px-4 py-2 bg-gradient-to-r from-purple-600 to-blue-600 text-white rounded-lg text-sm font-semibold hover:from-purple-700 hover:to-blue-700 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Ask
          </button>
        </div>
      </div>
      )}
    </div>
  );
}

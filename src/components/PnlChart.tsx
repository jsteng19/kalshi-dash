'use client';

import React, { useEffect, useState } from 'react';
import {
  Chart as ChartJS,
  TimeScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
} from 'chart.js';
import { Line } from 'react-chartjs-2';
import 'chartjs-adapter-date-fns';

ChartJS.register(
  TimeScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend
);

interface PnlChartProps {
  matchedTrades: any[];
}

interface Trade {
  Ticker: string;
  Exit_Date: string | Date;
  Net_Profit: number;
}

interface CumulativePnlItem {
  timestamp: number;
  pnl: number;
  trades: {
    ticker: string;
    profit: number;
  }[];
}

type TimePoint = [number, Trade[]];

export default function PnlChart({ matchedTrades }: PnlChartProps) {
  const [chartData, setChartData] = useState<any>(null);

  useEffect(() => {
    if (!matchedTrades || matchedTrades.length === 0) return;

    // Sort trades by exit date
    const sortedTrades = [...matchedTrades].sort(
      (a, b) => new Date(a.Exit_Date).getTime() - new Date(b.Exit_Date).getTime()
    );

    // Group trades by timestamp (minute precision) to prevent stacking
    const tradesByTimestamp = sortedTrades.reduce((acc: Map<number, Trade[]>, trade) => {
      const date = new Date(trade.Exit_Date);
      // Round to nearest minute to group trades that happen very close together
      date.setSeconds(0, 0);
      const timestamp = date.getTime();
      
      if (!acc.has(timestamp)) {
        acc.set(timestamp, []);
      }
      acc.get(timestamp)!.push(trade);
      return acc;
    }, new Map());

    // Convert to array and sort by timestamp
    const timePoints: TimePoint[] = Array.from(tradesByTimestamp.entries());
    timePoints.sort((a, b) => a[0] - b[0]);

    // Add starting point at the first trade's timestamp with 0 PNL
    const startTimestamp = timePoints[0][0] - 24 * 60 * 60 * 1000; // 1 day before first trade
    const dataPoints: CumulativePnlItem[] = [{
      timestamp: startTimestamp,
      pnl: 0,
      trades: []
    }];

    // Calculate cumulative PNL for each time point
    let runningPnl = 0;
    timePoints.forEach((timePoint: TimePoint) => {
      const [timestamp, trades] = timePoint;
      // Sum up all profits for trades at this timestamp
      const timestampPnl = trades.reduce((sum: number, trade: Trade) => sum + trade.Net_Profit, 0);
      runningPnl += timestampPnl;

      dataPoints.push({
        timestamp,
        pnl: runningPnl,
        trades: trades.map((trade: Trade) => ({
          ticker: trade.Ticker,
          profit: trade.Net_Profit
        }))
      });
    });

    setChartData({
      datasets: [
        {
          label: 'Cumulative PNL ($)',
          data: dataPoints.map(point => ({
            x: point.timestamp,
            y: point.pnl
          })),
          borderColor: 'rgb(75, 192, 192)',
          backgroundColor: 'rgba(75, 192, 192, 0.5)',
          tension: 0.1,
          pointRadius: (ctx: any) => {
            // Make points larger when there are multiple trades
            const index = ctx.dataIndex;
            const trades = dataPoints[index]?.trades || [];
            return trades.length > 1 ? 5 : 3;
          },
          pointHoverRadius: (ctx: any) => {
            const index = ctx.dataIndex;
            const trades = dataPoints[index]?.trades || [];
            return trades.length > 1 ? 7 : 5;
          },
        },
      ],
    });
  }, [matchedTrades]);

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        position: 'top' as const,
      },
      title: {
        display: true,
        text: 'Cumulative PNL Over Time',
        font: {
          size: 16,
        },
      },
      tooltip: {
        callbacks: {
          title: (context: any) => {
            const date = new Date(context[0].parsed.x);
            return date.toLocaleDateString('en-US', {
              year: 'numeric',
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit'
            });
          },
          label: (context: any) => {
            const index = context.dataIndex;
            const dataPoint = chartData.datasets[0].data[index];
            const trades = (dataPoint as any).trades || [];
            
            if (trades.length === 0) {
              return `PNL: ${formatCurrency(context.parsed.y)}`;
            }

            const lines = [
              `Total PNL: ${formatCurrency(context.parsed.y)}`,
              `Trades settled: ${trades.length}`,
              '',
              ...trades.map((t: any) => 
                `${t.ticker}: ${formatCurrency(t.profit)}`
              )
            ];
            return lines;
          }
        }
      }
    },
    scales: {
      y: {
        type: 'linear' as const,
        beginAtZero: false,
        grid: {
          color: 'rgba(0, 0, 0, 0.1)',
        },
        ticks: {
          callback: function(this: any, tickValue: number | string) {
            return formatCurrency(Number(tickValue));
          },
        },
      },
      x: {
        type: 'time' as const,
        time: {
          unit: 'day' as const,
          displayFormats: {
            day: 'MMM d',
          },
          tooltipFormat: 'PPpp', // Detailed format for tooltip
        },
        adapters: {
          date: Date,
        },
        grid: {
          color: 'rgba(0, 0, 0, 0.1)',
        },
        ticks: {
          maxRotation: 45,
          minRotation: 45,
        },
      },
    },
  };

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  };

  if (!chartData) return <div>Loading chart data...</div>;

  return (
    <div className="mt-6">
      <h2 className="text-xl font-semibold mb-4">PNL Over Time</h2>
      <div className="bg-white shadow rounded-lg p-4">
        <div style={{ height: '400px', width: '100%' }}>
          <Line options={options} data={chartData} />
        </div>
      </div>
    </div>
  );
} 
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
  trades: any[];
}

interface Trade {
  Ticker: string;
  Created: string;
  Date: Date;
  Realized_Profit: number;
  Type: string;
  Direction: string;
  Contracts: number;
  Average_Price: number;
  Realized_Revenue: number;
}

interface TradeDetail {
  ticker: string;
  profit: number;
  type: string;
  direction: string;
  contracts: number;
  price: number;
}

interface CumulativePnlItem {
  timestamp: number;
  pnl: number;
  trades: {
    ticker: string;
    profit: number;
    type: string;
    direction: string;
    contracts: number;
    price: number;
  }[];
}

type TimePoint = [number, Trade[]];

export default function PnlChart({ trades }: PnlChartProps) {
  const [chartData, setChartData] = useState<any>(null);

  useEffect(() => {
    if (!trades || trades.length === 0) {
      setChartData(null);
      return;
    }

    // Sort trades by the pre-parsed Date object
    const sortedTrades = [...trades].sort(
      (a, b) => a.Date.getTime() - b.Date.getTime()
    );

    // Add a starting point at 0 PNL one day before the first trade
    const firstTradeDate = new Date(sortedTrades[0].Date);
    const startTimestamp = firstTradeDate.setDate(firstTradeDate.getDate() - 1);

    const dataPoints: {x: number, y: number, trades: TradeDetail[]}[] = [{
      x: startTimestamp,
      y: 0,
      trades: []
    }];
    
    // Calculate cumulative PNL
    let cumulativePnl = 0;
    sortedTrades.forEach(trade => {
      cumulativePnl += trade.Realized_Profit;
      
      // Group trades that occur at the exact same time
      const lastPoint = dataPoints[dataPoints.length - 1];
      if (lastPoint && lastPoint.x === trade.Date.getTime()) {
        lastPoint.y = cumulativePnl;
        lastPoint.trades.push({
            ticker: trade.Ticker,
            profit: trade.Realized_Profit,
            type: trade.Type,
            direction: trade.Direction,
            contracts: trade.Contracts,
            price: trade.Average_Price,
        });
      } else {
        dataPoints.push({
          x: trade.Date.getTime(),
          y: cumulativePnl,
          trades: [{
            ticker: trade.Ticker,
            profit: trade.Realized_Profit,
            type: trade.Type,
            direction: trade.Direction,
            contracts: trade.Contracts,
            price: trade.Average_Price,
          }]
        });
      }
    });

    setChartData({
      datasets: [
        {
          label: 'Cumulative PNL ($)',
          data: dataPoints,
          borderColor: 'rgb(75, 192, 192)',
          backgroundColor: 'rgba(75, 192, 192, 0.5)',
          tension: 0.1,
          pointRadius: (ctx: any) => {
            const index = ctx.dataIndex;
            const point = dataPoints[index];
            return point && point.trades.length > 1 ? 5 : 3;
          },
          pointHoverRadius: (ctx: any) => {
            const index = ctx.dataIndex;
            const point = dataPoints[index];
            return point && point.trades.length > 1 ? 7 : 5;
          },
        },
      ],
    });
  }, [trades]);

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
            const trades = dataPoint.trades || [];
            
            if (trades.length === 0) {
              return `PNL: ${formatCurrency(context.parsed.y)}`;
            }

            const lines = [
              `Total PNL: ${formatCurrency(context.parsed.y)}`,
              `Trades: ${trades.length}`,
              '',
              ...trades.map((t: any) => 
                `${t.ticker} (${t.type}, ${t.direction}): ${formatCurrency(t.profit)}`
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
          tooltipFormat: 'PPpp',
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
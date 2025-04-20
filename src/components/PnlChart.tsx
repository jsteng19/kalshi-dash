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

interface CumulativePnlItem {
  timestamp: number;
  pnl: number;
}

export default function PnlChart({ matchedTrades }: PnlChartProps) {
  const [chartData, setChartData] = useState<any>(null);

  useEffect(() => {
    if (!matchedTrades || matchedTrades.length === 0) return;

    // Sort trades by exit date
    const sortedTrades = [...matchedTrades].sort(
      (a, b) => new Date(a.Exit_Date).getTime() - new Date(b.Exit_Date).getTime()
    );

    // Compute cumulative PNL for each trade
    const cumulativePnl: CumulativePnlItem[] = sortedTrades.reduce((acc: CumulativePnlItem[], trade, index) => {
      const previousTotal = index > 0 ? acc[index - 1].pnl : 0;
      return [
        ...acc,
        {
          timestamp: new Date(trade.Exit_Date).getTime(),
          pnl: previousTotal + trade.Net_Profit,
        },
      ];
    }, []);

    // Add starting point at the first trade's timestamp with 0 PNL
    const startPoint = {
      timestamp: new Date(sortedTrades[0].Exit_Date).getTime() - 24 * 60 * 60 * 1000, // 1 day before first trade
      pnl: 0
    };

    const dataPoints = [startPoint, ...cumulativePnl];

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
          pointRadius: 3,
          pointHoverRadius: 5,
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
            return `PNL: ${formatCurrency(context.parsed.y)}`;
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
'use client';

import React, { useMemo } from 'react';
import { Chart as ChartJS, ArcElement, Tooltip, Legend } from 'chart.js';
import { Pie } from 'react-chartjs-2';
import { MatchedTrade } from '@/utils/processData';

ChartJS.register(ArcElement, Tooltip, Legend);

interface MakerTakerPieProps {
  matchedTrades: MatchedTrade[];
}

export default function MakerTakerPie({ matchedTrades }: MakerTakerPieProps) {
  const { makerContracts, takerContracts } = useMemo(() => {
    let makerContracts = 0;
    let takerContracts = 0;
    for (const t of matchedTrades) {
      if (t.Entry_Fee === 0) makerContracts += t.Contracts;
      else takerContracts += t.Contracts;
    }
    return { makerContracts, takerContracts };
  }, [matchedTrades]);

  const data = {
    labels: ['Maker (0 fees)', 'Taker (paid fees)'],
    datasets: [
      {
        label: 'Contracts',
        data: [makerContracts, takerContracts],
        backgroundColor: [
          'rgba(34, 197, 94, 0.6)',  // Green for maker
          'rgba(249, 115, 22, 0.6)', // Orange for taker
        ],
        borderColor: [
          'rgba(34, 197, 94, 1)',
          'rgba(249, 115, 22, 1)',
        ],
        borderWidth: 1,
      },
    ],
  };

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        position: 'bottom' as const,
      },
      title: {
        display: false,
      },
      tooltip: {
        callbacks: {
          label: (context: any) => {
            const total = makerContracts + takerContracts;
            const value = context.raw as number;
            const percentage = total > 0 ? ((value / total) * 100).toFixed(1) : '0';
            return `${context.label}: ${value.toLocaleString()} contracts (${percentage}%)`;
          },
        },
      },
    },
  };

  // Don't render if no trades
  if (matchedTrades.length === 0) {
    return (
      <div className="w-full h-full flex items-center justify-center text-gray-500">
        No trades to analyze
      </div>
    );
  }

  return (
    <div className="w-full h-full">
      <Pie data={data} options={options} />
    </div>
  );
}


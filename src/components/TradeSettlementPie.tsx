'use client';

import React from 'react';
import { Chart as ChartJS, ArcElement, Tooltip, Legend } from 'chart.js';
import { Pie } from 'react-chartjs-2';
import { Trade } from '@/utils/processData';

ChartJS.register(ArcElement, Tooltip, Legend);

interface TradeSettlementPieProps {
  trades: Trade[];
}

export default function TradeSettlementPie({ trades }: TradeSettlementPieProps) {
  // Filter to exit trades only
  const exitTrades = trades.filter(trade => 
    trade.Type === 'settlement' || trade.Realized_Revenue > 0
  );
  
  // Calculate the number of contracts settled vs sold
  const settledContracts = exitTrades
    .filter(t => t.Type === 'settlement')
    .reduce((sum, t) => sum + t.Contracts, 0);
  
  const soldContracts = exitTrades
    .filter(t => t.Type !== 'settlement')
    .reduce((sum, t) => sum + Math.abs(t.Realized_Revenue), 0);

  const data = {
    labels: ['Settled Contracts', 'Sold Contracts'],
    datasets: [
      {
        label: 'Contract Settlement',
        data: [settledContracts, soldContracts],
        backgroundColor: [
          'rgba(75, 192, 192, 0.6)',
          'rgba(153, 102, 255, 0.6)',
        ],
        borderColor: [
          'rgba(75, 192, 192, 1)',
          'rgba(153, 102, 255, 1)',
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
    },
  };

  return (
    <div className="w-full h-full">
      <Pie data={data} options={options} />
    </div>
  );
} 
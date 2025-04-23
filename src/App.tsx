import React, { useState } from 'react';
import { processCSVData, ProcessedData } from './utils/processData';
import CsvUploader from './components/CsvUploader';
import Overview from './components/Overview';
import PnlChart from './components/PnlChart';
import TradeList from './components/TradeList';
import './App.css';

function App() {
  const [processedData, setProcessedData] = useState<ProcessedData | null>(null);

  const handleFileUpload = (data: ProcessedData) => {
    setProcessedData(data);
  };

  return (
    <div className="min-h-screen bg-gray-100">
      <div className="container mx-auto px-4 py-8">
        <h1 className="text-3xl font-bold text-gray-900 mb-8">Kalshi Dashboard</h1>
        <CsvUploader onFileUpload={handleFileUpload} />
        {processedData && (
          <div className="mt-8">
            <Overview 
              stats={processedData.basicStats} 
              trades={processedData.trades}
            />
            <PnlChart trades={processedData.trades} />
            <TradeList trades={processedData.matchedTrades} />
          </div>
        )}
      </div>
    </div>
  );
}

export default App; 
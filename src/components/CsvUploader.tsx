'use client';

import { useState, useRef, useMemo } from 'react';
import Papa from 'papaparse';
import { processCSVData, ProcessedData, combineProcessedData, filterTradesBySeries, normalizeHeader, Trade, MatchedTrade } from '@/utils/processData';
import Overview from '@/components/Overview';
import PnlChart from './PnlChart';
import TradeDirectionPie from './TradeDirectionPie';
import TradeSettlementPie from './TradeSettlementPie';
import MakerTakerPie from './MakerTakerPie';
import RiskAdjustedReturns from './RiskAdjustedReturns';
import TradeList from './TradeList';
import SeriesStatsTable from './SeriesStatsTable';

interface CsvData {
  headers: string[];
  rows: any[];
  rowCount: number;
}

interface CsvUploaderProps {
  onFileUpload?: (data: ProcessedData) => void;
}

export default function CsvUploader({ onFileUpload }: CsvUploaderProps) {
  const [processedData, setProcessedData] = useState<ProcessedData | null>(null);
  const [error, setError] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(false);
  const [uploadedFiles, setUploadedFiles] = useState<string[]>([]);
  const [selectedSeries, setSelectedSeries] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Filter trades by selected series
  const filteredData = useMemo(() => {
    if (!processedData || !selectedSeries) {
      return processedData;
    }

    const filteredTrades = filterTradesBySeries(processedData.trades, selectedSeries);
    
    // Filter matchedTrades based on ticker series
    const filteredMatchedTrades = processedData.matchedTrades.filter(trade => {
      const parts = trade.Ticker.split('-');
      return parts[0] === selectedSeries;
    });

    // Calculate stats from matchedTrades (works for both CSV formats)
    const yesNoBreakdown = filteredMatchedTrades.reduce((acc, trade) => {
      acc[trade.Entry_Direction] = (acc[trade.Entry_Direction] || 0) + trade.Contracts;
      return acc;
    }, {} as Record<string, number>);

    const totalFees = filteredMatchedTrades.reduce((sum, t) => sum + t.Total_Fees, 0);
    const totalProfit = filteredMatchedTrades.reduce((sum, t) => sum + t.Net_Profit, 0);

    // Calculate average prices from matchedTrades
    let totalWeightedEntryPrice = 0;
    let totalWeightedExitPrice = 0;
    let totalContracts = 0;

    filteredMatchedTrades.forEach(trade => {
      totalWeightedEntryPrice += trade.Entry_Price * trade.Contracts;
      totalWeightedExitPrice += trade.Exit_Price * trade.Contracts;
      totalContracts += trade.Contracts;
    });

    const avgContractPurchasePrice = totalContracts > 0 ? totalWeightedEntryPrice / totalContracts : 0;
    const avgContractFinalPrice = totalContracts > 0 ? totalWeightedExitPrice / totalContracts : 0;

    // Calculate holding period
    const totalTradeValue = filteredMatchedTrades.reduce((sum, trade) => sum + trade.Entry_Cost, 0);
    const weightedHoldingPeriod = totalTradeValue > 0 
      ? filteredMatchedTrades.reduce((sum, trade) => {
          const weight = trade.Entry_Cost / totalTradeValue;
          return sum + (trade.Holding_Period_Days * weight);
        }, 0)
      : 0;

    // Win rates from matchedTrades
    const profitableTrades = filteredMatchedTrades.filter(t => t.Net_Profit > 0);
    const settledTrades = filteredMatchedTrades.filter(t => t.Exit_Type === 'settlement');
    const profitableSettledTrades = settledTrades.filter(t => t.Net_Profit > 0);

    const winRate = filteredMatchedTrades.length > 0 ? profitableTrades.length / filteredMatchedTrades.length : 0;
    const settledWinRate = settledTrades.length > 0 ? profitableSettledTrades.length / settledTrades.length : 0;

    return {
      originalData: processedData.originalData,
      trades: filteredTrades,
      matchedTrades: filteredMatchedTrades,
      basicStats: {
        uniqueTickers: new Set(filteredMatchedTrades.map(t => t.Ticker)).size,
        totalTrades: filteredMatchedTrades.length,
        yesNoBreakdown: { 
          Yes: yesNoBreakdown["Yes"] || 0, 
          No: yesNoBreakdown["No"] || 0 
        },
        totalFees,
        totalProfit,
        avgContractPurchasePrice,
        avgContractFinalPrice,
        weightedHoldingPeriod,
        winRate,
        settledWinRate,
      },
    };
  }, [processedData, selectedSeries]);

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files || files.length === 0) return;

    setLoading(true);
    setError('');

    try {
      const processedDataArray: ProcessedData[] = [];

      // Process each file
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        
        // Skip if file was already processed
        if (uploadedFiles.includes(file.name)) {
          continue;
        }

        const results = await new Promise((resolve, reject) => {
          Papa.parse(file, {
            header: true,
            // Without this a UTF-8 BOM survives into the row keys, not just the
            // header list, and every row parses as empty. See docs/defects.md D-003.
            transformHeader: normalizeHeader,
            complete: resolve,
            error: reject,
          });
        });

        try {
          const processed = processCSVData(results);
          processedDataArray.push(processed);
          setUploadedFiles(prev => [...prev, file.name]);
        } catch (err) {
          setError(prev => prev + `\nError processing ${file.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      if (processedDataArray.length > 0) {
        // Combine all processed data
        const combinedData = processedDataArray.length === 1 
          ? processedDataArray[0] 
          : combineProcessedData(processedDataArray);

        setProcessedData(combinedData);
        if (onFileUpload) {
          onFileUpload(combinedData);
        }
      }
    } catch (err) {
      setError(prev => prev + `\nError parsing files: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  };

  const clearData = () => {
    setProcessedData(null);
    setError('');
    setUploadedFiles([]);
    setSelectedSeries(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
    if (onFileUpload) {
      onFileUpload({
        originalData: [],
        trades: [],
        matchedTrades: [],
        basicStats: {
          uniqueTickers: 0,
          totalTrades: 0,
          yesNoBreakdown: { Yes: 0, No: 0 },
          totalFees: 0,
          totalProfit: 0,
          avgContractPurchasePrice: 0,
          avgContractFinalPrice: 0,
          weightedHoldingPeriod: 0,
          winRate: 0,
          settledWinRate: 0
        }
      });
    }
  };

  return (
    <div className="p-4">
      <h1 className="text-3xl font-bold text-center mb-6">Kalshi Performance Dashboard</h1>
      
      <div className="bg-white shadow rounded-lg p-4 mb-6">
        <h2 className="text-lg font-semibold mb-3">Instructions</h2>
        <p className="mb-2">
          To analyze your trading history, download your transaction data from Kalshi:
        </p>
        <ol className="list-decimal pl-6 mb-4">
          <li>Log in to your Kalshi account</li>
          <li>Go to <a href="https://kalshi.com/account/taxes">Documents</a></li>
          <li>Download your transaction history CSV files (one for each year)</li>
          <li>Upload the CSV files below</li>
        </ol>
      </div>

      <div className="mb-6">
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Upload Transaction CSV Files
        </label>
        <div className="flex flex-col sm:flex-row gap-3">
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv"
            multiple
            onChange={handleFileUpload}
            className="block w-full text-sm text-gray-500
              file:mr-4 file:py-2 file:px-4
              file:rounded-full file:border-0
              file:text-sm file:font-semibold
              file:bg-blue-50 file:text-blue-700
              hover:file:bg-blue-100"
          />
          {uploadedFiles.length > 0 && (
            <button
              onClick={clearData}
              className="px-4 py-2 bg-red-50 text-red-700 rounded-full text-sm font-semibold hover:bg-red-100"
            >
              Clear Data
            </button>
          )}
        </div>
        {uploadedFiles.length > 0 && (
          <div className="mt-2">
            <p className="text-sm text-gray-600">Uploaded files:</p>
            <ul className="list-disc pl-5 text-sm text-gray-600">
              {uploadedFiles.map((file, index) => (
                <li key={index}>{file}</li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {loading && (
        <div className="text-center my-8">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-blue-500"></div>
          <p className="mt-2">Processing data...</p>
        </div>
      )}

      {error && (
        <div className="text-red-500 mb-4 whitespace-pre-line">
          {error}
        </div>
      )}

      {filteredData && !loading && (
        <div>
          <div className="mb-6">
            <h2 className="text-xl font-semibold mb-4 text-center">
              Profit & Loss Over Time
              {selectedSeries && <span className="text-blue-600 text-base ml-2">({selectedSeries})</span>}
            </h2>
            <PnlChart trades={filteredData.trades} />
          </div>
          
          <Overview 
            stats={filteredData.basicStats} 
            matchedTrades={filteredData.matchedTrades}
          />
          
          <RiskAdjustedReturns 
            matchedTrades={filteredData.matchedTrades}
          />
          
          <SeriesStatsTable 
            matchedTrades={processedData!.matchedTrades}
            selectedSeries={selectedSeries}
            onSeriesSelect={setSelectedSeries}
          />
          
          <div className="mt-6">
            <h2 className="text-xl font-semibold mb-4 text-center">Trading Distributions</h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div className="bg-white shadow rounded-lg p-6">
                <h3 className="text-lg font-medium text-gray-700 mb-4 text-center">Trade Direction</h3>
                <div className="h-[300px] w-full">
                  <TradeDirectionPie 
                    yesCount={filteredData.basicStats.yesNoBreakdown.Yes} 
                    noCount={filteredData.basicStats.yesNoBreakdown.No} 
                  />
                </div>
              </div>
              <div className="bg-white shadow rounded-lg p-6">
                <h3 className="text-lg font-medium text-gray-700 mb-4 text-center">Settlement vs Exit</h3>
                <div className="h-[300px] w-full">
                  <TradeSettlementPie matchedTrades={filteredData.matchedTrades} />
                </div>
              </div>
              <div className="bg-white shadow rounded-lg p-6">
                <h3 className="text-lg font-medium text-gray-700 mb-4 text-center">Maker vs Taker</h3>
                <div className="h-[300px] w-full">
                  <MakerTakerPie matchedTrades={filteredData.matchedTrades} />
                </div>
              </div>
            </div>
          </div>
          
          <TradeList trades={filteredData.matchedTrades} />
        </div>
      )}

      {/* GitHub link */}
      <div className="mt-12 text-center">
        <a
          href="https://github.com/jsteng19/kalshi-dash"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 px-4 py-2 bg-gray-800 text-white rounded-lg hover:bg-gray-700 transition-colors"
        >
          <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path fillRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" clipRule="evenodd" />
          </svg>
          View on GitHub
        </a>
      </div>
    </div>
  );
} 

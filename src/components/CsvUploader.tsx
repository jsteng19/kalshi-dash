'use client';

import { useState, useRef, useMemo } from 'react';
import { ProcessedData, combineProcessedData, filterTradesBySeries, Trade, MatchedTrade, fetchSeriesMetadata, fetchMarketSettlements, parseTickerComponents, SettlementResult } from '@/utils/processData';

// Process a single CSV file in a Web Worker so the UI stays responsive on
// large files. Returns the same ProcessedData shape the previous inline path
// produced.
const processCsvInWorker = (file: File): Promise<ProcessedData> =>
  new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL('../workers/processCsv.worker.ts', import.meta.url)
    );
    worker.onmessage = (e: MessageEvent<{ ok: true; data: ProcessedData } | { ok: false; error: string }>) => {
      if (e.data.ok) resolve(e.data.data);
      else reject(new Error(e.data.error));
      worker.terminate();
    };
    worker.onerror = (err) => {
      reject(err.error || new Error(err.message || 'CSV worker failed'));
      worker.terminate();
    };
    worker.postMessage({ file });
  });
import Overview from '@/components/Overview';
import SettlementWhatIf from './SettlementWhatIf';
import PnlChart from './PnlChart';
import TradeDirectionPie from './TradeDirectionPie';
import TradeSettlementPie from './TradeSettlementPie';
import MakerTakerPie from './MakerTakerPie';
import RiskAdjustedReturns from './RiskAdjustedReturns';
import TradeList from './TradeList';
import SeriesStatsTable from './SeriesStatsTable';
import CategoryStatsTable from './CategoryStatsTable';
import TradeNarrative from './TradeNarrative';
import DailyPnlTable from './DailyPnlTable';
import MonthlyPnlTable from './MonthlyPnlTable';

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
  const [categoryMap, setCategoryMap] = useState<Map<string, string>>(new Map());
  const [frequencyMap, setFrequencyMap] = useState<Map<string, string>>(new Map());
  const [selectedCategories, setSelectedCategories] = useState<Set<string>>(new Set());
  const [seriesFilter, setSeriesFilter] = useState<string>('');
  const [selectedMonths, setSelectedMonths] = useState<Set<string>>(new Set()); // YYYY-MM
  const [selectedDays, setSelectedDays] = useState<Set<string>>(new Set()); // YYYY-MM-DD
  const [settlementMap, setSettlementMap] = useState<Map<string, SettlementResult>>(new Map());
  const [settlementLoading, setSettlementLoading] = useState(false);
  const [settlementProgress, setSettlementProgress] = useState<{ completed: number; total: number } | null>(null);
  const categoryMapFetched = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const seriesFilterUpper = seriesFilter.toUpperCase();

  // Helper to check if a date matches the selected month/day filters
  const matchesDateFilter = (date: Date): boolean => {
    if (selectedDays.size > 0) {
      return selectedDays.has(date.toLocaleDateString('en-CA'));
    }
    if (selectedMonths.size > 0) {
      const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
      return selectedMonths.has(monthKey);
    }
    return true;
  };

  // Filter trades by selected categories, series name filter, series, month, and/or day
  const filteredData = useMemo(() => {
    if (!processedData || (!selectedSeries && selectedCategories.size === 0 && !seriesFilterUpper && selectedMonths.size === 0 && selectedDays.size === 0)) {
      return processedData;
    }

    let filteredMatchedTrades = processedData.matchedTrades;

    // Filter by month/day
    if (selectedMonths.size > 0 || selectedDays.size > 0) {
      filteredMatchedTrades = filteredMatchedTrades.filter(trade => matchesDateFilter(trade.Exit_Date));
    }

    // Filter by category
    if (selectedCategories.size > 0 && categoryMap.size > 0) {
      filteredMatchedTrades = filteredMatchedTrades.filter(trade => {
        const { series } = parseTickerComponents(trade.Ticker);
        const cat = categoryMap.get(series) || 'Uncategorized';
        return selectedCategories.has(cat);
      });
    }

    // Filter by series name substring
    if (seriesFilterUpper) {
      filteredMatchedTrades = filteredMatchedTrades.filter(trade => {
        const { series } = parseTickerComponents(trade.Ticker);
        return series.toUpperCase().includes(seriesFilterUpper);
      });
    }

    // Then filter by selected series
    if (selectedSeries) {
      filteredMatchedTrades = filteredMatchedTrades.filter(trade => {
        const parts = trade.Ticker.split('-');
        return parts[0] === selectedSeries;
      });
    }

    const filteredTrades = processedData.trades.filter(trade => {
      if (selectedMonths.size > 0 || selectedDays.size > 0) {
        if (!matchesDateFilter(trade.Date)) return false;
      }
      const { series } = parseTickerComponents(trade.Ticker);
      if (selectedCategories.size > 0 && categoryMap.size > 0) {
        const cat = categoryMap.get(series) || 'Uncategorized';
        if (!selectedCategories.has(cat)) return false;
      }
      if (seriesFilterUpper && !series.toUpperCase().includes(seriesFilterUpper)) return false;
      if (selectedSeries && series !== selectedSeries) return false;
      return true;
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
  }, [processedData, selectedSeries, selectedCategories, categoryMap, seriesFilterUpper, selectedMonths, selectedDays]);

  // Trades filtered by category/series but NOT by date — used for Monthly/Daily tables
  // so they always show all rows available for selection
  const nonDateFilteredTrades = useMemo(() => {
    if (!processedData) return [];
    let trades = processedData.matchedTrades;
    if (selectedCategories.size > 0 && categoryMap.size > 0) {
      trades = trades.filter(t => {
        const { series } = parseTickerComponents(t.Ticker);
        return selectedCategories.has(categoryMap.get(series) || 'Uncategorized');
      });
    }
    if (seriesFilterUpper) {
      trades = trades.filter(t => {
        const { series } = parseTickerComponents(t.Ticker);
        return series.toUpperCase().includes(seriesFilterUpper);
      });
    }
    if (selectedSeries) {
      trades = trades.filter(t => t.Ticker.split('-')[0] === selectedSeries);
    }
    return trades;
  }, [processedData, selectedCategories, categoryMap, seriesFilterUpper, selectedSeries]);

  // Last 30 days of trades, filtered by category/series name but NOT user date selection
  // Used for the trailing 30d avg return column in SeriesStatsTable
  const recentMatchedTrades = useMemo(() => {
    if (!processedData) return [];
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    let trades = processedData.matchedTrades.filter(t => t.Exit_Date >= thirtyDaysAgo);
    if (selectedCategories.size > 0 && categoryMap.size > 0) {
      trades = trades.filter(t => {
        const { series } = parseTickerComponents(t.Ticker);
        return selectedCategories.has(categoryMap.get(series) || 'Uncategorized');
      });
    }
    if (seriesFilterUpper) {
      trades = trades.filter(t => {
        const { series } = parseTickerComponents(t.Ticker);
        return series.toUpperCase().includes(seriesFilterUpper);
      });
    }
    return trades;
  }, [processedData, selectedCategories, categoryMap, seriesFilterUpper]);

  // Trades filtered by date/series but NOT by category — used for CategoryStatsTable
  // so all category rows stay visible for selection
  const nonCategoryFilteredTrades = useMemo(() => {
    if (!processedData) return [];
    let trades = processedData.matchedTrades;
    if (selectedMonths.size > 0 || selectedDays.size > 0) {
      trades = trades.filter(t => matchesDateFilter(t.Exit_Date));
    }
    if (seriesFilterUpper) {
      trades = trades.filter(t => {
        const { series } = parseTickerComponents(t.Ticker);
        return series.toUpperCase().includes(seriesFilterUpper);
      });
    }
    if (selectedSeries) {
      trades = trades.filter(t => t.Ticker.split('-')[0] === selectedSeries);
    }
    return trades;
  }, [processedData, selectedMonths, selectedDays, seriesFilterUpper, selectedSeries]);

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files || files.length === 0) return;

    setLoading(true);
    setError('');

    try {
      // Fetch category map once
      if (!categoryMapFetched.current) {
        categoryMapFetched.current = true;
        fetchSeriesMetadata()
          .then(({ categoryMap, frequencyMap }) => {
            setCategoryMap(categoryMap);
            setFrequencyMap(frequencyMap);
          })
          .catch(err => console.error('Failed to fetch series metadata:', err));
      }

      const processedDataArray: ProcessedData[] = [];

      // Process each file in a Web Worker (keeps UI responsive on large CSVs).
      for (let i = 0; i < files.length; i++) {
        const file = files[i];

        if (uploadedFiles.includes(file.name)) {
          continue;
        }

        try {
          const processed = await processCsvInWorker(file);
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

        // Fetch settlement outcomes for all mid-market exits (Exit_Price between 1–99)
        const earlyExitTickers = [
          ...new Set(
            combinedData.matchedTrades
              .filter(t => t.Exit_Price > 0 && t.Exit_Price < 100)
              .map(t => t.Ticker)
          ),
        ];

        if (earlyExitTickers.length > 0) {
          setSettlementLoading(true);
          setSettlementProgress({ completed: 0, total: earlyExitTickers.length });
          fetchMarketSettlements(earlyExitTickers, (completed, total) => {
            setSettlementProgress({ completed, total });
          })
            .then(map => setSettlementMap(map))
            .finally(() => setSettlementLoading(false));
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
    setSelectedCategories(new Set());
    setSeriesFilter('');
    setSelectedMonths(new Set());
    setSelectedDays(new Set());
    setSettlementMap(new Map());
    setSettlementLoading(false);
    setSettlementProgress(null);
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
              {selectedMonths.size > 0 && <span className="text-teal-600 text-base ml-2">({selectedMonths.size === 1 ? Array.from(selectedMonths)[0] : `${selectedMonths.size} months`})</span>}
              {selectedDays.size > 0 && <span className="text-teal-600 text-base ml-2">({selectedDays.size === 1 ? Array.from(selectedDays)[0] : `${selectedDays.size} days`})</span>}
              {selectedCategories.size > 0 && <span className="text-purple-600 text-base ml-2">({selectedCategories.size === 1 ? Array.from(selectedCategories)[0] : `${selectedCategories.size} categories`})</span>}
              {seriesFilter && <span className="text-orange-600 text-base ml-2">(~{seriesFilter})</span>}
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

          <SettlementWhatIf
            matchedTrades={filteredData.matchedTrades}
            settlementMap={settlementMap}
            loading={settlementLoading}
            progress={settlementProgress}
          />

          <TradeNarrative
            matchedTrades={processedData!.matchedTrades}
            basicStats={processedData!.basicStats}
            categoryMap={categoryMap}
          />

          <MonthlyPnlTable
            matchedTrades={nonDateFilteredTrades}
            selectedMonths={selectedMonths}
            onMonthSelect={(month, metaKey) => {
              if (month === null) {
                setSelectedMonths(new Set());
                setSelectedDays(new Set());
              } else if (metaKey) {
                setSelectedMonths(prev => {
                  const next = new Set(prev);
                  if (next.has(month)) next.delete(month);
                  else next.add(month);
                  return next;
                });
                setSelectedDays(new Set());
              } else {
                setSelectedMonths(prev => prev.size === 1 && prev.has(month) ? new Set() : new Set([month]));
                setSelectedDays(new Set());
              }
            }}
          />

          <DailyPnlTable
            matchedTrades={nonDateFilteredTrades}
            selectedDays={selectedDays}
            onDaySelect={(day, metaKey) => {
              if (day === null) {
                setSelectedDays(new Set());
              } else if (metaKey) {
                // CMD+click toggles individual days
                setSelectedDays(prev => {
                  const next = new Set(prev);
                  if (next.has(day)) {
                    next.delete(day);
                  } else {
                    next.add(day);
                  }
                  return next;
                });
              } else {
                // Regular click: toggle single day
                setSelectedDays(prev => prev.size === 1 && prev.has(day) ? new Set() : new Set([day]));
              }
            }}
          />

          {categoryMap.size > 0 && (
            <CategoryStatsTable
              matchedTrades={nonCategoryFilteredTrades}
              categoryMap={categoryMap}
              selectedCategories={selectedCategories}
              onCategorySelect={(cat, metaKey) => {
                if (cat === null) {
                  setSelectedCategories(new Set());
                  setSelectedSeries(null);
                } else if (metaKey) {
                  setSelectedCategories(prev => {
                    const next = new Set(prev);
                    if (next.has(cat)) next.delete(cat);
                    else next.add(cat);
                    return next;
                  });
                  setSelectedSeries(null);
                } else {
                  setSelectedCategories(prev => prev.size === 1 && prev.has(cat) ? new Set() : new Set([cat]));
                  setSelectedSeries(null);
                }
              }}
            />
          )}

          <SeriesStatsTable
            recentMatchedTrades={recentMatchedTrades}
            allMatchedTrades={processedData!.matchedTrades}
            matchedTrades={(() => {
              // Filter by date + category + series name filter, but NOT selected series
              // (so all series remain visible for selection)
              let trades = processedData!.matchedTrades;
              if (selectedMonths.size > 0 || selectedDays.size > 0) {
                trades = trades.filter(t => matchesDateFilter(t.Exit_Date));
              }
              if (selectedCategories.size > 0 && categoryMap.size > 0) {
                trades = trades.filter(t => {
                  const { series } = parseTickerComponents(t.Ticker);
                  return selectedCategories.has(categoryMap.get(series) || 'Uncategorized');
                });
              }
              if (seriesFilterUpper) {
                trades = trades.filter(t => {
                  const { series } = parseTickerComponents(t.Ticker);
                  return series.toUpperCase().includes(seriesFilterUpper);
                });
              }
              return trades;
            })()}
            selectedSeries={selectedSeries}
            onSeriesSelect={setSelectedSeries}
            frequencyMap={frequencyMap}
            categoryMap={categoryMap}
            settlementMap={settlementMap}
            seriesFilter={seriesFilter}
            onSeriesFilterChange={(val) => {
              setSeriesFilter(val);
              setSelectedSeries(null);
            }}
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
          
          {(selectedSeries || selectedCategories.size > 0 || seriesFilter || selectedMonths.size > 0 || selectedDays.size > 0) && <TradeList trades={filteredData.matchedTrades} />}
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

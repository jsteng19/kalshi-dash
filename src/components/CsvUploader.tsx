'use client';

import { useState } from 'react';
import Papa from 'papaparse';
import { processCSVData, ProcessedData, combineProcessedData } from '@/utils/processData';
import Overview from '@/components/Overview';
import PnlChart from './PnlChart';
import TradeDirectionPie from './TradeDirectionPie';
import TradeSettlementPie from './TradeSettlementPie';

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
  };

  return (
    <div className="p-4">
      <h1 className="text-3xl font-bold text-center mb-6">Kalshi Trading Dashboard</h1>
      
      <div className="bg-white shadow rounded-lg p-4 mb-6">
        <h2 className="text-lg font-semibold mb-3">Instructions</h2>
        <p className="mb-2">
          To analyze your trading history, download your transaction data from Kalshi:
        </p>
        <ol className="list-decimal pl-6 mb-4">
          <li>Log in to your Kalshi account</li>
          <li>Go to Documents</li>
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

      {processedData && !loading && (
        <div>
          {/* PNL chart moved to the top */}
          <div className="mb-6">
            <h2 className="text-xl font-semibold mb-4 text-center">Profit & Loss Over Time</h2>
            <PnlChart matchedTrades={processedData.matchedTrades} />
          </div>
          
          <Overview 
            stats={processedData.basicStats} 
            matchedTrades={processedData.matchedTrades}
          />
          
          {/* Improved pie charts layout */}
          <div className="mt-6">
            <h2 className="text-xl font-semibold mb-4 text-center">Trading Distributions</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="bg-white shadow rounded-lg p-6">
                <h3 className="text-lg font-medium text-gray-700 mb-4 text-center">Trade Direction</h3>
                <div className="h-[300px] w-full">
                  <TradeDirectionPie 
                    yesCount={processedData.basicStats.yesNoBreakdown.Yes} 
                    noCount={processedData.basicStats.yesNoBreakdown.No} 
                  />
                </div>
              </div>
              <div className="bg-white shadow rounded-lg p-6">
                <h3 className="text-lg font-medium text-gray-700 mb-4 text-center">Settlement vs Exit</h3>
                <div className="h-[300px] w-full">
                  <TradeSettlementPie matchedTrades={processedData.matchedTrades} />
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
} 
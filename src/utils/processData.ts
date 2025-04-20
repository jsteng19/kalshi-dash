import { parse } from 'papaparse';

interface Trade {
  Ticker: string;
  Type: string;
  Direction: string;
  Contracts: number;
  Average_Price: number;
  Realized_Revenue: number;
  Realized_Cost: number;
  Realized_Profit: number;
  Fees: number;
  Created: string;
  Date: Date;
  Trade_Cost: number;
}

export interface MatchedTrade {
  Ticker: string;
  Entry_Date: Date;
  Exit_Date: Date;
  Entry_Direction: string;
  Exit_Direction: string;
  Contracts: number;
  Entry_Cost: number;
  Exit_Cost: number;
  Realized_Profit: number;
  Net_Profit: number;
  Holding_Period_Days: number;
  ROI?: number;
  Entry_Fee: number;
  Exit_Fee: number;
  Total_Fees: number;
  Entry_Price: number;  // Original entry price in cents
  Exit_Price: number;   // Original exit price in cents
}

interface Position {
  ticker: string;
  direction: string;
  contracts: number;
  avg_price: number;
  entry_date: Date;
  entry_fee: number;
  cost: number;
  is_closed: boolean;
}

export interface ProcessedData {
  originalData: any[];
  trades: Trade[];
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
}

// Parse date from "Jan 20, 2025 at 10:04 AM PST" format
const parseDate = (dateStr: string): Date => {
  try {
    const pattern = /(\w+ \d+, \d+) at (\d+:\d+ [AP]M)/;
    const match = dateStr.match(pattern);
    if (match) {
      const dateTime = `${match[1]} ${match[2]}`;
      return new Date(dateTime);
    }
    return new Date();
  } catch (error) {
    console.error("Error parsing date:", dateStr, error);
    return new Date();
  }
};

// Calculate trade cost based on row data
const calculateTradeCost = (row: Trade): number => {
  if (row.Type === 'settlement' || (row.Type === 'trade' && row.Realized_Profit !== 0)) {
    // For settlements or trades with realized P&L, use the realized cost
    return Math.abs(row.Realized_Cost);
  } else if (row.Type === 'trade' && row.Realized_Profit === 0) {
    // For initial trades (buying position), use Average_Price
    const price = row.Average_Price / 100; // Convert cents to dollars
    return row.Contracts * price;
  }
  return 0;
};

// Match trades using FIFO method
const matchTradesFifo = (trades: Trade[]): MatchedTrade[] => {
  // Sort trades by date
  const sortedTrades = [...trades].sort((a, b) => a.Date.getTime() - b.Date.getTime());
  
  // Calculate proper trade costs
  sortedTrades.forEach(trade => {
    trade.Trade_Cost = calculateTradeCost(trade);
  });
  
  // Dictionary to store open positions for each ticker
  const openPositions: Record<string, Position[]> = {};
  const completedTrades: MatchedTrade[] = [];
  
  // Debug counters
  let entryCount = 0;
  let exitCount = 0;
  let unmatchedExits = 0;
  
  for (const trade of sortedTrades) {
    const ticker = trade.Ticker;
    const direction = trade.Direction;
    
    // Initialize position list if needed
    if (!openPositions[ticker]) {
      openPositions[ticker] = [];
    }
    
    if (trade.Type === 'trade' && trade.Realized_Profit === 0) {
      // Entry trade
      entryCount++;
      const position: Position = {
        ticker,
        direction,
        contracts: trade.Contracts,
        avg_price: trade.Average_Price,
        entry_date: trade.Date,
        entry_fee: trade.Fees || 0,
        cost: trade.Trade_Cost,
        is_closed: false
      };
      
      // Add as new position
      openPositions[ticker].push(position);
      
    } else if (trade.Type === 'settlement' || (trade.Type === 'trade' && trade.Realized_Profit !== 0)) {
      // Exit trade
      exitCount++;
      let contractsToClose = trade.Contracts;
      
      // Calculate exit price based on trade type
      let exitPrice: number;
      if (trade.Type === 'settlement') {
        // For settlements, exit price is Realized_Revenue / Contracts
        exitPrice = trade.Realized_Revenue / contractsToClose * 100; // Convert to cents
      } else {
        // For exit trades, use the Average_Price
        exitPrice = trade.Average_Price;
      }
      
      const realizedProfitPerContract = trade.Realized_Profit !== 0 ? trade.Realized_Profit / contractsToClose : 0;
      const exitFee = trade.Fees || 0;
      
      // Find matching open positions
      const matchingPositions = openPositions[ticker]?.filter(p => 
        !p.is_closed && 
        (p.direction === direction || 
        (p.direction === 'Yes' && direction === 'No') || 
        (p.direction === 'No' && direction === 'Yes'))
      );
      
      if (!matchingPositions || matchingPositions.length === 0) {
        unmatchedExits++;
        console.warn(`Warning: Exit without matching entry found for ${ticker} (${direction}) on ${trade.Date}`);
        continue;
      }
      
      // Match with oldest positions first (FIFO)
      for (const position of matchingPositions) {
        if (contractsToClose <= 0) break;
        
        const contractsClosed = Math.min(contractsToClose, position.contracts);
        
        // Calculate proportional profit and costs
        let profit: number;
        let finalExitPrice: number;
        
        if (trade.Type === 'settlement') {
          profit = realizedProfitPerContract * contractsClosed;
          finalExitPrice = exitPrice;
        } else {
          // For opposite direction trades, calculate profit based on price difference
          if (position.direction !== direction) {
            const entryPrice = position.avg_price;
            if (position.direction === 'Yes') { // YES entry, NO exit
              finalExitPrice = 100 - trade.Average_Price; // Effective sell price
              profit = contractsClosed * (100 - entryPrice - trade.Average_Price) / 100;
            } else { // NO entry, YES exit
              finalExitPrice = 100 - trade.Average_Price; // Effective sell price
              profit = contractsClosed * (100 - trade.Average_Price - entryPrice) / 100;
            }
          } else {
            finalExitPrice = trade.Average_Price;
            profit = realizedProfitPerContract * contractsClosed;
          }
        }
        
        const entryCost = position.cost * (contractsClosed / position.contracts);
        const exitCost = Math.abs(trade.Realized_Cost) * (contractsClosed / trade.Contracts);
        
        // Calculate proportional fees
        const proportionalEntryFee = position.entry_fee * (contractsClosed / position.contracts);
        const proportionalExitFee = exitFee * (contractsClosed / contractsToClose);
        const totalFees = proportionalEntryFee + proportionalExitFee;
        
        const matchedTrade: MatchedTrade = {
          Ticker: position.ticker,
          Entry_Date: position.entry_date,
          Exit_Date: trade.Date,
          Entry_Direction: position.direction,
          Exit_Direction: trade.Type,
          Contracts: contractsClosed,
          Entry_Cost: entryCost,
          Exit_Cost: exitCost,
          Realized_Profit: profit,
          Net_Profit: profit - totalFees,
          Holding_Period_Days: (trade.Date.getTime() - position.entry_date.getTime()) / (24 * 3600 * 1000),
          ROI: (profit - totalFees) / entryCost,
          Entry_Fee: proportionalEntryFee,
          Exit_Fee: proportionalExitFee,
          Total_Fees: totalFees,
          Entry_Price: position.avg_price,
          Exit_Price: finalExitPrice
        };
        
        completedTrades.push(matchedTrade);
        
        // Update position
        contractsToClose -= contractsClosed;
        position.contracts -= contractsClosed;
        if (position.contracts <= 0) {
          position.is_closed = true;
        }
      }
    }
  }
  
  // Clean up closed positions
  for (const ticker in openPositions) {
    openPositions[ticker] = openPositions[ticker].filter(p => !p.is_closed);
  }
  
  console.log("Matching Statistics:");
  console.log(`Entry trades processed: ${entryCount}`);
  console.log(`Exit trades processed: ${exitCount}`);
  console.log(`Unmatched exits: ${unmatchedExits}`);
  console.log(`Open positions remaining: ${Object.values(openPositions).reduce((sum, pos) => sum + pos.length, 0)}`);
  
  // Remove unreasonable ROIs
  return completedTrades.filter(t => Math.abs(t.ROI!) < 10);
};

// Calculate basic statistics
const calculateBasicStats = (trades: Trade[], matchedTrades: MatchedTrade[]) => {
  // Unique tickers
  const uniqueTickers = new Set(trades.map(t => t.Ticker)).size;
  
  // Yes/No breakdown
  const yesNoBreakdown = trades.reduce((acc, trade) => {
    acc[trade.Direction] = (acc[trade.Direction] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  
  // Total fees
  const totalFees = trades.reduce((sum, trade) => sum + (trade.Fees || 0), 0);
  
  // Total profit
  const totalProfit = matchedTrades.reduce((sum, trade) => sum + trade.Net_Profit, 0);
  
  // Calculate total contracts for weighting
  const totalContracts = matchedTrades.reduce((sum, trade) => sum + trade.Contracts, 0);
  
  // For debugging - minimal logging
  console.log(`Contract price calculation: Total contracts: ${totalContracts}`);
  
  // Average contract purchase price (in cents)
  const avgContractPurchasePrice = matchedTrades.reduce((sum, trade) => {
    const weight = trade.Contracts / totalContracts;
    return sum + (trade.Entry_Price * weight);
  }, 0);
  
  // Average contract final price (in cents)
  const avgContractFinalPrice = matchedTrades.reduce((sum, trade) => {
    const weight = trade.Contracts / totalContracts;
    return sum + (trade.Exit_Price * weight);
  }, 0);
  
  // Debug - final results
  console.log(`Average contract prices: Entry=${avgContractPurchasePrice.toFixed(2)}¢, Exit=${avgContractFinalPrice.toFixed(2)}¢`);
  
  // Weighted holding period (weighted by trade size)
  const totalTradeValue = matchedTrades.reduce((sum, trade) => sum + trade.Entry_Cost, 0);
  const weightedHoldingPeriod = matchedTrades.reduce((sum, trade) => {
    const weight = trade.Entry_Cost / totalTradeValue;
    return sum + (trade.Holding_Period_Days * weight);
  }, 0);
  
  // Win rate (all trades)
  const winRate = matchedTrades.filter(t => t.Net_Profit > 0).length / matchedTrades.length;
  
  // Win rate (settled contracts only)
  const settledTrades = matchedTrades.filter(t => t.Exit_Direction === 'settlement');
  const settledWinRate = settledTrades.length > 0 
    ? settledTrades.filter(t => t.Net_Profit > 0).length / settledTrades.length 
    : 0;
  
  return {
    uniqueTickers,
    totalTrades: trades.length,
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
    settledWinRate
  };
};

// Main processing function
export const processCSVData = (results: any): ProcessedData => {
  try {
    // Validate CSV structure
    if (!results.data || !Array.isArray(results.data) || results.data.length === 0) {
      throw new Error("Invalid CSV format: No data found");
    }
    
    // Check for required columns
    const requiredColumns = ['Ticker', 'Type', 'Direction', 'Contracts', 'Average_Price', 'Created'];
    const headers = results.meta.fields || [];
    const missingColumns = requiredColumns.filter(col => !headers.includes(col));
    
    if (missingColumns.length > 0) {
      throw new Error(`Invalid CSV format: Missing required columns: ${missingColumns.join(', ')}`);
    }
    
    const rawData = results.data as any[];
    
    // Convert string values and create Date objects
    const trades: Trade[] = rawData.filter(row => row && row.Ticker).map(row => {
      try {
        // Clean up monetary columns
        const cleanMoney = (val: string) => {
          if (!val) return 0;
          return parseFloat(val.replace('$', '').trim()) || 0;
        };
        
        const trade: Trade = {
          Ticker: row.Ticker,
          Type: row.Type,
          Direction: row.Direction,
          Contracts: parseFloat(row.Contracts) || 0,
          Average_Price: parseFloat(row.Average_Price) || 0,
          Realized_Revenue: cleanMoney(row.Realized_Revenue),
          Realized_Cost: cleanMoney(row.Realized_Cost),
          Realized_Profit: cleanMoney(row.Realized_Profit),
          Fees: row.Fees ? cleanMoney(row.Fees) : 0,
          Created: row.Created,
          Date: parseDate(row.Created),
          Trade_Cost: 0 // Will be calculated later
        };
        
        return trade;
      } catch (error) {
        console.error("Error processing row:", row, error);
        return null;
      }
    }).filter(Boolean) as Trade[];
    
    if (trades.length === 0) {
      throw new Error("No valid trades found in the CSV file");
    }
    
    // Match trades using FIFO
    const matchedTrades = matchTradesFifo(trades);
    
    // Calculate basic statistics
    const basicStats = calculateBasicStats(trades, matchedTrades);
    
    return {
      originalData: rawData,
      trades,
      matchedTrades,
      basicStats
    };
  } catch (error) {
    console.error("Error processing CSV data:", error);
    throw error;
  }
};

// Combine multiple ProcessedData objects into one
export const combineProcessedData = (dataArray: ProcessedData[]): ProcessedData => {
  // Combine all trades
  const allTrades = dataArray.reduce<Trade[]>((acc, data) => [...acc, ...data.trades], []);
  
  // Sort all trades by date
  const sortedTrades = allTrades.sort((a, b) => a.Date.getTime() - b.Date.getTime());
  
  // Match trades using FIFO across all data
  const matchedTrades = matchTradesFifo(sortedTrades);
  
  // Calculate combined stats
  const basicStats = calculateBasicStats(sortedTrades, matchedTrades);
  
  // Combine original data
  const originalData = dataArray.reduce<any[]>((acc, data) => [...acc, ...data.originalData], []);
  
  return {
    originalData,
    trades: sortedTrades,
    matchedTrades,
    basicStats,
  };
}; 
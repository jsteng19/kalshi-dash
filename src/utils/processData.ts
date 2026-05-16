import { parse } from 'papaparse';
import { toDate } from 'date-fns-tz';

// ============ CSV FORMAT DETECTION ============

export type CsvFormat = 'legacy' | 'new';

// New format columns (2025+)
const NEW_FORMAT_COLUMNS = ['type', 'quantity', 'market_ticker', 'side', 'entry_price_cents', 'exit_price_cents', 'open_fees_cents', 'close_fees_cents', 'realized_pnl_without_fees_cents', 'realized_pnl_with_fees_cents', 'close_timestamp', 'open_timestamp'];

// Legacy format columns
const LEGACY_FORMAT_COLUMNS = ['Ticker', 'Type', 'Direction', 'Contracts', 'Average_Price', 'Created'];

export const detectCsvFormat = (headers: string[]): CsvFormat => {
  const hasNewFormat = NEW_FORMAT_COLUMNS.every(col => headers.includes(col));
  if (hasNewFormat) return 'new';
  
  const hasLegacyFormat = LEGACY_FORMAT_COLUMNS.every(col => headers.includes(col));
  if (hasLegacyFormat) return 'legacy';
  
  throw new Error(`Unrecognized CSV format. Expected columns for either new format (${NEW_FORMAT_COLUMNS.slice(0, 3).join(', ')}...) or legacy format (${LEGACY_FORMAT_COLUMNS.join(', ')})`);
};

// ============ INTERFACES ============

export interface Trade {
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
  Exit_Type: string;
  Contracts: number;
  Entry_Cost: number;
  Realized_Profit: number;
  Net_Profit: number;
  Holding_Period_Days: number;
  ROI?: number;
  Entry_Fee: number;
  Exit_Fee: number;
  Total_Fees: number;
  Entry_Price: number;
  Exit_Price: number;
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

// Parse ticker into components: {SERIES}-{EVENT}-{MARKET}
// Example: KXKIRKMENTION-25DEC04-PATR -> { series: 'KXKIRKMENTION', event: '25DEC04', market: 'PATR' }
export interface TickerComponents {
  series: string;
  event: string;
  market: string;
}

// Series-level statistics
export interface SeriesStats {
  series: string;
  pnl: number;
  eventsTraded: Set<string>;
  marketsTraded: Set<string>;
  totalCost: number;
  tradesCount: number;
  winCount: number;
}

// ============ TICKER/SERIES UTILITIES ============

export const parseTickerComponents = (ticker: string): TickerComponents => {
  const parts = ticker.split('-');
  if (parts.length >= 3) {
    // Standard format: SERIES-EVENT-MARKET
    return {
      series: parts[0],
      event: parts[1],
      market: parts.slice(2).join('-'), // Market might have dashes
    };
  } else if (parts.length === 2) {
    // Some tickers might be SERIES-MARKET with no event
    return {
      series: parts[0],
      event: '',
      market: parts[1],
    };
  }
  // Fallback for non-standard tickers
  return {
    series: ticker,
    event: '',
    market: '',
  };
};

// Calculate series stats from MatchedTrades (works for both CSV formats)
export const calculateSeriesStatsFromMatched = (matchedTrades: MatchedTrade[]): Map<string, SeriesStats> => {
  const seriesMap = new Map<string, SeriesStats>();

  matchedTrades.forEach(trade => {
    const { series, event, market } = parseTickerComponents(trade.Ticker);
    
    if (!seriesMap.has(series)) {
      seriesMap.set(series, {
        series,
        pnl: 0,
        eventsTraded: new Set(),
        marketsTraded: new Set(),
        totalCost: 0,
        tradesCount: 0,
        winCount: 0,
      });
    }
    
    const stats = seriesMap.get(series)!;
    stats.pnl += trade.Net_Profit;
    if (event) stats.eventsTraded.add(event);
    if (market) stats.marketsTraded.add(market);
    stats.totalCost += trade.Entry_Cost;
    stats.tradesCount++;
    if (trade.Net_Profit > 0) {
      stats.winCount++;
    }
  });

  return seriesMap;
};

// Legacy function for backward compatibility (uses Trade[])
export const calculateSeriesStats = (trades: Trade[]): Map<string, SeriesStats> => {
  const seriesMap = new Map<string, SeriesStats>();

  trades.forEach(trade => {
    const { series, event, market } = parseTickerComponents(trade.Ticker);
    
    if (!seriesMap.has(series)) {
      seriesMap.set(series, {
        series,
        pnl: 0,
        eventsTraded: new Set(),
        marketsTraded: new Set(),
        totalCost: 0,
        tradesCount: 0,
        winCount: 0,
      });
    }
    
    const stats = seriesMap.get(series)!;
    stats.pnl += trade.Realized_Profit;
    if (event) stats.eventsTraded.add(event);
    if (market) stats.marketsTraded.add(market);
    
    // Track cost and trades for exit trades (to calculate average return)
    if (trade.Type === 'settlement' || trade.Realized_Revenue > 0) {
      if (trade.Type === 'settlement') {
        stats.totalCost += Math.abs(trade.Realized_Cost);
      } else {
        stats.totalCost += Math.abs(trade.Realized_Cost) - (trade.Average_Price * trade.Realized_Revenue / 100);
      }
      stats.tradesCount++;
      if (trade.Realized_Profit > 0) {
        stats.winCount++;
      }
    }
  });

  return seriesMap;
};

export const filterTradesBySeries = (trades: Trade[], series: string): Trade[] => {
  return trades.filter(trade => {
    const { series: tradeSeries } = parseTickerComponents(trade.Ticker);
    return tradeSeries === series;
  });
};

// ============ DATE PARSING ============

// Parse date by converting Kalshi format to standard format for date-fns-tz
const parseDate = (dateStr: string): Date => {
  try {
    // Check if it's the Kalshi format: "Jan 20, 2025 at 10:04 AM PST"
    const kalshiPattern = /(\w+ \d+, \d+) at (\d+:\d+) ?([AP]M) ([A-Z]{2,4})/i;
    const kalshiMatch = dateStr.match(kalshiPattern);
    
    if (kalshiMatch) {
      // Timezone mapping to UTC offsets
      const timezoneOffsets: Record<string, string> = {
        'PST': '-08:00', 'PDT': '-07:00', 'PT': '-08:00',
        'MST': '-07:00', 'MDT': '-06:00', 'MT': '-07:00',
        'CST': '-06:00', 'CDT': '-05:00', 'CT': '-06:00',
        'EST': '-05:00', 'EDT': '-04:00', 'ET': '-05:00',
        'AKST': '-09:00', 'AKDT': '-08:00', 'AKT': '-09:00',
        'HST': '-10:00', 'HDT': '-09:00', 'HT': '-10:00',
        'AST': '-04:00', 'ADT': '-03:00', 'AT': '-04:00',
        'UTC': '+00:00', 'GMT': '+00:00', 'Z': '+00:00'
      };
      
      const [, dateStr, timeStr, ampm, timeZone] = kalshiMatch;
      const upperTimeZone = timeZone.toUpperCase();
      const offset = timezoneOffsets[upperTimeZone] || '-08:00'; // Default to PST
      
      const dateMatch = dateStr.match(/(\w+) (\d+), (\d+)/);
      if (dateMatch) {
        const [, monthName, day, year] = dateMatch;
        const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                           'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const monthIndex = monthNames.indexOf(monthName);
        
        if (monthIndex !== -1) {
          const month = String(monthIndex + 1).padStart(2, '0');
          const dayPadded = day.padStart(2, '0');
          
          // Parse time: "10:04" + "AM" -> "10:04:00"
          const [hours, minutes] = timeStr.split(':');
          let hour24 = parseInt(hours);
          
          if (ampm.toUpperCase() === 'PM' && hour24 !== 12) {
            hour24 += 12;
          } else if (ampm.toUpperCase() === 'AM' && hour24 === 12) {
            hour24 = 0;
          }
          
          const hourPadded = String(hour24).padStart(2, '0');
          
          // Create ISO format: "2025-01-20T10:04:00-10:00"
          const isoFormat = `${year}-${month}-${dayPadded}T${hourPadded}:${minutes}:00${offset}`;
          
          // Use date-fns-tz to parse the ISO format
          const parsed = toDate(isoFormat);
          if (!isNaN(parsed.getTime())) {
            return parsed;
          }
        }
      }
    }
    

    const fallbackDate = new Date(dateStr);
    if (!isNaN(fallbackDate.getTime())) {
      return fallbackDate;
    }

    console.error("Failed to parse date:", dateStr);
    return new Date(); // Return current date as fallback
  } catch (error) {
    console.error("Error parsing date:", dateStr, error);
    return new Date(); // Return current date as fallback
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
          (position.direction !== direction) 
          const entryPrice = position.avg_price;
          finalExitPrice = 100 - exitPrice; // Effective sell price
          profit = contractsClosed * (100 - entryPrice - exitPrice) / 100;
        }
        
        const entryCost = position.cost * (contractsClosed / position.contracts);
        
        // Calculate proportional fees
        const proportionalEntryFee = position.entry_fee * (contractsClosed / position.contracts);
        const proportionalExitFee = exitFee * (contractsClosed / contractsToClose);
        const totalFees = proportionalEntryFee + proportionalExitFee;
        
        const matchedTrade: MatchedTrade = {
          Ticker: position.ticker,
          Entry_Date: position.entry_date,
          Exit_Date: trade.Date,
          Entry_Direction: position.direction,
          Exit_Type: trade.Type,
          Contracts: contractsClosed,
          Entry_Cost: entryCost,
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
  
  return completedTrades;
};

// Calculate basic statistics
const calculateBasicStats = (trades: Trade[], matchedTrades: MatchedTrade[]) => {
  // Unique tickers
  const uniqueTickers = new Set(trades.map(t => t.Ticker)).size;
  
  // Yes/No breakdown
  const yesNoBreakdown = trades.reduce((acc, trade) => {
    // For settlements, count contracts in the listed direction
    if (trade.Type === 'settlement') {
      acc[trade.Direction] = (acc[trade.Direction] || 0) + trade.Contracts;
    }
    else if (trade.Realized_Revenue > 0) {
      // Count closed contracts in opposite direction
      const oppositeDir = trade.Direction === 'Yes' ? 'No' : 'Yes';
      acc[oppositeDir] = (acc[oppositeDir] || 0) + trade.Realized_Revenue;
      
    }
    return acc;
  }, {} as Record<string, number>);
  
  // Total fees and profit directly from trades
  const totalFees = trades.reduce((sum, trade) => sum + (trade.Fees || 0), 0);
  const totalProfit = trades.reduce((sum, trade) => sum + trade.Realized_Profit, 0);

  // Calculate average entry and exit prices from exit trades only
  let totalWeightedEntryPrice = 0;
  let totalWeightedExitPrice = 0;
  let totalExitedContracts = 0;

  trades.forEach(trade => {
    if (trade.Type === 'settlement') {
      if (trade.Contracts > 0) {
        totalWeightedEntryPrice += trade.Average_Price * trade.Contracts;
        totalWeightedExitPrice += (trade.Realized_Revenue > 0 ? 100 : 0) * trade.Contracts;
        totalExitedContracts += trade.Contracts;
      }
    } else if (trade.Realized_Revenue > 0) {
      // For exit trades with non-zero Realized_Revenue
      const contracts = trade.Realized_Revenue;
      const exitPrice = 100 - trade.Average_Price;
      const entryPrice = (trade.Realized_Cost * 100 - contracts * trade.Average_Price) / contracts;
      
      totalWeightedEntryPrice += entryPrice * contracts;
      totalWeightedExitPrice += exitPrice * contracts;
      totalExitedContracts += contracts;
    }
  });

  const avgContractPurchasePrice = totalExitedContracts > 0 ? totalWeightedEntryPrice / totalExitedContracts : 0;
  const avgContractFinalPrice = totalExitedContracts > 0 ? totalWeightedExitPrice / totalExitedContracts : 0;
  
  // Keep using matchedTrades for holding period calculation
  const totalTradeValue = matchedTrades.reduce((sum, trade) => sum + trade.Entry_Cost, 0);
  const weightedHoldingPeriod = matchedTrades.reduce((sum, trade) => {
    const weight = trade.Entry_Cost / totalTradeValue;
    return sum + (trade.Holding_Period_Days * weight);
  }, 0);
  
  // Win rates based on Realized_Profit
  const exitTrades = trades.filter(t => t.Realized_Revenue > 0);
  const profitableTrades = exitTrades.filter(t => t.Realized_Profit > 0);
  const settledTrades = trades.filter(t => t.Type === 'settlement');
  const profitableSettledTrades = settledTrades.filter(t => t.Realized_Profit > 0);
  
  const winRate = exitTrades.length > 0 ? profitableTrades.length / exitTrades.length : 0;
  const settledWinRate = settledTrades.length > 0 ? profitableSettledTrades.length / settledTrades.length : 0;
  
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

// ============ NEW FORMAT PARSER (2025+) ============

interface NewFormatRow {
  type: string;
  quantity: string;
  market_ticker: string;
  side: string;
  entry_price_cents: string;
  exit_price_cents: string;
  open_fees_cents: string;
  close_fees_cents: string;
  realized_pnl_without_fees_cents: string;
  realized_pnl_with_fees_cents: string;
  close_timestamp: string;
  open_timestamp: string;
}

const processNewFormat = (rawData: NewFormatRow[]): { trades: Trade[], matchedTrades: MatchedTrade[] } => {
  const trades: Trade[] = [];
  const matchedTrades: MatchedTrade[] = [];
  let skippedRows = 0;
  
  rawData.forEach((row, index) => {
    try {
      if (!row.market_ticker || row.type !== 'trade') return;
      
      // Skip rows with missing timestamps
      if (!row.open_timestamp || !row.close_timestamp) {
        skippedRows++;
        return;
      }
      
      const quantity = parseInt(row.quantity) || 0;
      if (quantity === 0) return; // Skip zero quantity trades
      
      const entryPrice = parseInt(row.entry_price_cents) || 0;
      const exitPrice = parseInt(row.exit_price_cents) || 0;
      const openFees = (parseInt(row.open_fees_cents) || 0) / 100; // Convert to dollars
      const closeFees = (parseInt(row.close_fees_cents) || 0) / 100;
      const pnlWithFees = (parseInt(row.realized_pnl_with_fees_cents) || 0) / 100;
      const pnlWithoutFees = (parseInt(row.realized_pnl_without_fees_cents) || 0) / 100;
      const totalFees = openFees + closeFees;
      
      const entryDate = new Date(row.open_timestamp);
      const exitDate = new Date(row.close_timestamp);
      
      // Validate dates
      if (isNaN(entryDate.getTime()) || isNaN(exitDate.getTime())) {
        skippedRows++;
        console.warn(`Skipping row ${index}: Invalid date - open: "${row.open_timestamp}", close: "${row.close_timestamp}"`);
        return;
      }
      
      // Validate and normalize direction
      const side = row.side?.toLowerCase();
      if (side !== 'yes' && side !== 'no') {
        skippedRows++;
        return;
      }
      const direction = side === 'yes' ? 'Yes' : 'No';
      
      // Determine exit type based on exit price (0 or 100 = settlement, otherwise trade)
      const exitType = (exitPrice === 0 || exitPrice === 100) ? 'settlement' : 'trade';
      
      // Create a Trade object for compatibility with existing stats calculations
      // This represents a "virtual" exit trade in the legacy format
      const entryCost = (quantity * entryPrice) / 100; // Convert cents to dollars
      const trade: Trade = {
        Ticker: row.market_ticker,
        Type: exitType,
        Direction: direction,
        Contracts: quantity,
        Average_Price: entryPrice, // Entry price in cents
        Realized_Revenue: exitType === 'settlement' ? (exitPrice === 100 ? quantity : 0) : quantity,
        Realized_Cost: entryCost,
        Realized_Profit: pnlWithFees,
        Fees: totalFees,
        Created: row.close_timestamp,
        Date: exitDate,
        Trade_Cost: entryCost,
      };
      trades.push(trade);
      
      // Create MatchedTrade directly (no FIFO matching needed)
      const holdingDays = (exitDate.getTime() - entryDate.getTime()) / (24 * 3600 * 1000);
      const matchedTrade: MatchedTrade = {
        Ticker: row.market_ticker,
        Entry_Date: entryDate,
        Exit_Date: exitDate,
        Entry_Direction: direction,
        Exit_Type: exitType,
        Contracts: quantity,
        Entry_Cost: entryCost,
        Realized_Profit: pnlWithoutFees,
        Net_Profit: pnlWithFees,
        Holding_Period_Days: holdingDays,
        ROI: entryCost > 0 ? pnlWithFees / entryCost : 0,
        Entry_Fee: openFees,
        Exit_Fee: closeFees,
        Total_Fees: totalFees,
        Entry_Price: entryPrice,
        Exit_Price: exitPrice,
      };
      matchedTrades.push(matchedTrade);
      
    } catch (error) {
      console.error("Error processing new format row:", row, error);
      skippedRows++;
    }
  });
  
  console.log(`New format processing: ${matchedTrades.length} trades processed, ${skippedRows} rows skipped`);
  
  return { trades, matchedTrades };
};

// Calculate stats from new format (uses matchedTrades as source of truth)
const calculateBasicStatsFromMatchedTrades = (matchedTrades: MatchedTrade[]): ProcessedData['basicStats'] => {
  const uniqueTickers = new Set(matchedTrades.map(t => t.Ticker)).size;
  
  // Yes/No breakdown by contracts
  const yesNoBreakdown = matchedTrades.reduce((acc, trade) => {
    acc[trade.Entry_Direction] = (acc[trade.Entry_Direction] || 0) + trade.Contracts;
    return acc;
  }, {} as Record<string, number>);
  
  const totalFees = matchedTrades.reduce((sum, t) => sum + t.Total_Fees, 0);
  const totalProfit = matchedTrades.reduce((sum, t) => sum + t.Net_Profit, 0);
  
  // Average entry/exit prices weighted by contracts
  let totalWeightedEntryPrice = 0;
  let totalWeightedExitPrice = 0;
  let totalContracts = 0;
  
  matchedTrades.forEach(trade => {
    totalWeightedEntryPrice += trade.Entry_Price * trade.Contracts;
    totalWeightedExitPrice += trade.Exit_Price * trade.Contracts;
    totalContracts += trade.Contracts;
  });
  
  const avgContractPurchasePrice = totalContracts > 0 ? totalWeightedEntryPrice / totalContracts : 0;
  const avgContractFinalPrice = totalContracts > 0 ? totalWeightedExitPrice / totalContracts : 0;
  
  // Weighted holding period
  const totalTradeValue = matchedTrades.reduce((sum, t) => sum + t.Entry_Cost, 0);
  const weightedHoldingPeriod = totalTradeValue > 0 
    ? matchedTrades.reduce((sum, t) => sum + (t.Holding_Period_Days * t.Entry_Cost / totalTradeValue), 0)
    : 0;
  
  // Win rates — single pass instead of three separate filters
  let profitableCount = 0, settledCount = 0, profitableSettledCount = 0;
  for (const t of matchedTrades) {
    if (t.Net_Profit > 0) profitableCount++;
    if (t.Exit_Type === 'settlement') {
      settledCount++;
      if (t.Net_Profit > 0) profitableSettledCount++;
    }
  }
  const winRate = matchedTrades.length > 0 ? profitableCount / matchedTrades.length : 0;
  const settledWinRate = settledCount > 0 ? profitableSettledCount / settledCount : 0;
  
  return {
    uniqueTickers,
    totalTrades: matchedTrades.length,
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
  };
};

// ============ LEGACY FORMAT PARSER ============

const processLegacyFormat = (rawData: any[]): { trades: Trade[], matchedTrades: MatchedTrade[] } => {
  // Filter out credit transactions and convert string values and create Date objects
  const trades: Trade[] = rawData
    .filter(row => row && row.Ticker && row.Type !== 'credit')
    .map(row => {
      try {
        // Clean up monetary columns
        const cleanMoney = (val: string) => {
          if (!val) return 0;
          return parseFloat(val.replace('$', '').replace('+', '').trim()) || 0;
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
        console.error("Error processing legacy row:", row, error);
        return null;
      }
    }).filter(Boolean) as Trade[];
  
  // Match trades using FIFO
  const matchedTrades = matchTradesFifo(trades);
  
  return { trades, matchedTrades };
};

// ============ MAIN PROCESSING FUNCTION ============

// Main processing function - auto-detects format
export const processCSVData = (results: any): ProcessedData => {
  try {
    // Validate CSV structure
    if (!results.data || !Array.isArray(results.data) || results.data.length === 0) {
      throw new Error("Invalid CSV format: No data found");
    }
    
    const headers = results.meta.fields || [];
    const format = detectCsvFormat(headers);
    const rawData = results.data as any[];
    
    console.log(`Detected CSV format: ${format}`);
    
    let trades: Trade[];
    let matchedTrades: MatchedTrade[];
    let basicStats: ProcessedData['basicStats'];
    
    if (format === 'new') {
      const processed = processNewFormat(rawData);
      trades = processed.trades;
      matchedTrades = processed.matchedTrades;
      basicStats = calculateBasicStatsFromMatchedTrades(matchedTrades);
    } else {
      const processed = processLegacyFormat(rawData);
      trades = processed.trades;
      matchedTrades = processed.matchedTrades;
      basicStats = calculateBasicStats(trades, matchedTrades);
    }
    
    if (trades.length === 0 && matchedTrades.length === 0) {
      throw new Error("No valid trades found in the CSV file");
    }
    
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
  // Combine all trades and matched trades
  const allTrades = dataArray.flatMap(d => d.trades);
  const allMatchedTrades = dataArray.flatMap(d => d.matchedTrades);
  
  // Sort trades by date
  const sortedTrades = allTrades.sort((a, b) => a.Date.getTime() - b.Date.getTime());
  const sortedMatchedTrades = allMatchedTrades.sort((a, b) => a.Exit_Date.getTime() - b.Exit_Date.getTime());
  
  // Use matchedTrades-based stats since it works for both formats
  const basicStats = calculateBasicStatsFromMatchedTrades(sortedMatchedTrades);
  
  // Combine original data
  const originalData = dataArray.flatMap(d => d.originalData);
  
  return {
    originalData,
    trades: sortedTrades,
    matchedTrades: sortedMatchedTrades,
    basicStats,
  };
}; 

// Test function for timezone parsing (can be called from console for debugging)
export const testTimezoneParsing = () => {
  const testDates = [
    // Kalshi format with various timezones
    'Jan 20, 2025 at 10:04 AM HST',
    'Jan 20, 2025 at 10:04 AM PST',
    'Jan 20, 2025 at 10:04 AM EST',
    'Jan 20, 2025 at 2:30 PM CST',
    'Jan 20, 2025 at 11:45 PM MST',
    
    // Variations in formatting
    'Jan 20, 2025 at 10:04AM HST', // No space before AM
    'Feb 5, 2025 at 10:04 pm pst', // Lowercase
    
    // ISO formats that date-fns-tz should handle directly
    '2025-01-20T10:04:00-10:00', // HST offset
    '2025-01-20T10:04:00-08:00', // PST offset
    '2025-01-20T10:04:00-05:00', // EST offset
  ];
  
  console.log('Testing timezone parsing (Kalshi format -> ISO -> date-fns-tz):');
  testDates.forEach(dateStr => {
    const parsed = parseDate(dateStr);
    const isValid = !isNaN(parsed.getTime());
    console.log(`${dateStr.padEnd(35)} -> ${parsed.toISOString()} (${isValid ? 'VALID' : 'INVALID'})`);
  });
}; 
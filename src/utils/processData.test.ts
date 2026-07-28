import Papa from 'papaparse';
import { describe, it, expect } from 'vitest';
import {
  combineProcessedData,
  detectCsvFormat,
  normalizeHeader,
  parseTickerComponents,
  processCSVData,
} from './processData';

/**
 * Fixture in the earlier 2025 ("modern-cents") Kalshi export format. Row 1 is a
 * Yes position that settled at 100c; row 2 is a No position exited on the open
 * market at 55c. Every monetary field is integer cents.
 *
 * This is the regression harness for "files that work today still work".
 */
const MODERN_CENTS_CSV = [
  'type,quantity,market_ticker,side,entry_price_cents,exit_price_cents,open_fees_cents,close_fees_cents,realized_pnl_without_fees_cents,realized_pnl_with_fees_cents,close_timestamp,open_timestamp',
  'trade,10,KXTEST-25JAN01-A,yes,40,100,5,0,600,595,2025-01-02T15:00:00Z,2025-01-01T15:00:00Z',
  'trade,20,KXTEST-25JAN02-B,no,60,55,10,10,-100,-120,2025-01-05T15:00:00Z,2025-01-03T15:00:00Z',
].join('\n');

/**
 * Fixture in the current ("modern-dollars") Kalshi export format. Row 1 is
 * copied verbatim from upstream issue #4 — the reported bug — so the fixture
 * reproduces it exactly. Quantities are fractional and fees are sub-cent.
 */
const MODERN_DOLLARS_CSV = [
  'type,quantity_fp,market_ticker,side,entry_price_dollars,exit_price_dollars,open_fees_dollars,close_fees_dollars,realized_pnl_without_fees_dollars,realized_pnl_with_fees_dollars,close_timestamp,open_timestamp',
  'trade,10.18,KXBTCD-26MAY0805-T79799.99,yes,0.9800,1.0000,0.023600,0.000000,0.203600,0.180000,2026-05-08T05:02:54-04:00,2026-05-08T04:49:24-04:00',
  'trade,20,KXTEST-25JAN02-B,no,0.6000,0.5500,0.100000,0.100000,-1.000000,-1.200000,2025-01-05T15:00:00Z,2025-01-03T15:00:00Z',
].join('\n');

const LEGACY_FORMAT_CSV = [
  'Ticker,Type,Direction,Contracts,Average_Price,Realized_Revenue,Realized_Cost,Realized_Profit,Fees,Created',
  'KXTEST-25JAN01-A,trade,Yes,10,40,$0.00,$4.00,$0.00,$0.05,"Jan 1, 2025 at 10:04 AM PST"',
].join('\n');

const parseCsv = (csv: string) =>
  Papa.parse(csv, { header: true, skipEmptyLines: true });

describe('detectCsvFormat', () => {
  it('identifies the modern cents format', () => {
    expect(detectCsvFormat(parseCsv(MODERN_CENTS_CSV).meta.fields!)).toBe(
      'modern-cents',
    );
  });

  it('identifies the modern dollars format', () => {
    expect(detectCsvFormat(parseCsv(MODERN_DOLLARS_CSV).meta.fields!)).toBe(
      'modern-dollars',
    );
  });

  it('identifies the legacy format', () => {
    expect(detectCsvFormat(parseCsv(LEGACY_FORMAT_CSV).meta.fields!)).toBe(
      'legacy',
    );
  });

  it('throws on an unrecognised header row', () => {
    expect(() => detectCsvFormat(['foo', 'bar'])).toThrow(
      /Unrecognized CSV format/,
    );
    // The message must be actionable: name what is missing and echo what was
    // seen. See docs/defects.md D-004.
    expect(() => detectCsvFormat(['foo', 'bar'])).toThrow(
      /missing 6 column\(s\): Ticker, Type, Direction/,
    );
    expect(() => detectCsvFormat(['foo', 'bar'])).toThrow(/Headers seen \(2\)/);
    expect(() => detectCsvFormat(['foo', 'bar'])).toThrow(/foo, bar/);
  });

  it('names the one missing column when everything else matches', () => {
    const headers = parseCsv(MODERN_DOLLARS_CSV).meta.fields!.filter(
      h => h !== 'entry_price_dollars',
    );
    expect(() => detectCsvFormat(headers)).toThrow(/entry_price_dollars/);
    expect(() => detectCsvFormat(headers)).toThrow(/missing 1 column/);
  });

  // Weak by construction, and deliberately kept anyway. Papa strips a leading
  // BOM itself, but only when the input is a *string* (papaparse.js:238,
  // `typeof _input === 'string'`). CsvUploader hands Papa a File, which takes
  // the FileStreamer branch and does NOT strip it. So this test cannot fail
  // even with the D-003 fix reverted; it only pins the string path. The real
  // guard for D-003 is `normalizeHeader` below plus its use as transformHeader
  // at the Papa.parse call. Covering the File path needs a DOM environment
  // (FileReader), which this project does not have.
  it('tolerates a UTF-8 BOM on the header row', () => {
    expect(
      detectCsvFormat(parseCsv('﻿' + MODERN_CENTS_CSV).meta.fields!),
    ).toBe('modern-cents');
    expect(
      detectCsvFormat(parseCsv('﻿' + MODERN_DOLLARS_CSV).meta.fields!),
    ).toBe('modern-dollars');
  });

});

// Normalising inside detectCsvFormat is not sufficient on its own: Papa keys
// every row object by the raw header, so on the File path a leading BOM leaves
// `row.type` undefined and every row is skipped as a non-trade. CsvUploader
// therefore passes this as transformHeader. See docs/defects.md D-003.
describe('normalizeHeader', () => {
  it('strips a leading UTF-8 BOM', () => {
    expect(normalizeHeader('﻿type')).toBe('type');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeHeader('  market_ticker \t')).toBe('market_ticker');
  });

  it('leaves a clean header untouched', () => {
    expect(normalizeHeader('entry_price_dollars')).toBe('entry_price_dollars');
  });
});

describe('parseTickerComponents', () => {
  it('splits SERIES-EVENT-MARKET', () => {
    expect(parseTickerComponents('KXKIRKMENTION-25DEC04-PATR')).toEqual({
      series: 'KXKIRKMENTION',
      event: '25DEC04',
      market: 'PATR',
    });
  });

  it('keeps dashes that belong to the market segment', () => {
    expect(parseTickerComponents('KXA-25JAN01-B-C').market).toBe('B-C');
  });
});

describe('processCSVData — modern cents format', () => {
  const result = processCSVData(parseCsv(MODERN_CENTS_CSV));

  it('produces one matched trade per row', () => {
    expect(result.matchedTrades).toHaveLength(2);
  });

  it('classifies a 100c exit as a settlement and a 55c exit as a trade', () => {
    expect(result.matchedTrades[0].Exit_Type).toBe('settlement');
    expect(result.matchedTrades[1].Exit_Type).toBe('trade');
  });

  it('converts cents to dollars for PnL and fees', () => {
    expect(result.matchedTrades[0].Net_Profit).toBeCloseTo(5.95, 10);
    expect(result.matchedTrades[0].Realized_Profit).toBeCloseTo(6.0, 10);
    expect(result.matchedTrades[1].Net_Profit).toBeCloseTo(-1.2, 10);
    expect(result.matchedTrades[0].Total_Fees).toBeCloseTo(0.05, 10);
    expect(result.matchedTrades[1].Total_Fees).toBeCloseTo(0.2, 10);
  });

  it('derives entry cost from quantity and entry price', () => {
    expect(result.matchedTrades[0].Entry_Cost).toBeCloseTo(4.0, 10);
    expect(result.matchedTrades[1].Entry_Cost).toBeCloseTo(12.0, 10);
  });

  it('parses ISO timestamps into the holding period', () => {
    expect(result.matchedTrades[0].Holding_Period_Days).toBeCloseTo(1, 10);
    expect(result.matchedTrades[1].Holding_Period_Days).toBeCloseTo(2, 10);
  });

  it('aggregates basic stats across both rows', () => {
    const { basicStats } = result;
    expect(basicStats.uniqueTickers).toBe(2);
    expect(basicStats.totalTrades).toBe(2);
    expect(basicStats.yesNoBreakdown).toEqual({ Yes: 10, No: 20 });
    expect(basicStats.totalFees).toBeCloseTo(0.25, 10);
    expect(basicStats.totalProfit).toBeCloseTo(4.75, 10);
    expect(basicStats.winRate).toBeCloseTo(0.5, 10);
    expect(basicStats.settledWinRate).toBeCloseTo(1, 10);
  });
});

describe('processCSVData — modern dollars format', () => {
  const result = processCSVData(parseCsv(MODERN_DOLLARS_CSV));

  it('produces one matched trade per row', () => {
    expect(result.matchedTrades).toHaveLength(2);
  });

  it('carries the fractional contract count without rounding', () => {
    expect(result.matchedTrades[0].Contracts).toBeCloseTo(10.18, 10);
  });

  it('normalises dollar prices to cents', () => {
    expect(result.matchedTrades[0].Entry_Price).toBeCloseTo(98, 10);
    expect(result.matchedTrades[0].Exit_Price).toBeCloseTo(100, 10);
  });

  it('derives entry cost in dollars from the fractional quantity', () => {
    expect(result.matchedTrades[0].Entry_Cost).toBeCloseTo(9.9764, 10);
    expect(result.matchedTrades[1].Entry_Cost).toBeCloseTo(12.0, 10);
  });

  it('keeps sub-cent fees intact', () => {
    expect(result.matchedTrades[0].Entry_Fee).toBeCloseTo(0.0236, 10);
    expect(result.matchedTrades[0].Exit_Fee).toBeCloseTo(0, 10);
    expect(result.matchedTrades[0].Total_Fees).toBeCloseTo(0.0236, 10);
  });

  // A detection-only fix would leave both of these at 0: parseInt('0.203600')
  // is 0, and 0 is a legitimate PnL, so no guard would ever fire.
  it('reads PnL straight from the file rather than zeroing it', () => {
    expect(result.matchedTrades[0].Realized_Profit).toBeCloseTo(0.2036, 10);
    expect(result.matchedTrades[0].Net_Profit).toBeCloseTo(0.18, 10);
    expect(result.matchedTrades[1].Realized_Profit).toBeCloseTo(-1.0, 10);
    expect(result.matchedTrades[1].Net_Profit).toBeCloseTo(-1.2, 10);
  });

  it('classifies a $1.0000 exit as a settlement and $0.5500 as a trade', () => {
    expect(result.matchedTrades[0].Exit_Type).toBe('settlement');
    expect(result.matchedTrades[1].Exit_Type).toBe('trade');
  });

  it('computes ROI against the dollar entry cost', () => {
    expect(result.matchedTrades[0].ROI).toBeCloseTo(0.18 / 9.9764, 10);
  });

  it('aggregates basic stats across both rows', () => {
    const { basicStats } = result;
    expect(basicStats.uniqueTickers).toBe(2);
    expect(basicStats.totalTrades).toBe(2);
    expect(basicStats.totalFees).toBeCloseTo(0.2236, 10);
    expect(basicStats.totalProfit).toBeCloseTo(0.18 + -1.2, 10);
  });
});

describe('combineProcessedData across formats', () => {
  it('keeps prices in one unit when cents and dollars files are merged', () => {
    const combined = combineProcessedData([
      processCSVData(parseCsv(MODERN_CENTS_CSV)),
      processCSVData(parseCsv(MODERN_DOLLARS_CSV)),
    ]);

    expect(combined.matchedTrades).toHaveLength(4);
    expect(combined.basicStats.avgContractPurchasePrice).toBeGreaterThan(0);
    expect(combined.basicStats.avgContractPurchasePrice).toBeLessThan(100);
    expect(combined.basicStats.avgContractFinalPrice).toBeGreaterThan(0);
    expect(combined.basicStats.avgContractFinalPrice).toBeLessThanOrEqual(100);
  });
});

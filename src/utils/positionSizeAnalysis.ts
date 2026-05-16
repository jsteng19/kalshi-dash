import { MatchedTrade } from './processData';

export const POSITION_SIZE_BUCKETS = [
  1, 10, 25, 50, 75, 100, 125, 150, 175, 200,
  225, 250, 275, 300,
  350, 400, 450, 500, 550, 600, 650, 700, 750, 800, 850, 900, 950, 1000,
  1250, 1500, 1750, 2000,
] as const;

export const OVER_BUCKET_LABEL = '2000+';

export type PositionSizeBucket = (typeof POSITION_SIZE_BUCKETS)[number] | typeof OVER_BUCKET_LABEL;

export interface PositionSizeBucketStats {
  bucket: PositionSizeBucket;
  label: string;
  trades: number;
  distinctSeries: number;
  totalCost: number;
  totalPnl: number;
  totalFees: number;
  roi: number | null;
  winRate: number;
  firstUsed: string | null;
  lastUsed: string | null;
}

export type PositionSizeRange = 'all' | '30' | '60' | '90';

function bucketFor(contracts: number): PositionSizeBucket {
  if (contracts > 2000) return OVER_BUCKET_LABEL;
  for (const b of POSITION_SIZE_BUCKETS) {
    if (contracts <= b) return b;
  }
  return OVER_BUCKET_LABEL;
}

function bucketLabel(b: PositionSizeBucket): string {
  return b === OVER_BUCKET_LABEL ? '2000+' : String(b);
}

function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function bucketByPositionSize(
  matchedTrades: MatchedTrade[],
  range: PositionSizeRange = 'all',
): PositionSizeBucketStats[] {
  const now = new Date();
  const cutoff = range === 'all' ? null : new Date(now.getTime() - parseInt(range, 10) * 24 * 60 * 60 * 1000);

  const acc = new Map<PositionSizeBucket, {
    trades: number;
    series: Set<string>;
    cost: number;
    pnl: number;
    fees: number;
    wins: number;
    firstMs: number | null;
    lastMs: number | null;
  }>();

  for (const t of matchedTrades) {
    if (cutoff && t.Exit_Date < cutoff) continue;
    const b = bucketFor(t.Contracts);
    let agg = acc.get(b);
    if (!agg) {
      agg = { trades: 0, series: new Set(), cost: 0, pnl: 0, fees: 0, wins: 0, firstMs: null, lastMs: null };
      acc.set(b, agg);
    }
    agg.trades += 1;
    agg.series.add(t.Ticker.split('-')[0]);
    agg.cost += t.Entry_Cost;
    agg.pnl += t.Net_Profit;
    agg.fees += t.Total_Fees;
    if (t.Net_Profit > 0) agg.wins += 1;
    const ms = t.Exit_Date.getTime();
    if (agg.firstMs === null || ms < agg.firstMs) agg.firstMs = ms;
    if (agg.lastMs === null || ms > agg.lastMs) agg.lastMs = ms;
  }

  const result: PositionSizeBucketStats[] = [];
  const bucketOrder: PositionSizeBucket[] = [...POSITION_SIZE_BUCKETS, OVER_BUCKET_LABEL];
  for (const b of bucketOrder) {
    const agg = acc.get(b);
    if (!agg) continue;
    result.push({
      bucket: b,
      label: bucketLabel(b),
      trades: agg.trades,
      distinctSeries: agg.series.size,
      totalCost: agg.cost,
      totalPnl: agg.pnl,
      totalFees: agg.fees,
      roi: agg.cost > 0 ? agg.pnl / agg.cost : null,
      winRate: agg.trades > 0 ? agg.wins / agg.trades : 0,
      firstUsed: agg.firstMs !== null ? formatDate(new Date(agg.firstMs)) : null,
      lastUsed: agg.lastMs !== null ? formatDate(new Date(agg.lastMs)) : null,
    });
  }
  return result;
}

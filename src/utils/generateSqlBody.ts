/**
 * SQL generation — Option B (relative ladder model).
 *
 * KalshiPNL does NOT track absolute tier values. OCT owns the tier.
 * Each Generate SQL run emits:
 *   - DELETE for inactive series (>60d no trades, w/ row-age guard)
 *   - PROMOTE (relative +1 rung via CASE-WHEN) for series whose today event = 'promote'
 *   - DEMOTE (relative -1 rung via CASE-WHEN) for series whose today event = 'demote'
 *   - DISABLE for stinkers (sustained losers)
 *   - Sell-strategy UPDATEs (settlement vs limit) — unchanged
 *
 * Output: { sql, events, newDeletions }. Caller persists `events` via
 * /api/tier-history/event and `newDeletions` via /api/tier-history/deleted.
 */

import { MatchedTrade, parseTickerComponents, calculateSeriesStatsFromMatched, SettlementResult } from './processData';
import { evaluateLadder, ladderUpCase, ladderDownCase, SeriesEvaluation } from './tierBacktest';
import type { EventInput, NewDeletionInput } from '@/lib/tierHistory';

export interface GenerateSqlInput {
  allMatchedTrades: MatchedTrade[];
  frequencyMap: Map<string, string>;
  categoryMap?: Map<string, string>;
  settlementMap: Map<string, SettlementResult>;
  // Series previously emitted in a DELETE block — suppress repeat while
  // CSV history hasn't advanced.
  previouslyDeleted?: Record<string, string>;
}

export interface GenerateSqlOutput {
  sql: string;
  events: EventInput[];
  newDeletions: NewDeletionInput[];
}

const STINKER_SUSTAINED_NEGATIVE_DAYS = 30;

function stinkerThresh(freq?: string): { days: number; trades: number } {
  switch (freq) {
    case 'hourly':
    case 'fifteen_min': return { days: 30, trades: 50 };
    case 'daily':       return { days: 30, trades: 30 };
    case 'weekly':      return { days: 45, trades: 20 };
    case 'monthly':     return { days: 60, trades: 6 };
    case 'annual':      return { days: 90, trades: 10 };
    case 'one_off':
    case 'custom':      return { days: 90, trades: 5 };
    default:            return { days: 90, trades: 30 };
  }
}

function fmtPct(v: number): string {
  return (v >= 0 ? '+' : '') + (v * 100).toFixed(1) + '%';
}

function todayDateKey(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Sustained-negative check: walk evaluation history backward; return
 * true if the last positive-signal day (or first day if none) is at
 * least N days before today.
 */
function sustainedNegativeFor(ev: SeriesEvaluation, days: number): boolean {
  if (ev.history.length === 0) return false;
  // Look at the most recent active day with a non-null demote signal.
  // If every such day for the past `days` was negative → sustained.
  const todayMs = Date.parse(ev.history[ev.history.length - 1].date + 'T00:00:00');
  let lastPositiveMs: number | null = null;
  for (let i = ev.history.length - 1; i >= 0; i--) {
    const h = ev.history[i];
    if (h.signalValue !== null && h.signalValue >= 0) {
      lastPositiveMs = Date.parse(h.date + 'T00:00:00');
      break;
    }
  }
  if (lastPositiveMs === null) {
    // No positive day ever → sustained if history spans ≥days
    const firstMs = Date.parse(ev.history[0].date + 'T00:00:00');
    return Math.floor((todayMs - firstMs) / 86400000) >= days;
  }
  return Math.floor((todayMs - lastPositiveMs) / 86400000) >= days;
}

export function generateSqlBody(input: GenerateSqlInput): GenerateSqlOutput {
  const { allMatchedTrades, frequencyMap, settlementMap, previouslyDeleted = {} } = input;
  const today = new Date();
  const MS_PER_DAY = 1000 * 60 * 60 * 24;
  const today_s = todayDateKey();

  // --- Per-series first/last trade dates -----------------------------------
  const lastTradeDateMap = new Map<string, Date>();
  const firstTradeDateMap = new Map<string, Date>();
  for (const t of allMatchedTrades) {
    const { series } = parseTickerComponents(t.Ticker);
    const last = lastTradeDateMap.get(series);
    if (!last || t.Exit_Date > last) lastTradeDateMap.set(series, t.Exit_Date);
    const first = firstTradeDateMap.get(series);
    if (!first || t.Exit_Date < first) firstTradeDateMap.set(series, t.Exit_Date);
  }

  const startOfToday = new Date(today);
  startOfToday.setHours(0, 0, 0, 0);

  const allSeriesStats = calculateSeriesStatsFromMatched(allMatchedTrades);
  const evaluations = evaluateLadder(allMatchedTrades, frequencyMap);

  type Entry = { series: string; comment: string };
  const promotes: Entry[] = [];
  const demotes: Entry[] = [];
  const stinkers: string[] = [];
  const toDelete: string[] = [];
  const newDeletions: NewDeletionInput[] = [];
  const events: EventInput[] = [];

  allSeriesStats.forEach((stats, series) => {
    const lastDate = lastTradeDateMap.get(series);
    const firstDate = firstTradeDateMap.get(series);
    const daysSinceLast = lastDate ? Math.floor((startOfToday.getTime() - lastDate.getTime()) / MS_PER_DAY) : Infinity;
    const daysSinceFirst = firstDate ? Math.floor((startOfToday.getTime() - firstDate.getTime()) / MS_PER_DAY) : 0;

    // --- DELETE (with suppression) -----------------------------------------
    if (daysSinceLast > 60) {
      const lastTradeStr = lastDate ? ymd(lastDate) : '';
      const prevLastTrade = previouslyDeleted[series];
      if (prevLastTrade && prevLastTrade === lastTradeStr) return;
      toDelete.push(series);
      newDeletions.push({ series, lastTradeDate: lastTradeStr, emittedOn: today_s });
      return;
    }

    const ev = evaluations.get(series);
    if (!ev) return;

    // --- Stinker check (no tier reference) ---------------------------------
    // Rule (Option B): sustained negative signal for STINKER_SUSTAINED_NEGATIVE_DAYS,
    // all-time PnL negative, and per-frequency observation + trade thresholds.
    // Series must NOT have settled a positive day in the trailing window.
    const fr = frequencyMap?.get(series);
    const th = stinkerThresh(fr);
    if (daysSinceFirst >= th.days
        && stats.tradesCount >= th.trades
        && stats.pnl < 0
        && sustainedNegativeFor(ev, STINKER_SUSTAINED_NEGATIVE_DAYS)) {
      stinkers.push(series);
    }

    // --- Build today's comment + emit move ---------------------------------
    const last = ev.history[ev.history.length - 1];
    const lastTradeDaysAgo = lastDate
      ? Math.floor((startOfToday.getTime() - lastDate.getTime()) / MS_PER_DAY)
      : null;
    const lastTradeStr = lastTradeDaysAgo === 0 ? 'last trade today'
                       : lastTradeDaysAgo === 1 ? 'last trade yesterday'
                       : lastTradeDaysAgo !== null ? `last trade ${lastTradeDaysAgo}d ago`
                       : 'no trades';
    const sigStr = ev.lastSignal && ev.lastSignalValue !== null
                 ? `${ev.lastSignal} ${fmtPct(ev.lastSignalValue)}`
                 : ev.lastR30 !== null ? `r30 ${fmtPct(ev.lastR30)}`
                 : 'no signal';
    const counterStr = ev.todayEvent === 'hold' && ev.todayConsecutivePositive > 0
                     ? ` · counter=${ev.todayConsecutivePositive}/3`
                     : '';
    const comment = `${lastTradeStr} (${sigStr})${counterStr}`;

    if (ev.todayEvent === 'promote') {
      promotes.push({ series, comment });
    } else if (ev.todayEvent === 'demote') {
      demotes.push({ series, comment });
    }

    // Persist today's evaluation regardless of event.
    events.push({
      date: today_s,
      series,
      event: ev.todayEvent,
      r10: last?.r10 ?? null,
      r15: last?.r15 ?? null,
      r30: last?.r30 ?? null,
      r35: last?.r35 ?? null,
      signal_label: ev.lastSignal,
      consecutive: ev.todayConsecutivePositive,
      reason: comment,
    });
  });

  // --- Emit SQL ----------------------------------------------------------
  const emitInBlock = (entries: Entry[]): string => {
    const sorted = [...entries].sort((a, b) => a.series.localeCompare(b.series));
    return sorted.map((e, i) => {
      const isLast = i === sorted.length - 1;
      return `  '${e.series}'${isLast ? '' : ','} -- ${e.comment}`;
    }).join('\n');
  };
  const toIn = (arr: string[]) => arr.map(s => `'${s}'`).join(',\n  ');
  const parts: string[] = [];

  if (toDelete.length) {
    parts.push(
      `-- Inactive series (no trades in 60+ days) — ${toDelete.length} series\n` +
      `-- Row-age guard (created_at < 60d ago) protects rows freshly re-added\n` +
      `-- by the discovery cron; they need 60 days to attempt a first trade\n` +
      `-- before sweep eligibility.\n` +
      `DELETE FROM one_cent_series_filters\nWHERE series_ticker IN (\n  ${toIn(toDelete)}\n)\nAND created_at < NOW() - INTERVAL 60 DAY;`
    );
  }

  if (promotes.length) {
    parts.push(
      `-- Promote +1 rung (relative) — ${promotes.length} series\n` +
      `-- 3 consecutive active days with r30 ≥ 0.\n` +
      `UPDATE one_cent_series_filters\nSET position_size_cents = ${ladderUpCase()}\nWHERE series_ticker IN (\n${emitInBlock(promotes)}\n);`
    );
  }

  if (demotes.length) {
    parts.push(
      `-- Demote -1 rung (relative) — ${demotes.length} series\n` +
      `-- Hybrid demote signal (r10 / r15 / r35) negative today.\n` +
      `UPDATE one_cent_series_filters\nSET position_size_cents = ${ladderDownCase()}\nWHERE series_ticker IN (\n${emitInBlock(demotes)}\n);`
    );
  }

  if (stinkers.length) {
    parts.push(
      `-- Disable stinkers — ${stinkers.length} series\n` +
      `-- All-time PnL negative, sustained negative signal for ${STINKER_SUSTAINED_NEGATIVE_DAYS}+ days, freq thresholds met (hourly/daily 30d/30t, weekly 45d/20t, monthly 60d/6t, annual/one_off/custom 90d). Weather excluded.\n` +
      `UPDATE one_cent_series_filters\nSET enabled = 0\nWHERE series_ticker IN (\n  ${toIn(stinkers)}\n)\nAND category != 'Climate and Weather';`
    );
  }

  // --- Sell strategy (unchanged from prior model) ------------------------
  if (settlementMap && settlementMap.size > 0) {
    const seriesEarlyExits = new Map<string, MatchedTrade[]>();
    allMatchedTrades
      .filter(t => t.Exit_Price > 0 && t.Exit_Price < 100)
      .forEach(t => {
        const { series } = parseTickerComponents(t.Ticker);
        if (!seriesEarlyExits.has(series)) seriesEarlyExits.set(series, []);
        seriesEarlyExits.get(series)!.push(t);
      });

    const settlementStrategy: string[] = [];
    const limitStrategy: string[] = [];

    seriesEarlyExits.forEach((trades, series) => {
      let knownActualPnl = 0;
      let whatIfPnl = 0;
      let knownCount = 0;
      for (const t of trades) {
        const result = settlementMap.get(t.Ticker);
        if (result === 'no') {
          knownActualPnl += t.Net_Profit;
          whatIfPnl += (100 - t.Entry_Price) * t.Contracts / 100;
          knownCount++;
        } else if (result === 'yes') {
          knownActualPnl += t.Net_Profit;
          whatIfPnl += -t.Entry_Cost;
          knownCount++;
        }
      }
      if (knownCount === 0) return;
      if (whatIfPnl > knownActualPnl) settlementStrategy.push(series);
      else limitStrategy.push(series);
    });

    if (settlementStrategy.length) {
      parts.push(
        `-- Sell strategy: settlement (holding to settlement was better) — ${settlementStrategy.length} series\n` +
        `UPDATE one_cent_series_filters\nSET sell_strategy = 'settlement'\nWHERE series_ticker IN (\n  ${toIn(settlementStrategy)}\n);`
      );
    }
    if (limitStrategy.length) {
      parts.push(
        `-- Sell strategy: limit (early exit was better) — ${limitStrategy.length} series\n` +
        `UPDATE one_cent_series_filters\nSET sell_strategy = 'limit'\nWHERE series_ticker IN (\n  ${toIn(limitStrategy)}\n);`
      );
    }
  }

  const dateHeader = `-- Generated ${today.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`;
  const sql = [dateHeader, ...parts].join('\n\n');
  return { sql, events, newDeletions };
}

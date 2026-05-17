/**
 * Tier history SQLite layer (Option B — relative ladder model).
 *
 * KalshiPNL no longer tracks absolute tier numbers. OCT owns the tier.
 * KalshiPNL only tracks per-series state needed to decide the next move:
 *
 *   - tier_state: rolling per-series state machine (counter, last event,
 *     last promote/demote dates).
 *   - tier_events: append-only audit log of every evaluation per day.
 *   - tier_deleted: dormant series we've already DELETE'd, suppressed
 *     until CSV history advances.
 *
 * DB lives at ~/.local/share/kalshipnl/kalshipnl.db (outside Dropbox to
 * avoid WAL sync conflicts). Override with KALSHIPNL_DATA_DIR env var.
 *
 * Server-side only — do not import from client components.
 */

import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA_DIR = process.env.KALSHIPNL_DATA_DIR
  ?? path.join(os.homedir(), '.local', 'share', 'kalshipnl');
const DB_PATH = path.join(DATA_DIR, 'kalshipnl.db');

let _db: Database.Database | null = null;

function db(): Database.Database {
  if (_db) return _db;
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  initSchema(_db);
  return _db;
}

function initSchema(d: Database.Database): void {
  d.exec(`
    -- Per-series rolling state machine. One row per series.
    CREATE TABLE IF NOT EXISTS tier_state (
      series                TEXT PRIMARY KEY,
      consecutive_positive  INTEGER NOT NULL DEFAULT 0,
      last_event            TEXT,                 -- 'promote' | 'demote' | 'hold' | null
      last_event_date       TEXT,                 -- YYYY-MM-DD
      last_promote_date     TEXT,
      last_demote_date      TEXT,
      updated_at            TEXT NOT NULL
    );

    -- Append-only per-day per-series audit log of evaluations.
    CREATE TABLE IF NOT EXISTS tier_events (
      date          TEXT NOT NULL,                -- YYYY-MM-DD
      series        TEXT NOT NULL,
      event         TEXT NOT NULL,                -- 'promote' | 'demote' | 'hold'
      r10           REAL,
      r15           REAL,
      r30           REAL,
      r35           REAL,
      signal_label  TEXT,                         -- 'r10' | 'r15' | 'r35' | null
      consecutive   INTEGER,
      reason        TEXT,
      PRIMARY KEY (date, series)
    );
    CREATE INDEX IF NOT EXISTS idx_tier_events_series_date
      ON tier_events (series, date DESC);

    -- Series we previously emitted in a DELETE block. Suppresses
    -- re-emission while CSV history hasn't changed.
    CREATE TABLE IF NOT EXISTS tier_deleted (
      series                  TEXT PRIMARY KEY,
      deleted_on              TEXT NOT NULL,
      last_trade_at_deletion  TEXT NOT NULL
    );
  `);
}

// ----------------------------------------------------------------------
// State (tier_state)
// ----------------------------------------------------------------------

export type LadderEvent = 'promote' | 'demote' | 'hold';

export interface TierStateRow {
  series: string;
  consecutive_positive: number;
  last_event: LadderEvent | null;
  last_event_date: string | null;
  last_promote_date: string | null;
  last_demote_date: string | null;
  updated_at: string;
}

export function getAllStates(): Map<string, TierStateRow> {
  const rows = db().prepare('SELECT * FROM tier_state').all() as TierStateRow[];
  const m = new Map<string, TierStateRow>();
  for (const r of rows) m.set(r.series, r);
  return m;
}

export function getState(series: string): TierStateRow | null {
  return (db().prepare('SELECT * FROM tier_state WHERE series = ?').get(series) as TierStateRow | undefined) ?? null;
}

// ----------------------------------------------------------------------
// Events (tier_events) + paired state UPSERT
// ----------------------------------------------------------------------

export interface EventInput {
  date: string;                    // YYYY-MM-DD
  series: string;
  event: LadderEvent;
  r10: number | null;
  r15: number | null;
  r30: number | null;
  r35: number | null;
  signal_label: 'r10' | 'r15' | 'r35' | null;
  consecutive: number;
  reason: string | null;
}

/**
 * Write today's evaluation per series + refresh tier_state in one tx.
 * Idempotent: re-running same date overwrites the event row, and state
 * upsert is a deterministic function of inputs.
 */
export function writeEvents(events: EventInput[]): { written: number } {
  if (events.length === 0) return { written: 0 };
  const d = db();

  const insertEvent = d.prepare(`
    INSERT INTO tier_events
      (date, series, event, r10, r15, r30, r35, signal_label, consecutive, reason)
    VALUES (@date, @series, @event, @r10, @r15, @r30, @r35, @signal_label, @consecutive, @reason)
    ON CONFLICT(date, series) DO UPDATE SET
      event=excluded.event, r10=excluded.r10, r15=excluded.r15, r30=excluded.r30,
      r35=excluded.r35, signal_label=excluded.signal_label,
      consecutive=excluded.consecutive, reason=excluded.reason
  `);

  const upsertState = d.prepare(`
    INSERT INTO tier_state
      (series, consecutive_positive, last_event, last_event_date,
       last_promote_date, last_demote_date, updated_at)
    VALUES (@series, @consecutive, @event, @date,
            @last_promote_date, @last_demote_date, @updated_at)
    ON CONFLICT(series) DO UPDATE SET
      consecutive_positive=excluded.consecutive_positive,
      last_event=excluded.last_event,
      last_event_date=excluded.last_event_date,
      last_promote_date=COALESCE(excluded.last_promote_date, tier_state.last_promote_date),
      last_demote_date =COALESCE(excluded.last_demote_date,  tier_state.last_demote_date),
      updated_at=excluded.updated_at
  `);

  const now = new Date().toISOString();
  const tx = d.transaction((rows: EventInput[]) => {
    let n = 0;
    for (const r of rows) {
      insertEvent.run(r);
      upsertState.run({
        series: r.series,
        consecutive: r.consecutive,
        event: r.event,
        date: r.date,
        last_promote_date: r.event === 'promote' ? r.date : null,
        last_demote_date:  r.event === 'demote'  ? r.date : null,
        updated_at: now,
      });
      n++;
    }
    return n;
  });
  return { written: tx(events) };
}

export interface TierEventRow extends EventInput {}

export function getEvents(series: string, limit = 90): TierEventRow[] {
  return db()
    .prepare('SELECT * FROM tier_events WHERE series = ? ORDER BY date DESC LIMIT ?')
    .all(series, limit) as TierEventRow[];
}

// ----------------------------------------------------------------------
// Deleted (tier_deleted) — unchanged from prior implementation
// ----------------------------------------------------------------------

export interface DeletedRow {
  series: string;
  deleted_on: string;
  last_trade_at_deletion: string;
}

export function getAllDeleted(): Map<string, DeletedRow> {
  const rows = db().prepare('SELECT * FROM tier_deleted').all() as DeletedRow[];
  const m = new Map<string, DeletedRow>();
  for (const r of rows) m.set(r.series, r);
  return m;
}

export interface NewDeletionInput {
  series: string;
  lastTradeDate: string;
  emittedOn: string;
}

export function recordDeletions(items: NewDeletionInput[]): { written: number } {
  if (items.length === 0) return { written: 0 };
  const d = db();
  const stmt = d.prepare(`
    INSERT INTO tier_deleted (series, deleted_on, last_trade_at_deletion)
    VALUES (@series, @emittedOn, @lastTradeDate)
    ON CONFLICT(series) DO UPDATE SET
      deleted_on=excluded.deleted_on,
      last_trade_at_deletion=excluded.last_trade_at_deletion
  `);
  const tx = d.transaction((rows: NewDeletionInput[]) => {
    let n = 0;
    for (const r of rows) { stmt.run(r); n++; }
    return n;
  });
  return { written: tx(items) };
}

// ----------------------------------------------------------------------
// Date helpers
// ----------------------------------------------------------------------

export function daysBetween(a: string | null, b: string): number | null {
  if (!a) return null;
  const am = Date.parse(a + 'T00:00:00Z');
  const bm = Date.parse(b + 'T00:00:00Z');
  if (isNaN(am) || isNaN(bm)) return null;
  return Math.round((bm - am) / 86400000);
}

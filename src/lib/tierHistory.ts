/**
 * Tier history SQLite layer.
 *
 * Local persistence for the 10-step ladder: today's tier per series,
 * full transition history, and cooldown timestamps.
 *
 * DB lives at ~/.local/share/kalshipnl/kalshipnl.db (outside Dropbox).
 * Dropbox-syncing SQLite WAL files causes intermittent SQLITE_BUSY and
 * "(Conflicted copy)" files when the project dir is opened on two
 * machines. Keep this DB local; export to Dropbox manually if backup
 * is desired.
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
    CREATE TABLE IF NOT EXISTS tier_history (
      date         TEXT    NOT NULL,
      series       TEXT    NOT NULL,
      tier         INTEGER NOT NULL,
      prev_tier    INTEGER,
      moved        TEXT,
      r10          REAL,
      r15          REAL,
      r35          REAL,
      signal       TEXT,
      trades_today INTEGER,
      reason       TEXT,
      PRIMARY KEY (date, series)
    );
    CREATE INDEX IF NOT EXISTS idx_tier_history_series_date
      ON tier_history (series, date DESC);

    CREATE TABLE IF NOT EXISTS tier_cooldown (
      series             TEXT PRIMARY KEY,
      current_tier       INTEGER NOT NULL,
      last_promote_date  TEXT,
      last_demote_date   TEXT,
      last_move_date     TEXT,
      updated_at         TEXT NOT NULL
    );
  `);
}

export interface TierHistoryRow {
  date: string;
  series: string;
  tier: number;
  prev_tier: number | null;
  moved: 'up' | 'down' | 'hold' | null;
  r10: number | null;
  r15: number | null;
  r35: number | null;
  signal: 'r10' | 'r15' | 'r35' | null;
  trades_today: number | null;
  reason: string | null;
}

export interface CooldownRow {
  series: string;
  current_tier: number;
  last_promote_date: string | null;
  last_demote_date: string | null;
  last_move_date: string | null;
  updated_at: string;
}

export function getCurrentTier(series: string): number | null {
  const row = db()
    .prepare('SELECT current_tier FROM tier_cooldown WHERE series = ?')
    .get(series) as { current_tier: number } | undefined;
  return row ? row.current_tier : null;
}

export function getCooldown(series: string): CooldownRow | null {
  const row = db()
    .prepare('SELECT * FROM tier_cooldown WHERE series = ?')
    .get(series) as CooldownRow | undefined;
  return row ?? null;
}

export function getAllCooldowns(): Map<string, CooldownRow> {
  const rows = db().prepare('SELECT * FROM tier_cooldown').all() as CooldownRow[];
  const m = new Map<string, CooldownRow>();
  for (const r of rows) m.set(r.series, r);
  return m;
}

export function getHistory(series: string, limit = 60): TierHistoryRow[] {
  return db()
    .prepare('SELECT * FROM tier_history WHERE series = ? ORDER BY date DESC LIMIT ?')
    .all(series, limit) as TierHistoryRow[];
}

export interface SnapshotInput {
  date: string;
  series: string;
  tier: number;
  prev_tier: number | null;
  moved: 'up' | 'down' | 'hold' | null;
  r10: number | null;
  r15: number | null;
  r35: number | null;
  signal: 'r10' | 'r15' | 'r35' | null;
  trades_today: number | null;
  reason: string | null;
}

/**
 * Write one day's snapshot per series + refresh cooldown row.
 * Idempotent: same (date, series) overwrites itself via UPSERT.
 * Wrapped in a single transaction for atomicity across both tables.
 */
export function writeSnapshots(snaps: SnapshotInput[]): { written: number } {
  if (snaps.length === 0) return { written: 0 };

  const d = db();
  const insertHist = d.prepare(`
    INSERT INTO tier_history
      (date, series, tier, prev_tier, moved, r10, r15, r35, signal, trades_today, reason)
    VALUES (@date, @series, @tier, @prev_tier, @moved, @r10, @r15, @r35, @signal, @trades_today, @reason)
    ON CONFLICT(date, series) DO UPDATE SET
      tier=excluded.tier, prev_tier=excluded.prev_tier, moved=excluded.moved,
      r10=excluded.r10, r15=excluded.r15, r35=excluded.r35, signal=excluded.signal,
      trades_today=excluded.trades_today, reason=excluded.reason
  `);

  const upsertCool = d.prepare(`
    INSERT INTO tier_cooldown
      (series, current_tier, last_promote_date, last_demote_date, last_move_date, updated_at)
    VALUES (@series, @current_tier, @last_promote_date, @last_demote_date, @last_move_date, @updated_at)
    ON CONFLICT(series) DO UPDATE SET
      current_tier=excluded.current_tier,
      last_promote_date=COALESCE(excluded.last_promote_date, tier_cooldown.last_promote_date),
      last_demote_date =COALESCE(excluded.last_demote_date,  tier_cooldown.last_demote_date),
      last_move_date   =COALESCE(excluded.last_move_date,    tier_cooldown.last_move_date),
      updated_at       =excluded.updated_at
  `);

  const tx = d.transaction((rows: SnapshotInput[]) => {
    let n = 0;
    for (const r of rows) {
      insertHist.run(r);
      upsertCool.run({
        series: r.series,
        current_tier: r.tier,
        last_promote_date: r.moved === 'up' ? r.date : null,
        last_demote_date:  r.moved === 'down' ? r.date : null,
        last_move_date:    r.moved && r.moved !== 'hold' ? r.date : null,
        updated_at: new Date().toISOString(),
      });
      n++;
    }
    return n;
  });

  const written = tx(snaps);
  return { written };
}

/**
 * Days between two YYYY-MM-DD strings (b - a), or null on parse failure.
 */
export function daysBetween(a: string | null, b: string): number | null {
  if (!a) return null;
  const am = Date.parse(a + 'T00:00:00Z');
  const bm = Date.parse(b + 'T00:00:00Z');
  if (isNaN(am) || isNaN(bm)) return null;
  return Math.round((bm - am) / 86400000);
}

/**
 * Returns true if the series is within its promote cooldown window
 * (days since last promote < cooldownDays).
 */
export function inPromoteCooldown(cool: CooldownRow | null, today: string, cooldownDays = 3): boolean {
  if (!cool || !cool.last_promote_date) return false;
  const d = daysBetween(cool.last_promote_date, today);
  return d !== null && d < cooldownDays;
}

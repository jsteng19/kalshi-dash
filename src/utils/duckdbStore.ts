/**
 * DuckDB-WASM singleton + helpers for fast in-browser analytics over the
 * loaded matchedTrades. Aggregations that used to be JS for-loops over
 * 100k+ rows become millisecond SQL queries.
 *
 * Usage:
 *   await loadTradesIntoDuckDB(matchedTrades);
 *   const conn = await getDuckDBConnection();
 *   const result = await conn.query("SELECT series, SUM(net) FROM trades GROUP BY series");
 *
 * The DuckDB binary (~1.5MB gzipped) loads on-demand the first time
 * loadTradesIntoDuckDB is called, so users who never trip a heavy query
 * never pay for it.
 */

import * as duckdb from '@duckdb/duckdb-wasm';
import { MatchedTrade, parseTickerComponents } from './processData';

let _db: duckdb.AsyncDuckDB | null = null;
let _conn: duckdb.AsyncDuckDBConnection | null = null;
let _initPromise: Promise<duckdb.AsyncDuckDBConnection> | null = null;
let _loadedTradeCount = 0;

async function initDuckDB(): Promise<duckdb.AsyncDuckDBConnection> {
  if (_conn) return _conn;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    const JSDELIVR_BUNDLES = duckdb.getJsDelivrBundles();
    const bundle = await duckdb.selectBundle(JSDELIVR_BUNDLES);
    const workerUrl = URL.createObjectURL(
      new Blob([`importScripts("${bundle.mainWorker!}");`], {
        type: 'text/javascript',
      })
    );
    const worker = new Worker(workerUrl);
    const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);
    const db = new duckdb.AsyncDuckDB(logger, worker);
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    URL.revokeObjectURL(workerUrl);

    _db = db;
    _conn = await db.connect();
    return _conn;
  })();

  return _initPromise;
}

export async function getDuckDBConnection(): Promise<duckdb.AsyncDuckDBConnection> {
  return initDuckDB();
}

/**
 * Materialize matchedTrades into a `trades` table inside DuckDB.
 * Re-runnable: drops and rebuilds the table each call. The series column
 * is pre-extracted so we don't pay parseTickerComponents inside SQL.
 *
 * Returns when the table is committed and queryable.
 */
export async function loadTradesIntoDuckDB(matched: MatchedTrade[]): Promise<void> {
  const conn = await initDuckDB();

  // Build columnar arrays for fast bulk insert via JSON registration.
  // (DuckDB-WASM accepts files via registerFileText / registerFileBuffer;
  //  JSON-lines is the simplest path that handles dates cleanly.)
  const lines: string[] = new Array(matched.length);
  for (let i = 0; i < matched.length; i++) {
    const t = matched[i];
    const { series, event, market } = parseTickerComponents(t.Ticker);
    lines[i] = JSON.stringify({
      ticker: t.Ticker,
      series,
      event,
      market,
      direction: t.Entry_Direction,
      exit_type: t.Exit_Type,
      contracts: t.Contracts,
      entry_price: t.Entry_Price,
      exit_price: t.Exit_Price,
      entry_cost: t.Entry_Cost,
      realized: t.Realized_Profit,
      net: t.Net_Profit,
      total_fees: t.Total_Fees,
      entry_date: t.Entry_Date.toISOString(),
      exit_date: t.Exit_Date.toISOString(),
      holding_days: t.Holding_Period_Days,
    });
  }
  const ndjson = lines.join('\n');

  await _db!.registerFileText('trades.ndjson', ndjson);
  await conn.query(`DROP TABLE IF EXISTS trades`);
  await conn.query(
    `CREATE TABLE trades AS
     SELECT * FROM read_json('trades.ndjson',
       format='newline_delimited',
       columns={
         ticker: 'VARCHAR',
         series: 'VARCHAR',
         event: 'VARCHAR',
         market: 'VARCHAR',
         direction: 'VARCHAR',
         exit_type: 'VARCHAR',
         contracts: 'INTEGER',
         entry_price: 'INTEGER',
         exit_price: 'INTEGER',
         entry_cost: 'DOUBLE',
         realized: 'DOUBLE',
         net: 'DOUBLE',
         total_fees: 'DOUBLE',
         entry_date: 'TIMESTAMP',
         exit_date: 'TIMESTAMP',
         holding_days: 'DOUBLE'
       }
     )`
  );
  await conn.query(`CREATE INDEX IF NOT EXISTS idx_trades_series ON trades(series)`);
  await conn.query(`CREATE INDEX IF NOT EXISTS idx_trades_exit_date ON trades(exit_date)`);
  _loadedTradeCount = matched.length;
}

export function getLoadedTradeCount(): number {
  return _loadedTradeCount;
}

/**
 * Run a SQL query against the loaded `trades` table and return rows as
 * plain JS objects. Returns [] if DuckDB isn't ready yet.
 */
export async function queryTrades(sql: string): Promise<Record<string, unknown>[]> {
  if (!_conn) return [];
  const result = await _conn.query(sql);
  return result.toArray().map((row) => row.toJSON());
}

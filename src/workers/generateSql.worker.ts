// Worker: runs the heavy generateSqlBody pipeline (backtests + per-series
// stats + 3-point classifier) off the main thread. Click handler in
// SeriesStatsTable posts here, gets the SQL string back when done.

import { generateSqlBody, GenerateSqlInput } from '../utils/generateSqlBody';

self.onmessage = (e: MessageEvent<GenerateSqlInput>) => {
  try {
    const sql = generateSqlBody(e.data);
    (self as unknown as Worker).postMessage({ ok: true, sql });
  } catch (err) {
    (self as unknown as Worker).postMessage({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};

export {};

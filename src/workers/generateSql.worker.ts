// Worker: runs the heavy generateSqlBody pipeline (backtests + per-series
// stats) off the main thread. Click handler in SeriesStatsTable posts here,
// gets { sql, snapshots } back when done. Main thread persists snapshots
// to /api/tier-history/snapshot afterward.

import { generateSqlBody, GenerateSqlInput } from '../utils/generateSqlBody';

self.onmessage = (e: MessageEvent<GenerateSqlInput>) => {
  try {
    const { sql, snapshots } = generateSqlBody(e.data);
    (self as unknown as Worker).postMessage({ ok: true, sql, snapshots });
  } catch (err) {
    (self as unknown as Worker).postMessage({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};

export {};

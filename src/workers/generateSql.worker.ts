// Worker: runs the heavy generateSqlBody pipeline (per-series ladder
// evaluation + sell-strategy classification) off the main thread. Click
// handler in SeriesStatsTable posts here, gets { sql, events, newDeletions }
// back when done. Main thread persists events to /api/tier-history/event
// and newDeletions to /api/tier-history/deleted afterward.

import { generateSqlBody, GenerateSqlInput } from '../utils/generateSqlBody';

self.onmessage = (e: MessageEvent<GenerateSqlInput>) => {
  try {
    const { sql, events, newDeletions } = generateSqlBody(e.data);
    (self as unknown as Worker).postMessage({ ok: true, sql, events, newDeletions });
  } catch (err) {
    (self as unknown as Worker).postMessage({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};

export {};

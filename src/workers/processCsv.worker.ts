// Web Worker: parses CSV and runs processCSVData off the main thread.
// CSVs over ~100k rows freeze the UI when parsed inline; this worker keeps
// React responsive during upload. Settlement/metadata API fetches stay on
// the main thread (network, not CPU bound).

import Papa from 'papaparse';
import { processCSVData, ProcessedData } from '../utils/processData';

type IncomingMessage = { file: File };
type OutgoingMessage =
  | { ok: true; data: ProcessedData }
  | { ok: false; error: string };

self.onmessage = (e: MessageEvent<IncomingMessage>) => {
  const { file } = e.data;

  Papa.parse<Record<string, unknown>>(file, {
    header: true,
    complete: (results) => {
      try {
        const processed = processCSVData(results);
        const out: OutgoingMessage = { ok: true, data: processed };
        (self as unknown as Worker).postMessage(out);
      } catch (err) {
        const out: OutgoingMessage = {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
        (self as unknown as Worker).postMessage(out);
      }
    },
    error: (err) => {
      const out: OutgoingMessage = { ok: false, error: err.message };
      (self as unknown as Worker).postMessage(out);
    },
  });
};

// Required so TS treats this as a module
export {};

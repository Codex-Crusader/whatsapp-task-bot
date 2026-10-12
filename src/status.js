// One in-memory health object. Modules write to it; the dashboard reads it.
import { statSync } from 'node:fs';

const MAX_ERRORS = 20;

export const status = {
  startedAt: Date.now(),
  whatsapp: { state: 'starting', since: Date.now(), lastMessageAt: null, offlineDone: false },
  ingest: { seen: 0, stored: 0, dropped: 0, ignored: 0 },
  batch: { lastRun: null, lastAt: null, durationMs: null, result: null, nextAt: null, running: false, tasksFound: 0, mineFound: 0, lastTaskAt: null },
  ollama: { reachable: null, checkedAt: null },
  calendar: { lastWriteAt: null, ok: null },
  email: { lastSentDate: null, lastAt: null, ok: null, nextAt: null },
  errors: [],
};

// Stores only the source and the error text. Never pass message text here.
export function recordError(source, err) {
  const message = String(err?.message ?? err).slice(0, 300);
  status.errors.unshift({ at: Date.now(), source, message });
  if (status.errors.length > MAX_ERRORS) status.errors.length = MAX_ERRORS;
}

// Values that are cheap to read at request time. No database query.
export function snapshot(dbFile) {
  let dbBytes = 0;
  for (const f of [dbFile, `${dbFile}-wal`]) {
    try { dbBytes += statSync(f).size; } catch { /* file not there yet */ }
  }
  return {
    ...status,
    now: Date.now(),
    uptimeSec: Math.round(process.uptime()),
    rssBytes: process.memoryUsage.rss(),
    dbBytes,
  };
}

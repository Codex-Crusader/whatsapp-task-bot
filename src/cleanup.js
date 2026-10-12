// Daily cleanup after the email: one DELETE per table, then incremental vacuum.
import { localDay } from './store.js';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export function runCleanup({ store, config, log, now = Date.now() }) {
  const r = config.retention;
  const s = store.s;
  const removed = store.db.transaction(() => ({
    messages: s.cleanMessages.run(now - r.messageHours * HOUR).changes,
    processed: s.cleanProcessed.run(now - r.processedDays * DAY).changes,
    summaries: s.cleanSummaries.run(localDay(now - 7 * DAY)).changes,
    reports: s.cleanReports.run(now - r.reportDays * DAY).changes,
  }))();
  store.db.pragma('incremental_vacuum');
  store.db.pragma('wal_checkpoint(TRUNCATE)'); // give the WAL file space back too
  log.info('cleanup: done', removed);
  return removed;
}

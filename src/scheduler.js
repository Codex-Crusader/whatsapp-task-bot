// Startup sequence, 30-minute batches, and the daily job:
// batch (no skips) -> calendar -> report -> email -> cleanup.
// A 1-minute tick (not long timers) so the laptop's sleep cannot make us miss a job.
// Missed reports (laptop off at the email time) are sent late, up to CATCH_UP_DAYS back.
import { localDay } from './store.js';
import { recordError } from './status.js';
import { runCleanup } from './cleanup.js';

const MIN = 60 * 1000;
const DAY_MS = 24 * 60 * MIN;
const EMAIL_RETRY_MS = 10 * MIN;
const OLLAMA_RETRY_MS = 5 * MIN; // at logon Ollama can start after the bot
export const CATCH_UP_DAYS = 7; // summaries are kept 7 days, so older days cannot be built

export function createScheduler({ store, config, status, log, reader, flush, batcher, calendar, reporter, mailer, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  // Read at each use, so a change in the Settings page applies at once.
  const interval = () => config.batchIntervalMinutes * MIN;
  const emailHM = () => config.emailTime.split(':').map(Number);
  let busy = false;
  let timer = null;
  let lastEmailFail = 0;

  // Email time on the local day of ms, or on a YYYY-MM-DD day.
  const emailTimeOn = (x) => {
    const d = typeof x === 'string' ? new Date(`${x}T00:00:00`) : new Date(x);
    const [eh, em] = emailHM();
    d.setHours(eh, em, 0, 0);
    return d.getTime();
  };
  const addDays = (day, n) => localDay(new Date(`${day}T12:00:00`).getTime() + n * DAY_MS);
  const firstDay = () => store.kvGet('firstDay') || localDay(now());

  // Oldest day whose report email is due and not sent. Past days with no
  // content are skipped (nothing to report). Today is always sent.
  function pendingDay() {
    const t = now();
    const today = localDay(t);
    let day = [firstDay(), addDays(today, -CATCH_UP_DAYS)].sort().at(-1);
    for (; day <= today; day = addDays(day, 1)) {
      if (emailTimeOn(day) > t) continue;
      const r = store.s.getReport.get(day);
      if (r?.sent_at) continue;
      if (!r && day < today && !store.s.dayHasContent.get({ day })) continue; // report skipped
      return day;
    }
    return null;
  }

  const emailBlocked = () => now() - lastEmailFail < EMAIL_RETRY_MS;

  function updateNextEmail() {
    const t = now();
    const today = localDay(t);
    const sentToday = !!store.s.getReport.get(today)?.sent_at;
    status.email.nextAt = !sentToday && t < emailTimeOn(t) ? emailTimeOn(t) : emailTimeOn(t + DAY_MS);
    status.email.lastSentDate = store.kvGet('lastEmailDate');
  }

  function planNext() {
    status.batch.nextAt = now() + interval();
  }

  async function syncCalendar() {
    try {
      await calendar.sync();
    } catch (err) {
      recordError('calendar', err);
      log.error('scheduler: calendar sync failed', { err: err.message });
    }
  }

  async function batchJob() {
    let retrySoon = false;
    try {
      flush();
      await batcher.run();
    } catch (err) {
      recordError('batch', err);
      log.error('scheduler: batch failed', { err: err.message });
      retrySoon = /Ollama is not reachable|fetch failed|ECONNREFUSED/.test(err.message);
    }
    await syncCalendar();
    if (retrySoon) status.batch.nextAt = now() + OLLAMA_RETRY_MS;
    else planNext();
  }

  // Report and email for one day. Today: batch first (no skips). A past day:
  // built from what was found that day (new messages belong to today).
  async function dailyJob(day = localDay(now())) {
    const today = localDay(now());
    const late = day < today;
    let saved = store.s.getReport.get(day);
    let stats;
    if (!saved) {
      if (!late) {
        try {
          flush();
          await batcher.run({ force: true, day }); // process all waiting messages, no skips
        } catch (err) {
          recordError('batch', err);
          log.error('scheduler: report batch failed, report uses what is stored', { err: err.message });
        }
        await syncCalendar();
      }
      const to = late ? emailTimeOn(day) : now();
      const from = Math.min(Number(store.kvGet('lastReportAt')) || to - DAY_MS, to);
      const built = await reporter.build(day, from, to);
      store.kvSet('lastReportAt', Math.max(Number(store.kvGet('lastReportAt')) || 0, to));
      saved = { html: built.html };
      stats = built.stats;
    } else {
      const tasks = store.s.tasksForDay.all(day);
      stats = { tasks: tasks.length, mine: tasks.filter((x) => x.assignee === 'me').length };
    }
    try {
      await mailer.sendReport(day, saved.html, stats, { prefix: late ? '[Late] ' : '' });
      store.s.markReportSent.run(now(), day);
      if (day > (store.kvGet('lastEmailDate') || '')) store.kvSet('lastEmailDate', day);
      lastEmailFail = 0;
    } catch (err) {
      lastEmailFail = now();
      recordError('email', err);
      updateNextEmail();
      return false; // retry in 10 minutes; cleanup waits for the email
    }
    runCleanup({ store, config, log });
    updateNextEmail();
    if (!late) planNext();
    return true;
  }

  // Sends every due report, oldest first. Stops at the first failure.
  async function catchUp() {
    for (let day = pendingDay(); day && !emailBlocked(); day = pendingDay()) {
      if (!(await dailyJob(day))) break;
    }
  }

  // One job at a time.
  async function exclusive(job) {
    if (busy) return;
    busy = true;
    try {
      await job();
    } catch (err) {
      recordError('scheduler', err);
      log.error('scheduler: job failed', { err: err.message });
    } finally {
      busy = false;
    }
  }

  async function tick() {
    if (busy) return;
    if (pendingDay() && !emailBlocked()) return exclusive(catchUp);
    if (status.batch.nextAt && now() >= status.batch.nextAt) return exclusive(batchJob);
  }

  // Spec startup steps 2 to 9. Messages are already stored by ingest while we wait.
  async function start() {
    if (!store.kvGet('firstDay')) store.kvSet('firstDay', localDay(now()));
    updateNextEmail();
    status.batch.nextAt = null;
    await sleep(60 * 1000);
    let ok = reader.isOfflineDone();
    for (let i = 0; i < 10 && !ok; i++) {
      log.warn('scheduler: offline messages not complete, check again in 30 s', { attempt: i + 1 });
      await sleep(30 * 1000);
      ok = reader.isOfflineDone();
    }
    if (ok) {
      await exclusive(batchJob); // first batch at once
    } else {
      log.error('scheduler: offline messages never completed, first batch skipped (lastRun unchanged)');
      recordError('scheduler', 'offline messages never completed; first batch skipped');
      planNext();
    }
    await exclusive(catchUp); // missed or due reports, oldest first
    timer = setInterval(tick, MIN);
  }

  return { start, stop: () => clearInterval(timer), tick, dailyJob, batchJob, pendingDay, catchUp, emailTimeOn, refresh: updateNextEmail };
}

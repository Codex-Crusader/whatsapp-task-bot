// Entry point. One process: dashboard (with setup wizard), reader, ingest, and
// the scheduler (batcher, calendar, report, mail). With no setup yet, only the
// dashboard runs; the rest starts when WhatsApp is linked and a name is set.
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { config, env, DB_FILE, ROOT, INSTALLED } from './config.js';
import { openStore, localDay } from './store.js';
import { status, recordError } from './status.js';
import { log } from './log.js';
import { createReader } from './reader.js';
import { createIngest } from './ingest.js';
import { createExtractor } from './extractor.js';
import { createBatcher } from './batcher.js';
import { createCalendar } from './calendar.js';
import { createReporter } from './report.js';
import { createMailer } from './mailer.js';
import { createScheduler } from './scheduler.js';
import { createDashboard } from './dashboard.js';
import { createSetup } from './setup.js';
import { loadOrCreateToken, loginUrl, writeShortcut } from './access.js';

const background = process.argv.includes('--background'); // no console: Task Scheduler or the app launcher
const launched = process.argv.includes('--from-launcher'); // started by the launcher, not by Task Scheduler
const store = openStore(DB_FILE);
const token = loadOrCreateToken();

let reader = null;
let mailer = null;
const ingest = createIngest({ store, status, log, meIds: () => reader.meIds(), isIgnored: (id) => reader.isIgnored(id) });
reader = createReader({
  store, config, status, log, onUpsert: ingest.onUpsert, onUpdate: ingest.onUpdate, onDelete: ingest.onDelete,
  onStopped: (code, reason) => alertOnce(`whatsapp-${reason}`, 'WhatsApp disconnected the bot',
    `The WhatsApp connection closed with "${reason}" (code ${code}). The bot does not read messages until you fix this.\n\n${
      reason === 'loggedOut'
        ? 'Your phone removed the linked device. Open the dashboard, go to "Setup", and link WhatsApp again. Your tasks stay.'
        : 'Another WhatsApp Web session or a second copy of the bot took over. Restart the bot.'}`),
});

// One alert email per kind per day, also across restarts.
function alertOnce(kind, subject, text) {
  const key = `alert:${kind}`;
  const today = localDay();
  if (store.kvGet(key) === today || !mailer?.configured) return;
  store.kvSet(key, today);
  mailer.sendAlert(subject, text).catch((err) => log.error('main: alert email failed', { err: err.message }));
}

const lastRun = store.kvGet('lastRun');
status.batch.lastRun = lastRun ? Number(lastRun) : null;
status.whatsapp.lastMessageAt = store.s.lastMessageTs.get().ts ?? null;
// Restore the values that the dashboard shows, so a restart does not reset them.
const totals = store.s.taskTotals.get();
Object.assign(status.batch, { tasksFound: totals.total, mineFound: totals.mine, lastTaskAt: totals.lastAt });
const lastCal = Number(store.kvGet('lastCalendarWriteAt')) || null;
if (lastCal) Object.assign(status.calendar, { lastWriteAt: lastCal, ok: true });
status.email.lastSentDate = store.kvGet('lastEmailDate');

// Functions that call the current reader, never a copy of its methods.
const nameOf = (jid) => reader.nameOf(jid);
const meIds = () => reader.meIds();
const extractor = createExtractor({ config, status });
const batcher = createBatcher({ store, config, extractor, nameOf, meIds, status, log });
const calendar = createCalendar({ store, config, env, status, log });
const reporter = createReporter({ store, config, extractor, nameOf, log });
mailer = createMailer({ env, status, log });
const scheduler = createScheduler({ store, config, status, log, reader, flush: ingest.flush, batcher, calendar, reporter, mailer });

// The scheduler needs a linked WhatsApp and a name. It starts once both are there.
let schedulerStarted = false;
function maybeStartScheduler() {
  if (schedulerStarted || !reader.isLinked() || !config.myName) return;
  schedulerStarted = true;
  log.info('main: scheduler starts');
  scheduler.start().catch((err) => { recordError('scheduler', err); log.error('main: scheduler start failed', { err: err.message }); });
}

// Setup button "Start with Windows". The only child process besides Ollama:
// a fixed script with no input from the page, and only on Windows.
const runAutostartScript = process.platform !== 'win32' ? null : () => new Promise((resolve, reject) => {
  execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(ROOT, 'scripts', 'install-autostart.ps1'), '-Node', process.execPath],
    { windowsHide: true, timeout: 60_000 }, (err) => (err ? reject(err) : resolve()));
});

// Setup button "Install Ollama": winget with a fixed package ID, then start Ollama.
const runOllamaInstall = process.platform !== 'win32' ? null : () => new Promise((resolve, reject) => {
  execFile('winget.exe', ['install', '--id', 'Ollama.Ollama', '-e', '--silent', '--accept-source-agreements', '--accept-package-agreements'],
    { windowsHide: true, timeout: 20 * 60_000 }, (err) => {
      // winget gives a non-zero code when the newest version is already installed.
      const app = join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama app.exe');
      if (existsSync(app)) { spawn(app, [], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); return resolve(); }
      reject(err || new Error('Ollama is not in the expected folder'));
    });
});

const setup = createSetup({
  store, status, log, reader, calendar, mailer, port: config.dashboardPort, token,
  onProfileSaved: () => { maybeStartScheduler(); scheduler.refresh(); }, onLinked: maybeStartScheduler,
  runAutostartScript, runOllamaInstall, isBackground: background, launched, requestExit: () => setTimeout(() => shutdown('handover to Task Scheduler'), 3000),
});
const dashboard = createDashboard({ store, config, status, log, dbFile: DB_FILE, pingOllama: extractor.ping, calendar, token, setup });

log.info('main: start', { pid: process.pid, node: process.version, background });
// The dashboard port is also the single-instance lock: a second copy stops here.
try {
  await dashboard.start();
} catch (err) {
  const msg = err.code === 'EADDRINUSE' ? `port ${config.dashboardPort} in use: another copy of the bot is running` : err.message;
  log.error('main: cannot start', { err: msg });
  console.error(`Cannot start: ${msg}`);
  store.close();
  process.exit(1);
}

// The desktop shortcut holds the access link. Never write the token to the log.
// An installed copy has its own Start menu and desktop icons (from the installer).
if (!INSTALLED && !process.argv.includes('--no-shortcut')) {
  try { writeShortcut(config.dashboardPort, token); } catch (err) { log.warn('main: no desktop shortcut', { err: err.message }); }
}
if (!background) {
  console.log(`\nWhatsApp Task Bot is running. Open the dashboard:\n\n  ${loginUrl(config.dashboardPort, token)}\n\n(The desktop shortcut "WhatsApp Task Bot" opens the same page. Press Ctrl+C to stop.)\n`);
}

if (reader.isLinked()) reader.start();
else {
  status.whatsapp.state = 'not linked';
  log.info('main: WhatsApp is not linked; waiting for the setup page');
}
maybeStartScheduler();

// Health line: RAM, connection, ingest counters (counts only, no text).
const HEALTH_MS = Number(process.env.HEALTH_MINUTES || 60) * 60 * 1000;
setInterval(() => {
  log.info('main: health', { rssMB: Math.round(process.memoryUsage.rss() / 1048576), wa: status.whatsapp.state, ...status.ingest });
}, HEALTH_MS).unref();

process.on('uncaughtException', (err) => { log.error('main: uncaught', { err: err.stack?.slice(0, 500) }); recordError('main', err); });
process.on('unhandledRejection', (err) => { log.error('main: unhandled rejection', { err: String(err?.stack ?? err).slice(0, 500) }); recordError('main', err); });

function shutdown(sig) {
  log.info('main: stop', { sig });
  scheduler.stop();
  dashboard.stop();
  try { ingest.flush(); } catch { /* logged in flush */ }
  reader.stop();
  store.close();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
// Windows: console close (SIGHUP) and Ctrl+Break (SIGBREAK), sent at logoff and shutdown.
process.on('SIGHUP', () => shutdown('SIGHUP'));
process.on('SIGBREAK', () => shutdown('SIGBREAK'));

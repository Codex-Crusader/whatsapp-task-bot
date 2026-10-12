// Demo: the dashboard with made-up data, in a temporary folder.
// No WhatsApp, no Google, no email. Nothing touches your real data.
// Run: npm run demo            (setup complete)
//      npm run demo -- --setup (setup in progress, at the WhatsApp step)
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { openStore, localDay } from '../src/store.js';
import { status } from '../src/status.js';
import { createLogger } from '../src/log.js';
import { createReporter } from '../src/report.js';
import { createDashboard } from '../src/dashboard.js';
import { createSetup } from '../src/setup.js';
import { loginUrl } from '../src/access.js';

const settingUp = process.argv.includes('--setup');
const port = Number(process.argv[process.argv.indexOf('--port') + 1]) || 4795;
const dir = mkdtempSync(join(tmpdir(), 'wtb-demo-'));
const paths = { config: join(dir, 'config.json'), env: join(dir, '.env'), key: join(dir, 'key.json') };
const config = Object.assign(loadConfig(paths.config), { myName: 'Alex Morgan', aliases: ['Alex'], dashboardPort: port });
const store = openStore(join(dir, 'demo.db'));
const log = createLogger({ dir, echo: false });
const token = randomBytes(32).toString('hex');

const H = 3600 * 1000;
const D = 24 * H;
const now = Date.now();
const day = (n) => localDay(now + n * D);
const at = (n, hh, mm = 0) => { const d = new Date(now + n * D); d.setHours(hh, mm, 0, 0); return d; };
const iso = (d, time = true) => `${localDay(d.getTime())}${time ? `T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : ''}`;

// ---- made-up tasks ----
const chats = { team: ['team@g.us', 'Product Team'], club: ['club@g.us', 'Design Club'], hostel: ['hostel@g.us', 'Hostel Block C'], maya: ['maya@s.whatsapp.net', 'Maya Chen'], family: ['family@g.us', 'Family'] };
let n = 0;
const task = (chat, title, assignee, due, kind, extra = {}) => {
  const [chat_id, chat_name] = chats[chat];
  store.s.insertTask.run({ message_id: `demo-${++n}`, chat_id, chat_name, sender_name: chat_name, title, assignee, due, due_kind: kind, confidence: extra.confidence ?? 0.92, flagged: extra.flagged ?? 0, day: extra.day ?? day(0), created_at: now - (20 - n) * H });
  if (extra.event) store.s.setEventId.run(`event${n}`, `demo-${n}`);
  if (extra.status) store.s.setTaskStatus.run({ id: n, status: extra.status, now });
  store.s.clearDirty.run(n);
};
task('team', 'Send the Q3 slides to Priya', 'me', iso(at(0, 17, 30)), 'datetime', { event: 1 });
task('maya', 'Return the camera lens', 'me', iso(at(1, 0), false), 'date', { event: 1 });
task('club', 'Submit the poster draft', 'everyone', iso(at(2, 12)), 'datetime', { event: 1 });
task('team', 'Review the onboarding checklist', 'me', iso(at(-1, 0), false), 'date', { event: 1, day: day(-1) });
task('hostel', 'Pay the mess fee', 'everyone', iso(at(4, 0), false), 'date', { event: 1 });
task('family', 'Book train tickets for Diwali', 'me', null, null);
task('team', 'Update the API docs', 'Leo', iso(at(3, 0), false), 'date');
task('club', 'Bring the projector', 'unclear', iso(at(1, 0), false), 'date', { flagged: 1, confidence: 0.55, event: 1 });
task('maya', 'Call the landlord ?', 'me', iso(at(2, 0), false), 'date', { event: 1, confidence: 0.7 });
task('hostel', 'Clean the common room', 'Sam', null, null, { day: day(-1) });
task('team', 'Share the meeting notes', 'me', iso(at(-1, 18)), 'datetime', { event: 1, status: 'done', day: day(-1) });
task('club', 'Order the club T-shirts', 'everyone', iso(at(-2, 0), false), 'date', { status: 'done', day: day(-2) });

// ---- made-up reports: sent, sent late, skipped ----
const reporter = createReporter({ store, config, extractor: {}, nameOf: (j) => Object.values(chats).find(([id]) => id === j)?.[1] ?? j, log });
const sample = (d, extra) => reporter.render({
  day: d,
  stats: { messages: 184 + extra, conversations: 9, tasks: 4, mine: 2 },
  chats: [{ name: 'Product Team', lines: ['Priya asked for the Q3 slides before the review.', 'The launch moved to next Tuesday.'] }, { name: 'Design Club', lines: ['Poster drafts are due on Friday at noon.'] }],
  tasks: store.s.tasksForDay.all(day(0)).slice(0, 4),
  check: [],
});
const email = (n2) => at(n2, 21).getTime();
store.kvSet('firstDay', day(-5));
for (const [n2, sentAt] of [[-1, email(-1) + 60000], [-2, email(-2) + 9.5 * H], [-4, email(-4) + 60000], [-5, email(-5) + 60000]]) {
  store.s.saveReport.run(day(n2), sample(day(n2), n2 * -7), sentAt);
  store.s.markReportSent.run(sentAt, day(n2));
}

// ---- made-up health values ----
const t0 = now - 5.5 * H;
process.uptime = () => (Date.now() - t0) / 1000; // the demo looks like a bot that runs for hours
Object.assign(status.whatsapp, { state: settingUp ? 'not linked' : 'open', since: t0, lastMessageAt: now - 4 * 60000, offlineDone: true });
Object.assign(status.ingest, { seen: 251, stored: 214, dropped: 37 });
Object.assign(status.batch, { lastRun: now - 6 * 60000, lastAt: now - 6 * 60000, durationMs: 4300, result: 'ok: 3 chats, 3 calls, 2 tasks', nextAt: now + 4 * 60000, tasksFound: 12, mineFound: 7, lastTaskAt: now - 6 * 60000 });
Object.assign(status.ollama, { reachable: true, checkedAt: now });
Object.assign(status.calendar, { lastWriteAt: now - 22 * 60000, ok: true });
Object.assign(status.email, { lastSentDate: day(-1), ok: true, nextAt: email(now < email(0) ? 0 : 1) });
for (const [lvl, msg] of [['info', 'main: start pid=4120 node=v24.13.0 background=true'], ['info', 'dashboard: listening url=http://localhost:4780/'], ['info', 'reader: connected'], ['info', 'batcher: done ok=true messages=38 chats=3 waiting=2 calls=3 tasks=2 mine=1 ms=4300'], ['info', 'calendar: sync pending=2 created=2 edited=0 updated=0 failed=0'], ['warn', 'reader: connection closed, reconnect code=428 delayMs=2000'], ['info', 'reader: connected'], ['info', 'main: health rssMB=84 wa=open seen=251 stored=214 dropped=37 ignored=0']]) log[lvl](msg);

// ---- setup page: complete, or in progress at the WhatsApp step ----
const env = settingUp ? {} : { calendarId: 'whatsapp-tasks@group.calendar.google.com', gmailUser: 'alex.morgan@example.com', gmailAppPassword: 'x', googleKeyFile: '' };
if (!settingUp) { store.kvSet('setupCalendarOk', '1'); store.kvSet('setupEmailOk', '1'); store.kvSet('autostart', '1'); }
if (settingUp) Object.assign(config, { myName: 'Alex Morgan' });
const reader = {
  isLinked: () => !settingUp,
  isPairing: () => settingUp,
  link: () => {},
};
if (settingUp) status.whatsapp.pairingCode = 'K7QW-2M9P';
const setup = createSetup({
  store, config, env, status, log, reader, port, token, paths, shortcutDir: dir, isBackground: !settingUp,
  calendar: { reset() {}, testWrite: async () => {}, sync: async () => {} },
  mailer: { sendTest: async () => {} },
  runAutostartScript: async () => {},
  fetchFn: async () => ({ ok: true, json: async () => ({ models: [{ name: config.ollama.model }] }) }),
});

const dashboard = createDashboard({ store, config, status, log, dbFile: join(dir, 'demo.db'), token, setup, calendar: null });
await dashboard.start();
console.log(`\nDemo dashboard with made-up data${settingUp ? ' (setup in progress)' : ''}:\n\n  ${loginUrl(port, token)}\n\nPress Ctrl+C to stop. The demo data is in ${dir} and is not used by the real bot.\n`);

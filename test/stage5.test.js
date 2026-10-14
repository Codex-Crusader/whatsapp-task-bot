import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { openStore, localDay } from '../src/store.js';
import { createReporter, taskStatus } from '../src/report.js';
import { runCleanup } from '../src/cleanup.js';
import { createScheduler } from '../src/scheduler.js';

const config = loadConfig();
const log = { info() {}, warn() {}, error() {} };
const newStore = () => openStore(join(mkdtempSync(join(tmpdir(), 'wabot-')), 'r.db'));
const H = 3600 * 1000;
const NOW = new Date(2026, 9, 12, 21, 5).getTime();
const DAY = '2026-10-12';

let k = 0;
const task = (o = {}) => ({ message_id: `T${++k}`, chat_id: 'g1@g.us', chat_name: 'CSE <3rd>', sender_name: 'Asha', title: 'Pay fees', assignee: 'me', due: '2026-10-20', due_kind: 'date', confidence: 0.9, flagged: 0, day: DAY, created_at: 1, ...o });
const msg = (id, chat, text, ts = NOW - H) => ({ id, chat_id: chat, sender_id: 's', ts, text, quoted_sender_id: null, mentions_me: 0, is_dm: 0, mentioned: null });

function seed(store) {
  store.s.insertTask.run(task({ title: 'Ravi task', assignee: 'Ravi', chat_id: 'g2@g.us' }));
  store.s.insertTask.run(task({ title: 'Everyone task', assignee: 'everyone' }));
  store.s.insertTask.run(task({ title: 'My <b>task</b>', assignee: 'me' }));
  store.s.setEventId.run('ev1', `T${k}`);
  store.s.insertTask.run(task({ title: 'Unclear task', assignee: 'unclear', flagged: 1, due: null, due_kind: null }));
  store.insertMessages([msg('m1', 'g1@g.us', 'Everyone pay the fees by 20/10 please'), msg('m2', 'g3@g.us', 'ok'), msg('m3', 'g3@g.us', 'thanks'), msg('m4', 'g4@g.us', 'long discussion about the trip plan')]);
  for (const id of ['m1', 'm2', 'm3', 'm4']) store.s.markProcessed.run(id, NOW - H);
  store.s.addSummary.run('g1@g.us', DAY, 'Fees are due on 20 Oct.', 1);
  store.s.addSummary.run('g3@g.us', DAY, 'People said ok.', 1);
  for (let i = 0; i < 7; i++) store.s.addSummary.run('g4@g.us', DAY, `Trip line ${i}`, 1);
}

test('report: content, order, statuses, escaping, short chats, merge call', async () => {
  const store = newStore();
  seed(store);
  const merges = [];
  const extractor = { summarize: async (lines, keepAlive) => { merges.push({ n: lines.length, keepAlive }); return ['Trip planned for Sunday.']; } };
  const names = { 'g1@g.us': 'CSE <3rd>', 'g3@g.us': 'Hostel', 'g4@g.us': 'Trip' };
  const r = createReporter({ store, config, extractor, nameOf: (j) => names[j], log });
  const { html, stats } = await r.build(DAY, NOW - 24 * H, NOW);

  assert.deepEqual(stats, { messages: 4, conversations: 3, tasks: 4, mine: 1 });
  assert.deepEqual(merges, [{ n: 7, keepAlive: 0 }], 'one merge call for the chat with 7 lines, model unloads');
  assert.match(html, /Trip planned for Sunday\./);
  assert.doesNotMatch(html, /Hostel/, 'chat with only short replies is left out');
  assert.match(html, /CSE &lt;3rd&gt;/, 'HTML escaped');
  assert.match(html, /My &lt;b&gt;task&lt;\/b&gt;/);
  const order = ['My &lt;b&gt;task', 'Everyone task', 'Unclear task', 'Ravi task'].map((s) => html.indexOf(s));
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'my rows first');
  assert.match(html, /font-weight:700;">My &lt;b&gt;task/, 'my rows bold');
  assert.match(html, /In calendar/);
  assert.match(html, /No date/);
  assert.match(html, /Not yours/);
  const check = html.slice(html.indexOf('Needs review ('));
  assert.match(check, /Unclear task/);
  assert.match(check, /Unclear who must do it/, 'the reason is shown');
  assert.doesNotMatch(check, /Ravi task/);

  assert.ok(store.s.getReport.get(DAY).html === html, 'saved once in SQLite');
  assert.equal(store.s.summariesForDay.all(DAY).length, 0, 'summaries removed when the report is saved');
  assert.equal(taskStatus({ assignee: 'me', due: '2026-10-20', event_id: null }), 'Pending');
});

test('cleanup: retention per table, then vacuum', () => {
  const store = newStore();
  store.insertMessages([msg('old', 'c', 'x', NOW - 49 * H), msg('new', 'c', 'y', NOW - 47 * H)]);
  store.s.markProcessed.run('p-old', NOW - 8 * 24 * H);
  store.s.markProcessed.run('p-new', NOW - 6 * 24 * H);
  store.s.saveReport.run('2026-09-01', '<p>old</p>', NOW - 31 * 24 * H);
  store.s.saveReport.run(DAY, '<p>new</p>', NOW);
  store.s.addSummary.run('c', DAY, 'reported day', 1);
  store.s.addSummary.run('c', '2026-10-13', 'not reported yet', 1);
  store.s.addSummary.run('c', '2026-09-01', 'laptop was off at email time', 1);
  store.s.insertTask.run(task({ day: '2025-01-01' }));
  const removed = runCleanup({ store, config, log, now: NOW });
  assert.deepEqual(removed, { messages: 1, processed: 1, summaries: 2, reports: 1 });
  assert.equal(store.db.prepare('SELECT COUNT(*) FROM tasks').pluck().get(), 1, 'tasks are permanent');
});

function schedSetup({ sendFails = false, offline = true, sentToday = false, at = NOW, firstDay = DAY } = {}) {
  const store = newStore();
  store.kvSet('firstDay', firstDay);
  if (sentToday) { store.s.saveReport.run(localDay(at), '<p>r</p>', at); store.s.markReportSent.run(at, localDay(at)); }
  const status = { batch: {}, email: {}, whatsapp: {} };
  const order = [];
  let clock = at;
  const sched = createScheduler({
    store, config, status, log,
    now: () => clock,
    sleep: async (ms) => { clock += ms; order.push(`sleep${ms / 1000}`); },
    reader: { isOfflineDone: () => offline },
    flush: () => order.push('flush'),
    batcher: { run: async (o = {}) => { order.push(o.force ? `batch(force,${o.day})` : 'batch'); return { ok: true }; } },
    calendar: { sync: async () => { order.push('calendar'); } },
    reporter: { build: async (day) => { order.push(`report(${day})`); store.s.saveReport.run(day, '<p>r</p>', clock); return { html: '<p>r</p>', stats: { tasks: 1, mine: 1 } }; } },
    mailer: { sendReport: async (day, html, stats, o = {}) => { order.push(`email(${o.prefix || ''}${day})`); if (sendFails) throw new Error('smtp down'); } },
  });
  return { store, status, order, sched, advance: (ms) => { clock += ms; } };
}

test('scheduler: startup waits 60 s, first batch at once, then the due daily email', async () => {
  const { order, sched, store } = schedSetup();
  await sched.start();
  sched.stop();
  assert.deepEqual(order, ['sleep60', 'flush', 'batch', 'calendar', 'flush', `batch(force,${DAY})`, 'calendar', `report(${DAY})`, `email(${DAY})`]);
  assert.ok(store.s.getReport.get(DAY).sent_at, 'sent_at saved per day');
  assert.equal(store.kvGet('lastEmailDate'), DAY);
});

test('scheduler: offline never completes -> 10 checks, first batch skipped', async () => {
  const { order, sched, status } = schedSetup({ offline: false, sentToday: true });
  await sched.start();
  sched.stop();
  assert.equal(order.filter((x) => x === 'sleep30').length, 10);
  assert.ok(!order.includes('batch'));
  assert.ok(status.batch.nextAt > NOW, 'next regular batch is planned');
});

test('scheduler: failed email -> no cleanup, retry after 10 minutes without a new report', async () => {
  const s = schedSetup({ sendFails: true });
  assert.equal(await s.sched.dailyJob(DAY), false);
  assert.equal(s.store.s.getReport.get(DAY).sent_at, null);
  s.order.length = 0;
  await s.sched.tick();
  assert.deepEqual(s.order, [], 'not again at once');
  s.advance(10 * 60 * 1000);
  await s.sched.tick();
  assert.deepEqual(s.order, [`email(${DAY})`], 'saved report reused, no second batch or report');
});

test('scheduler: regular batches every interval on the tick', async () => {
  const s = schedSetup({ sentToday: true });
  s.status.batch.nextAt = NOW + 1000;
  await s.sched.tick();
  assert.deepEqual(s.order, []);
  s.advance(1000);
  await s.sched.tick();
  assert.deepEqual(s.order, ['flush', 'batch', 'calendar']);
});

test('scheduler: Ollama not reachable -> next batch in 5 minutes, not 30', async () => {
  const s = schedSetup({ sentToday: true });
  const sched = createScheduler({
    store: s.store, config, status: s.status, log, now: () => NOW, sleep: async () => {},
    reader: { isOfflineDone: () => true }, flush() {}, calendar: { sync: async () => {} },
    batcher: { run: async () => { throw new Error('Ollama is not reachable'); } },
    reporter: {}, mailer: {},
  });
  await sched.batchJob();
  assert.equal(s.status.batch.nextAt, NOW + 5 * 60 * 1000);
});

test('scheduler: when Ollama answers again, the batch runs at the next tick, not after 5 minutes', async () => {
  const s = schedSetup({ sentToday: true });
  let up = false;
  let runs = 0;
  const sched = createScheduler({
    store: s.store, config, status: s.status, log, now: () => NOW, sleep: async () => {},
    reader: { isOfflineDone: () => true }, flush() {}, calendar: { sync: async () => {} },
    batcher: { run: async () => { runs++; if (!up) throw new Error('Ollama is not reachable'); return { ok: true }; } },
    reporter: {}, mailer: {}, pingOllama: async () => up,
  });
  await sched.batchJob();
  assert.equal(runs, 1);
  await sched.tick();
  assert.equal(runs, 1, 'Ollama still down: wait');
  up = true;
  await sched.tick();
  assert.equal(runs, 2, 'Ollama back: batch at once');
  assert.ok(s.status.batch.nextAt > NOW + 5 * 60 * 1000, 'then the normal interval');
  await sched.tick();
  assert.equal(runs, 2, 'no extra batch after the retry');
});

test('scheduler: laptop off at report time -> late report when it is on again; empty day skipped', async () => {
  const morning = new Date(2026, 9, 12, 8, 0).getTime(); // 12 Oct 08:00, before today's email time
  const s = schedSetup({ at: morning, firstDay: '2026-10-10' });
  s.store.s.insertTask.run(task({ day: '2026-10-10' })); // something was found on the 10th
  // the 11th: laptop off all day, nothing found
  assert.equal(s.sched.pendingDay(), '2026-10-10');
  await s.sched.tick();
  assert.deepEqual(s.order, ['report(2026-10-10)', 'email([Late] 2026-10-10)'], 'no batch for a past day; the 11th is skipped');
  assert.ok(s.store.s.getReport.get('2026-10-10').sent_at);
  assert.equal(s.store.s.getReport.get('2026-10-11'), undefined);
  assert.equal(s.sched.pendingDay(), null, 'today is not due before the email time');
  s.advance(13 * 60 * 60 * 1000 + 5 * 60 * 1000); // 21:05
  assert.equal(s.sched.pendingDay(), '2026-10-12', 'today is always sent, even with no content');
});

test('scheduler: catch-up ignores days before the first day and older than 7 days', async () => {
  const s = schedSetup({ firstDay: '2026-10-11', sentToday: true });
  s.store.s.insertTask.run(task({ day: '2026-10-10' })); // before the first day
  s.store.s.insertTask.run(task({ day: '2026-10-01' }));
  assert.equal(s.sched.pendingDay(), null);
  const t = schedSetup({ firstDay: '2026-09-01', sentToday: true });
  t.store.s.insertTask.run(task({ day: '2026-10-01' })); // 11 days ago
  t.store.s.insertTask.run(task({ day: '2026-10-06' })); // 6 days ago
  assert.equal(t.sched.pendingDay(), '2026-10-06');
});

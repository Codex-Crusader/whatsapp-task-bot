import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { compileMatcher, classify } from '../src/filter.js';
import { createBatcher } from '../src/batcher.js';
import { parseOutput, systemPrompt, TAGS } from '../src/extractor.js';
import { openStore, reportDay } from '../src/store.js';

const config = { ...loadConfig(), myName: 'Alexander Morgan', aliases: ['Alexander', 'Alex'] };
const ME = '919000000001@s.whatsapp.net';
const GROUP = '120363000000000001@g.us';
const DM = '919000000002@s.whatsapp.net';
const names = { [GROUP]: 'Class 12B', [DM]: 'Ravi', '919000000003@s.whatsapp.net': 'Asha' };
const nameOf = (j) => names[j] || j;
const re = compileMatcher(config);
const ctx = { re, nameOf, selfChatIds: new Set([ME]) };

let n = 0;
const T0 = new Date(2026, 9, 12, 10, 0).getTime(); // Mon 12 Oct 2026, 10:00 local
const row = (o = {}) => ({ id: `R${++n}`, chat_id: GROUP, sender_id: '919000000003@s.whatsapp.net', ts: T0 + n * 60000, text: 'hello', quoted_sender_id: null, mentions_me: 0, is_dm: 0, mentioned: null, ...o });

test('filter: signals follow the table order', () => {
  const sig = (o) => classify(row(o), ctx).signal;
  assert.equal(sig({ mentions_me: 1 }), 'me');
  assert.equal(sig({ quoted_sender_id: 'me' }), 'me');
  assert.equal(sig({ chat_id: DM, is_dm: 1 }), 'me');
  assert.equal(sig({ mentioned: '919000000002@s.whatsapp.net' }), 'other:Ravi');
  assert.equal(sig({ text: 'Everyone bring the record' }), 'everyone');
  assert.equal(sig({ text: 'Alex, check this' }), 'candidate');
  assert.equal(sig({ text: "ask Alexander's sister" }), 'candidate');
  assert.equal(sig({ text: 'submit by friday' }), 'candidate');
  assert.equal(sig({ text: 'Can you send notes' }), 'candidate');
  assert.equal(sig({ text: 'nice baby photo' }), 'none', '"by" inside a word');
  assert.equal(sig({ text: 'the ball is lost' }), 'none', '"all" inside a word');
  assert.equal(sig({ text: 'ok' }), 'none');
  assert.equal(sig({ sender_id: 'me', text: 'please do it' }), 'none', 'my messages in other chats');
  assert.equal(sig({ sender_id: 'me', chat_id: ME, is_dm: 1, text: 'pay rent' }), 'me', 'my self-chat notes');
});

test('extractor: output parsing keeps valid tasks only', () => {
  const out = parseOutput(JSON.stringify({
    summary_update: '- Teacher set the exam date\n- Ravi asked for notes\n\nextra\nmore',
    tasks: [
      { message_id: '3*', title: ' Bring record ', assignee: 'me', due_text: 'tomorrow', due_guess: null, confidence: 1.4 },
      { message_id: '4', title: '', assignee: 'me', due_text: null, due_guess: null, confidence: 0.5 },
    ],
  }));
  assert.deepEqual(out.summary, ['Teacher set the exam date', 'Ravi asked for notes', 'extra']);
  assert.deepEqual(parseOutput('{"summary_update":"Sir set the date. Ravi asked for notes on 2.5 marks. Asha left! Extra.","tasks":[]}').summary,
    ['Sir set the date.', 'Ravi asked for notes on 2.5 marks.', 'Asha left!']);
  assert.equal(out.tasks.length, 1);
  assert.equal(out.tasks[0].message_id, '3');
  assert.equal(out.tasks[0].title, 'Bring record');
  assert.equal(out.tasks[0].confidence, 1);
  assert.throws(() => parseOutput('{"summary_update": "x"'));
  assert.throws(() => parseOutput('{"summary_update": "SECRETWORD meeting", "tasks": [ {'), (err) => err.message === 'model output is not valid JSON' && !/SECRETWORD/.test(err.message));
  const nul = parseOutput('{"summary_update":"","tasks":[{"message_id":"1","title":"x","assignee":"me","due_text":"null","due_guess":"None","confidence":1}]}');
  assert.equal(nul.tasks[0].due_text, null);
  assert.equal(nul.tasks[0].due_guess, null);
  assert.match(systemPrompt(config), /Alexander Morgan/);
});

test('report day: after the email time, work counts for tomorrow', () => {
  assert.equal(reportDay(new Date(2026, 9, 12, 20, 59).getTime(), '21:00'), '2026-10-12');
  assert.equal(reportDay(new Date(2026, 9, 12, 21, 0).getTime(), '21:00'), '2026-10-13');
});

function setup({ budget = 6000, reply = () => ({ summary: ['something happened'], tasks: [] }) } = {}) {
  const store = openStore(join(mkdtempSync(join(tmpdir(), 'wabot-')), 'b.db'));
  const status = { batch: { lastRun: null, running: false }, ollama: {} };
  const calls = [];
  const extractor = {
    budget,
    ping: async () => true,
    unload: async () => {},
    extract: async (user, keepAlive) => {
      calls.push({ user, keepAlive });
      const r = reply(user, calls.length);
      if (r instanceof Error) throw r;
      return { truncated: false, ...r };
    },
  };
  const log = { info() {}, warn() {}, error() {} };
  const added = [];
  const batcher = createBatcher({
    store, config, extractor, nameOf, status, log,
    meIds: () => new Set([ME, '111@lid']),
    onTask: async (t) => added.push(t),
    now: () => T0 + 3 * 60 * 60 * 1000,
  });
  return { store, status, calls, batcher, added };
}

test('batcher: empty batch makes no Ollama call', async () => {
  const { batcher, calls, status } = setup();
  const r = await batcher.run();
  assert.equal(calls.length, 0);
  assert.equal(r.ok, true);
  assert.ok(status.batch.lastRun, 'lastRun moves after a complete batch');
});

test('batcher: quiet chat waits at most 2 batches, then runs; force skips the wait', async () => {
  const { store, batcher, calls } = setup();
  store.insertMessages([row({ text: 'lol' }), row({ text: 'ok' })]);
  await batcher.run();
  await batcher.run();
  assert.equal(calls.length, 0, 'skipped twice');
  await batcher.run();
  assert.equal(calls.length, 1, 'third batch runs');
  assert.equal(store.s.getSkips.get(GROUP).skips, 0);

  const s2 = setup();
  s2.store.insertMessages([row({ text: 'lol' })]);
  await s2.batcher.run({ force: true });
  assert.equal(s2.calls.length, 1, 'force: no skip before the report');
});

test('batcher: 85 messages -> 3 parts of max 40, context, marks, keep_alive', async () => {
  const { store, batcher, calls } = setup();
  const old = [row({ text: 'old context 1', ts: T0 - 7200000 }), row({ text: 'old context 2', ts: T0 - 3600000 })];
  store.insertMessages(old);
  for (const r of old) store.s.markProcessed.run(r.id, 1);
  const rows = Array.from({ length: 85 }, (_, i) => row({ text: i === 0 ? 'Everyone submit by Friday' : `msg ${i}` }));
  store.insertMessages(rows);
  const res = await batcher.run();
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((c) => c.keepAlive), ['5m', '5m', 0], 'model unloads after the last call');
  const first = calls[0].user;
  assert.match(first, /Chat: Class 12B \(group\)/);
  assert.match(first, /Earlier messages:\n--- 2026-10-12 Mon ---\n\d\d:\d\d Asha: old context 1/);
  assert.match(first, /\[1\*\] \d\d:\d\d Asha: Everyone submit by Friday/);
  assert.match(first, /\[2\] \d\d:\d\d Asha: msg 1\n/);
  assert.match(first, /\[40\] /);
  assert.doesNotMatch(first, /\[41\]/);
  assert.match(calls[1].user, /Earlier messages:\n--- [^\n]+(\n\d\d:\d\d Asha: msg 3\d){5}\n\nNew messages/, 'part 2 gets 5 context lines');
  assert.equal(res.chats, 1);
  assert.equal(store.db.prepare('SELECT COUNT(*) FROM processed').pluck().get(), 87);
  assert.equal(store.db.prepare('SELECT COUNT(*) FROM summaries').pluck().get(), 3);
});

test('batcher: input too long for the context is split by time', async () => {
  const { store, batcher, calls } = setup({ budget: 400 });
  store.insertMessages(Array.from({ length: 6 }, () => row({ text: `please read this long note ${'x'.repeat(300)}` })));
  await batcher.run();
  assert.ok(calls.length >= 3, `split into ${calls.length} calls`);
  for (const c of calls) assert.ok(Buffer.byteLength(c.user) / 3 <= 400 || /\[1\*?\][^[]*$/.test(c.user));
});

test('batcher: bad model output splits the part and retries', async () => {
  const { store, batcher, calls } = setup({ reply: (u, k) => (k === 1 ? new Error('Unexpected end of JSON input') : { summary: [], tasks: [] }) });
  store.insertMessages(Array.from({ length: 6 }, () => row({ text: 'please do this' })));
  const r = await batcher.run();
  assert.equal(calls.length, 3, '1 failed + 2 halves');
  assert.equal(r.ok, true);
  assert.equal(store.db.prepare('SELECT COUNT(*) FROM processed').pluck().get(), 6);
});

test('batcher: assignee rules, dates, flags, one task per message', async () => {
  const msgs = [
    row({ text: '@91900 bring the record tomorrow', mentions_me: 1 }), // 1 mention -> me
    row({ text: 'Everyone pay fees by 15/10', }), // 2 everyone
    row({ text: 'Ravi, submit report by 5pm', mentioned: '919000000002@s.whatsapp.net' }), // 3 other
    row({ text: 'Alex can you bring chairs kal' }), // 4 candidate, Hindi date
    row({ text: 'someone fix the projector' }), // 5 none, unclear
  ];
  const reply = () => ({
    summary: ['Plans for the event'],
    tasks: [
      { message_id: '1', title: 'Bring record', assignee: 'Asha', due_text: 'tomorrow', due_guess: null, confidence: 0.9 },
      { message_id: '2', title: 'Pay fees', assignee: 'me', due_text: 'by 15/10', due_guess: null, confidence: 0.9 },
      { message_id: '3', title: 'Submit report', assignee: 'unclear', due_text: 'by 5pm', due_guess: null, confidence: 0.8 },
      { message_id: '4', title: 'Bring chairs', assignee: 'Alex', due_text: 'kal', due_guess: '2026-10-13', confidence: 0.7 },
      { message_id: '4', title: 'Call caterer', assignee: 'me', due_text: null, due_guess: null, confidence: 0.5 },
      { message_id: '5', title: 'Fix projector', assignee: 'unclear', due_text: null, due_guess: null, confidence: 0.4 },
      { message_id: '99', title: 'Ghost', assignee: 'me', due_text: null, due_guess: null, confidence: 1 },
    ],
  });
  const { store, batcher, added } = setup({ reply });
  store.insertMessages(msgs);
  const r = await batcher.run();
  const t = Object.fromEntries(added.map((x) => [msgs.findIndex((m) => m.id === x.message_id) + 1, x]));
  assert.equal(added.length, 5, 'unknown id 99 ignored, two tasks of message 4 merged');
  assert.equal(t[1].assignee, 'me');
  assert.equal(t[1].due, '2026-10-13');
  assert.equal(t[1].due_kind, 'date');
  assert.equal(t[2].assignee, 'everyone');
  assert.equal(t[2].due, '2026-10-15', 'DD/MM');
  assert.equal(t[3].assignee, 'Ravi');
  assert.equal(t[3].due_kind, 'datetime');
  assert.match(t[3].due, /^2026-10-12T17:00$/);
  assert.equal(t[4].assignee, 'me', 'alias normalized to me');
  assert.equal(t[4].title, 'Bring chairs; Call caterer', 'no "?" in the title any more');
  assert.equal(t[4].due, '2026-10-13');
  assert.equal(t[4].flagged, 1, 'merged confidence 0.5 < 0.6');
  assert.match(t[4].review_reason, /Low confidence \(50%\)/);
  assert.match(t[4].review_reason, /Date guessed by the model/);
  assert.ok(TAGS.includes(t[4].tag), 'a tag from the title words when the model gives none');
  assert.equal(t[5].assignee, 'unclear');
  assert.equal(t[5].flagged, 1);
  assert.equal(t[5].due, null);
  assert.equal(r.mine, 2);
  assert.equal(t[1].chat_name, 'Class 12B');

  // Processed ids are skipped: a second run makes no call and no duplicate.
  const again = await batcher.run();
  assert.equal(again.calls, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) FROM tasks').pluck().get(), 5);
});

test('batcher: impossible guessed dates are dropped, not sent to the calendar', async () => {
  const msgs = [row({ text: 'pay on the 30th please' }), row({ text: 'meet at 25 please' })];
  const reply = () => ({ summary: [], tasks: [
    { message_id: '1', title: 'Pay', assignee: 'me', due_text: 'the 30th xyz', due_guess: '2026-02-30', confidence: 0.9 },
    { message_id: '2', title: 'Meet', assignee: 'me', due_text: 'at 25 xyz', due_guess: '2026-10-13T25:00', confidence: 0.9 },
  ] });
  const { store, batcher, added } = setup({ reply });
  store.insertMessages(msgs);
  await batcher.run();
  assert.deepEqual(added.map((t) => t.due), [null, null]);
});

test('batcher: DM default assignee is me, unless the model names another person', async () => {
  const dm = (text) => row({ chat_id: DM, sender_id: DM, is_dm: 1, text });
  const msgs = [dm('can you send the form'), dm('my exam is on friday'), dm('pls call')];
  const reply = () => ({ summary: [], tasks: [
    { message_id: '1', title: 'Send form', assignee: 'unclear', due_text: null, due_guess: null, confidence: 0.9 },
    { message_id: '2', title: 'Write exam', assignee: 'Ravi', due_text: 'friday', due_guess: null, confidence: 0.9 },
    { message_id: '3', title: 'Call Ravi', assignee: 'everyone', due_text: null, due_guess: null, confidence: 0.9 },
  ] });
  const { store, batcher, added } = setup({ reply });
  store.insertMessages(msgs);
  await batcher.run();
  assert.deepEqual(added.map((t) => t.assignee), ['me', 'Ravi', 'me']);
});

test('batcher: "everyone" keyword gives way to a named person from the model', async () => {
  const msgs = [row({ text: 'Karthik, please bring all the chairs' }), row({ text: 'Everyone submit the form' }), row({ text: 'all of you come early' })];
  const reply = () => ({ summary: [], tasks: [
    { message_id: '1', title: 'Bring chairs', assignee: 'Karthik', due_text: null, due_guess: null, confidence: 0.9 },
    { message_id: '2', title: 'Submit form', assignee: 'me', due_text: null, due_guess: null, confidence: 0.9 },
    { message_id: '3', title: 'Come early', assignee: 'unclear', due_text: null, due_guess: null, confidence: 0.9 },
  ] });
  const { store, batcher, added } = setup({ reply });
  store.insertMessages(msgs);
  await batcher.run();
  assert.deepEqual(added.map((t) => t.assignee), ['Karthik', 'everyone', 'everyone']);
});

test('batcher: Ollama down -> batch fails, lastRun unchanged, nothing processed', async () => {
  const { store, batcher, status } = setup({ reply: () => new TypeError('fetch failed') });
  status.batch.lastRun = 123;
  store.insertMessages([row({ text: 'please come' })]);
  await assert.rejects(batcher.run(), /fetch failed/);
  assert.equal(status.batch.lastRun, 123);
  assert.equal(store.db.prepare('SELECT COUNT(*) FROM processed').pluck().get(), 0);
  assert.match(status.batch.result, /^failed/);
});

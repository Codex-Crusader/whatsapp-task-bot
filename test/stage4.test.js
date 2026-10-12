import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store.js';
import { createCalendar, eventBody, eventIdFor } from '../src/calendar.js';

const task = (o = {}) => ({
  message_id: `M${Math.random()}`, chat_id: 'g@g.us', chat_name: 'CSE', sender_name: 'Asha', title: 'Pay fees',
  assignee: 'me', due: '2026-10-20', due_kind: 'date', confidence: 0.9, flagged: 0, day: '2026-10-12', created_at: 1, ...o,
});

test('calendar: event body for date, datetime, flags, original message', () => {
  const allDay = eventBody(task(), { text: 'pay fees by 20/10', includeOriginal: true });
  assert.deepEqual(allDay.start, { date: '2026-10-20' });
  assert.deepEqual(allDay.end, { date: '2026-10-21' });
  assert.deepEqual(allDay.reminders, { useDefault: true });
  assert.equal(allDay.summary, 'Pay fees');
  assert.match(allDay.description, /Chat: CSE\nFrom: Asha[\s\S]*Message:\npay fees by 20\/10/);
  const monthEnd = eventBody(task({ due: '2026-10-31' }), {});
  assert.deepEqual(monthEnd.end, { date: '2026-11-01' });

  const timed = eventBody(task({ due: '2026-10-16T23:45', due_kind: 'datetime' }), { text: 'x', includeOriginal: false });
  assert.equal(timed.start.dateTime, '2026-10-16T23:45:00');
  assert.equal(timed.end.dateTime, '2026-10-17T00:15:00', '30 minutes, crosses midnight');
  assert.ok(timed.start.timeZone);
  assert.doesNotMatch(timed.description, /Message:/, 'original message left out by config');

  assert.equal(eventBody(task({ assignee: 'unclear' }), {}).summary, '? Pay fees');
  assert.equal(eventBody(task({ flagged: 1 }), {}).summary, '? Pay fees');
  assert.match(eventIdFor('ABC', 'cal@group'), /^[0-9a-f]{40}$/);
  assert.equal(eventIdFor('ABC', 'cal@group'), eventIdFor('ABC', 'cal@group'));
});

function setup(responder) {
  const store = openStore(join(mkdtempSync(join(tmpdir(), 'wabot-')), 'c.db'));
  const status = { calendar: {} };
  const log = { info() {}, warn() {}, error() {} };
  const calls = [];
  const request = async (opts) => { calls.push(opts); return responder(opts, calls.length); };
  const cal = createCalendar({ store, config: { includeOriginalMessage: true }, env: { calendarId: 'cal@group' }, status, log, request, sleep: async () => {} });
  return { store, status, calls, cal };
}

test('calendar: only me/everyone/unclear with a date get events; one event per message', async () => {
  const { store, cal, calls } = setup(() => ({ status: 200, data: {} }));
  const add = (o) => store.s.insertTask.run(task(o));
  add({ message_id: 'a', assignee: 'me' });
  add({ message_id: 'b', assignee: 'everyone', due: '2026-10-16T17:00', due_kind: 'datetime' });
  add({ message_id: 'c', assignee: 'unclear' });
  add({ message_id: 'd', assignee: 'Karthik' });
  add({ message_id: 'e', assignee: 'me', due: null, due_kind: null });
  const r = await cal.sync();
  assert.equal(r.created, 3);
  assert.deepEqual(calls.map((c) => c.data.id), ['a', 'b', 'c'].map((m) => eventIdFor(m, 'cal@group')));
  assert.match(calls[0].url, /calendars\/cal%40group\/events$/);
  assert.equal(store.s.taskByMessage.get('a').event_id, eventIdFor('a', 'cal@group'));
  const again = await cal.sync();
  assert.equal(again.created, 0);
  assert.equal(calls.length, 3, 'no second event');
});

test('calendar: rate limit is retried; 409 for our own event updates it; setup errors stop the sync', async () => {
  const { store, cal, calls, status } = setup((o, n) => {
    if (n === 1) return { status: 403, data: { error: { errors: [{ reason: 'rateLimitExceeded' }] } } };
    if (n === 2) return { status: 409, data: {} }; // x exists already (an earlier try)
    if (n === 3) return { status: 200, data: { status: 'confirmed' } }; // GET: it is ours
    if (n === 4) return { status: 200, data: {} }; // PATCH
    return { status: 404, data: {} }; // y: calendar not found
  });
  store.s.insertTask.run(task({ message_id: 'x' }));
  store.s.insertTask.run(task({ message_id: 'y' }));
  store.s.insertTask.run(task({ message_id: 'z' }));
  const r = await cal.sync();
  assert.equal(r.created, 1);
  assert.equal(r.failed, 1);
  assert.deepEqual(calls.map((c) => c.method ?? 'GET'), ['POST', 'POST', 'GET', 'PATCH', 'POST'], 'stops after 404, z waits');
  assert.equal(store.s.taskByMessage.get('x').event_id, eventIdFor('x', 'cal@group'));
  assert.equal(store.s.taskByMessage.get('y').event_id, null);
  assert.equal(status.calendar.ok, false);
});

test('calendar: 409 for an event that was removed earlier -> the next id', async () => {
  const { store, cal, calls } = setup((o, n) => (n === 1 ? { status: 409, data: {} } : n === 2 ? { status: 200, data: { status: 'cancelled' } } : { status: 200, data: {} }));
  store.s.insertTask.run(task({ message_id: 'r' }));
  await cal.sync();
  assert.equal(calls[2].data.id, eventIdFor('r', 'cal@group', 1));
  const t = store.s.taskByMessage.get('r');
  assert.equal(t.event_id, eventIdFor('r', 'cal@group', 1));
  assert.equal(t.event_gen, 1);
});

test('calendar: dashboard edits update, complete, remove, and restore the event', async () => {
  const { store, cal, calls } = setup(() => ({ status: 200, data: {} }));
  store.s.insertTask.run(task({ message_id: 'e', title: 'Pay fees' }));
  await cal.sync();
  const t = () => store.s.taskByMessage.get('e');
  const id0 = eventIdFor('e', 'cal@group');
  assert.equal(t().event_id, id0);
  const last = () => calls.at(-1);
  const set = (status) => store.s.setTaskStatus.run({ id: t().id, status, now: 1 });

  // Edit: new title and time -> PATCH of the same event.
  store.s.updateTask.run({ id: t().id, title: 'Pay hostel fees', assignee: 'me', due: '2026-10-21T10:00', due_kind: 'datetime', now: 1 });
  await cal.sync();
  assert.equal(last().method, 'PATCH');
  assert.match(last().url, new RegExp(`/events/${id0}$`));
  assert.equal(last().data.summary, 'Pay hostel fees');
  assert.equal(last().data.start.dateTime, '2026-10-21T10:00:00');
  assert.equal(t().event_dirty, 0);

  // Done: check mark, no reminders.
  set('done');
  await cal.sync();
  assert.equal(last().data.summary, '\u2713 Pay hostel fees');
  assert.deepEqual(last().data.reminders, { useDefault: false, overrides: [] });

  // Reopen: normal again.
  set('open');
  await cal.sync();
  assert.deepEqual(last().data.reminders, { useDefault: true });

  // Delete: event removed, next event gets a new id.
  set('deleted');
  await cal.sync();
  assert.equal(last().method, 'DELETE');
  assert.equal(t().event_id, null);
  assert.equal(t().event_gen, 1);

  // Restore: a new event with gen 1.
  set('open');
  await cal.sync();
  assert.equal(last().method, 'POST');
  assert.equal(last().data.id, eventIdFor('e', 'cal@group', 1));
  assert.equal(t().event_id, eventIdFor('e', 'cal@group', 1));

  // Another person: no event for me.
  store.s.updateTask.run({ id: t().id, title: 'Pay hostel fees', assignee: 'Ravi', due: '2026-10-21', due_kind: 'date', now: 1 });
  await cal.sync();
  assert.equal(last().method, 'DELETE');
  assert.equal(t().event_id, null);
  const n = calls.length;
  await cal.sync();
  assert.equal(calls.length, n, 'nothing more to do');
});

test('calendar: not configured -> no requests', async () => {
  const store = openStore(join(mkdtempSync(join(tmpdir(), 'wabot-')), 'n.db'));
  const cal = createCalendar({ store, config: {}, env: { calendarId: '', googleKeyFile: '' }, status: { calendar: {} }, log: { warn() {} } });
  assert.equal(cal.configured, false);
  assert.deepEqual(await cal.sync(), { created: 0, updated: 0, failed: 0, skipped: true });
});

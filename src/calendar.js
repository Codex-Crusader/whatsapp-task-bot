// Google Calendar writer. Writes only to CALENDAR_ID from .env.
// sync() runs after each batch and after each dashboard edit: it updates or
// removes the events of edited tasks, then creates the missing events.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { localDay } from './store.js';

const SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const EVENT_MINUTES = 30;
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

// Same message -> same event id, so a retry gets 409 instead of a duplicate.
// Google keeps the id of a removed event, so a new event after a removal uses gen + 1.
// Calendar ids allow 0-9 and a-v; hex is a subset.
export function eventIdFor(messageId, calendarId, gen = 0) {
  return createHash('sha1').update(gen ? `${calendarId}\n${messageId}\n${gen}` : `${calendarId}\n${messageId}`).digest('hex');
}

const MINE = new Set(['me', 'everyone', 'unclear']);
// A task has an event if it is open or done, has a date, and is for me, everyone, or unclear.
export const wantsEvent = (t) => (t.status === 'open' || t.status === 'done') && !!t.due && MINE.has(t.assignee);

export function eventBody(task, { text, includeOriginal }) {
  const flagged = task.assignee === 'unclear' || task.flagged;
  const done = task.status === 'done';
  const lines = [`Chat: ${task.chat_name}`, `From: ${task.sender_name}`, `Assigned to: ${task.assignee}`];
  if (includeOriginal && text) lines.push('', 'Message:', text);
  const body = {
    // A done task keeps its event, marked with a check, and gives no more reminders.
    summary: `${done ? '✓ ' : flagged ? '? ' : ''}${task.title}`,
    description: lines.join('\n'),
    reminders: done ? { useDefault: false, overrides: [] } : { useDefault: true },
  };
  if (task.due_kind === 'datetime') {
    const [d, t] = task.due.split('T');
    const [y, mo, da] = d.split('-').map(Number);
    const [h, mi] = t.split(':').map(Number);
    const end = new Date(y, mo - 1, da, h, mi + EVENT_MINUTES);
    const endStr = `${localDay(end.getTime())}T${String(end.getHours()).padStart(2, '0')}:${String(end.getMinutes()).padStart(2, '0')}:00`;
    body.start = { dateTime: `${task.due}:00`, timeZone: TZ };
    body.end = { dateTime: endStr, timeZone: TZ };
  } else {
    const [y, mo, da] = task.due.split('-').map(Number);
    body.start = { date: task.due };
    body.end = { date: localDay(new Date(y, mo - 1, da + 1).getTime()) };
  }
  return body;
}

// request(opts) -> { status, data }; injectable for tests.
export function createCalendar({ store, config, env, status, log, request = null, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  let send = request;
  let clientFor = ''; // key file the cached client was made from
  // Checked at each sync: the setup wizard can add the key and the calendar later.
  const isConfigured = () => !!(env.calendarId && (request || (env.googleKeyFile && existsSync(env.googleKeyFile))));

  async function client() {
    if (send && (request || clientFor === env.googleKeyFile)) return send;
    clientFor = env.googleKeyFile;
    const { JWT } = await import('google-auth-library'); // loaded only when needed
    // Pass email and key directly: with only keyFile, this library version
    // leaves the email empty and Google answers "account not found".
    const key = JSON.parse(readFileSync(env.googleKeyFile, 'utf8'));
    const jwt = new JWT({ email: key.client_email, key: key.private_key, keyId: key.private_key_id, scopes: [SCOPE] }); // one client, token reused
    send = async (opts) => {
      try {
        const r = await jwt.request(opts);
        return { status: r.status, data: r.data };
      } catch (err) {
        if (err.response) return { status: err.response.status, data: err.response.data };
        throw err;
      }
    };
    return send;
  }

  const eventsUrl = () => `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(env.calendarId)}/events`;

  // One request with retry for rate limits and server errors.
  // ok: the statuses that count as done for this call.
  async function call(opts, ok) {
    const req = await client();
    for (let attempt = 0; ; attempt++) {
      const r = await req(opts);
      if (ok.includes(r.status)) return r;
      const reason = r.data?.error?.errors?.[0]?.reason || '';
      const retry = r.status === 429 || r.status >= 500 || /rateLimitExceeded|userRateLimitExceeded/.test(reason);
      if (!retry || attempt >= 4) throw new Error(`calendar HTTP ${r.status} ${reason}`.trim());
      await sleep(1000 * 2 ** attempt);
    }
  }

  const written = () => {
    status.calendar.lastWriteAt = Date.now();
    store.kvSet('lastCalendarWriteAt', status.calendar.lastWriteAt); // survives a restart
    status.calendar.ok = true;
  };
  const bodyOf = (t) => eventBody(t, { text: store.s.messageText.get(t.message_id)?.text, includeOriginal: config.includeOriginalMessage });

  // Creates the event. On 409 the id exists: if that event was removed, try the next gen;
  // if it is ours from an earlier try, update it.
  async function create(task) {
    const first = task.event_gen ?? 0;
    for (let gen = first; gen < first + 5; gen++) {
      const id = eventIdFor(task.message_id, env.calendarId, gen);
      const r = await call({ url: eventsUrl(), method: 'POST', data: { id, ...bodyOf(task) } }, [200, 409]);
      if (r.status === 409) {
        const old = await call({ url: `${eventsUrl()}/${id}` }, [200, 404, 410]);
        if (old.status !== 200 || old.data?.status === 'cancelled') continue; // removed earlier
        await call({ url: `${eventsUrl()}/${id}`, method: 'PATCH', data: bodyOf(task) }, [200]);
      }
      store.s.setEvent.run({ event_id: id, gen, id: task.id });
      return;
    }
    throw new Error('calendar: no free event id');
  }

  // An edited task: update its event, or remove it if the task no longer needs one.
  async function apply(task) {
    if (task.event_id && wantsEvent(task)) {
      const r = await call({ url: `${eventsUrl()}/${task.event_id}`, method: 'PATCH', data: bodyOf(task) }, [200, 404, 410]);
      if (r.status !== 200) store.s.setEvent.run({ event_id: null, gen: task.event_gen + 1, id: task.id }); // removed in Google: make it again
    } else if (task.event_id) {
      await call({ url: `${eventsUrl()}/${task.event_id}`, method: 'DELETE' }, [200, 204, 404, 410]);
      store.s.setEvent.run({ event_id: null, gen: task.event_gen + 1, id: task.id });
    }
    store.s.clearDirty.run(task.id);
  }

  let running = null;
  let again = false;

  // One sync at a time. A call during a sync makes one more pass after it.
  function sync() {
    if (!isConfigured()) return Promise.resolve({ created: 0, updated: 0, failed: 0, skipped: true });
    if (running) { again = true; return running; }
    running = (async () => {
      let result;
      do {
        again = false;
        result = await pass();
      } while (again);
      return result;
    })().finally(() => { running = null; });
    return running;
  }

  // Edited tasks first, then the missing events.
  async function pass() {
    let created = 0;
    let updated = 0;
    let failed = 0;
    const dirty = store.s.dirtyEvents.all();
    for (const task of dirty) {
      try {
        await apply(task);
        updated++;
        written();
      } catch (err) {
        failed++;
        status.calendar.ok = false;
        log.error('calendar: update failed', { err: err.message });
        if (/HTTP (401|403)/.test(err.message)) return { created, updated, failed }; // setup problem
      }
    }
    const pending = store.s.pendingEvents.all();
    for (const task of pending) {
      try {
        await create(task);
        created++;
        written();
      } catch (err) {
        failed++;
        status.calendar.ok = false;
        log.error('calendar: insert failed', { err: err.message });
        if (/HTTP (401|403|404)/.test(err.message)) break; // setup problem: stop, retry next batch
      }
    }
    if (pending.length || dirty.length) log.info('calendar: sync', { pending: pending.length, created, edited: dirty.length, updated, failed });
    return { created, updated, failed };
  }

  // Setup wizard: create one event for tomorrow and remove it again.
  async function testWrite() {
    if (!isConfigured()) throw new Error('The key file or the Calendar ID is missing.');
    const id = eventIdFor(`setup-test-${Date.now()}`, env.calendarId);
    const day = localDay(Date.now() + 24 * 3600 * 1000);
    const next = localDay(Date.now() + 48 * 3600 * 1000);
    const body = { id, summary: 'WhatsApp Task Bot test', start: { date: day }, end: { date: next }, reminders: { useDefault: false, overrides: [] } };
    let r;
    try {
      r = await call({ url: eventsUrl(), method: 'POST', data: body }, [200]);
    } catch (err) {
      const m = /HTTP (\d+)/.exec(err.message)?.[1];
      if (m === '404') throw new Error('Google cannot find this calendar. Check the Calendar ID, and share the calendar with the service account email.');
      if (m === '403') throw new Error('The service account cannot write to this calendar. Share it with "Make changes to events".');
      if (m === '400' || m === '401') throw new Error('Google refused the key. Upload the key file again.');
      throw err;
    }
    await call({ url: `${eventsUrl()}/${id}`, method: 'DELETE' }, [200, 204, 404, 410]);
    written();
    return r.status;
  }

  // A new key file: make a new client at the next call.
  function reset() {
    if (!request) send = null;
  }

  return { sync, reset, testWrite, get configured() { return isConfigured(); } };
}

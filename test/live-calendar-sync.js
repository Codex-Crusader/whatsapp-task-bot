// Manual check: the real calendar.sync() with one timed and one all-day task,
// in a temporary database. Deletes both events at the end. Run: node test/live-calendar-sync.js
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JWT } from 'google-auth-library';
import { config, env } from '../src/config.js';
import { openStore, localDay } from '../src/store.js';
import { createCalendar } from '../src/calendar.js';

const store = openStore(join(mkdtempSync(join(tmpdir(), 'wabot-cal-')), 'c.db'));
const status = { calendar: {} };
const log = { info: (m, f) => console.log(m, f ?? ''), warn: console.warn, error: (m, f) => console.error(m, f ?? '') };
const tomorrow = localDay(Date.now() + 86400000);
const base = { chat_id: 'g@g.us', chat_name: 'Bot test', sender_name: 'Test', confidence: 0.9, flagged: 0, day: localDay(), created_at: Date.now() };
store.s.insertTask.run({ ...base, message_id: `sync-test-timed-${Date.now()}`, title: 'Bot sync test (timed)', assignee: 'me', due: `${tomorrow}T17:00`, due_kind: 'datetime' });
store.s.insertTask.run({ ...base, message_id: `sync-test-allday-${Date.now()}`, title: 'Bot sync test (all day)', assignee: 'unclear', due: tomorrow, due_kind: 'date' });

const cal = createCalendar({ store, config, env, status, log });
console.log('sync:', await cal.sync());
const rows = store.db.prepare('SELECT title, event_id FROM tasks').all();

const key = JSON.parse(readFileSync(env.googleKeyFile, 'utf8'));
const jwt = new JWT({ email: key.client_email, key: key.private_key, scopes: ['https://www.googleapis.com/auth/calendar.events'] });
const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(env.calendarId)}/events`;
for (const r of rows) {
  const ev = (await jwt.request({ url: `${url}/${r.event_id}` })).data;
  console.log(`${r.title}: summary="${ev.summary}" start=${JSON.stringify(ev.start)} end=${JSON.stringify(ev.end)} reminders=${JSON.stringify(ev.reminders)}`);
  console.log('  delete:', (await jwt.request({ url: `${url}/${r.event_id}`, method: 'DELETE' })).status);
}
store.close();

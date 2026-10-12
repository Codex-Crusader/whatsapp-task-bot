// Manual check: a timed event that starts in 63 minutes, made with the bot's own
// eventBody(). Its "1 hour before" reminder fires in about 3 minutes. MINUTES=4 tests the 0-minute reminder.
// Run: node test/live-reminder.js        (create)
//      node test/live-reminder.js delete <id> (remove)
import { readFileSync } from 'node:fs';
import { JWT } from 'google-auth-library';
import { env } from '../src/config.js';
import { eventBody, eventIdFor } from '../src/calendar.js';
import { localDay } from '../src/store.js';

const key = JSON.parse(readFileSync(env.googleKeyFile, 'utf8'));
const jwt = new JWT({ email: key.client_email, key: key.private_key, scopes: ['https://www.googleapis.com/auth/calendar.events'] });
const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(env.calendarId)}/events`;
// A deleted event keeps its id at Google, so each test run uses a new id.
const id = process.argv[3] || eventIdFor(`live-reminder-test-${Date.now()}`, env.calendarId);

if (process.argv[2] === 'delete') {
  console.log('delete:', (await jwt.request({ url: `${url}/${id}`, method: 'DELETE' })).status);
} else {
  const at = new Date(Date.now() + Number(process.env.MINUTES || 63) * 60 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  const due = `${localDay(at.getTime())}T${p(at.getHours())}:${p(at.getMinutes())}`;
  const task = { title: 'Bot reminder test', chat_name: 'Test', sender_name: 'WhatsApp Task Bot', assignee: 'me', flagged: 0, due, due_kind: 'datetime' };
  const r = await jwt.request({ url, method: 'POST', data: { id, ...eventBody(task, {}) } });
  console.log('created:', r.status, 'id', id, 'starts', due, '- reminder about', new Date(at.getTime() - 3600000).toLocaleTimeString());
}

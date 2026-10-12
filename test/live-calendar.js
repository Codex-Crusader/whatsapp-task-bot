// Manual check: creates one test event in the WhatsApp Tasks calendar.
// Run: node test/live-calendar.js        (create)
//      node test/live-calendar.js delete (remove it again)
import { JWT } from 'google-auth-library';
import { env } from '../src/config.js';
import { eventIdFor } from '../src/calendar.js';
import { localDay } from '../src/store.js';

import { readFileSync } from 'node:fs';
const key = JSON.parse(readFileSync(env.googleKeyFile, 'utf8'));
const jwt = new JWT({ email: key.client_email, key: key.private_key, keyId: key.private_key_id, scopes: ['https://www.googleapis.com/auth/calendar.events'] });
const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(env.calendarId)}/events`;
const id = eventIdFor('live-calendar-test', env.calendarId);
const call = (opts) => jwt.request(opts).then((r) => r.status, (e) => `${e.response?.status} ${JSON.stringify(e.response?.data?.error?.errors ?? e.message)}`);

if (process.argv[2] === 'delete') {
  console.log('delete:', await call({ url: `${base}/${id}`, method: 'DELETE' }));
} else {
  const today = localDay();
  const tomorrow = localDay(Date.now() + 86400000);
  const body = { id, summary: 'WhatsApp bot test event', description: 'Created by test/live-calendar.js', start: { date: today }, end: { date: tomorrow }, reminders: { useDefault: true } };
  console.log('insert:', await call({ url: base, method: 'POST', data: body }));
  console.log('insert again (expect 409):', await call({ url: base, method: 'POST', data: body }));
}

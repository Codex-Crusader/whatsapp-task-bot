// Setup wizard actions with fake WhatsApp, calendar, mailer and Ollama.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, loadEnv } from '../src/config.js';
import { openStore } from '../src/store.js';
import { createSetup } from '../src/setup.js';

const KEY = JSON.stringify({ type: 'service_account', client_email: 'bot@proj-1.iam.gserviceaccount.com', private_key: '-----BEGIN PRIVATE KEY-----\nSECRETKEYDATA\n-----END PRIVATE KEY-----\n' });

function setup({ linked = false, sendTestError = null, background = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wabot-setup-'));
  const paths = { config: join(dir, 'config.json'), env: join(dir, '.env'), key: join(dir, 'keys', 'sa.json') };
  const config = loadConfig(paths.config);
  const env = loadEnv(paths.env, {});
  const store = openStore(join(dir, 's.db'));
  const status = { whatsapp: { state: linked ? 'open' : 'not linked' } };
  const calls = [];
  let linkCallbacks = null;
  const reader = {
    isLinked: () => linked,
    isPairing: () => !!linkCallbacks,
    link: (phone, cb) => { calls.push(`link:${phone}`); linkCallbacks = cb; },
  };
  const calendar = { reset: () => calls.push('calendar.reset'), testWrite: async () => calls.push('calendar.test'), sync: async () => calls.push('calendar.sync') };
  const mailer = { sendTest: async () => { if (sendTestError) throw sendTestError; calls.push('mail.test'); } };
  const fetchFn = async () => ({ ok: true, json: async () => ({ models: [{ name: 'qwen2.5:7b' }] }) });
  const s = createSetup({
    store, config, env, status, log: { info() {}, warn() {}, error() {} }, reader, calendar, mailer, port: 4780, token: 'x',
    onProfileSaved: () => calls.push('profileSaved'), onLinked: () => calls.push('linked'),
    runAutostartScript: async () => calls.push('autostart'), isBackground: background, requestExit: () => calls.push('exit'),
    fetchFn, paths, shortcutDir: dir,
  });
  return { s, store, config, env, status, calls, paths, dir, cb: () => linkCallbacks };
}

const code = async (p) => { try { await p; return 200; } catch (err) { return err.code; } };

test('setup: name step saves to config.json and starts the scheduler check', async () => {
  const t = setup();
  assert.equal((await t.s.state()).profile.done, false);
  assert.equal(await code(t.s.act('profile', { myName: '  ' })), 400);
  await t.s.act('profile', { myName: 'Alexander Morgan', aliases: 'Alex, Al', emailTime: '20:00' });
  assert.equal(t.config.myName, 'Alexander Morgan');
  assert.deepEqual(t.config.aliases, ['Alex', 'Al']);
  assert.deepEqual(JSON.parse(readFileSync(t.paths.config, 'utf8')).aliases, ['Alex', 'Al']);
  assert.ok(t.calls.includes('profileSaved'));
  assert.equal(await code(t.s.act('profile', { myName: 'A', emailTime: '99:99' })), 400);
  assert.equal(await code(t.s.act('nope', {})), 404);
});

test('setup: WhatsApp link -- phone check, code shown, cooldown, failure, success', async () => {
  const t = setup();
  assert.equal(await code(t.s.act('link', { phone: '12' })), 400);
  assert.equal(await code(t.s.act('link', { phone: '+91 98765-43210' })), 200);
  assert.deepEqual(t.calls.filter((c) => c.startsWith('link:')), ['link:919876543210']);
  assert.equal(await code(t.s.act('link', { phone: '919876543210' })), 429, 'one code request per minute');
  t.cb().onCode('ABCD1234');
  let st = await t.s.state();
  assert.equal(st.whatsapp.code, 'ABCD-1234');
  t.cb().onFail();
  st = await t.s.state();
  assert.equal(st.whatsapp.code, null);
  assert.match(st.whatsapp.error, /did not finish/);
  t.cb().onLinked();
  assert.ok(t.calls.includes('linked'));
  const done = setup({ linked: true });
  assert.equal(await code(done.s.act('link', { phone: '919876543210' })), 400, 'already linked');
});

test('setup: Google key and Calendar ID, with checks; a new calendar forgets old event ids', async () => {
  const t = setup();
  assert.equal(await code(t.s.act('google-key', { text: '{"type":"user"}' })), 400);
  const r = await t.s.act('google-key', { text: KEY });
  assert.equal(r.serviceEmail, 'bot@proj-1.iam.gserviceaccount.com');
  assert.ok(existsSync(t.paths.key));
  assert.equal(t.env.googleKeyFile, t.paths.key);
  assert.ok(t.calls.includes('calendar.reset'));
  assert.equal(await code(t.s.act('calendar-id', { calendarId: 'not an id' })), 400);
  await t.s.act('calendar-id', { calendarId: 'abc@group.calendar.google.com' });
  assert.equal(t.env.calendarId, 'abc@group.calendar.google.com');
  t.store.s.insertTask.run({ message_id: 'm', chat_id: 'c', chat_name: 'C', sender_name: 'S', title: 'T', assignee: 'me', due: '2026-10-20', due_kind: 'date', confidence: 1, flagged: 0, day: '2026-10-12', created_at: 1 });
  t.store.s.setEventId.run('oldevent', 'm');
  await t.s.act('calendar-id', { calendarId: 'new@group.calendar.google.com' });
  assert.equal(t.store.s.taskByMessage.get('m').event_id, null, 'open task gets an event in the new calendar');
  await t.s.act('calendar-test', {});
  assert.equal((await t.s.state()).google.tested, true);
  // Real use also counts: an event written after the last calendar change.
  const u = setup();
  u.env.calendarId = 'x@group.calendar.google.com';
  u.store.kvSet('lastCalendarWriteAt', Date.now());
  assert.equal((await u.s.state()).google.tested, true, 'an earlier real event write counts');
  await u.s.act('calendar-id', { calendarId: 'y@group.calendar.google.com' });
  assert.equal((await u.s.state()).google.tested, false, 'a new calendar needs a new test');
});

test('setup: Gmail -- checks, password never sent back, readable auth error', async () => {
  const t = setup({ sendTestError: Object.assign(new Error('Invalid login: 535-5.7.8 Username and Password not accepted'), { code: 'EAUTH' }) });
  assert.equal(await code(t.s.act('gmail', { gmailUser: 'not-an-email', gmailAppPassword: 'abcdefghijklmnop' })), 400);
  assert.equal(await code(t.s.act('gmail', { gmailUser: 'alex@example.com', gmailAppPassword: 'short' })), 400);
  await t.s.act('gmail', { gmailUser: 'alex@example.com', gmailAppPassword: 'abcd efgh ijkl mnop' });
  await t.s.act('google-key', { text: KEY });
  const st = await t.s.state();
  assert.equal(st.gmail.passwordSet, true);
  const json = JSON.stringify(st);
  assert.doesNotMatch(json, /abcdefghijklmnop/, 'the App Password never goes to the browser');
  assert.doesNotMatch(json, /SECRETKEYDATA|PRIVATE KEY/, 'the private key never goes to the browser');
  await assert.rejects(t.s.act('email-test', {}), /refused the address or the App Password/);
  await t.s.act('gmail', { gmailUser: 'alex@example.com', gmailAppPassword: '' });
  assert.equal(loadEnv(t.paths.env, {}).gmailAppPassword, 'abcdefghijklmnop', 'an empty field keeps the saved password');
});

test('setup: autostart hands over from the console copy; ready needs name, link and model', async () => {
  const t = setup({ linked: true });
  const r = await t.s.act('autostart', {});
  assert.equal(r.handover, true);
  assert.ok(t.calls.includes('autostart') && t.calls.includes('exit'));
  const bg = setup({ linked: true, background: true });
  assert.equal((await bg.s.state()).autostart.enabled, true, 'running as the background task proves autostart');
  await bg.s.act('autostart', {});
  assert.ok(!bg.calls.includes('exit'), 'the background copy keeps running');
  assert.equal((await t.s.state()).ready, false, 'no name yet');
  await t.s.act('profile', { myName: 'Alexander Morgan' });
  assert.equal((await t.s.state()).ready, true);
  const sc = await t.s.act('shortcut', {});
  assert.equal(sc.ok, true);
  assert.match(readFileSync(join(t.dir, 'WhatsApp Task Bot.url'), 'utf8'), /URL=http:\/\/localhost:4780\/login\?t=x/);
});

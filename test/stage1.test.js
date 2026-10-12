import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { createLogger, baileysLogger } from '../src/log.js';
import { guardSocket, BLOCKED, SendBlockedError } from '../src/guard.js';
import { openStore, useSqliteAuthState } from '../src/store.js';
import { recordError, status, snapshot } from '../src/status.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'wabot-'));

test('config: defaults merge and validation', () => {
  const dir = tmp();
  const f = join(dir, 'c.json');
  writeFileSync(f, JSON.stringify({ myName: 'Ram', retention: { messageHours: 24 } }));
  const c = loadConfig(f);
  assert.equal(c.myName, 'Ram');
  assert.equal(c.retention.messageHours, 24);
  assert.equal(c.retention.reportDays, 30);
  assert.equal(c.dashboardPort, 4780);
  writeFileSync(f, JSON.stringify({ emailTime: '9pm' }));
  assert.throws(() => loadConfig(f), /emailTime/);
  writeFileSync(f, JSON.stringify({ aliases: 'Ram' }));
  assert.throws(() => loadConfig(f), /aliases/);
});

test('log: rotates at max size and keeps 3 files', () => {
  const dir = tmp();
  const log = createLogger({ dir, maxBytes: 200, echo: false });
  for (let i = 0; i < 50; i++) log.info(`line ${i}`, { n: i });
  log.close();
  const files = readdirSync(dir).sort();
  assert.deepEqual(files, ['bot.1.log', 'bot.2.log', 'bot.log']);
  for (const f of files) assert.ok(readFileSync(join(dir, f)).length <= 200);
  const last = createLogger({ dir, maxBytes: 200, echo: false });
  const lines = last.tail(3);
  assert.equal(lines.length, 3);
  assert.match(lines[2], /line 49/);
  last.close();
});

test('log: Baileys adapter drops log objects, keeps error text', () => {
  const dir = tmp();
  const log = createLogger({ dir, echo: false });
  const bl = baileysLogger(log);
  bl.info({ msg: { conversation: 'SECRET TEXT' } }, 'info is off');
  bl.warn({ message: { conversation: 'SECRET TEXT' }, key: { id: 'X' } }, 'failed to decrypt');
  bl.error({ err: new Error('boom') }, 'oops');
  assert.equal(bl.child({}), bl);
  log.close();
  const text = readFileSync(join(dir, 'bot.log'), 'utf8');
  assert.doesNotMatch(text, /SECRET/);
  assert.doesNotMatch(text, /info is off/);
  assert.match(text, /WARN baileys: failed to decrypt/);
  assert.match(text, /ERROR baileys: oops err=boom/);
});

test('guard: every blocked method throws, allowed members work', async () => {
  const calls = [];
  const fake = { ev: { on() {} }, user: { id: '1@s.whatsapp.net' }, groupMetadata: async (j) => ({ id: j }), end() { calls.push('end'); } };
  for (const name of BLOCKED) fake[name] = () => calls.push(name);
  const g = guardSocket(fake);
  for (const name of BLOCKED) {
    assert.throws(() => g[name], SendBlockedError, name);
  }
  assert.throws(() => g.somethingNew, SendBlockedError);
  assert.throws(() => { g.sendMessage = () => {}; }, SendBlockedError);
  assert.equal(g.user.id, '1@s.whatsapp.net');
  assert.deepEqual(await g.groupMetadata('g@g.us'), { id: 'g@g.us' });
  g.end();
  assert.deepEqual(calls, ['end']);
});

test('store: pragmas, indexes, dedupe, processed join', () => {
  const st = openStore(join(tmp(), 'b.db'));
  assert.equal(st.db.pragma('journal_mode', { simple: true }), 'wal');
  assert.equal(st.db.pragma('synchronous', { simple: true }), 1);
  assert.equal(st.db.pragma('auto_vacuum', { simple: true }), 2);
  const idx = st.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'").pluck().all();
  for (const n of ['messages_chat_ts', 'messages_ts', 'tasks_message']) assert.ok(idx.includes(n), n);

  const row = (id, ts) => ({ id, chat_id: 'c', sender_id: 's', ts, text: 't', quoted_sender_id: null, mentions_me: 0, is_dm: 1, mentioned: null });
  assert.equal(st.insertMessages([row('a', 10), row('b', 20), row('a', 10)]), 2);
  st.s.markProcessed.run('a', 1);
  assert.deepEqual(st.s.unprocessedSince.all(0).map((r) => r.id), ['b']);
  st.kvSet('lastRun', 123);
  assert.equal(st.kvGet('lastRun'), '123');
  assert.equal(st.kvGet('missing'), null);
  st.close();
});

test('store: SQLite auth state round trip and key deletion', async () => {
  const file = join(tmp(), 'a.db');
  let st = openStore(file);
  let auth = useSqliteAuthState(st);
  const key = Buffer.from([1, 2, 3]);
  auth.state.creds.me = { id: '91@s.whatsapp.net' };
  await auth.saveCreds();
  await auth.state.keys.set({ 'pre-key': { 1: { public: key, private: key }, 2: { public: key, private: key } } });
  await auth.state.keys.set({ 'pre-key': { 1: null } });
  st.close();

  st = openStore(file);
  auth = useSqliteAuthState(st);
  assert.equal(auth.state.creds.me.id, '91@s.whatsapp.net');
  assert.ok(Buffer.isBuffer(auth.state.creds.noiseKey.private));
  const got = await auth.state.keys.get('pre-key', ['1', '2']);
  assert.equal(got['1'], null);
  assert.deepEqual(got['2'].public, key);
  st.close();
});

test('status: keeps the last 20 errors and reads RAM without a query', () => {
  for (let i = 0; i < 25; i++) recordError('test', new Error(`e${i}`));
  assert.equal(status.errors.length, 20);
  assert.equal(status.errors[0].message, 'e24');
  const snap = snapshot(join(tmp(), 'none.db'));
  assert.ok(snap.rssBytes > 0);
  assert.equal(snap.dbBytes, 0);
});

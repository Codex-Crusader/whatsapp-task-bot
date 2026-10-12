import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { loadConfig } from '../src/config.js';
import { openStore, localDay } from '../src/store.js';
import { createLogger } from '../src/log.js';
import { createDashboard } from '../src/dashboard.js';

const PORT = 47861;
const config = { ...loadConfig(), dashboardPort: PORT };
const dir = mkdtempSync(join(tmpdir(), 'wabot-'));
const store = openStore(join(dir, 'd.db'));
const log = createLogger({ dir, echo: false });
let dash;

const TOKEN = 'ab'.repeat(32);
function get(path, { host = `localhost:${PORT}`, method = 'GET', headers = {}, body = null, cookie = `wtb_session=${TOKEN}` } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: PORT, path, method, headers: { host, ...(cookie ? { cookie } : {}), ...headers } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c)).on('end', () => resolve({ code: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject).end(body);
  });
}

// A request as the dashboard page sends it.
const ORIGIN = `http://localhost:${PORT}`;
const post = (path, json, headers = {}) => get(path, {
  method: 'POST',
  headers: { origin: ORIGIN, 'content-type': 'application/json', 'x-bot-action': '1', 'sec-fetch-site': 'same-origin', ...headers },
  body: JSON.stringify(json),
});
let syncs = 0;

before(async () => {
  const today = localDay();
  for (let i = 0; i < 60; i++) {
    store.s.insertTask.run({ message_id: `M${i}`, chat_id: 'g@g.us', chat_name: 'CSE', sender_name: 'Asha', title: `Task ${i}`, assignee: i % 3 === 0 ? 'me' : i % 3 === 1 ? 'everyone' : 'Ravi', due: i < 10 ? null : today, due_kind: i < 10 ? null : 'date', confidence: 0.9, flagged: 0, day: today, created_at: i });
  }
  store.s.insertTask.run({ message_id: 'X', chat_id: 'g@g.us', chat_name: '<script>alert(1)</script>', sender_name: 'A', title: 'x', assignee: 'me', due: null, due_kind: null, confidence: 1, flagged: 0, day: today, created_at: 1 });
  const day = (n) => localDay(Date.now() - n * 24 * 3600 * 1000);
  store.kvSet('firstDay', day(3));
  store.s.saveReport.run(day(3), '<html><body><h1>Report</h1><script>bad()</script></body></html>', Date.now());
  store.s.markReportSent.run(Date.now(), day(3));
  store.s.addSummary.run('g@g.us', day(1), 'something happened', 1); // content, not sent yet
  // day(2): nothing -> skipped
  log.info('dashboard test line <b>');
  dash = createDashboard({ store, config, status: (await import('../src/status.js')).status, log, dbFile: join(dir, 'd.db'), calendar: { sync: async () => { syncs++; } }, token: TOKEN });
  await dash.start();
});
after(() => { dash.stop(); store.close(); log.close(); });

test('dashboard: a second copy cannot bind the port (single instance)', async () => {
  const second = createDashboard({ store, config, status: {}, log, dbFile: join(dir, 'd.db'), token: TOKEN });
  await assert.rejects(second.start(), { code: 'EADDRINUSE' });
});

test('dashboard: access token -- no data without it, login sets a strict cookie', async () => {
  const no = await get('/tasks', { cookie: '' });
  assert.equal(no.code, 401);
  assert.match(no.body, /access link/);
  assert.doesNotMatch(no.body, /Task 1/, 'no task data without the token');
  assert.equal((await get('/api/status', { cookie: '' })).code, 401);
  assert.equal((await get('/api/status', { cookie: `wtb_session=${'cd'.repeat(32)}` })).code, 401, 'wrong token');
  assert.equal((await get('/reports', { cookie: 'wtb_session=' })).code, 401);
  assert.equal((await get('/favicon.ico', { cookie: '' })).code, 200, 'the icon needs no token');
  assert.equal((await get(`/login?t=${'cd'.repeat(32)}`, { cookie: '' })).code, 403);
  const ok = await get(`/login?t=${TOKEN}`, { cookie: '' });
  assert.equal(ok.code, 302);
  assert.ok(!ok.headers.location.includes(TOKEN), 'the redirect removes the token from the address');
  assert.match(ok.headers['set-cookie'][0], new RegExp(`^wtb_session=${TOKEN}; HttpOnly; SameSite=Strict; Path=/`));
  const post401 = await get('/api/tasks/bulk', { method: 'POST', cookie: '', headers: { origin: `http://localhost:${PORT}`, 'content-type': 'application/json', 'x-bot-action': '1' }, body: '{"action":"delete","ids":[1]}' });
  assert.equal(post401.code, 401, 'changes need the token too');
});

test('dashboard: listens on 127.0.0.1 only and checks the Host header', async () => {
  assert.equal((await get('/')).code, 200);
  assert.equal((await get('/', { host: `127.0.0.1:${PORT}` })).code, 200);
  assert.equal((await get('/', { host: 'evil.example' })).code, 403, 'DNS rebinding blocked');
  assert.equal((await get('/', { host: `localhost:${PORT + 1}` })).code, 403);
  assert.equal((await get('/api/status', { method: 'POST' })).code, 405, 'read-only');
});

test('dashboard: status API has values and red/green checks', async () => {
  const r = await get('/api/status');
  const s = JSON.parse(r.body);
  for (const k of ['whatsapp', 'lastMessage', 'lastRun', 'lastBatch', 'nextBatch', 'ollama', 'calendar', 'email', 'nextEmail', 'ram', 'db']) assert.ok(['ok', 'bad', 'idle'].includes(s.checks[k]), k);
  // Nothing happened yet in this test process: gray, never green.
  for (const k of ['calendar', 'email', 'lastBatch']) assert.equal(s.checks[k], 'idle', k);
  assert.equal(s.checks.ram, 'ok');
  assert.ok(s.rssBytes > 0 && s.dbBytes > 0);
  assert.ok(Array.isArray(s.errors));
  const home = await get('/');
  assert.match(home.headers['content-security-policy'], /script-src 'self'/);
  assert.match((await get('/app.js')).body, /visibilityState/);
});

test('dashboard: tasks filter, pagination, escaping', async () => {
  const all = await get('/tasks');
  assert.match(all.body, /Page 1 of 2 \(61 tasks\)/);
  assert.equal((all.body.match(/<tr class=/g) || []).length, 50, '50 rows per page');
  assert.match((await get('/tasks?page=2')).body, /Page 2 of 2/);
  assert.match((await get('/tasks?f=mine')).body, /\(21 tasks\)/);
  assert.match((await get('/tasks?f=others')).body, /\(20 tasks\)/);
  assert.match((await get('/tasks?due=nodate')).body, /\(11 tasks\)/);
  assert.match((await get('/tasks?f=bogus&due=x&page=-3')).body, /Page 1 of 2 \(61 tasks\)/, 'bad input falls back to defaults');
  assert.doesNotMatch(all.body, /<script>alert/);
  assert.match(all.body, /&lt;script&gt;alert/);
});

test('dashboard: reports list with skipped days, report view, favicon, logs', async () => {
  const day = (n) => localDay(Date.now() - n * 24 * 3600 * 1000);
  const list = (await get('/reports')).body;
  assert.match(list, new RegExp(`href="/reports/${day(3)}"`));
  assert.match(list, /Sent late/);
  assert.match(list, /Report skipped/);
  assert.match(list, /Waiting to send/);
  const view = await get(`/reports/${day(3)}`);
  assert.match(view.body, new RegExp(`<iframe class="report" sandbox="" src="/reports/${day(3)}/raw"`));
  const raw = await get(`/reports/${day(3)}/raw`);
  assert.match(raw.body, /<h1>Report<\/h1>/);
  assert.equal(raw.headers['content-security-policy'], "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'", 'no script runs in a report');
  assert.equal(raw.headers['x-frame-options'], 'SAMEORIGIN');
  assert.equal(view.headers['x-frame-options'], 'DENY');
  assert.equal((await get('/reports/2026-01-01')).code, 404);
  assert.equal((await get('/reports/../etc')).code, 404);
  const ico = await get('/favicon.ico');
  assert.equal(ico.code, 200);
  assert.equal(ico.headers['content-type'], 'image/x-icon');
  assert.match((await get('/logs')).body, /dashboard test line &lt;b&gt;/);
});

test('dashboard: changes only from the dashboard page (no cross-site requests)', async () => {
  const ok = { id: 1, title: 'x', assignee: 'me', due: null };
  assert.equal((await post('/api/tasks/update', ok, { origin: 'https://evil.example' })).code, 403, 'other origin');
  assert.equal((await post('/api/tasks/update', ok, { origin: '' })).code, 403, 'no origin');
  assert.equal((await post('/api/tasks/update', ok, { 'x-bot-action': '' })).code, 403, 'no custom header');
  assert.equal((await post('/api/tasks/update', ok, { 'content-type': 'text/plain' })).code, 403, 'form-like content type');
  assert.equal((await post('/api/tasks/update', ok, { 'sec-fetch-site': 'cross-site' })).code, 403, 'cross-site fetch');
  assert.equal((await post('/api/tasks/update', ok, {}, )).code, 200);
  assert.equal((await get('/api/tasks/update', { method: 'PUT' })).code, 405);
  assert.equal((await get('/tasks', { method: 'POST' })).code, 405, 'pages stay read-only');
});

test('dashboard: edit a task, with input checks', async () => {
  const id = store.db.prepare("SELECT id FROM tasks WHERE message_id = 'M15'").pluck().get();
  const before = syncs;
  const r = await post('/api/tasks/update', { id, title: 'Bring the lab record', assignee: 'Ravi', due: '2026-10-20T09:30' });
  assert.equal(r.code, 200, r.body);
  const t = store.s.taskById.get(id);
  assert.deepEqual([t.title, t.assignee, t.due, t.due_kind, t.flagged, t.event_dirty], ['Bring the lab record', 'Ravi', '2026-10-20T09:30', 'datetime', 0, 1]);
  assert.equal(syncs, before + 1, 'calendar sync starts at once');
  assert.equal((await post('/api/tasks/update', { id, title: 'x', assignee: 'me', due: null })).code, 200);
  assert.equal(store.s.taskById.get(id).due_kind, null);
  for (const bad of [
    { id, title: '', assignee: 'me' },
    { id, title: 'x'.repeat(201), assignee: 'me' },
    { id, title: 'ok', assignee: '' },
    { id, title: 'ok', assignee: 'me', due: '2026-02-30' },
    { id, title: 'ok', assignee: 'me', due: '2026-10-20T25:00' },
    { id, title: 'ok', assignee: 'me', due: 'tomorrow' },
    { id: 'abc', title: 'ok', assignee: 'me' },
  ]) assert.equal((await post('/api/tasks/update', bad)).code, 400, JSON.stringify(bad));
  assert.equal((await post('/api/tasks/update', { id: 99999, title: 'ok', assignee: 'me' })).code, 404);
  const big = await get('/api/tasks/update', { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json', 'x-bot-action': '1' }, body: JSON.stringify({ t: 'x'.repeat(20000) }) });
  assert.equal(big.code, 413);
});

test('dashboard: select many, mark done, delete, restore', async () => {
  const ids = store.db.prepare("SELECT id FROM tasks WHERE message_id IN ('M20', 'M21', 'M22') ORDER BY id").pluck().all();
  const count = async (q) => Number(/\((\d+) tasks\)/.exec((await get(`/tasks?${q}`)).body)[1]);
  const open0 = await count('s=open');
  let r = JSON.parse((await post('/api/tasks/bulk', { action: 'done', ids })).body);
  assert.equal(r.changed, 3);
  assert.equal(await count('s=open'), open0 - 3);
  assert.equal(await count('s=done'), 3);
  assert.match((await get('/tasks?s=done')).body, /<tr class="done"/);
  r = JSON.parse((await post('/api/tasks/bulk', { action: 'done', ids })).body);
  assert.equal(r.changed, 0, 'done twice changes nothing');
  r = JSON.parse((await post('/api/tasks/bulk', { action: 'delete', ids: [ids[0], ids[1]] })).body);
  assert.equal(r.changed, 2);
  assert.equal(await count('s=deleted'), 2);
  assert.equal(await count('s=all'), (await count('s=open')) + (await count('s=done')), '"All" leaves out deleted tasks');
  assert.match((await get('/tasks?s=deleted')).body, /data-act="restore"/);
  r = JSON.parse((await post('/api/tasks/bulk', { action: 'restore', ids: [ids[0]] })).body);
  assert.equal(r.changed, 1);
  assert.equal(store.s.taskById.get(ids[0]).status, 'open');
  for (const bad of [{ action: 'nuke', ids }, { action: 'delete', ids: [] }, { action: 'delete', ids: ['1'] }, { action: 'delete', ids: Array(501).fill(1) }]) {
    assert.equal((await post('/api/tasks/bulk', bad)).code, 400, JSON.stringify(bad).slice(0, 60));
  }
});

test('dashboard: failure pages explain the problem and offer a way on', async () => {
  const nf = await get('/no-such-page');
  assert.equal(nf.code, 404);
  assert.match(nf.body, /Page not found/);
  assert.match(nf.body, /class="nav"/, 'the normal frame with navigation');
  const rep = await get('/reports/2020-01-01');
  assert.equal(rep.code, 404);
  assert.match(rep.body, /Report not found/);
  assert.match(rep.body, /href="\/reports"/);
  const api = await get('/api/nothing');
  assert.equal(api.code, 404);
  assert.equal(JSON.parse(api.body).error, 'Not found');
  const host = await get('/', { host: 'evil.example' });
  assert.equal(host.code, 403);
  assert.match(host.body, /Address not allowed/);
  assert.doesNotMatch(host.body, /Task \d/, 'no data on the refusal page');
  const put = await get('/tasks', { method: 'DELETE' });
  assert.equal(put.code, 405);
  assert.match(put.body, /Not available/);
});

test('dashboard: the status API never removes the live pairing code', async () => {
  const live = (await import('../src/status.js')).status;
  live.whatsapp.pairingCode = 'ABCD-1234';
  const r = JSON.parse((await get('/api/status')).body);
  assert.equal(r.whatsapp.pairingCode, undefined, 'the code is not in the status answer');
  assert.equal(live.whatsapp.pairingCode, 'ABCD-1234', 'but it stays in the live state for /api/setup');
  delete live.whatsapp.pairingCode;
});

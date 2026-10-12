// Release features: guided setup, Ollama install, About page, launcher start.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { loadConfig, loadEnv, VERSION } from '../src/config.js';
import { openStore } from '../src/store.js';
import { createLogger } from '../src/log.js';
import { createSetup } from '../src/setup.js';
import { createDashboard } from '../src/dashboard.js';

const PORT = 47871;
const TOKEN = 'ef'.repeat(32);
const dir = mkdtempSync(join(tmpdir(), 'wabot-release-'));
const paths = { config: join(dir, 'config.json'), env: join(dir, '.env'), key: join(dir, 'keys', 'sa.json') };
const config = { ...loadConfig(paths.config), dashboardPort: PORT };
const env = loadEnv(paths.env, {});
const store = openStore(join(dir, 'r.db'));
const log = createLogger({ dir, echo: false });
const status = { whatsapp: { state: 'not linked' } };
const quiet = { info() {}, warn() {}, error() {} };
let installs = 0;
let finishInstall;

function makeSetup(extra = {}) {
  return createSetup({
    store, config, env, status, log: quiet, port: PORT, token: TOKEN, paths, shortcutDir: dir,
    reader: { isLinked: () => false, isPairing: () => false, link() {} },
    calendar: { reset() {}, testWrite: async () => {}, sync: async () => {} },
    mailer: { sendTest: async () => {} },
    fetchFn: async () => { throw new Error('offline'); }, // Ollama is not running
    runOllamaInstall: () => { installs++; return new Promise((resolve) => { finishInstall = resolve; }); },
    ...extra,
  });
}
const setup = makeSetup();
let dash;

function get(path, { method = 'GET', headers = {}, body = null, cookie = `wtb_session=${TOKEN}` } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: PORT, path, method, headers: { host: `localhost:${PORT}`, ...(cookie ? { cookie } : {}), ...headers } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c)).on('end', () => resolve({ code: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject).end(body);
  });
}
const post = (path, json) => get(path, {
  method: 'POST',
  headers: { origin: `http://localhost:${PORT}`, 'content-type': 'application/json', 'x-bot-action': '1', 'sec-fetch-site': 'same-origin' },
  body: JSON.stringify(json),
});

before(async () => {
  dash = createDashboard({ store, config, status, log, dbFile: join(dir, 'r.db'), token: TOKEN, setup });
  await dash.start();
});
after(() => { dash.stop(); store.close(); log.close(); });

test('release: the access link opens the guided setup until it is finished or skipped', async () => {
  const first = await get(`/login?t=${TOKEN}`, { cookie: '' });
  assert.equal(first.code, 302);
  assert.equal(first.headers.location, '/welcome');
  assert.equal((await get('/welcome', { cookie: '' })).code, 401, 'the guided setup needs the token');
  const page = await get('/welcome');
  assert.equal(page.code, 200);
  assert.match(page.body, /id="journey"/);
  assert.equal((await post('/api/setup/onboarding', { state: 'maybe' })).code, 400);
  assert.equal((await post('/api/setup/onboarding', { state: 'skipped' })).code, 200);
  assert.equal(JSON.parse((await get('/api/setup')).body).onboarding, 'skipped');
  assert.equal((await get(`/login?t=${TOKEN}`, { cookie: '' })).headers.location, '/', 'skipped: no guided setup again');
});

test('release: Install Ollama runs once at a time and reports progress', async () => {
  let st = JSON.parse((await get('/api/setup')).body);
  assert.equal(st.ollama.reachable, false);
  assert.equal(st.ollama.install.available, true);
  assert.equal((await post('/api/setup/ollama-install', {})).code, 200);
  assert.equal((await post('/api/setup/ollama-install', {})).code, 200);
  assert.equal(installs, 1, 'a second click does not start a second install');
  st = JSON.parse((await get('/api/setup')).body);
  assert.equal(st.ollama.install.running, true);
  finishInstall();
  await new Promise((r) => setTimeout(r, 20));
  st = JSON.parse((await get('/api/setup')).body);
  assert.equal(st.ollama.install.running, false);
  assert.equal(st.ollama.install.done, true);
  const none = makeSetup({ runOllamaInstall: null });
  await assert.rejects(none.act('ollama-install', {}), { code: 400 });
});

test('release: a copy started by the launcher does not count as Start with Windows', async () => {
  assert.equal((await makeSetup({ isBackground: true }).state()).autostart.enabled, true, 'Task Scheduler copy');
  assert.equal((await makeSetup({ isBackground: true, launched: true }).state()).autostart.enabled, false, 'launcher copy');
});

test('release: About page shows the version, the author, and issue links', async () => {
  assert.equal((await get('/about', { cookie: '' })).code, 401);
  const about = await get('/about');
  assert.equal(about.code, 200);
  assert.match(about.body, new RegExp(`Version ${VERSION.replace(/\./g, '\\.')}`));
  assert.match(about.body, /Bhargavaram Krishnapur/);
  assert.match(about.body, /issues\/new\?template=bug_report\.yml/);
  assert.match(about.body, /issues\/new\?template=feature_request\.yml/);
  assert.doesNotMatch(about.body, new RegExp(TOKEN), 'no token in the page');
  assert.match((await get('/')).body, /href="\/about"/, 'the sidebar links to About');
});

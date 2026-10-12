// Setup wizard and Settings page. The person sets up everything in the browser:
// name, Ollama model, WhatsApp link, Google Calendar, Gmail, autostart, shortcut.
// Secrets go in .env and keys/ (git-ignored) and are never sent back to the browser.
import { existsSync, readFileSync } from 'node:fs';
import { config as liveConfig, env as liveEnv, saveConfig, saveEnv, saveKeyFile, validEmail, validCalendarId, validAppPassword, normalizeAppPassword, CONFIG_FILE, ENV_FILE, KEY_FILE } from './config.js';
import { writeShortcut, desktopDir, SHORTCUT_NAME } from './access.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const httpError = (code, message) => Object.assign(new Error(message), { code });
const LINK_COOLDOWN_MS = 60 * 1000; // WhatsApp limits pairing code requests

export function createSetup({ store, config = liveConfig, env = liveEnv, status, log, reader, calendar, mailer, port, token, onProfileSaved = () => {}, onLinked = () => {}, runAutostartScript = null, isBackground = false, requestExit = () => {}, fetchFn = fetch, paths = {}, shortcutDir = undefined }) {
  const files = { config: CONFIG_FILE, env: ENV_FILE, key: KEY_FILE, ...paths }; // tests use a temporary folder
  const pull = { running: false, status: '', completed: 0, total: 0, error: null };
  let linkError = null;
  let lastLinkAt = 0;

  // ---- state shown in the wizard (no secrets) ----
  async function ollamaState() {
    try {
      const r = await fetchFn(`${config.ollama.url}/api/tags`, { signal: AbortSignal.timeout(2000) });
      const names = (await r.json()).models?.map((m) => m.name) ?? [];
      const m = config.ollama.model;
      return { reachable: true, hasModel: names.some((n) => n === m || n === `${m}:latest`), model: m, pull };
    } catch {
      return { reachable: false, hasModel: false, model: config.ollama.model, pull };
    }
  }

  function keyEmail() {
    try {
      return env.googleKeyFile && existsSync(env.googleKeyFile) ? JSON.parse(readFileSync(env.googleKeyFile, 'utf8')).client_email ?? null : null;
    } catch {
      return null;
    }
  }

  // A step also counts as done when real use proves it: an event written after the
  // last calendar change, or a report sent after the last Gmail change.
  const num = (k) => Number(store.kvGet(k)) || 0;
  const calendarWorks = () => !!store.kvGet('setupCalendarOk') || (num('lastCalendarWriteAt') > num('calendarChangedAt') && !!env.calendarId);
  const emailWorks = () => !!store.kvGet('setupEmailOk') || (!!store.kvGet('lastEmailDate') && !store.kvGet('gmailChangedAt'));

  async function state() {
    const ollama = await ollamaState();
    const linked = reader.isLinked();
    const s = {
      profile: { done: !!config.myName, myName: config.myName, aliases: config.aliases, emailTime: config.emailTime },
      ollama,
      whatsapp: { linked, state: status.whatsapp.state, pairing: reader.isPairing(), code: status.whatsapp.pairingCode ?? null, error: linkError, waitSec: Math.max(0, Math.ceil((lastLinkAt + LINK_COOLDOWN_MS - Date.now()) / 1000)) },
      google: { serviceEmail: keyEmail(), calendarId: env.calendarId || '', tested: calendarWorks() },
      gmail: { user: env.gmailUser || '', passwordSet: !!env.gmailAppPassword, tested: emailWorks() },
      autostart: { enabled: store.kvGet('autostart') === '1' || isBackground, background: isBackground },
      shortcut: { exists: !!desktopDir() && existsSync(`${desktopDir()}/${SHORTCUT_NAME}`) },
    };
    s.ready = s.profile.done && linked && ollama.hasModel;
    return s;
  }

  // ---- actions ----
  const asList = (v, max = 50) => (Array.isArray(v) ? v : String(v ?? '').split(/[,\n]/)).map((x) => String(x).trim()).filter(Boolean).slice(0, max);

  function saveProfile(b) {
    const myName = String(b.myName ?? '').trim();
    if (!myName) throw httpError(400, 'Write your name as it shows in WhatsApp.');
    try {
      saveConfig({ myName, aliases: asList(b.aliases, 20), emailTime: b.emailTime || config.emailTime }, config, files.config);
    } catch (err) {
      throw httpError(400, err.message);
    }
    log.info('setup: profile saved');
    onProfileSaved();
    return { ok: true };
  }

  function saveSettings(b) {
    const num = (v) => (v === '' || v == null ? undefined : Number(v));
    const patch = {
      myName: String(b.myName ?? config.myName).trim(),
      aliases: asList(b.aliases, 20),
      ignoredChats: asList(b.ignoredChats, 500),
      taskWords: asList(b.taskWords),
      everyoneWords: asList(b.everyoneWords),
      emailTime: b.emailTime,
      batchIntervalMinutes: num(b.batchIntervalMinutes),
      skipThreshold: num(b.skipThreshold),
      confidenceThreshold: num(b.confidenceThreshold),
      includeOriginalMessage: b.includeOriginalMessage === true || b.includeOriginalMessage === 'true',
      retention: { messageHours: num(b.messageHours), processedDays: num(b.processedDays), reportDays: num(b.reportDays) },
    };
    for (const k of Object.keys(patch)) if (patch[k] === undefined) delete patch[k];
    for (const k of Object.keys(patch.retention)) if (patch.retention[k] === undefined) delete patch.retention[k];
    try {
      saveConfig(patch, config, files.config);
    } catch (err) {
      throw httpError(400, err.message);
    }
    log.info('setup: settings saved');
    onProfileSaved();
    return { ok: true };
  }

  async function pullModel() {
    if (pull.running) return { ok: true };
    Object.assign(pull, { running: true, status: 'starting', completed: 0, total: 0, error: null });
    (async () => {
      try {
        const res = await fetchFn(`${config.ollama.url}/api/pull`, { method: 'POST', body: JSON.stringify({ model: config.ollama.model, stream: true }) });
        if (!res.ok) throw new Error(`Ollama answered ${res.status}`);
        const reader2 = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done, value } = await reader2.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (!line) continue;
            const j = JSON.parse(line);
            if (j.error) throw new Error(j.error);
            pull.status = j.status ?? pull.status;
            if (j.total) { pull.total = j.total; pull.completed = j.completed ?? 0; }
          }
        }
        pull.status = 'done';
        log.info('setup: model downloaded');
      } catch (err) {
        pull.error = err.message;
        log.error('setup: model download failed', { err: err.message });
      } finally {
        pull.running = false;
      }
    })();
    return { ok: true };
  }

  function link(b) {
    const phone = String(b.phone ?? '').replace(/[\s()+-]/g, '');
    if (!/^\d{8,15}$/.test(phone)) throw httpError(400, 'Write the phone number with the country code, for example 919876543210.');
    if (reader.isLinked()) throw httpError(400, 'WhatsApp is already linked.');
    const wait = lastLinkAt + LINK_COOLDOWN_MS - Date.now();
    if (wait > 0) throw httpError(429, `Wait ${Math.ceil(wait / 1000)} seconds before you ask for a new code.`);
    lastLinkAt = Date.now();
    linkError = null;
    status.whatsapp.pairingCode = null;
    reader.link(phone, {
      onCode: (code) => { status.whatsapp.pairingCode = `${code.slice(0, 4)}-${code.slice(4)}`; },
      onFail: () => {
        status.whatsapp.pairingCode = null;
        linkError = 'The link did not finish: the code expired, or the phone refused it. Ask for a new code.';
      },
      onLinked: () => {
        status.whatsapp.pairingCode = null;
        log.info('setup: WhatsApp linked');
        onLinked();
      },
    });
    log.info('setup: pairing code requested');
    return { ok: true };
  }

  function googleKey(b) {
    let out;
    try {
      out = saveKeyFile(String(b.text ?? ''), env, files.key, files.env);
    } catch (err) {
      throw httpError(400, err.message);
    }
    calendar.reset();
    store.kvSet('setupCalendarOk', '');
    log.info('setup: service account key saved');
    return { ok: true, serviceEmail: keyEmail(), file: !!out.googleKeyFile };
  }

  function calendarId(b) {
    const id = String(b.calendarId ?? '').trim();
    if (!validCalendarId(id)) throw httpError(400, 'This is not a Calendar ID. It looks like "...@group.calendar.google.com".');
    if (id !== env.calendarId) {
      if (env.calendarId) store.s.resetEvents.run(); // events of the old calendar stay there
      saveEnv({ calendarId: id }, env, files.env);
      store.kvSet('setupCalendarOk', '');
      store.kvSet('calendarChangedAt', Date.now());
      calendar.reset();
      log.info('setup: calendar id saved');
    }
    return { ok: true };
  }

  async function calendarTest() {
    try {
      await calendar.testWrite();
    } catch (err) {
      throw httpError(400, err.message);
    }
    store.kvSet('setupCalendarOk', String(Date.now()));
    calendar.sync().catch(() => {});
    return { ok: true };
  }

  function gmail(b) {
    const user = String(b.gmailUser ?? '').trim();
    const pass = normalizeAppPassword(b.gmailAppPassword);
    if (!validEmail(user)) throw httpError(400, 'Write a valid Gmail address.');
    if (!pass && !(env.gmailAppPassword && user === env.gmailUser)) throw httpError(400, 'Paste the 16-letter App Password.');
    if (pass && !validAppPassword(pass)) throw httpError(400, 'An App Password has 16 letters.');
    saveEnv(pass ? { gmailUser: user, gmailAppPassword: pass } : { gmailUser: user }, env, files.env);
    store.kvSet('setupEmailOk', '');
    store.kvSet('gmailChangedAt', Date.now());
    log.info('setup: gmail saved');
    return { ok: true };
  }

  async function emailTest() {
    try {
      await mailer.sendTest();
    } catch (err) {
      const auth = /EAUTH|535|Username and Password not accepted/i.test(`${err.code} ${err.message}`);
      throw httpError(400, auth ? 'Gmail refused the address or the App Password. Make a new App Password and paste it again.' : `The email was not sent: ${err.message}`);
    }
    store.kvSet('setupEmailOk', String(Date.now()));
    return { ok: true };
  }

  async function autostart() {
    if (!runAutostartScript) throw httpError(400, 'Autostart is available on Windows only.');
    try {
      await runAutostartScript();
    } catch (err) {
      log.error('setup: autostart failed', { err: err.message });
      throw httpError(500, 'Task Scheduler refused the task. See the log page.');
    }
    store.kvSet('autostart', '1');
    log.info('setup: autostart registered');
    // This copy runs in a console. The task starts the background copy within a
    // minute, after this one stops and frees the port.
    if (!isBackground) requestExit();
    return { ok: true, handover: !isBackground };
  }

  function shortcut() {
    const file = writeShortcut(port, token, shortcutDir);
    if (!file) throw httpError(400, 'No desktop folder was found.');
    return { ok: true };
  }

  const ACTIONS = { profile: saveProfile, settings: saveSettings, 'ollama-pull': pullModel, link, 'google-key': googleKey, 'calendar-id': calendarId, 'calendar-test': calendarTest, gmail, 'email-test': emailTest, autostart, shortcut };

  async function act(name, body) {
    const f = ACTIONS[name];
    if (!f) throw httpError(404, 'Unknown setup action');
    return f(body ?? {});
  }

  return { state, act, settingsBody: () => settingsBody(config), setupBody };
}

// ---- pages (filled in by /setup.js in the browser) ----
function setupBody() {
  return '<div id="setup" class="steps"><div class="panel"><div class="empty">Loading...</div></div></div><div class="toast" id="toast" hidden></div>';
}

function settingsBody(c) {
  const field = (id, label, value, hint = '', type = 'text', extra = '') => `<div class="field"><label for="${id}">${label}</label><input id="${id}" name="${id}" type="${type}" value="${esc(value)}" ${extra}>${hint ? `<span class="hint">${hint}</span>` : ''}</div>`;
  const area = (id, label, list, hint) => `<div class="field"><label for="${id}">${label}</label><textarea id="${id}" name="${id}" rows="3">${esc(list.join('\n'))}</textarea><span class="hint">${hint}</span></div>`;
  const sec = (title, desc, body) => `<div class="form-sec"><div><h2>${title}</h2><p class="desc">${desc}</p></div><div>${body}</div></div>`;
  return `<form id="settings-form" class="panel"><div class="panel-b">
${sec('Your names', 'The bot marks messages that use these names.', field('myName', 'Your name in WhatsApp', c.myName, '', 'text', 'maxlength="80" required') + area('aliases', 'Other names', c.aliases, 'One name on each line.'))}
${sec('Messages', 'Which chats the bot reads, and which words mark a possible task.', area('ignoredChats', 'Chats to ignore', c.ignoredChats, 'One chat name or chat ID on each line. The bot does not read these chats.') + area('taskWords', 'Task words', c.taskWords, 'For example "deadline". One word or phrase on each line.') + area('everyoneWords', 'Group words', c.everyoneWords, 'Words that mark a task for the whole group.'))}
${sec('Timing', 'When the bot checks for messages and sends the report.', `<div class="row2">${field('emailTime', 'Daily report time', c.emailTime, '', 'time', 'required')}${field('batchIntervalMinutes', 'Check every (minutes)', c.batchIntervalMinutes, '', 'number', 'min="1" max="1440" required')}</div><div class="row2">${field('skipThreshold', 'Quiet chats wait for', c.skipThreshold, 'Messages, before the bot reads them.', 'number', 'min="1" max="1000" required')}${field('confidenceThreshold', 'Low-confidence limit', c.confidenceThreshold, 'From 0 to 1. Tasks below it get "?".', 'number', 'min="0" max="1" step="0.05" required')}</div><label class="check"><input type="checkbox" id="includeOriginalMessage" ${c.includeOriginalMessage ? 'checked' : ''}> Put the original message in the calendar event</label>`)}
${sec('Data retention', 'How long the bot keeps data on this computer. Tasks stay until you delete them.', `<div class="row2">${field('messageHours', 'Message text (hours)', c.retention.messageHours, '', 'number', 'min="1" required')}${field('reportDays', 'Reports (days)', c.retention.reportDays, '', 'number', 'min="1" required')}</div>${field('processedDays', 'Processed message IDs (days)', c.retention.processedDays, '', 'number', 'min="1" required')}`)}
<div class="form-actions"><button type="submit" class="btn primary">Save settings</button></div>
</div></form>
<p class="hint">Secrets (Google key, Calendar ID, Gmail) are on the <a href="/setup">Setup</a> page. The port and the Ollama model are in config.json and need a restart.</p>
<div class="toast" id="toast" hidden></div>`;
}

// ---- browser script for /setup and /settings ----
export const SETUP_JS = String.raw`(() => {
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const toast = (m, bad) => { const t = $('toast'); if (!t) return; t.textContent = m; t.className = 'toast' + (bad ? ' bad' : ''); t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 6000); };
async function post(action, body) {
  let r;
  try { r = await fetch('/api/setup/' + action, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bot-action': '1' }, body: JSON.stringify(body || {}) }); }
  catch (e) { throw new Error('The bot does not answer. Make sure that it operates, and try again.'); }
  if (r.status === 401) { location.reload(); throw new Error('Access link needed.'); }
  let j = {}; try { j = await r.json(); } catch (e) {}
  if (!r.ok) throw new Error(j.error || ('Error ' + r.status));
  return j;
}

// Settings page
const form = $('settings-form');
if (form) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = (id) => $(id).value;
    try {
      await post('settings', { myName: v('myName'), aliases: v('aliases'), ignoredChats: v('ignoredChats'), taskWords: v('taskWords'), everyoneWords: v('everyoneWords'), emailTime: v('emailTime'), batchIntervalMinutes: v('batchIntervalMinutes'), skipThreshold: v('skipThreshold'), confidenceThreshold: v('confidenceThreshold'), includeOriginalMessage: $('includeOriginalMessage').checked, messageHours: v('messageHours'), processedDays: v('processedDays'), reportDays: v('reportDays') });
      toast('Saved. The new settings apply at once.');
    } catch (err) { toast(err.message, true); }
  });
  return;
}

const root = $('setup');
if (!root) return;
let s = null;
const badge = (done, optional) => done ? '<span class="badge ok">Complete</span>' : optional ? '<span class="badge">Optional</span>' : '<span class="badge warn">Required</span>';
const CHECK = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 5 5 9-10"/></svg>';
const opened = new Set(); // steps that the person opened or closed by hand stay that way
const step = (n, title, done, body, optional, summary) => {
  const id = 'step' + n;
  const open = opened.has(id) ? opened.has(id + ':open') : !done;
  return '<details class="step' + (done ? ' done' : '') + '" id="' + id + '"' + (open ? ' open' : '') + '><summary><span class="sn">' + (done ? CHECK : n) + '</span><span class="st-title">' + title + '</span>' + (summary ? '<span class="st-sum">' + summary + '</span>' : '') + '<span class="st-right">' + badge(done, optional) + '</span></summary><div class="step-b">' + body + '</div></details>';
};
const FAIL_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M12 8v5M12 16.5v.5"/><circle cx="12" cy="12" r="9"/></svg>';
const ext = (href, text) => '<a href="' + href + '" target="_blank" rel="noopener noreferrer">' + text + '</a> &#8599;';
const copy = (text) => '<span class="copy"><code>' + esc(text) + '</code><button type="button" class="btn sm" data-copy="' + esc(text) + '">Copy</button></span>';

function render() {
  const p = s.profile, o = s.ollama, w = s.whatsapp, g = s.google, m = s.gmail;
  let html = s.ready ? '<div class="callout ok"><span>Setup complete. The bot reads WhatsApp and finds tasks.</span><a class="btn sm" href="/">Open Status</a></div>' : '';

  html += step(1, 'Your name', p.done,
    '<p class="sub">The bot uses your name to find messages for you.</p><form data-form="profile"><div class="row2"><div class="field"><label>Your name as it shows in WhatsApp</label><input name="myName" maxlength="80" value="' + esc(p.myName) + '" required></div><div class="field"><label>Daily report time</label><input name="emailTime" type="time" value="' + esc(p.emailTime) + '" required></div></div><div class="field"><label>Other names for you</label><input name="aliases" value="' + esc((p.aliases || []).join(', ')) + '" placeholder="For example: Alex, Al"><span class="hint">Put a comma between names.</span></div><button class="btn primary">Save</button></form>', false, p.done ? esc(p.myName) : '');

  let ob;
  if (!o.reachable) ob = '<p>Ollama is not running. Ollama runs the language model on this computer, so your messages stay here.</p><ol><li>Install it: ' + ext('https://ollama.com/download', 'ollama.com/download') + ', or in PowerShell: ' + copy('winget install --id Ollama.Ollama -e') + '</li><li>Start Ollama from the Start menu.</li></ol><button class="btn" data-act="refresh">Check again</button>';
  else if (!o.hasModel) {
    const pc = o.pull.total ? Math.floor(100 * o.pull.completed / o.pull.total) : 0;
    ob = o.pull.running ? '<p>Downloading ' + esc(o.model) + ': ' + esc(o.pull.status) + '</p><div class="bar"><span style="width:' + pc + '%"></span></div><p class="sub">' + pc + '%. You can leave this page open.</p>'
      : '<p>Ollama runs. The model ' + esc(o.model) + ' is not downloaded yet (about 4.7 GB).</p>' + (o.pull.error ? '<p class="bad-text">The download failed: ' + esc(o.pull.error) + '</p>' : '') + '<button class="btn primary" data-act="ollama-pull">Download the model</button>';
  } else ob = '<p>Ollama runs, and the model ' + esc(o.model) + ' is ready.</p>';
  html += step(2, 'Language model', o.hasModel, ob, false, o.hasModel ? esc(o.model) + ' on Ollama' : '');

  let wb;
  if (w.linked) wb = '<p>WhatsApp is linked. The bot only reads. It never sends a message.</p>';
  else if (w.code) wb = '<p>On your phone: open WhatsApp, then <b>Linked devices</b>, <b>Link a device</b>, and <b>Link with phone number instead</b>. Type this code:</p><div class="code">' + esc(w.code) + '</div><p class="hint">Waiting for your phone. The code is valid for about 2 minutes.</p>';
  else if (w.pairing) wb = '<p class="sub">Requesting a code from WhatsApp...</p>';
  else wb = '<p>Link this bot to your WhatsApp as a linked device. The bot is not an official WhatsApp client. It only reads, but WhatsApp can block accounts that use unofficial clients.</p>' + (w.error ? '<p class="bad-text">' + esc(w.error) + '</p>' : '') + '<form data-form="link" class="inline"><div class="field"><label>Your phone number with the country code (digits only)</label><input name="phone" inputmode="numeric" maxlength="20" placeholder="919876543210" required></div><button class="btn primary"' + (w.waitSec ? ' disabled' : '') + '>Get pairing code' + (w.waitSec ? ' (' + w.waitSec + ' s)' : '') + '</button></form>';
  html += step(3, 'WhatsApp', w.linked, wb, false, w.linked ? 'Linked, read-only' : '');

  let gb = '<p class="sub">The bot writes your tasks to a calendar of its own, with a Google service account (a Google account for a program).</p>';
  if (!g.serviceEmail) {
    gb += '<ol class="howto"><li>' + ext('https://console.cloud.google.com/projectcreate', 'Make a Google Cloud project') + ' (any name, for example "whatsapp-task-bot"). Wait until it is selected at the top.</li>'
      + '<li>' + ext('https://console.cloud.google.com/apis/library/calendar-json.googleapis.com', 'Enable the Google Calendar API') + '.</li>'
      + '<li>' + ext('https://console.cloud.google.com/iam-admin/serviceaccounts/create', 'Make a service account') + '. No role is necessary. Click "Done".</li>'
      + '<li>Open the new account, then "Keys", "Add key", "Create new key", "JSON". The browser downloads a key file.</li>'
      + '<li>Choose that file here: <input type="file" id="keyfile" accept=".json,application/json"></li></ol>'
      + '<p class="sub">The key stays on this computer, in the keys folder. After the upload, delete the file from your Downloads folder.</p>';
  } else {
    gb += '<p>Key loaded. Service account: ' + copy(g.serviceEmail) + '</p>'
      + '<ol class="howto"><li>' + ext('https://calendar.google.com/calendar/r/settings/createcalendar', 'Make a new calendar') + ' named "WhatsApp Tasks".</li>'
      + '<li>In its settings, under "Share with specific people", add the service account email above with "Make changes to events".</li>'
      + '<li>Under "Event notifications", add reminders, for example 1 day, 1 hour, and 0 minutes before. A new calendar has none.</li>'
      + '<li>Under "Integrate calendar", copy the Calendar ID and paste it here:</li></ol>'
      + '<form data-form="calendar-id" class="inline"><div class="field"><label>Calendar ID</label><input name="calendarId" value="' + esc(g.calendarId) + '" placeholder="...@group.calendar.google.com" required></div><button class="btn">Save</button></form>'
      + (g.calendarId ? '<p><button class="btn primary" data-act="calendar-test">Make a test event</button> <span class="sub">The bot makes one event for tomorrow and removes it at once.</span></p>' : '')
      + '<p class="sub">Another key: <input type="file" id="keyfile" accept=".json,application/json"></p>';
  }
  html += step(4, 'Google Calendar', g.tested, gb, !g.tested, g.tested ? 'Events go to your calendar' : '');

  const mb = '<p class="sub">The daily report comes by email. Gmail needs an App Password (a 16-letter password for one program) and 2-Step Verification.</p>'
    + '<ol class="howto"><li>' + ext('https://myaccount.google.com/apppasswords', 'Make an App Password') + ' with the name "whatsapp-task-bot".</li><li>Paste it here.</li></ol>'
    + '<form data-form="gmail"><div class="row2"><div class="field"><label>Gmail address</label><input name="gmailUser" type="email" value="' + esc(m.user) + '" required></div><div class="field"><label>App Password' + (m.passwordSet ? ' (saved; paste only to change it)' : '') + '</label><input name="gmailAppPassword" type="password" autocomplete="off" placeholder="xxxx xxxx xxxx xxxx"' + (m.passwordSet ? '' : ' required') + '></div></div><button class="btn">Save</button></form>'
    + (m.user && m.passwordSet ? '<p><button class="btn primary" data-act="email-test">Send a test email</button></p>' : '');
  html += step(5, 'Daily email', m.tested, mb, !m.tested, m.tested ? esc(m.user) : '');

  const a = s.autostart;
  const fb = '<p>' + (a.enabled ? 'The bot starts by itself when you log on to Windows, with no window.' : '<button class="btn primary" data-act="autostart">Start the bot with Windows</button> <span class="sub">Task Scheduler starts it at each log on and again within 5 minutes if it stops.</span>') + '</p>'
    + '<p>' + (s.shortcut.exists ? 'The desktop has a "WhatsApp Task Bot" shortcut to this dashboard.' : '<button class="btn" data-act="shortcut">Put a shortcut on the desktop</button>') + '</p>';
  html += step(6, 'Start with Windows', a.enabled, fb, !a.enabled, a.enabled ? 'Starts at log on' : '');
  root.innerHTML = html;
}

async function load() {
  try {
    const r = await fetch('/api/setup');
    if (r.status === 401) { location.reload(); return; }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    s = await r.json(); render();
  } catch (e) {
    s = null;
    root.innerHTML = '<section class="panel"><div class="failure bad"><div class="fi">' + FAIL_ICON + '</div><h2>Connection to the bot lost</h2><p>The setup page cannot reach the bot. Make sure that it operates (the PowerShell window or the background task), and try again.</p><div class="acts"><button class="btn primary" data-act="refresh">Try again</button></div></div></section>';
  }
  const busy = s && (s.whatsapp.pairing || s.whatsapp.code || s.ollama.pull.running || s.whatsapp.waitSec);
  clearTimeout(load.t);
  load.t = setTimeout(() => { if (document.visibilityState === 'visible' && !document.activeElement?.closest('form')) load(); else load.t = setTimeout(load, 2000); }, busy ? 2500 : 15000);
}

root.addEventListener('submit', async (e) => {
  const f = e.target.closest('form[data-form]');
  if (!f) return;
  e.preventDefault();
  const body = Object.fromEntries(new FormData(f).entries());
  try { await post(f.dataset.form, body); toast('Saved.'); document.activeElement?.blur(); await load(); } catch (err) { toast(err.message, true); }
});
root.addEventListener('click', async (e) => {
  const c = e.target.closest('[data-copy]');
  if (c) { try { await navigator.clipboard.writeText(c.dataset.copy); toast('Copied.'); } catch (err) { toast('Select the text and copy it.', true); } return; }
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const act = b.dataset.act;
  if (act === 'refresh') return load();
  b.disabled = true;
  try {
    const r = await post(act, {});
    if (act === 'autostart' && r.handover) { toast('Done. This window stops now, and the bot continues in the background within about a minute.'); setTimeout(() => location.reload(), 70000); }
    else toast({ 'calendar-test': 'The test event worked. Google Calendar is ready.', 'email-test': 'Test email sent. Look in your inbox.', 'ollama-pull': 'Download started.', shortcut: 'Shortcut made.' }[act] || 'Done.');
    await load();
  } catch (err) { toast(err.message, true); b.disabled = false; }
});
// Only a click by the person counts. The browser also sends "toggle" for steps that the page opens.
root.addEventListener('click', (e) => {
  const sm = e.target.closest('summary');
  if (!sm) return;
  const d = sm.parentElement;
  setTimeout(() => { opened.add(d.id); if (d.open) opened.add(d.id + ':open'); else opened.delete(d.id + ':open'); }, 0);
});
root.addEventListener('change', (e) => {
  if (e.target.id !== 'keyfile' || !e.target.files[0]) return;
  const file = e.target.files[0];
  if (file.size > 10000) { toast('This file is too large for a key file.', true); return; }
  const rd = new FileReader();
  rd.onload = async () => { try { await post('google-key', { text: rd.result }); toast('Key saved.'); await load(); } catch (err) { toast(err.message, true); } };
  rd.readAsText(file);
});
load();
})();`;

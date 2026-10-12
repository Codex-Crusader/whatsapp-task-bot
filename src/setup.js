// Setup wizard and Settings page. The person sets up everything in the browser:
// name, Ollama model, WhatsApp link, Google Calendar, Gmail, autostart, shortcut.
// Secrets go in .env and keys/ (git-ignored) and are never sent back to the browser.
import { existsSync, readFileSync } from 'node:fs';
import { config as liveConfig, env as liveEnv, saveConfig, saveEnv, saveKeyFile, validEmail, validCalendarId, validAppPassword, normalizeAppPassword, CONFIG_FILE, ENV_FILE, KEY_FILE } from './config.js';
import { writeShortcut, desktopDir, SHORTCUT_NAME } from './access.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const httpError = (code, message) => Object.assign(new Error(message), { code });
const LINK_COOLDOWN_MS = 60 * 1000; // WhatsApp limits pairing code requests

export function createSetup({ store, config = liveConfig, env = liveEnv, status, log, reader, calendar, mailer, port, token, onProfileSaved = () => {}, onLinked = () => {}, runAutostartScript = null, runOllamaInstall = null, isBackground = false, launched = false, requestExit = () => {}, fetchFn = fetch, paths = {}, shortcutDir = undefined }) {
  const files = { config: CONFIG_FILE, env: ENV_FILE, key: KEY_FILE, ...paths }; // tests use a temporary folder
  const pull = { running: false, status: '', completed: 0, total: 0, error: null };
  const install = { running: false, done: false, error: null, available: !!runOllamaInstall };
  let linkError = null;
  let lastLinkAt = 0;

  // ---- state shown in the wizard (no secrets) ----
  async function ollamaState() {
    try {
      const r = await fetchFn(`${config.ollama.url}/api/tags`, { signal: AbortSignal.timeout(2000) });
      const names = (await r.json()).models?.map((m) => m.name) ?? [];
      const m = config.ollama.model;
      return { reachable: true, hasModel: names.some((n) => n === m || n === `${m}:latest`), model: m, pull, install };
    } catch {
      return { reachable: false, hasModel: false, model: config.ollama.model, pull, install };
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
      autostart: { enabled: store.kvGet('autostart') === '1' || (isBackground && !launched), background: isBackground },
      shortcut: { exists: !!desktopDir() && existsSync(`${desktopDir()}/${SHORTCUT_NAME}`) },
    };
    s.ready = s.profile.done && linked && ollama.hasModel;
    s.onboarding = store.kvGet('onboarding') || ''; // '', 'done' or 'skipped'
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
    const hadOriginal = config.includeOriginalMessage;
    try {
      saveConfig(patch, config, files.config);
    } catch (err) {
      throw httpError(400, err.message);
    }
    // The event text changed: rewrite the existing events, so that turning this off
    // also removes the message text that is already in Google Calendar.
    if (hadOriginal !== config.includeOriginalMessage) {
      const n = store.s.markEventsDirty.run().changes;
      log.info('setup: original message setting changed, events to rewrite', { events: n });
      calendar?.sync().catch((err) => log.error('setup: calendar sync failed', { err: err.message }));
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
    // This copy runs in a console or was started by the launcher, so Task Scheduler
    // does not own it. It stops and frees the port, and the task starts the
    // background copy within a minute. Without this, the task tries every 5 minutes.
    const handover = !isBackground || launched;
    if (handover) requestExit();
    return { ok: true, handover };
  }

  // Installs Ollama with winget (one fixed command, no input from the page).
  function ollamaInstall() {
    if (!runOllamaInstall) throw httpError(400, 'Automatic install is not available. Install Ollama from ollama.com/download.');
    if (install.running) return { ok: true };
    Object.assign(install, { running: true, error: null });
    log.info('setup: Ollama install started');
    runOllamaInstall()
      .then(() => { install.done = true; log.info('setup: Ollama installed'); })
      .catch((err) => {
        install.error = /ENOENT/.test(err.code ?? err.message) ? 'winget is not on this computer. Install Ollama from ollama.com/download.' : 'The install did not finish. Install Ollama from ollama.com/download.';
        log.error('setup: Ollama install failed', { err: String(err.message).slice(0, 200) });
      })
      .finally(() => { install.running = false; });
    return { ok: true };
  }

  // The guided setup: finished, or skipped by the person.
  function onboarding(b) {
    if (b.state !== 'done' && b.state !== 'skipped') throw httpError(400, 'Unknown state');
    store.kvSet('onboarding', b.state);
    log.info('setup: guided setup', { state: b.state });
    return { ok: true };
  }

  function shortcut() {
    const file = writeShortcut(port, token, shortcutDir);
    if (!file) throw httpError(400, 'No desktop folder was found.');
    return { ok: true };
  }

  const ACTIONS = { profile: saveProfile, settings: saveSettings, 'ollama-pull': pullModel, 'ollama-install': ollamaInstall, onboarding, link, 'google-key': googleKey, 'calendar-id': calendarId, 'calendar-test': calendarTest, gmail, 'email-test': emailTest, autostart, shortcut };

  async function act(name, body) {
    const f = ACTIONS[name];
    if (!f) throw httpError(404, 'Unknown setup action');
    return f(body ?? {});
  }

  return { state, act, settingsBody: () => settingsBody(config), setupBody, journeyBody };
}

// ---- pages (filled in by /setup.js in the browser) ----
const SKELETON = '<div class="panel skel-panel"><div class="skel w40"></div><div class="skel w70"></div><div class="skel w55"></div></div>';

function setupBody() {
  return `<div id="setup" class="steps" aria-busy="true">${SKELETON.repeat(3)}</div><div class="toast" id="toast" hidden></div>`;
}

// The guided setup has its own simple frame: one step on each screen.
function journeyBody() {
  return `<div id="journey" class="journey" aria-busy="true"><div class="j-card panel">${SKELETON}</div></div><div class="toast" id="toast" hidden></div>`;
}

function settingsBody(c) {
  const field = (id, label, value, hint = '', type = 'text', extra = '') => `<div class="field"><label for="${id}">${label}</label><input id="${id}" name="${id}" type="${type}" value="${esc(value)}" ${extra}>${hint ? `<span class="hint">${hint}</span>` : ''}</div>`;
  const area = (id, label, list, hint) => `<div class="field"><label for="${id}">${label}</label><textarea id="${id}" name="${id}" rows="3">${esc(list.join('\n'))}</textarea><span class="hint">${hint}</span></div>`;
  const sec = (title, desc, body) => `<div class="form-sec"><div><h2>${title}</h2><p class="desc">${desc}</p></div><div>${body}</div></div>`;
  return `<form id="settings-form" class="panel"><div class="panel-b">
${sec('Your names', 'The bot marks messages that use these names.', field('myName', 'Your name in WhatsApp', c.myName, '', 'text', 'maxlength="80" required') + area('aliases', 'Other names', c.aliases, 'One name on each line.'))}
${sec('Messages', 'Which chats the bot reads, and which words mark a possible task.', area('ignoredChats', 'Chats to ignore', c.ignoredChats, 'One chat name or chat ID on each line. The bot does not read these chats.') + area('taskWords', 'Task words', c.taskWords, 'For example "deadline". One word or phrase on each line.') + area('everyoneWords', 'Group words', c.everyoneWords, 'Words that mark a task for the whole group.'))}
${sec('Timing', 'When the bot checks for messages and sends the report.', `<div class="row2">${field('emailTime', 'Daily report time', c.emailTime, '', 'time', 'required')}${field('batchIntervalMinutes', 'Check every (minutes)', c.batchIntervalMinutes, '', 'number', 'min="1" max="1440" required')}</div><div class="row2">${field('skipThreshold', 'Quiet chats wait for', c.skipThreshold, 'Messages, before the bot reads them.', 'number', 'min="1" max="1000" required')}${field('confidenceThreshold', 'Low-confidence limit', c.confidenceThreshold, 'From 0 to 1. Tasks below it get a "Needs review" warning and "?" in the calendar.', 'number', 'min="0" max="1" step="0.05" required')}</div><label class="check"><input type="checkbox" id="includeOriginalMessage" ${c.includeOriginalMessage ? 'checked' : ''}> Put the original message in the calendar event</label><p class="hint">Off by default. When it is on, the full message text goes to Google. When you change it, the bot rewrites the events that already exist.</p>`)}
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

const root = $('setup') || $('journey');
if (!root) return;
const journey = root.id === 'journey';
let s = null;
const badge = (done, optional) => done ? '<span class="badge ok">Complete</span>' : optional ? '<span class="badge">Optional</span>' : '<span class="badge warn">Required</span>';
const CHECK = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 5 5 9-10"/></svg>';
const FAIL_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M12 8v5M12 16.5v.5"/><circle cx="12" cy="12" r="9"/></svg>';
const SPIN = '<span class="spin" aria-hidden="true"></span>';
const ext = (href, text) => '<a href="' + href + '" target="_blank" rel="noopener noreferrer">' + text + '</a> &#8599;';
const copy = (text) => '<span class="copy"><code>' + esc(text) + '</code><button type="button" class="btn sm" data-copy="' + esc(text) + '">Copy</button></span>';
const opened = new Set(); // steps that the person opened or closed by hand stay that way

// The six steps, built once, shown as a list (Setup) or one at a time (guided setup).
function stepsData() {
  const p = s.profile, o = s.ollama, w = s.whatsapp, g = s.google, m = s.gmail, a = s.autostart;
  const out = [];
  out.push({ title: 'Your name', intro: 'The bot uses your name to find the messages that are for you.', done: p.done, summary: p.done ? esc(p.myName) : '',
    body: '<form data-form="profile"><div class="row2"><div class="field"><label>Your name as it shows in WhatsApp</label><input name="myName" maxlength="80" value="' + esc(p.myName) + '" required></div><div class="field"><label>Daily report time</label><input name="emailTime" type="time" value="' + esc(p.emailTime) + '" required></div></div><div class="field"><label>Other names for you</label><input name="aliases" value="' + esc((p.aliases || []).join(', ')) + '" placeholder="For example: Alex, Al"><span class="hint">Put a comma between names.</span></div><button class="btn primary">Save</button></form>' });

  let ob;
  if (!o.reachable) {
    if (o.install.running) ob = '<p class="busy-line">' + SPIN + 'Installing Ollama. This can take a few minutes. Windows can ask for permission.</p>';
    else if (o.install.done) ob = '<p class="busy-line">' + SPIN + 'Ollama is installed and starts now. This takes a few seconds.</p><button class="btn" data-act="refresh">Check again</button>';
    else ob = '<p>Ollama runs the language model on this computer, so your messages stay here. It is not installed or not running.</p>'
      + (o.install.error ? '<p class="bad-text">' + esc(o.install.error) + '</p>' : '')
      + '<p>' + (o.install.available ? '<button class="btn primary" data-act="ollama-install">Install Ollama</button> ' : '') + '<button class="btn" data-act="refresh">Check again</button></p>'
      + (o.install.available ? '<p class="hint">The button installs Ollama with winget and accepts the Ollama license for you.</p>' : '')
      + '<p class="hint">Or install it yourself: ' + ext('https://ollama.com/download', 'ollama.com/download') + '. Then start Ollama from the Start menu.</p>';
  } else if (!o.hasModel) {
    const pc = o.pull.total ? Math.floor(100 * o.pull.completed / o.pull.total) : 0;
    ob = o.pull.running ? '<p class="busy-line">' + SPIN + 'Downloading ' + esc(o.model) + ': ' + esc(o.pull.status) + '</p><div class="bar"><span style="width:' + pc + '%"></span></div><p class="hint">' + pc + '%. You can leave this page open.</p>'
      : '<p>Ollama runs. The model ' + esc(o.model) + ' is not downloaded yet (about 4.7 GB).</p>' + (o.pull.error ? '<p class="bad-text">The download failed: ' + esc(o.pull.error) + '</p>' : '') + '<button class="btn primary" data-act="ollama-pull">Download the model</button>';
  } else ob = '<p>Ollama runs, and the model ' + esc(o.model) + ' is ready.</p>';
  out.push({ title: 'Language model', intro: 'A language model reads your messages and finds the tasks, on this computer.', done: o.hasModel, summary: o.hasModel ? esc(o.model) + ' on Ollama' : '', body: ob });

  let wb;
  if (w.linked) wb = '<p>WhatsApp is linked. The bot only reads. It never sends a message.</p>';
  else if (w.code) wb = '<p>On your phone: open WhatsApp, then <b>Linked devices</b>, <b>Link a device</b>, and <b>Link with phone number instead</b>. Type this code:</p><div class="code">' + esc(w.code) + '</div><p class="hint busy-line">' + SPIN + 'Waiting for your phone. The code is valid for about 2 minutes.</p>';
  else if (w.pairing) wb = '<p class="busy-line">' + SPIN + 'Requesting a code from WhatsApp...</p>';
  else wb = '<p class="hint">The bot is not an official WhatsApp client. It only reads, but WhatsApp can block accounts that use unofficial clients.</p>' + (w.error ? '<p class="bad-text">' + esc(w.error) + '</p>' : '') + '<form data-form="link" class="inline"><div class="field"><label>Your phone number with the country code (digits only)</label><input name="phone" inputmode="numeric" maxlength="20" placeholder="919876543210" required></div><button class="btn primary"' + (w.waitSec ? ' disabled' : '') + '>Get pairing code' + (w.waitSec ? ' (' + w.waitSec + ' s)' : '') + '</button></form>';
  out.push({ title: 'WhatsApp', intro: 'Link the bot to your WhatsApp as a linked device, the same way as WhatsApp Web.', done: w.linked, summary: w.linked ? 'Linked, read-only' : '', body: wb });

  let gb = '';
  if (!g.serviceEmail) {
    gb += '<ol class="howto"><li>' + ext('https://console.cloud.google.com/projectcreate', 'Make a Google Cloud project') + ' (any name, for example "whatsapp-task-bot"). Wait until it is selected at the top.</li>'
      + '<li>' + ext('https://console.cloud.google.com/apis/library/calendar-json.googleapis.com', 'Enable the Google Calendar API') + '.</li>'
      + '<li>' + ext('https://console.cloud.google.com/iam-admin/serviceaccounts/create', 'Make a service account') + '. No role is necessary. Click "Done".</li>'
      + '<li>Open the new account, then "Keys", "Add key", "Create new key", "JSON". The browser downloads a key file.</li>'
      + '<li>Choose that file here: <input type="file" id="keyfile" accept=".json,application/json"></li></ol>'
      + '<p class="hint">The key stays on this computer. After the upload, delete the file from your Downloads folder.</p>';
  } else {
    gb += '<p>Key loaded. Service account: ' + copy(g.serviceEmail) + '</p>'
      + '<ol class="howto"><li>' + ext('https://calendar.google.com/calendar/r/settings/createcalendar', 'Make a new calendar') + ' named "WhatsApp Tasks".</li>'
      + '<li>In its settings, under "Share with specific people", add the service account email above with "Make changes to events".</li>'
      + '<li>Under "Event notifications", add reminders, for example 1 day, 1 hour, and 0 minutes before. A new calendar has none.</li>'
      + '<li>Under "Integrate calendar", copy the Calendar ID and paste it here:</li></ol>'
      + '<form data-form="calendar-id" class="inline"><div class="field"><label>Calendar ID</label><input name="calendarId" value="' + esc(g.calendarId) + '" placeholder="...@group.calendar.google.com" required></div><button class="btn">Save</button></form>'
      + (g.calendarId ? '<p><button class="btn primary" data-act="calendar-test">Make a test event</button> <span class="hint">One event for tomorrow, removed at once.</span></p>' : '')
      + '<p class="hint">Another key: <input type="file" id="keyfile" accept=".json,application/json"></p>';
  }
  out.push({ title: 'Google Calendar', intro: 'Your tasks go to a calendar of their own, so your phone gives you reminders. The bot uses a Google service account (a Google account for a program).', done: g.tested, optional: !g.tested, summary: g.tested ? 'Events go to your calendar' : '', body: gb });

  const mb = '<ol class="howto"><li>' + ext('https://myaccount.google.com/apppasswords', 'Make an App Password') + ' with the name "whatsapp-task-bot". It needs 2-Step Verification.</li><li>Paste it here.</li></ol>'
    + '<form data-form="gmail"><div class="row2"><div class="field"><label>Gmail address</label><input name="gmailUser" type="email" value="' + esc(m.user) + '" required></div><div class="field"><label>App Password' + (m.passwordSet ? ' (saved; paste only to change it)' : '') + '</label><input name="gmailAppPassword" type="password" autocomplete="off" placeholder="xxxx xxxx xxxx xxxx"' + (m.passwordSet ? '' : ' required') + '></div></div><button class="btn">Save</button></form>'
    + (m.user && m.passwordSet ? '<p><button class="btn primary" data-act="email-test">Send a test email</button></p>' : '');
  out.push({ title: 'Daily email', intro: 'Each evening the bot emails you a short report. Gmail needs an App Password (a 16-letter password for one program).', done: m.tested, optional: !m.tested, summary: m.tested ? esc(m.user) : '', body: mb });

  const fb = '<p>' + (a.enabled ? 'The bot starts by itself when you log on to Windows, with no window.' : '<button class="btn primary" data-act="autostart">Start the bot with Windows</button>') + '</p>'
    + '<p>' + (s.shortcut.exists ? 'The desktop has a "WhatsApp Task Bot" shortcut to this dashboard.' : '<button class="btn" data-act="shortcut">Put a shortcut on the desktop</button>') + '</p>';
  out.push({ title: 'Start with Windows', intro: 'The bot operates in the background, starts at each log on, and starts again by itself if it stops.', done: a.enabled, optional: !a.enabled, summary: a.enabled ? 'Starts at log on' : '', body: fb });
  return out;
}

// ---- Setup page: all steps in a list ----
function renderList() {
  const steps = stepsData();
  let html = s.ready ? '<div class="callout ok"><span>Setup complete. The bot reads WhatsApp and finds tasks.</span><a class="btn sm" href="/">Open Status</a></div>'
    : '<div class="callout"><span>New here? The guided setup shows one step at a time.</span><a class="btn sm" href="/welcome">Start the guided setup</a></div>';
  steps.forEach((st, i) => {
    const id = 'step' + (i + 1);
    const open = opened.has(id) ? opened.has(id + ':open') : !st.done;
    html += '<details class="step' + (st.done ? ' done' : '') + '" id="' + id + '"' + (open ? ' open' : '') + '><summary><span class="sn">' + (st.done ? CHECK : i + 1) + '</span><span class="st-title">' + st.title + '</span>' + (st.summary ? '<span class="st-sum">' + st.summary + '</span>' : '') + '<span class="st-right">' + badge(st.done, st.optional) + '</span></summary><div class="step-b"><p class="sub">' + st.intro + '</p>' + st.body + '</div></details>';
  });
  root.innerHTML = html;
}

// ---- guided setup: welcome, one step per screen, finish ----
let at = Number(sessionStorage.getItem('journey-step') ?? -1);
const skipped = new Set(JSON.parse(sessionStorage.getItem('journey-skipped') || '[]'));
const go = (n) => { at = n; try { sessionStorage.setItem('journey-step', String(n)); sessionStorage.setItem('journey-skipped', JSON.stringify([...skipped])); } catch (e) {} renderJourney(); window.scrollTo(0, 0); };
const LOGO_BIG = document.querySelector('.brand svg') ? document.querySelector('.brand svg').outerHTML.replace('width="22" height="22"', 'width="56" height="56"') : '';

function renderJourney() {
  const steps = stepsData();
  const n = steps.length;
  if (at < -1) at = -1;
  if (at > n) at = n;
  let html = '';
  if (at === -1) {
    html = '<div class="j-card panel j-hero">' + LOGO_BIG + '<h2>Welcome to WhatsApp Task Bot</h2><p class="sub">It finds the tasks in your WhatsApp chats, puts them in your calendar, and emails you a short report each evening. Let us set it up together. It takes about 15 minutes.</p>'
      + '<div class="j-need"><div><b>Your phone</b><span>with WhatsApp</span></div><div><b>A Google account</b><span>with 2-Step Verification</span></div><div><b>About 6 GB</b><span>for the language model</span></div></div>'
      + '<div class="j-actions"><button class="btn primary lg" data-j="next">Start the setup</button><button class="btn ghost" data-j="skip-all">Skip for now</button></div></div>';
  } else if (at === n) {
    const rows = steps.map((st, i) => '<li><span class="sn' + (st.done ? ' on' : '') + '">' + (st.done ? CHECK : i + 1) + '</span><span>' + st.title + '</span><span class="st-right">' + (st.done ? '<span class="badge ok">Complete</span>' : '<span class="badge">' + (skipped.has(i) ? 'Skipped' : 'Not done') + '</span>') + '</span></li>').join('');
    const allReq = steps[0].done && steps[1].done && steps[2].done;
    html = '<div class="j-card panel j-hero">' + LOGO_BIG + '<h2>' + (allReq ? 'You are all set' : 'Almost there') + '</h2><p class="sub">' + (allReq ? 'The bot reads WhatsApp and finds your tasks. You can change everything later on the Setup and Settings pages.' : 'The first three steps are necessary before the bot can find tasks. You can finish them later on the Setup page.') + '</p>'
      + '<ul class="j-summary">' + rows + '</ul><div class="j-actions"><button class="btn primary lg" data-j="finish">Open the dashboard</button><button class="btn ghost" data-j="back">Back</button></div></div>';
  } else {
    const st = steps[at];
    const pct = Math.round(100 * at / n);
    html = '<div class="j-progress"><span>Step ' + (at + 1) + ' of ' + n + '</span><div class="bar"><span style="width:' + pct + '%"></span></div><button class="btn ghost sm" data-j="skip-all">Skip setup</button></div>'
      + '<div class="j-card panel"><div class="j-head"><h2>' + st.title + '</h2>' + badge(st.done, st.optional) + '</div><p class="sub">' + st.intro + '</p>'
      + (st.done ? '<div class="callout ok j-ok"><span>' + CHECK + ' This step is complete.</span></div>' : '') + '<div class="j-body">' + st.body + '</div></div>'
      + '<div class="j-nav"><button class="btn ghost" data-j="back">Back</button><span class="grow"></span>'
      + (st.done ? '<button class="btn primary lg" data-j="next">Continue</button>' : '<button class="btn" data-j="skip">Skip this step</button>') + '</div>';
  }
  root.innerHTML = html;
  root.setAttribute('aria-busy', 'false');
}

const render = () => (journey ? renderJourney() : renderList());

// Thin loading bar at the top while a request runs.
let pending = 0;
const busy = (d) => { pending = Math.max(0, pending + d); document.documentElement.classList.toggle('is-loading', pending > 0); };

async function load() {
  busy(1);
  try {
    const r = await fetch('/api/setup');
    if (r.status === 401) { location.reload(); return; }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    s = await r.json(); render();
  } catch (e) {
    s = null;
    root.innerHTML = '<section class="panel"><div class="failure bad"><div class="fi">' + FAIL_ICON + '</div><h2>Connection to the bot lost</h2><p>The page cannot reach the bot. Make sure that it operates, and try again.</p><div class="acts"><button class="btn primary" data-act="refresh">Try again</button></div></div></section>';
  } finally { busy(-1); }
  const active = s && (s.whatsapp.pairing || s.whatsapp.code || s.ollama.pull.running || s.ollama.install.running || (s.ollama.install.done && !s.ollama.reachable) || s.whatsapp.waitSec);
  clearTimeout(load.t);
  load.t = setTimeout(() => { if (document.visibilityState === 'visible' && !document.activeElement?.closest('form')) load(); else load.t = setTimeout(load, 2000); }, active ? 2500 : 15000);
}

root.addEventListener('submit', async (e) => {
  const f = e.target.closest('form[data-form]');
  if (!f) return;
  e.preventDefault();
  const body = Object.fromEntries(new FormData(f).entries());
  busy(1);
  try { await post(f.dataset.form, body); toast('Saved.'); document.activeElement?.blur(); await load(); } catch (err) { toast(err.message, true); } finally { busy(-1); }
});
root.addEventListener('click', async (e) => {
  const j = e.target.closest('[data-j]');
  if (j) {
    const a = j.dataset.j;
    if (a === 'next') return go(at + 1);
    if (a === 'back') return go(at - 1);
    if (a === 'skip') { skipped.add(at); return go(at + 1); }
    if (a === 'skip-all' || a === 'finish') {
      try { await post('onboarding', { state: a === 'finish' ? 'done' : 'skipped' }); } catch (err) {}
      try { sessionStorage.removeItem('journey-step'); sessionStorage.removeItem('journey-skipped'); } catch (err2) {}
      location.href = '/';
      return;
    }
  }
  const c = e.target.closest('[data-copy]');
  if (c) { try { await navigator.clipboard.writeText(c.dataset.copy); toast('Copied.'); } catch (err) { toast('Select the text and copy it.', true); } return; }
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const act = b.dataset.act;
  if (act === 'refresh') return load();
  b.disabled = true;
  busy(1);
  try {
    const r = await post(act, {});
    if (act === 'autostart' && r.handover) { toast('Done. The bot restarts in the background. This page reloads in about a minute.'); setTimeout(() => location.reload(), 70000); }
    else toast({ 'calendar-test': 'The test event worked. Google Calendar is ready.', 'email-test': 'Test email sent. Look in your inbox.', 'ollama-pull': 'Download started.', 'ollama-install': 'Install started.', shortcut: 'Shortcut made.' }[act] || 'Done.');
    await load();
  } catch (err) { toast(err.message, true); b.disabled = false; } finally { busy(-1); }
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
  rd.onload = async () => { busy(1); try { await post('google-key', { text: rd.result }); toast('Key saved.'); await load(); } catch (err) { toast(err.message, true); } finally { busy(-1); } };
  rd.readAsText(file);
});
load();
})();`;

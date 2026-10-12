// Loads config.json and .env, and saves changes from the setup wizard and the
// Settings page. Every other module reads settings from here at the moment it
// needs them, so a saved change applies without a restart (except the port).
import { readFileSync, existsSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

// ROOT: the program files. HOME: the personal files (settings, secrets, data, logs).
// A developer copy keeps both in the project folder. An installed copy (the
// installer writes the file ".installed") keeps HOME in the user's AppData, so an
// update replaces the program and never touches the personal files.
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const INSTALLED = existsSync(join(ROOT, '.installed'));
export const HOME = process.env.WTB_HOME
  || (INSTALLED ? join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'WhatsApp Task Bot') : ROOT);
export const DATA_DIR = join(HOME, 'data');
export const LOG_DIR = join(HOME, 'logs');
export const DB_FILE = join(DATA_DIR, 'bot.db');
export const CONFIG_FILE = join(HOME, 'config.json');
export const ENV_FILE = join(HOME, '.env');
export const KEY_FILE = join(HOME, 'keys', 'service-account.json');
export const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
export const REPO_URL = 'https://github.com/Codex-Crusader/whatsapp-task-bot';
export const AUTHOR = 'Bhargavaram Krishnapur';

const DEFAULTS = {
  myName: '',
  aliases: [],
  ignoredChats: [],
  taskWords: ['by', 'deadline', 'can you', 'please'],
  everyoneWords: ['everyone', 'all', 'team'],
  batchIntervalMinutes: 10,
  skipThreshold: 5,
  emailTime: '21:00',
  confidenceThreshold: 0.6,
  includeOriginalMessage: false, // off by default: message text leaves the computer only when the user turns this on
  retention: { messageHours: 48, processedDays: 7, reportDays: 30 },
  dashboardPort: 4780,
  ollama: { url: 'http://127.0.0.1:11434', model: 'qwen2.5:7b', numCtx: 8192, numPredict: 1024 },
};

// Fixed values from the spec. Not in config.json on purpose.
export const LIMITS = {
  chunkSize: 40, // max new messages per LLM call
  contextMessages: 5, // older messages shown for context
  maxSkips: 2, // max batches in a row that a quiet chat can wait
  writeBufferMs: 2000,
  writeBufferRows: 200,
  textMax: 2000,
  textHead: 1500,
  textTail: 500,
};

// Keys that the Settings page can change. The port and Ollama stay file-only.
const EDITABLE = ['myName', 'aliases', 'ignoredChats', 'taskWords', 'everyoneWords', 'batchIntervalMinutes',
  'skipThreshold', 'emailTime', 'confidenceThreshold', 'includeOriginalMessage', 'retention'];

function merge(base, user) {
  return {
    ...base,
    ...user,
    retention: { ...base.retention, ...user.retention },
    ollama: { ...base.ollama, ...user.ollama },
  };
}

export function loadConfig(file = CONFIG_FILE) {
  const user = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const cfg = merge(DEFAULTS, user);
  validate(cfg);
  return cfg;
}

const isLoopback = (url) => {
  try {
    const h = new URL(url).hostname;
    return h === '127.0.0.1' || h === 'localhost' || h === '[::1]';
  } catch {
    return false;
  }
};

export function validate(c) {
  const lists = { aliases: [20, 60], ignoredChats: [500, 200], taskWords: [50, 60], everyoneWords: [50, 60] };
  for (const [k, [maxItems, maxLen]] of Object.entries(lists)) {
    if (!Array.isArray(c[k]) || c[k].length > maxItems || c[k].some((x) => typeof x !== 'string' || x.length > maxLen || /[\r\n]/.test(x))) {
      throw new Error(`"${k}" must be a list of at most ${maxItems} short texts`);
    }
  }
  if (typeof c.myName !== 'string' || c.myName.length > 80 || /[\r\n]/.test(c.myName)) throw new Error('"myName" must be a short text');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(c.emailTime)) throw new Error('"emailTime" must be HH:MM (24-hour)');
  const ranges = [
    ['batchIntervalMinutes', c.batchIntervalMinutes, 1, 1440],
    ['skipThreshold', c.skipThreshold, 1, 1000],
    ['dashboardPort', c.dashboardPort, 1024, 65535],
    ['retention.messageHours', c.retention.messageHours, 1, 24 * 365],
    ['retention.processedDays', c.retention.processedDays, 1, 365],
    ['retention.reportDays', c.retention.reportDays, 1, 3650],
  ];
  for (const [k, v, min, max] of ranges) {
    if (!Number.isInteger(v) || v < min || v > max) throw new Error(`"${k}" must be a whole number from ${min} to ${max}`);
  }
  if (typeof c.confidenceThreshold !== 'number' || c.confidenceThreshold < 0 || c.confidenceThreshold > 1) {
    throw new Error('"confidenceThreshold" must be from 0 to 1');
  }
  if (typeof c.includeOriginalMessage !== 'boolean') throw new Error('"includeOriginalMessage" must be true or false');
  // Message text goes to Ollama. A remote address would send it off this computer.
  if (!isLoopback(c.ollama.url)) throw new Error('"ollama.url" must be on this computer (127.0.0.1 or localhost)');
}

// Writes a file in one step: a crash never leaves half a file.
export function writeAtomic(file, text, mode = 0o600) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode });
  renameSync(tmp, file);
}

// Saves allowed keys to config.json and applies them to the live config object.
export function saveConfig(patch, target = config, file = CONFIG_FILE) {
  const clean = {};
  for (const k of EDITABLE) if (k in patch) clean[k] = patch[k];
  const next = merge(target, clean);
  validate(next);
  const onDisk = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  writeAtomic(file, `${JSON.stringify(merge(onDisk, clean), null, 2)}\n`, 0o644);
  Object.assign(target, next);
  return target;
}

// ---- secrets (.env) ----
const ENV_KEYS = { googleKeyFile: 'GOOGLE_KEY_FILE', calendarId: 'CALENDAR_ID', gmailUser: 'GMAIL_USER', gmailAppPassword: 'GMAIL_APP_PASSWORD', reportTo: 'REPORT_TO' };

export const validEmail = (s) => typeof s === 'string' && s.length <= 254 && /^[^\s@"<>,;]+@[^\s@"<>,;]+\.[A-Za-z]{2,}$/.test(s);
export const validCalendarId = (s) => validEmail(s); // "...@group.calendar.google.com" or an email address
export const normalizeAppPassword = (s) => String(s ?? '').replace(/\s+/g, '');
export const validAppPassword = (s) => /^[a-z]{16}$/i.test(normalizeAppPassword(s));

function readEnvFile(file) {
  if (!existsSync(file)) return {};
  const out = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

export function loadEnv(file = ENV_FILE, target = {}) {
  const v = readEnvFile(file);
  const get = (k) => v[k] ?? process.env[k] ?? '';
  Object.assign(target, {
    googleKeyFile: get('GOOGLE_KEY_FILE') || (existsSync(KEY_FILE) ? KEY_FILE : ''),
    calendarId: get('CALENDAR_ID'),
    gmailUser: get('GMAIL_USER'),
    gmailAppPassword: normalizeAppPassword(get('GMAIL_APP_PASSWORD')),
    reportTo: get('REPORT_TO') || get('GMAIL_USER'),
  });
  return target;
}

// Changes some secrets. Keeps all other lines of .env. Refuses line breaks,
// which would add a second variable to the file.
export function saveEnv(patch, target = env, file = ENV_FILE) {
  const lines = existsSync(file) ? readFileSync(file, 'utf8').split(/\r?\n/) : ['# Secrets for the WhatsApp Task Bot. Do not share or commit this file.'];
  for (const [key, value] of Object.entries(patch)) {
    const name = ENV_KEYS[key];
    if (!name) throw new Error(`unknown setting "${key}"`);
    const text = String(value ?? '');
    if (/[\r\n\0]/.test(text) || text.length > 500) throw new Error(`"${key}" has characters that are not allowed`);
    const i = lines.findIndex((l) => new RegExp(`^\\s*${name}\\s*=`).test(l));
    if (i >= 0) lines[i] = `${name}=${text}`;
    else lines.push(`${name}=${text}`);
  }
  writeAtomic(file, `${lines.filter((l, i, a) => l !== '' || i < a.length - 1).join('\n')}\n`);
  return loadEnv(file, target);
}

// A Google service account key, as downloaded from Google Cloud. Returns the
// parsed key or throws. Only the fields the bot needs are checked.
export function checkServiceAccount(text) {
  if (typeof text !== 'string' || text.length > 10_000) throw new Error('The key file is too large.');
  let k;
  try { k = JSON.parse(text); } catch { throw new Error('The key file is not valid JSON.'); }
  if (k?.type !== 'service_account') throw new Error('This is not a service account key (type must be "service_account").');
  if (typeof k.client_email !== 'string' || !/^[^\s@]+@[^\s@]+\.iam\.gserviceaccount\.com$/.test(k.client_email)) throw new Error('The key has no valid client_email.');
  if (typeof k.private_key !== 'string' || !/-----BEGIN PRIVATE KEY-----[\s\S]+-----END PRIVATE KEY-----/.test(k.private_key)) throw new Error('The key has no private key.');
  return k;
}

export function saveKeyFile(text, target = env, keyFile = KEY_FILE, envFile = ENV_FILE) {
  checkServiceAccount(text);
  writeAtomic(keyFile, text, 0o600);
  return saveEnv({ googleKeyFile: keyFile }, target, envFile);
}

export const config = loadConfig();
export const env = loadEnv();

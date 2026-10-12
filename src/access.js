// Dashboard access token. Without it, any program on this computer could open
// http://localhost:<port> and read or change the tasks. The token is made once,
// kept in data/ (local, git-ignored), and put in the desktop shortcut.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { DATA_DIR, ROOT, INSTALLED, writeAtomic } from './config.js';
import { execFileSync } from 'node:child_process';

const TOKEN_FILE = join(DATA_DIR, 'dashboard-token');
export const COOKIE = 'wtb_session';

export function loadOrCreateToken(file = TOKEN_FILE) {
  if (existsSync(file)) {
    const t = readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(t)) return t;
  }
  const t = randomBytes(32).toString('hex');
  writeAtomic(file, `${t}\n`, 0o600);
  return t;
}

export const loginUrl = (port, token) => `http://localhost:${port}/login?t=${token}`;

// Constant time: the time of a check shows nothing about the token.
export function sameToken(given, token) {
  if (typeof given !== 'string' || given.length !== token.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(token));
}

export function cookieToken(req) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return v.join('=');
  }
  return null;
}

// HttpOnly: page scripts cannot read it. SameSite=Strict: other sites cannot send it.
export const sessionCookie = (token) => `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`;

export function desktopDir() {
  const home = process.env.USERPROFILE || homedir();
  const oneDrive = process.env.OneDrive ? join(process.env.OneDrive, 'Desktop') : null;
  for (const d of [join(home, 'Desktop'), oneDrive]) if (d && existsSync(d)) return d;
  return null;
}

// A developer copy: a web link with the access token. The installed app: a
// shortcut to the launcher, which starts the bot when it does not operate.
export const SHORTCUT_NAME = INSTALLED ? 'WhatsApp Task Bot.lnk' : 'WhatsApp Task Bot.url';

// Desktop shortcut that opens the dashboard and logs in. Written only when it changed.
export function writeShortcut(port, token, dir = desktopDir()) {
  if (!dir) return null;
  const file = join(dir, SHORTCUT_NAME);
  if (INSTALLED) {
    execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(ROOT, 'scripts', 'make-shortcut.ps1'), '-Path', file], { windowsHide: true, timeout: 30_000 });
    return file;
  }
  const text = `[InternetShortcut]\r\nURL=${loginUrl(port, token)}\r\nIconFile=${join(ROOT, 'assets', 'icon.ico')}\r\nIconIndex=0\r\n`;
  if (!existsSync(file) || readFileSync(file, 'utf8') !== text) writeFileSync(file, text);
  return file;
}

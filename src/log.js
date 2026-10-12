// File log with size-based rotation: bot.log, bot.1.log, bot.2.log.
// Rule: never log message text. Log ids, counts and errors only.
import { openSync, writeSync, closeSync, fstatSync, renameSync, rmSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { LOG_DIR } from './config.js';

export function createLogger({ dir = LOG_DIR, name = 'bot', maxBytes = 5 * 1024 * 1024, files = 3, echo = process.stdout.isTTY } = {}) {
  mkdirSync(dir, { recursive: true });
  const fileAt = (i) => join(dir, i === 0 ? `${name}.log` : `${name}.${i}.log`);
  let fd = openSync(fileAt(0), 'a');
  let size = fstatSync(fd).size;

  function rotate() {
    closeSync(fd);
    rmSync(fileAt(files - 1), { force: true });
    for (let i = files - 2; i >= 0; i--) {
      if (existsSync(fileAt(i))) renameSync(fileAt(i), fileAt(i + 1));
    }
    fd = openSync(fileAt(0), 'a');
    size = 0;
  }

  function write(level, msg, fields) {
    let line = `${stamp()} ${level} ${msg}`;
    if (fields) {
      for (const [k, v] of Object.entries(fields)) {
        if (v !== undefined) line += ` ${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`;
      }
    }
    line += '\n';
    const bytes = Buffer.byteLength(line);
    if (size + bytes > maxBytes) rotate();
    writeSync(fd, line);
    size += bytes;
    if (echo) process.stdout.write(line);
  }

  // Last n lines, newest last. Reads the current file and, if needed, the one before.
  function tail(n = 200) {
    let lines = [];
    for (let i = 0; i < files && lines.length < n; i++) {
      if (!existsSync(fileAt(i))) break;
      const text = readFileSync(fileAt(i), 'utf8');
      lines = text.split('\n').filter(Boolean).concat(lines);
    }
    return lines.slice(-n);
  }

  return {
    info: (msg, fields) => write('INFO', msg, fields),
    warn: (msg, fields) => write('WARN', msg, fields),
    error: (msg, fields) => write('ERROR', msg, fields),
    tail,
    close: () => closeSync(fd),
  };
}

function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// Pino-shaped logger for Baileys, level "warn" (or "info" while linking).
// It keeps only the text message and an error message, so message content
// in log objects is dropped.
export function baileysLogger(log, level = 'warn') {
  const keep = (level) => (obj, msg) => {
    if (typeof obj === 'string') return log[level](`baileys: ${obj}`);
    const err = obj instanceof Error ? obj : obj?.err ?? obj?.error;
    log[level](`baileys: ${msg ?? ''}`.trim(), err ? { err: String(err?.message ?? err).slice(0, 200) } : undefined);
  };
  const noop = () => {};
  const logger = {
    level,
    trace: noop,
    debug: level === 'debug' ? keep('info') : noop,
    info: level === 'info' || level === 'debug' ? keep('info') : noop,
    warn: keep('warn'),
    error: keep('error'),
    fatal: keep('error'),
    child: () => logger,
  };
  return logger;
}

export const log = createLogger();

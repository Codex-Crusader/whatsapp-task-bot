// Chat batcher: one LLM call per active chat (per part of 40 messages).
import * as chrono from 'chrono-node';
import { isJidGroup } from 'baileys';
import { LIMITS } from './config.js';
import { compileMatcher, classify } from './filter.js';
import { userPrompt, estimateTokens, TAGS, tagFor } from './extractor.js';
import { localDay, reportDay } from './store.js';

const DAY = 24 * 60 * 60 * 1000;
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const pad = (n) => String(n).padStart(2, '0');
const hhmm = (ms) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const dayLine = (ms) => `--- ${localDay(ms)} ${WEEKDAY[new Date(ms).getDay()]} ---`;
// A guess such as 2026-02-30 or T25:00 must not reach Google (it answers 400 every batch).
function validDate(day, time = '00:00') {
  const [y, m, d] = day.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const x = new Date(y, m - 1, d, hh, mm);
  return x.getFullYear() === y && x.getMonth() === m - 1 && x.getDate() === d && x.getHours() === hh && x.getMinutes() === mm;
}
const localDateTime = (d) => `${localDay(d.getTime())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

export function createBatcher({ store, config, extractor, nameOf, meIds, status, log, onTask = async () => {}, now = Date.now }) {
  // Rebuilt when the names or words change in the Settings page.
  let cacheKey = '';
  let re = null;
  let myNames = null;
  function names() {
    const key = JSON.stringify([config.myName, config.aliases, config.taskWords, config.everyoneWords]);
    if (key !== cacheKey) {
      cacheKey = key;
      re = compileMatcher(config);
      myNames = new Set([config.myName, ...config.aliases, 'me'].filter(Boolean).map((x) => x.toLowerCase()));
    }
    return { re, myNames };
  }
  const EVERYONE = new Set(['everyone', 'all', 'everybody', 'group', 'team', 'all members']);

  // ---- formatting ----
  function mentionNames(row) {
    const map = new Map();
    for (const jid of meIds()) map.set(jid.split('@')[0], 'Me');
    for (const jid of (row.mentioned || '').split(' ').filter(Boolean)) map.set(jid.split('@')[0], nameOf(jid));
    return map;
  }

  function lineText(row) {
    const names = mentionNames(row);
    return row.text
      .replace(/@(\d{6,})/g, (m, digits) => (names.has(digits) ? `@${names.get(digits)}` : m))
      .replace(/\s*\n+\s*/g, ' / ');
  }

  const sender = (row) => (row.sender_id === 'me' ? 'Me' : nameOf(row.sender_id));

  // Lines with date separators. idOf(i) gives the short id, or null for context.
  function formatRows(rows, idOf) {
    const out = [];
    let lastDay = null;
    rows.forEach((row, i) => {
      const day = localDay(row.ts);
      if (day !== lastDay) { out.push(dayLine(row.ts)); lastDay = day; }
      const id = idOf(i);
      out.push(`${id ? `[${id}] ` : ''}${hhmm(row.ts)} ${sender(row)}: ${lineText(row)}`);
    });
    return out;
  }

  // ---- planning ----
  function selfChatIds() {
    return new Set([...meIds()].filter((j) => !j.endsWith('@lid')));
  }

  // Returns the list of parts to send, and the chats that wait.
  function plan({ force = false } = {}) {
    const t = now();
    const lastRun = status.batch.lastRun;
    const since = Math.min(lastRun ?? t, t - DAY);
    const rows = store.s.unprocessedSince.all(since);
    const byChat = new Map();
    for (const r of rows) {
      if (!byChat.has(r.chat_id)) byChat.set(r.chat_id, []);
      byChat.get(r.chat_id).push(r);
    }

    const ctx = { re: names().re, nameOf, selfChatIds: selfChatIds() };
    const parts = [];
    const waiting = [];
    for (const [chatId, list] of byChat) {
      const classes = list.map((r) => classify(r, ctx));
      const hasSignal = classes.some((c) => c.signal !== 'none');
      const skips = store.s.getSkips.get(chatId)?.skips ?? 0;
      if (!force && !hasSignal && list.length < config.skipThreshold && skips < LIMITS.maxSkips) {
        waiting.push(chatId);
        continue;
      }
      for (let i = 0; i < list.length; i += LIMITS.chunkSize) {
        const rowsPart = list.slice(i, i + LIMITS.chunkSize);
        parts.push(...fit({ chatId, rows: rowsPart, classes: classes.slice(i, i + LIMITS.chunkSize) }));
      }
    }
    return { parts, waiting, since, messages: rows.length, chats: byChat.size };
  }

  // Build the prompt. If it is too long for the context, split by time.
  function fit(part) {
    const p = build(part);
    if (estimateTokens(p.user) <= extractor.budget || part.rows.length === 1) return [p];
    const mid = Math.ceil(part.rows.length / 2);
    return [
      ...fit({ ...part, rows: part.rows.slice(0, mid), classes: part.classes.slice(0, mid) }),
      ...fit({ ...part, rows: part.rows.slice(mid), classes: part.classes.slice(mid) }),
    ];
  }

  function build({ chatId, rows, classes }) {
    const context = store.s.contextBefore.all(chatId, rows[0].ts, LIMITS.contextMessages).reverse();
    const lines = formatRows(rows, (i) => `${i + 1}${classes[i].signal !== 'none' ? '*' : ''}`);
    const user = userPrompt({
      chatName: nameOf(chatId),
      isGroup: isJidGroup(chatId),
      today: `${localDay(now())} ${WEEKDAY[new Date(now()).getDay()]}`,
      context: formatRows(context, () => null),
      lines,
    });
    return { chatId, rows, classes, user };
  }

  // ---- results ----
  function normAssignee(a) {
    const x = a.trim().toLowerCase();
    if (names().myNames.has(x)) return 'me';
    if (EVERYONE.has(x)) return 'everyone';
    if (!x || x === 'unclear' || x === 'unknown') return 'unclear';
    return a.trim();
  }

  // Code sets the assignee for mention, quote, everyone and other-mention signals.
  // "everyone" comes from a keyword only, so a named person from the model wins
  // ("Karthik, bring all the chairs" -> Karthik). User decision, 2026-10-12.
  function resolveAssignee(cls, modelValue) {
    const model = normAssignee(modelValue);
    const person = model !== 'me' && model !== 'everyone' && model !== 'unclear';
    switch (cls.reason) {
      case 'mention': case 'quote': case 'self': return 'me';
      case 'everyone': return person ? model : 'everyone';
      case 'other': return cls.signal.slice('other:'.length);
      case 'dm': return person ? model : 'me';
      default: return model;
    }
  }

  // chrono-node first (DD/MM, as used in India). If it fails, the model's guess and a "?".
  function resolveDue(task, msgTs) {
    if (task.due_text) {
      const r = chrono.en.GB.parse(task.due_text, new Date(msgTs), { forwardDate: true })[0];
      if (r) {
        const d = r.start.date();
        return r.start.isCertain('hour') ? { due: localDateTime(d), kind: 'datetime', guessed: false } : { due: localDay(d.getTime()), kind: 'date', guessed: false };
      }
    }
    const g = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?/.exec(task.due_guess || '');
    if (g && validDate(g[1], g[2])) return g[2] ? { due: `${g[1]}T${g[2]}`, kind: 'datetime', guessed: true } : { due: g[1], kind: 'date', guessed: true };
    return { due: null, kind: null, guessed: false };
  }

  // One task per message: if the model gives two for one message, join the titles.
  function mergeByMessage(tasks) {
    const byId = new Map();
    for (const t of tasks) {
      const prev = byId.get(t.message_id);
      if (!prev) byId.set(t.message_id, { ...t });
      else {
        prev.title = `${prev.title}; ${t.title}`;
        prev.confidence = Math.min(prev.confidence, t.confidence);
        prev.due_text ??= t.due_text;
        prev.due_guess ??= t.due_guess;
      }
    }
    return [...byId.values()];
  }

  async function applyResult(part, out, day) {
    const found = [];
    for (const t of mergeByMessage(out.tasks)) {
      const i = Number(t.message_id) - 1;
      const row = part.rows[i];
      if (!row) continue; // id not in this part
      const cls = part.classes[i];
      const assignee = resolveAssignee(cls, t.assignee);
      const due = resolveDue(t, row.ts);
      // An uncertain task still goes to the calendar (with "?"), and the dashboard
      // shows a "Needs review" warning with these reasons. User decision, 2026-10-12.
      const reasons = [];
      if (assignee === 'unclear') reasons.push('Unclear who must do it');
      if (t.confidence < config.confidenceThreshold) reasons.push(`Low confidence (${Math.round(t.confidence * 100)}%)`);
      if (due.guessed) reasons.push('Date guessed by the model');
      const task = {
        message_id: row.id,
        chat_id: row.chat_id,
        chat_name: nameOf(row.chat_id),
        sender_name: sender(row),
        title: t.title,
        assignee,
        due: due.due,
        due_kind: due.kind,
        confidence: t.confidence,
        flagged: reasons.length ? 1 : 0,
        review_reason: reasons.join('; ') || null,
        tag: TAGS.includes(t.tag) ? t.tag : tagFor(t.title),
        day,
        created_at: now(),
      };
      if (store.s.insertTask.run(task).changes) {
        found.push(task);
        await onTask(task, row);
      }
    }
    for (const line of out.summary) store.s.addSummary.run(part.chatId, day, line, now());
    store.db.transaction(() => { for (const r of part.rows) store.s.markProcessed.run(r.id, now()); })();
    return found;
  }

  // ---- run ----
  // force: no skips (before the report). day: report day for the results.
  async function run({ force = false, day: forDay = null } = {}) {
    if (status.batch.running) return { ok: false, reason: 'already running' };
    status.batch.running = true;
    const started = now();
    const result = { ok: true, chats: 0, calls: 0, tasks: 0, mine: 0, waiting: 0, failedParts: 0, messages: 0 };
    try {
      const p = plan({ force });
      result.messages = p.messages;
      result.waiting = p.waiting.length;
      for (const chatId of p.waiting) store.s.setSkips.run(chatId, (store.s.getSkips.get(chatId)?.skips ?? 0) + 1);
      if (!p.parts.length) return result; // empty batch: no Ollama call
      if (!(await extractor.ping())) throw new Error('Ollama is not reachable');

      const day = forDay ?? reportDay(started, config.emailTime);
      const queue = [...p.parts];
      const done = new Set();
      while (queue.length) {
        const part = queue.shift();
        const keepAlive = queue.length ? '5m' : 0;
        let out;
        try {
          out = await extractor.extract(part.user, keepAlive);
          result.calls++;
          if (out.truncated) throw new Error('output cut at num_predict');
        } catch (err) {
          if (err.name === 'TimeoutError' || /fetch failed|ECONNREFUSED|HTTP 5/.test(err.message)) throw err;
          if (part.rows.length > 1) {
            log.warn('batcher: bad model output, split part', { rows: part.rows.length, err: err.message });
            const mid = Math.ceil(part.rows.length / 2);
            const half = (a, b) => build({ chatId: part.chatId, rows: part.rows.slice(a, b), classes: part.classes.slice(a, b) });
            queue.unshift(half(0, mid), half(mid));
          } else {
            result.failedParts++;
            log.error('batcher: model output failed for one message', { err: err.message });
          }
          continue;
        }
        const found = await applyResult(part, out, day);
        result.tasks += found.length;
        result.mine += found.filter((t) => t.assignee === 'me').length;
        if (found.length) {
          status.batch.tasksFound = (status.batch.tasksFound ?? 0) + found.length;
          status.batch.mineFound = (status.batch.mineFound ?? 0) + found.filter((t) => t.assignee === 'me').length;
          status.batch.lastTaskAt = now();
        }
        done.add(part.chatId);
      }
      for (const chatId of done) store.s.setSkips.run(chatId, 0);
      result.chats = done.size;
      if (result.failedParts) result.ok = false;
      return result;
    } catch (err) {
      result.ok = false;
      result.error = err.message;
      await extractor.unload();
      throw Object.assign(err, { result });
    } finally {
      status.batch.running = false;
      result.durationMs = now() - started;
      status.batch.lastAt = started;
      status.batch.durationMs = result.durationMs;
      status.batch.result = result.ok
        ? `ok: ${result.chats} chats, ${result.calls} calls, ${result.tasks} tasks`
        : `failed: ${result.error || `${result.failedParts} parts`}`;
      if (result.ok) {
        status.batch.lastRun = started;
        store.kvSet('lastRun', started);
      }
      log.info('batcher: done', { ok: result.ok, messages: result.messages, chats: result.chats, waiting: result.waiting, calls: result.calls, tasks: result.tasks, mine: result.mine, ms: result.durationMs });
    }
  }

  return { plan, run, resolveDue, resolveAssignee, formatRows };
}

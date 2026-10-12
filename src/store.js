// SQLite storage. All statements are prepared once in openStore().
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { initAuthCreds, BufferJSON, proto } from 'baileys';
import { tagFor } from './extractor.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  sender_id TEXT,              -- 'me' for my own messages
  ts INTEGER NOT NULL,         -- ms since epoch
  text TEXT NOT NULL,
  quoted_sender_id TEXT,       -- 'me' if the quoted message is mine
  mentions_me INTEGER NOT NULL DEFAULT 0,
  is_dm INTEGER NOT NULL DEFAULT 0,
  mentioned TEXT               -- other mentioned JIDs, space separated
);
CREATE INDEX IF NOT EXISTS messages_chat_ts ON messages(chat_id, ts);
CREATE INDEX IF NOT EXISTS messages_ts ON messages(ts);

CREATE TABLE IF NOT EXISTS processed (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  message_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  chat_name TEXT,
  sender_name TEXT,
  title TEXT NOT NULL,
  assignee TEXT NOT NULL,      -- me | everyone | unclear | <name>
  due TEXT,                    -- ISO date or datetime
  due_kind TEXT,               -- 'date' | 'datetime' | NULL
  confidence REAL,
  flagged INTEGER NOT NULL DEFAULT 0, -- unclear or low confidence
  event_id TEXT,
  day TEXT NOT NULL,           -- local report day, YYYY-MM-DD
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', -- open | done | deleted (deleted rows stay, so the task is never made again)
  event_dirty INTEGER NOT NULL DEFAULT 0, -- 1: the calendar event must be updated or removed
  event_gen INTEGER NOT NULL DEFAULT 0,   -- part of the event id; +1 after an event is removed
  updated_at INTEGER,
  tag TEXT,                    -- kind of task, from the model or from the title words
  review_reason TEXT           -- why a flagged task needs a check; NULL after Confirm or Edit
);
CREATE UNIQUE INDEX IF NOT EXISTS tasks_message ON tasks(message_id);
CREATE INDEX IF NOT EXISTS tasks_day ON tasks(day);

CREATE TABLE IF NOT EXISTS summaries (
  id INTEGER PRIMARY KEY,
  chat_id TEXT NOT NULL,
  day TEXT NOT NULL,
  line TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS summaries_day ON summaries(day, chat_id);

CREATE TABLE IF NOT EXISTS reports (
  day TEXT PRIMARY KEY,
  html TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  sent_at INTEGER              -- NULL until the email is sent
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS chat_state (
  chat_id TEXT PRIMARY KEY,
  skips INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS groups (
  jid TEXT PRIMARY KEY,
  subject TEXT,
  data TEXT NOT NULL,          -- Baileys GroupMetadata as JSON
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS contacts (
  jid TEXT PRIMARY KEY,
  name TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS auth (
  category TEXT NOT NULL,
  id TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (category, id)
) WITHOUT ROWID;
`;

// @s status tab ("review": open tasks with a warning), @f person, @d due date,
// @tag, @chat exact, @q text search (a LIKE pattern: the caller puts ! before %, _ and !).
const TASK_FILTER = `(@s = 'all' AND status <> 'deleted' OR @s = 'review' AND status = 'open' AND flagged = 1 OR status = @s)
  AND (@f = 'all' OR (@f = 'mine' AND assignee = 'me') OR (@f = 'everyone' AND assignee = 'everyone')
    OR (@f = 'others' AND assignee NOT IN ('me', 'everyone')))
  AND (@d = 'all' OR (@d = 'nodate' AND due IS NULL) OR (@d = 'overdue' AND substr(due, 1, 10) < @today)
    OR (@d = 'today' AND substr(due, 1, 10) = @today) OR (@d = 'week' AND substr(due, 1, 10) BETWEEN @today AND @week)
    OR (@d = 'upcoming' AND substr(due, 1, 10) >= @today))
  AND (@tag = '' OR tag = @tag)
  AND (@chat = '' OR chat_name = @chat)
  AND (@q = '' OR title LIKE @q ESCAPE '!' OR chat_name LIKE @q ESCAPE '!' OR sender_name LIKE @q ESCAPE '!')`;

// Sort orders for the task list. Only these keys reach the SQL.
export const TASK_SORTS = {
  mine: "(assignee = 'me') DESC, due IS NULL, due, id DESC",
  due: 'due IS NULL, due, id DESC',
  newest: 'created_at DESC, id DESC',
  chat: 'chat_name COLLATE NOCASE, due IS NULL, due, id DESC',
};

export function openStore(file) {
  mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  // auto_vacuum must be set before the first table exists.
  db.pragma('auto_vacuum = INCREMENTAL');
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.exec(SCHEMA);
  migrate(db);

  const q = (sql) => db.prepare(sql);
  const s = {
    insertMessage: q(`INSERT INTO messages (id, chat_id, sender_id, ts, text, quoted_sender_id, mentions_me, is_dm, mentioned)
      VALUES (@id, @chat_id, @sender_id, @ts, @text, @quoted_sender_id, @mentions_me, @is_dm, @mentioned)
      ON CONFLICT(id) DO NOTHING`),
    updateText: q('UPDATE messages SET text = ? WHERE id = ?'),
    deleteMessage: q('DELETE FROM messages WHERE id = ?'),
    unprocessedSince: q(`SELECT m.* FROM messages m LEFT JOIN processed p ON p.id = m.id
      WHERE m.ts > ? AND p.id IS NULL ORDER BY m.chat_id, m.ts`),
    contextBefore: q('SELECT * FROM messages WHERE chat_id = ? AND ts < ? ORDER BY ts DESC LIMIT ?'),
    markProcessed: q('INSERT OR IGNORE INTO processed (id, at) VALUES (?, ?)'),
    lastMessageTs: q('SELECT MAX(ts) AS ts FROM messages'),
    taskTotals: q("SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE assignee = 'me') AS mine, MAX(created_at) AS lastAt FROM tasks WHERE status <> 'deleted'"),

    insertTask: q(`INSERT INTO tasks (message_id, chat_id, chat_name, sender_name, title, assignee, due, due_kind, confidence, flagged, day, created_at, tag, review_reason)
      VALUES (@message_id, @chat_id, @chat_name, @sender_name, @title, @assignee, @due, @due_kind, @confidence, @flagged, @day, @created_at, @tag, @review_reason)
      ON CONFLICT(message_id) DO NOTHING`),
    taskByMessage: q('SELECT * FROM tasks WHERE message_id = ?'),
    setEventId: q('UPDATE tasks SET event_id = ? WHERE message_id = ?'),
    tasksForDay: q("SELECT * FROM tasks WHERE day = ? AND status <> 'deleted' ORDER BY id"),
    // Dashboard edits. Each one marks the calendar event for an update.
    taskById: q('SELECT * FROM tasks WHERE id = ?'),
    updateTask: q(`UPDATE tasks SET title = @title, assignee = @assignee, due = @due, due_kind = @due_kind, tag = coalesce(@tag, tag),
      flagged = 0, review_reason = NULL, event_dirty = 1, updated_at = @now WHERE id = @id AND status <> 'deleted'`),
    // Confirm a task with a warning: the "?" leaves the calendar event at the next sync.
    confirmTask: q(`UPDATE tasks SET flagged = 0, review_reason = NULL, event_dirty = 1, updated_at = @now
      WHERE id = @id AND flagged = 1 AND status <> 'deleted'`),
    // The event text changed for all tasks (the original-message setting): rewrite every event.
    markEventsDirty: q("UPDATE tasks SET event_dirty = 1 WHERE event_id IS NOT NULL AND status <> 'deleted'"),
    reviewCount: q("SELECT COUNT(*) FROM tasks WHERE status = 'open' AND flagged = 1").pluck(),
    tagCounts: q("SELECT tag, COUNT(*) AS n FROM tasks WHERE status <> 'deleted' AND tag IS NOT NULL GROUP BY tag"),
    chatNames: q("SELECT chat_name, COUNT(*) AS n FROM tasks WHERE status <> 'deleted' AND chat_name IS NOT NULL GROUP BY chat_name ORDER BY chat_name COLLATE NOCASE LIMIT 300"),
    setTaskStatus: q('UPDATE tasks SET status = @status, event_dirty = 1, updated_at = @now WHERE id = @id AND status <> @status'),
    dirtyEvents: q('SELECT * FROM tasks WHERE event_dirty = 1 ORDER BY id'),
    clearDirty: q('UPDATE tasks SET event_dirty = 0 WHERE id = ?'),
    // A new calendar: forget the old event ids, so open tasks get events in the new one.
    resetEvents: q('UPDATE tasks SET event_id = NULL, event_gen = 0, event_dirty = 0 WHERE event_id IS NOT NULL'),
    setEvent: q('UPDATE tasks SET event_id = @event_id, event_gen = @gen WHERE id = @id'),
    // Dashboard task list: filter by assignee group (@f) and due date (@d), 50 per page.
    tasksPage: Object.fromEntries(Object.entries(TASK_SORTS).map(([k, order]) => [k, q(`SELECT * FROM tasks WHERE ${TASK_FILTER}
      ORDER BY ${order} LIMIT 50 OFFSET @off`)])),
    tasksCount: q(`SELECT COUNT(*) FROM tasks WHERE ${TASK_FILTER}`).pluck(),
    // Tasks that need a calendar event: me, everyone or unclear, with a date.
    pendingEvents: q(`SELECT * FROM tasks WHERE event_id IS NULL AND due IS NOT NULL AND status = 'open'
      AND assignee IN ('me', 'everyone', 'unclear') ORDER BY id`),
    messageText: q('SELECT text FROM messages WHERE id = ?'),

    addSummary: q('INSERT INTO summaries (chat_id, day, line, at) VALUES (?, ?, ?, ?)'),
    deleteSummariesForDay: q('DELETE FROM summaries WHERE day = ?'),
    // Report numbers for messages processed in a time window.
    windowStats: q(`SELECT COUNT(*) AS messages, COUNT(DISTINCT m.chat_id) AS chats
      FROM processed p JOIN messages m ON m.id = p.id WHERE p.at > ? AND p.at <= ?`),
    chatMaxLen: q(`SELECT MAX(LENGTH(m.text)) FROM processed p JOIN messages m ON m.id = p.id
      WHERE m.chat_id = ? AND p.at > ? AND p.at <= ?`).pluck(),

    // Cleanup: one DELETE per table.
    cleanMessages: q('DELETE FROM messages WHERE ts < ?'),
    cleanProcessed: q('DELETE FROM processed WHERE at < ?'),
    // Days with a saved report, and days older than ? that never got one (laptop off at email time).
    cleanSummaries: q('DELETE FROM summaries WHERE day IN (SELECT day FROM reports) OR day < ?'),
    cleanReports: q('DELETE FROM reports WHERE created_at < ?'),
    summariesForDay: q('SELECT chat_id, line FROM summaries WHERE day = ? ORDER BY chat_id, at'),

    saveReport: q('INSERT OR REPLACE INTO reports (day, html, created_at) VALUES (?, ?, ?)'),
    getReport: q('SELECT day, html, created_at, sent_at FROM reports WHERE day = ?'),
    listReports: q('SELECT day, created_at, sent_at FROM reports ORDER BY day DESC'),
    markReportSent: q('UPDATE reports SET sent_at = ? WHERE day = ?'),
    // A day has content if a batch found tasks or wrote summaries for it.
    dayHasContent: q(`SELECT EXISTS (SELECT 1 FROM tasks WHERE day = @day AND status <> 'deleted')
      OR EXISTS (SELECT 1 FROM summaries WHERE day = @day)`).pluck(),

    getSkips: q('SELECT skips FROM chat_state WHERE chat_id = ?'),
    setSkips: q(`INSERT INTO chat_state (chat_id, skips) VALUES (?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET skips = excluded.skips`),

    upsertGroup: q(`INSERT INTO groups (jid, subject, data, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET subject = excluded.subject, data = excluded.data, updated_at = excluded.updated_at`),
    getGroup: q('SELECT subject, data, updated_at FROM groups WHERE jid = ?'),
    upsertContact: q(`INSERT INTO contacts (jid, name) VALUES (?, ?)
      ON CONFLICT(jid) DO UPDATE SET name = excluded.name WHERE contacts.name <> excluded.name`),
    // A push name fills a missing name or replaces a masked one ("+91∙∙∙∙56").
    addContactIfMissing: q(`INSERT INTO contacts (jid, name) VALUES (?, ?)
      ON CONFLICT(jid) DO UPDATE SET name = excluded.name WHERE contacts.name LIKE '%∙%'`),
    getContact: q('SELECT name FROM contacts WHERE jid = ?'),

    kvGet: q('SELECT value FROM kv WHERE key = ?'),
    kvSet: q(`INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`),

    authGet: q('SELECT value FROM auth WHERE category = ? AND id = ?'),
    authSet: q(`INSERT INTO auth (category, id, value) VALUES (?, ?, ?)
      ON CONFLICT(category, id) DO UPDATE SET value = excluded.value`),
    authDelete: q('DELETE FROM auth WHERE category = ? AND id = ?'),
  };

  // Callers that do not know the newer fields still work: tag from the title words.
  const rawInsertTask = s.insertTask;
  s.insertTask = { run: (t) => rawInsertTask.run({ review_reason: null, ...t, tag: t.tag ?? tagFor(t.title) }) };
  const rawUpdateTask = s.updateTask;
  s.updateTask = { run: (t) => rawUpdateTask.run({ tag: null, ...t }) };

  const insertMessages = db.transaction((rows) => {
    let n = 0;
    for (const r of rows) n += s.insertMessage.run(r).changes;
    return n;
  });

  return {
    db,
    s,
    insertMessages,
    kvGet: (key) => s.kvGet.get(key)?.value ?? null,
    kvSet: (key, value) => s.kvSet.run(key, value == null ? null : String(value)),
    close: () => db.close(),
  };
}

// Columns added after the first release. Safe to run on every start.
function migrate(db) {
  const taskCols = db.prepare('PRAGMA table_info(tasks)').all().map((c) => c.name);
  if (!taskCols.includes('status')) db.exec("ALTER TABLE tasks ADD COLUMN status TEXT NOT NULL DEFAULT 'open'");
  if (!taskCols.includes('event_dirty')) db.exec('ALTER TABLE tasks ADD COLUMN event_dirty INTEGER NOT NULL DEFAULT 0');
  if (!taskCols.includes('event_gen')) db.exec('ALTER TABLE tasks ADD COLUMN event_gen INTEGER NOT NULL DEFAULT 0');
  if (!taskCols.includes('updated_at')) db.exec('ALTER TABLE tasks ADD COLUMN updated_at INTEGER');
  if (!taskCols.includes('review_reason')) {
    db.exec('ALTER TABLE tasks ADD COLUMN review_reason TEXT');
    // Before this column, a guessed date put " ?" after the title. Now it is a warning.
    db.exec(`UPDATE tasks SET title = substr(title, 1, length(title) - 2), flagged = 1,
      review_reason = coalesce(review_reason, 'Date guessed by the model'),
      event_dirty = CASE WHEN event_id IS NOT NULL THEN 1 ELSE event_dirty END
      WHERE title LIKE '% ?' AND status = 'open'`);
  }
  if (!taskCols.includes('tag')) db.exec('ALTER TABLE tasks ADD COLUMN tag TEXT');
  const untagged = db.prepare('SELECT id, title FROM tasks WHERE tag IS NULL').all();
  if (untagged.length) {
    const set = db.prepare('UPDATE tasks SET tag = ? WHERE id = ?');
    db.transaction(() => { for (const t of untagged) set.run(tagFor(t.title), t.id); })();
  }
  // Masked names ("+91∙∙∙∙56") stored before the fix: use the phone number of the chat.
  db.exec(`UPDATE tasks SET chat_name = '+' || substr(chat_id, 1, instr(chat_id, '@') - 1)
    WHERE chat_name LIKE '%∙%' AND chat_id NOT LIKE '%@g.us'`);
  db.exec(`UPDATE tasks SET sender_name = '+' || substr(chat_id, 1, instr(chat_id, '@') - 1)
    WHERE sender_name LIKE '%∙%' AND chat_id NOT LIKE '%@g.us'`);
  const cols = db.prepare('PRAGMA table_info(reports)').all().map((c) => c.name);
  if (!cols.includes('sent_at')) {
    db.exec('ALTER TABLE reports ADD COLUMN sent_at INTEGER');
    // Reports saved before this column existed were emailed (the email followed at once).
    db.exec('UPDATE reports SET sent_at = created_at');
  }
}

// Baileys auth state in SQLite. Keys that Baileys sets to null are deleted;
// that is how used pre-keys and old sessions go away.
export function useSqliteAuthState(store) {
  const { s, db } = store;
  const read = (category, id) => {
    const row = s.authGet.get(category, id);
    return row ? JSON.parse(row.value, BufferJSON.reviver) : null;
  };
  const creds = read('creds', '') || initAuthCreds();

  const writeKeys = db.transaction((data) => {
    for (const category in data) {
      for (const id in data[category]) {
        const value = data[category][id];
        if (value) s.authSet.run(category, id, JSON.stringify(value, BufferJSON.replacer));
        else s.authDelete.run(category, id);
      }
    }
  });

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const out = {};
          for (const id of ids) {
            let value = read(type, id);
            if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value);
            out[id] = value;
          }
          return out;
        },
        set: async (data) => writeKeys(data),
      },
    },
    saveCreds: async () => {
      s.authSet.run('creds', '', JSON.stringify(creds, BufferJSON.replacer));
    },
    clear: () => db.exec('DELETE FROM auth'),
  };
}

// Local calendar day for a timestamp in ms.
export function localDay(ms = Date.now()) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// The report day a moment belongs to. After the email time, work counts
// toward tomorrow's report.
export function reportDay(ms, emailTime) {
  const d = new Date(ms);
  const [h, m] = emailTime.split(':').map(Number);
  if (d.getHours() * 60 + d.getMinutes() >= h * 60 + m) d.setDate(d.getDate() + 1);
  return localDay(d.getTime());
}

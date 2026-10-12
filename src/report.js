// Daily report: built once as HTML from summaries and tasks, saved in SQLite.
// The email and the dashboard both use the saved HTML.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SHORT_CHAT_MAX = 12; // a chat whose longest message is this short ("ok", "thanks") is left out
const MERGE_OVER = 5; // more summary lines than this -> one short LLM call

const RANK = { me: 0, everyone: 1, unclear: 2 };
const rank = (t) => RANK[t.assignee] ?? 3;

export function taskStatus(t) {
  if (t.status === 'done') return 'Done';
  if (!(t.assignee in RANK)) return 'Not yours';
  if (!t.due) return 'No date';
  return t.event_id ? 'In calendar' : 'Pending';
}

function formatDue(t) {
  if (!t.due) return '';
  if (t.due_kind !== 'datetime') return t.due;
  return t.due.replace('T', ' ');
}

export function createReporter({ store, config, extractor, nameOf, log }) {
  // Collects the content. Makes one merge call per long chat, the last with keep_alive 0.
  async function collect(day, from, to) {
    const tasks = store.s.tasksForDay.all(day).sort((a, b) => rank(a) - rank(b) || a.id - b.id);
    const byChat = new Map();
    for (const { chat_id: c, line } of store.s.summariesForDay.all(day)) {
      if (!byChat.has(c)) byChat.set(c, []);
      byChat.get(c).push(line);
    }
    const taskChats = new Set(tasks.map((t) => t.chat_id));
    const chats = [];
    for (const [chatId, lines] of byChat) {
      const maxLen = store.s.chatMaxLen.get(chatId, from, to) ?? 0;
      if (!taskChats.has(chatId) && maxLen <= SHORT_CHAT_MAX) continue; // only short replies
      chats.push({ chatId, name: nameOf(chatId), lines });
    }
    const long = chats.filter((c) => c.lines.length > MERGE_OVER);
    for (let i = 0; i < long.length; i++) {
      try {
        const merged = await extractor.summarize(long[i].lines, i === long.length - 1 ? 0 : '5m');
        if (merged.length) long[i].lines = merged;
      } catch (err) {
        log.warn('report: summary merge failed, using first lines', { err: err.message });
        long[i].lines = long[i].lines.slice(0, 3);
      }
    }
    chats.sort((a, b) => a.name.localeCompare(b.name));
    const w = store.s.windowStats.get(from, to);
    const stats = {
      messages: w.messages,
      conversations: w.chats,
      tasks: tasks.length,
      mine: tasks.filter((t) => t.assignee === 'me').length,
    };
    return { day, tasks, chats, stats, check: tasks.filter((t) => t.status !== 'done' && (t.flagged || t.assignee === 'unclear')) };
  }

  function render({ day, tasks, chats, stats, check }) {
    const td = 'padding:6px 8px;border-bottom:1px solid #ddd;text-align:left;vertical-align:top';
    const th = `${td};background:#f3f3f3;font-weight:600`;
    const row = (t) => {
      const b = t.assignee === 'me' ? 'font-weight:700;' : '';
      const who = t.assignee === 'me' ? 'Me' : t.assignee === 'everyone' ? 'Everyone' : t.assignee === 'unclear' ? 'Unclear' : t.assignee;
      return `<tr><td style="${td};${b}">${esc(t.title)}</td><td style="${td};${b}">${esc(who)}</td><td style="${td}">${esc(t.chat_name)}</td><td style="${td}">${esc(formatDue(t))}</td><td style="${td}">${esc(taskStatus(t))}</td></tr>`;
    };
    const reviewRow = (t) => `<tr><td style="${td}">${esc(t.title)}</td><td style="${td}">${esc(t.chat_name)}</td><td style="${td}">${esc(t.review_reason || (t.assignee === 'unclear' ? 'Unclear who must do it' : 'Low confidence'))}</td></tr>`;
    const reviewTable = check.length
      ? `<table style="border-collapse:collapse;width:100%;font-size:14px"><tr><th style="${th}">Task</th><th style="${th}">Chat</th><th style="${th}">Why</th></tr>${check.map(reviewRow).join('')}</table><p style="color:#666;font-size:13px">These tasks are in your calendar with "?". Open the dashboard to confirm or edit them.</p>`
      : '<p style="color:#666">None.</p>';
    const table = (list) => list.length
      ? `<table style="border-collapse:collapse;width:100%;font-size:14px"><tr><th style="${th}">Task</th><th style="${th}">Assigned to</th><th style="${th}">Chat</th><th style="${th}">Due</th><th style="${th}">Status</th></tr>${list.map(row).join('')}</table>`
      : '<p style="color:#666">None.</p>';
    const convo = chats.length
      ? chats.map((c) => `<p style="margin:0 0 10px"><b>${esc(c.name)}</b><br>${c.lines.map(esc).join('<br>')}</p>`).join('')
      : '<p style="color:#666">No active conversations.</p>';
    return `<!doctype html><html><head><meta charset="utf-8"><title>WhatsApp report ${esc(day)}</title></head>
<body style="font-family:Segoe UI,Arial,sans-serif;color:#222;max-width:760px;margin:0 auto;padding:16px">
<h1 style="font-size:20px;margin:0 0 12px">WhatsApp report, ${esc(day)}</h1>
<h2 style="font-size:16px;margin:20px 0 8px">Overview</h2>
<p style="margin:0">Messages scanned: <b>${stats.messages}</b> &nbsp; Conversations: <b>${stats.conversations}</b> &nbsp; Tasks found: <b>${stats.tasks}</b> &nbsp; Tasks for me: <b>${stats.mine}</b></p>
<h2 style="font-size:16px;margin:20px 0 8px">Conversations</h2>
${convo}
<h2 style="font-size:16px;margin:20px 0 8px">Tasks</h2>
${table(tasks)}
<h2 style="font-size:16px;margin:20px 0 8px">Needs review (${check.length})</h2>
${reviewTable}
</body></html>`;
  }

  // Builds, saves, and deletes the day's summaries in one transaction.
  async function build(day, from, to) {
    const data = await collect(day, from, to);
    const html = render(data);
    store.db.transaction(() => {
      store.s.saveReport.run(day, html, Date.now());
      store.s.deleteSummariesForDay.run(day);
    })();
    log.info('report: saved', { day, ...data.stats, chats: data.chats.length });
    return { html, stats: data.stats };
  }

  return { build, render, collect };
}

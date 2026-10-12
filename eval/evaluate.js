// Evaluation: WhatsApp "Export chat" .txt files (Android) + a CSV of labels.
// Runs the rule filter and the chat batcher (real Ollama), prints precision and
// recall for "mine", LLM calls, total time, and the errors.
//
// Run: npm run eval -- --chats <folder or .txt file> --labels <labels.csv>
//   [--me "Name as shown in the export"] [--everyone-not-mine] [--date-order mdy]
//
// labels.csv: file,line,label   (label = mine | other | not_task)
//   file = export file name, line = 1-based line where the message starts.
import { readFileSync, readdirSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseArgs } from 'node:util';
import { config } from '../src/config.js';
import { openStore } from '../src/store.js';
import { createBatcher } from '../src/batcher.js';
import { createExtractor } from '../src/extractor.js';
import { clipText, isEmojiOnly } from '../src/ingest.js';

// "12/10/26, 9:05 pm - Name: text" or "12/10/2026, 21:05 - Name: text"
const LINE = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::\d{2})?(?:[\s ]*([ap]\.?\s?m\.?))?\s+-\s+(.*)$/i;
const DROP = /^(<Media omitted>|This message was deleted|You deleted this message|null|<attached: .*>)$/i;

export function parseExport(text, file, { dateOrder = 'dmy' } = {}) {
  const out = [];
  let cur = null;
  text.replace(/\r/g, '').split('\n').forEach((raw, i) => {
    const line = raw.replace(/^﻿/, '');
    const m = LINE.exec(line);
    if (!m) {
      if (cur) cur.text += `\n${line}`; // continuation of a multi-line message
      return;
    }
    const [, a, b, y, hh, mm, ap, rest] = m;
    const [day, month] = dateOrder === 'mdy' ? [b, a] : [a, b];
    let hour = Number(hh);
    if (ap) {
      const pm = /^p/i.test(ap);
      if (pm && hour < 12) hour += 12;
      if (!pm && hour === 12) hour = 0;
    }
    const year = y.length === 2 ? 2000 + Number(y) : Number(y);
    const colon = rest.indexOf(': ');
    if (colon < 0) { cur = null; return; } // system line ("X joined", "Messages are end-to-end encrypted")
    cur = { file, line: i + 1, ts: new Date(year, month - 1, day, hour, Number(mm)).getTime(), sender: rest.slice(0, colon), text: rest.slice(colon + 2) };
    out.push(cur);
  });
  for (const m of out) m.text = m.text.trimEnd(); // trailing empty lines at the end of a file
  return out;
}

export function parseLabels(text) {
  const map = new Map();
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    const [file, line, label] = raw.split(',').map((x) => x?.trim());
    if (!file || !/^\d+$/.test(line || '')) continue; // header or empty line
    if (!['mine', 'other', 'not_task'].includes(label)) throw new Error(`labels: bad label "${label}" for ${file}:${line}`);
    map.set(`${basename(file)}:${line}`, label);
  }
  return map;
}

// Export messages -> compact rows, as ingest would store them. Returns null for dropped ones.
export function toEvalRow(m, { me, meNames, isDm }) {
  const text = m.text.trim();
  if (!text || DROP.test(text) || isEmojiOnly(text)) return null;
  const at = [...text.matchAll(/@([\p{L}\p{N}_.+-]+(?:\s[\p{Lu}][\p{L}]+)?)/gu)].map((x) => x[1].toLowerCase());
  const mentionsMe = at.some((t) => meNames.some((n) => t.startsWith(n.split(' ')[0])));
  const others = mentionsMe ? [] : at;
  return {
    id: `${m.file}:${m.line}`,
    chat_id: m.file,
    sender_id: m.sender === me ? 'me' : m.sender,
    ts: m.ts,
    text: clipText(text),
    quoted_sender_id: null, // exports have no reply data
    mentions_me: mentionsMe ? 1 : 0,
    is_dm: isDm ? 1 : 0,
    mentioned: others.length ? others.join(' ') : null,
  };
}

function listFiles(p) {
  return statSync(p).isDirectory() ? readdirSync(p).filter((f) => f.endsWith('.txt')).map((f) => join(p, f)) : [p];
}

async function main() {
  const { values: a } = parseArgs({ options: {
    chats: { type: 'string' }, labels: { type: 'string' }, me: { type: 'string' },
    'everyone-not-mine': { type: 'boolean', default: false }, 'date-order': { type: 'string', default: 'dmy' },
  } });
  if (!a.chats || !a.labels) {
    console.error('Usage: npm run eval -- --chats <folder or .txt> --labels <labels.csv> [--me "Your name in the export"]');
    process.exit(1);
  }
  const me = a.me || config.myName;
  const meNames = [config.myName, ...config.aliases, me].filter(Boolean).map((x) => x.toLowerCase());
  const labels = parseLabels(readFileSync(a.labels, 'utf8'));

  const dir = mkdtempSync(join(tmpdir(), 'wabot-eval-'));
  const store = openStore(join(dir, 'eval.db'));
  const texts = new Map();
  let parsed = 0;
  let dropped = 0;
  for (const f of listFiles(a.chats)) {
    const msgs = parseExport(readFileSync(f, 'utf8'), basename(f), { dateOrder: a['date-order'] });
    const senders = new Set(msgs.map((m) => m.sender).filter((s) => s !== me));
    const rows = [];
    for (const m of msgs) {
      texts.set(`${m.file}:${m.line}`, m.text);
      const r = toEvalRow(m, { me, meNames, isDm: senders.size <= 1 });
      if (r) rows.push(r); else dropped++;
    }
    parsed += msgs.length;
    store.insertMessages(rows);
  }

  const status = { batch: { lastRun: 0, running: false }, ollama: {} }; // lastRun 0: take all messages
  const extractor = createExtractor({ config, status });
  let calls = 0;
  const counted = { ...extractor, extract: (u, k) => { calls++; return extractor.extract(u, k); } };
  const log = { info() {}, warn: (m, f) => console.warn(m, f ?? ''), error: (m, f) => console.error(m, f ?? '') };
  const batcher = createBatcher({ store, config, extractor: counted, nameOf: (x) => x, meIds: () => new Set(), status, log, now: () => Date.now() });

  const t0 = Date.now();
  const res = await batcher.run({ force: true }); // final state = every message processed, no skips
  const ms = Date.now() - t0;

  const tasks = new Map(store.db.prepare('SELECT * FROM tasks').all().map((t) => [t.message_id, t]));
  const mineSet = new Set(a['everyone-not-mine'] ? ['me'] : ['me', 'everyone']);
  const predict = (id) => { const t = tasks.get(id); return !t ? 'not_task' : mineSet.has(t.assignee) ? 'mine' : 'other'; };

  let tp = 0, fp = 0, fn = 0, missingIds = 0;
  const confusion = {};
  const errors = [];
  for (const [id, label] of labels) {
    if (!texts.has(id)) { missingIds++; continue; }
    const p = predict(id);
    confusion[`${label} -> ${p}`] = (confusion[`${label} -> ${p}`] ?? 0) + 1;
    if (p === 'mine' && label === 'mine') tp++;
    else if (p === 'mine') fp++;
    else if (label === 'mine') fn++;
    if (p !== label) errors.push({ id, label, p, task: tasks.get(id) });
  }
  const precision = tp + fp ? tp / (tp + fp) : NaN;
  const recall = tp + fn ? tp / (tp + fn) : NaN;
  const pct = (x) => (Number.isNaN(x) ? 'n/a' : `${(100 * x).toFixed(1)}%`);

  console.log(`\nMessages parsed: ${parsed} (dropped as noise: ${dropped}), labeled: ${labels.size}${missingIds ? `, labels with no matching message line: ${missingIds}` : ''}`);
  console.log(`"mine" counts ${a['everyone-not-mine'] ? 'only assignee "me"' : 'assignee "me" and "everyone"'}`);
  console.log(`Precision (mine): ${pct(precision)}   (${tp} of ${tp + fp} predicted "mine")`);
  console.log(`Recall    (mine): ${pct(recall)}   (${tp} of ${tp + fn} labeled "mine")`);
  console.log(`LLM calls: ${calls}   Total time: ${(ms / 1000).toFixed(1)} s   Batch ok: ${res.ok}`);
  console.log('Label -> predicted:', confusion);
  if (errors.length) {
    console.log(`\nErrors (${errors.length}):`);
    for (const e of errors) {
      const t = e.task ? ` | task: "${e.task.title}" assignee=${e.task.assignee} conf=${e.task.confidence}` : '';
      console.log(`- ${e.id} label=${e.label} predicted=${e.p}${t}\n    ${texts.get(e.id).replace(/\n/g, ' / ').slice(0, 160)}`);
    }
  }
  store.close();
  rmSync(dir, { recursive: true, force: true });
}

if (process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]))) main().catch((err) => { console.error(err); process.exit(1); });

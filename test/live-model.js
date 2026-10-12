// Manual check against the real Ollama model with fixture chats (no real data).
// Run: node test/live-model.js
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../src/config.js';
import { openStore } from '../src/store.js';
import { createBatcher } from '../src/batcher.js';
import { createExtractor } from '../src/extractor.js';

const ME = '919000000001@s.whatsapp.net';
const G = '120363000000000001@g.us';
const DM = '919000000002@s.whatsapp.net';
const P = (n) => `91900000001${n}@s.whatsapp.net`;
const names = { [G]: 'CSE 3rd Year', [DM]: 'Ravi', [P(1)]: 'Prof. Sharma', [P(2)]: 'Asha', [P(3)]: 'Karthik', [P(4)]: 'Neha' };
const nameOf = (j) => names[j] || j;

const base = new Date(); base.setHours(9, 0, 0, 0);
let k = 0;
const m = (chat, sender, text, extra = {}) => ({ id: `F${++k}`, chat_id: chat, sender_id: sender, ts: base.getTime() + k * 4 * 60000, text, quoted_sender_id: null, mentions_me: 0, is_dm: chat === DM ? 1 : 0, mentioned: null, ...extra });

const rows = [
  m(G, P(1), 'Good morning class'),
  m(G, P(1), 'Everyone must submit the DBMS assignment by Friday 5 pm on the portal'),
  m(G, P(2), 'ok sir'),
  m(G, P(1), '@919000000001 please prepare the seminar slides on normalization by Thursday', { mentions_me: 1 }),
  m(G, P(3), 'Who will book the lab for tomorrow?'),
  m(G, P(4), "I'll do it"),
  m(G, P(2), 'Alex bro, bring the extension board kal'),
  m(G, P(3), 'lol that meme 😂'),
  m(G, P(1), '@919000000013 send me the attendance sheet today', { mentioned: P(3) }),
  m(G, P(2), 'Fee payment last date is 20/10, dont forget'),
  m(G, P(2), 'Karthik, please bring all the chairs to the hall'),
  m(G, 'me', 'Thanks sir, will do'),
  m(DM, DM, 'bro my GRE exam is on 25th, so I cant come to the trip'),
  m(DM, DM, 'can you send me the OS notes tonight?'),
  m(DM, 'me', 'sure'),
  m(DM, DM, 'also happy birthday in advance haha'),
];

const store = openStore(join(mkdtempSync(join(tmpdir(), 'wabot-live-')), 'l.db'));
store.insertMessages(rows);
const status = { batch: { lastRun: null, running: false }, ollama: {} };
const extractor = createExtractor({ config, status });
const timed = { ...extractor, extract: async (u, ka) => {
  const t = Date.now();
  const out = await extractor.extract(u, ka);
  console.log(`call: ${Date.now() - t} ms, prompt ${out.promptTokens} tok, output ${out.outputTokens} tok, keep_alive=${ka}`);
  return out;
} };
const log = { info: (a, b) => console.log(a, b ?? ''), warn: console.warn, error: console.error };
const rawExtract = timed.extract;
timed.extract = async (u, ka) => { const out = await rawExtract(u, ka); for (const t of out.tasks) console.log(`   model: [${t.message_id}] ${t.assignee} | due_text=${JSON.stringify(t.due_text)} guess=${t.due_guess}`); return out; };
const batcher = createBatcher({ store, config, extractor: timed, nameOf, meIds: () => new Set([ME]), status, log });

const t0 = Date.now();
const res = await batcher.run();
console.log(`\ntotal ${Date.now() - t0} ms`, res);
const text = Object.fromEntries(rows.map((r) => [r.id, r.text]));
for (const t of store.db.prepare('SELECT * FROM tasks ORDER BY id').all()) {
  console.log(`- [${t.assignee}] ${t.title} | due ${t.due ?? '-'} (${t.due_kind ?? '-'}) | conf ${t.confidence} ${t.flagged ? 'FLAG' : ''}\n    <- ${text[t.message_id]}`);
}
console.log('\nsummaries:');
for (const s of store.db.prepare('SELECT chat_id, line FROM summaries').all()) console.log(`  ${nameOf(s.chat_id)}: ${s.line}`);
store.close();

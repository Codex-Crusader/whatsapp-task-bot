import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseExport, parseLabels, toEvalRow } from '../eval/evaluate.js';

const file = 'WhatsApp Chat with CSE 3rd Year.txt';
const text = readFileSync(`eval/sample/${file}`, 'utf8');

test('eval: parses Android export lines, multi-line messages, am/pm', () => {
  const msgs = parseExport(text, file);
  assert.equal(msgs.length, 14, 'system line skipped');
  const fee = msgs.find((m) => m.line === 11);
  assert.equal(fee.sender, 'Asha');
  assert.equal(fee.text, 'Fee payment last date is 20/10.\nAlso bring the receipt to the office.');
  assert.equal(new Date(fee.ts).getHours(), 9);
  const pm = parseExport('12/10/26, 8:01 pm - Ravi: hi\n12/10/26, 12:05 am - Ravi: late\n13/10/2026, 21:05 - Ravi: 24h', 'x.txt');
  assert.deepEqual(pm.map((m) => [new Date(m.ts).getDate(), new Date(m.ts).getHours()]), [[12, 20], [12, 0], [13, 21]]);
});

test('eval: noise dropped, mentions from @Name text, labels file', () => {
  const opts = { me: 'Alexander Morgan', meNames: ['alexander morgan', 'alexander', 'alex'], isDm: false };
  const byLine = Object.fromEntries(parseExport(text, file).map((m) => [m.line, toEvalRow(m, opts)]));
  assert.equal(byLine[9], null, 'media omitted');
  assert.equal(byLine[13], null, 'deleted');
  assert.equal(byLine[16], null, 'emoji only');
  assert.equal(byLine[5].mentions_me, 1);
  assert.equal(byLine[10].mentions_me, 0);
  assert.equal(byLine[10].mentioned, 'karthik');
  assert.equal(byLine[15].sender_id, 'me');
  const labels = parseLabels(readFileSync('eval/sample/labels.csv', 'utf8'));
  assert.equal(labels.size, 15);
  assert.equal(labels.get(`${file}:5`), 'mine');
  assert.throws(() => parseLabels('a.txt,1,maybe'), /bad label/);
});

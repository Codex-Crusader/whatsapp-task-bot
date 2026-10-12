import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toRow, createIngest, isEmojiOnly, clipText } from '../src/ingest.js';
import { openStore } from '../src/store.js';
import { WAMessageStubType } from 'baileys';

const ME_PN = '919000000001@s.whatsapp.net';
const ME_LID = '111111111111111@lid';
const me = new Set([ME_PN, ME_LID]);
const GROUP = '120363000000000001@g.us';
const ALICE_PN = '919000000002@s.whatsapp.net';
const ALICE_LID = '222222222222222@lid';

let n = 0;
const msg = (message, key = {}, ts = 1760000000) => ({
  key: { id: `M${++n}`, remoteJid: GROUP, participant: ALICE_LID, participantAlt: ALICE_PN, fromMe: false, ...key },
  messageTimestamp: ts,
  message,
});

test('ingest: drops noise before storage', () => {
  const drop = [
    msg({ stickerMessage: {} }),
    msg({ reactionMessage: { text: '👍', key: { id: 'X' } } }),
    msg({ protocolMessage: { type: 0 } }),
    msg({ pollCreationMessageV3: { name: 'Lunch?', options: [] } }),
    msg({ imageMessage: { mimetype: 'image/jpeg' } }),
    msg({ audioMessage: {} }),
    msg({ senderKeyDistributionMessage: {} }),
    msg({ conversation: '😂😂 👍🏽' }),
    msg({ conversation: '🇮🇳' }),
    msg({ conversation: '   ' }),
    msg({ conversation: 'status text' }, { remoteJid: 'status@broadcast' }),
    msg({ conversation: 'news' }, { remoteJid: '1203630000@newsletter' }),
  ];
  for (const m of drop) assert.equal(toRow(m, me), null, JSON.stringify(m.message));
  assert.equal(isEmojiOnly('ok 👍'), false);
  assert.equal(isEmojiOnly('123'), false);
});

test('ingest: keeps text and captions in compact rows', () => {
  const r = toRow(msg({ conversation: '  submit by friday ' }), me);
  assert.deepEqual(Object.keys(r).sort(), ['chat_id', 'id', 'is_dm', 'mentioned', 'mentions_me', 'quoted_sender_id', 'sender_id', 'text', 'ts'].sort());
  assert.equal(r.text, 'submit by friday');
  assert.equal(r.sender_id, ALICE_PN); // phone number preferred over LID
  assert.equal(r.chat_id, GROUP);
  assert.equal(r.is_dm, 0);
  assert.equal(r.ts, 1760000000000);
  assert.equal(toRow(msg({ imageMessage: { caption: 'form attached, fill it' } }), me).text, 'form attached, fill it');
  assert.equal(toRow(msg({ documentWithCaptionMessage: { message: { documentMessage: { caption: 'doc cap' } } } }), me).text, 'doc cap');
  assert.equal(toRow(msg({ ephemeralMessage: { message: { conversation: 'temp' } } }), me).text, 'temp');
});

test('ingest: mentions_me and quoted_sender_id match both phone number and LID', () => {
  const byLid = toRow(msg({ extendedTextMessage: { text: '@111 do this', contextInfo: { mentionedJid: [ME_LID] } } }), me);
  assert.equal(byLid.mentions_me, 1);
  assert.equal(byLid.mentioned, null);
  const byPn = toRow(msg({ extendedTextMessage: { text: '@91 do this', contextInfo: { mentionedJid: [`${ME_PN.split('@')[0]}:12@s.whatsapp.net`] } } }), me);
  assert.equal(byPn.mentions_me, 1, 'device suffix is normalized');
  const other = toRow(msg({ extendedTextMessage: { text: '@alice do this', contextInfo: { mentionedJid: [ALICE_LID] } } }), me);
  assert.equal(other.mentions_me, 0);
  assert.equal(other.mentioned, ALICE_LID);
  const quoteMe = toRow(msg({ extendedTextMessage: { text: 'yes you', contextInfo: { stanzaId: 'Q1', participant: ME_LID } } }), me);
  assert.equal(quoteMe.quoted_sender_id, 'me');
  const quoteOther = toRow(msg({ extendedTextMessage: { text: 'ok', contextInfo: { stanzaId: 'Q2', participant: ALICE_PN } } }), me);
  assert.equal(quoteOther.quoted_sender_id, ALICE_PN);
});

test('ingest: DM rows, own messages, LID DM chat id', () => {
  const dm = toRow(msg({ conversation: 'call me' }, { remoteJid: ALICE_LID, remoteJidAlt: ALICE_PN, participant: undefined, participantAlt: undefined }), me);
  assert.equal(dm.chat_id, ALICE_PN);
  assert.equal(dm.sender_id, ALICE_PN);
  assert.equal(dm.is_dm, 1);
  const mine = toRow(msg({ conversation: 'sure' }, { remoteJid: ALICE_PN, fromMe: true, participant: undefined }), me);
  assert.equal(mine.sender_id, 'me');
});

test('ingest: long text keeps first 1500 and last 500 characters', () => {
  const long = 'A'.repeat(1600) + 'B'.repeat(600) + 'deadline friday';
  const c = clipText(long);
  assert.ok(c.startsWith('A'.repeat(1500)));
  assert.ok(c.endsWith('deadline friday'));
  assert.equal(c.length, 1500 + 3 + 500);
  assert.equal(clipText('short'), 'short');
});

function setup() {
  const store = openStore(join(mkdtempSync(join(tmpdir(), 'wabot-')), 'i.db'));
  const status = { whatsapp: { lastMessageAt: null }, ingest: { seen: 0, stored: 0, dropped: 0, ignored: 0 } };
  const log = { error() {}, info() {}, warn() {} };
  const ingest = createIngest({ store, status, log, meIds: () => me, isIgnored: (id) => id === 'ignored@g.us' });
  const count = () => store.db.prepare('SELECT COUNT(*) FROM messages').pluck().get();
  return { store, status, ingest, count };
}

test('write buffer: flushes at 200 rows or after 2 seconds', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { ingest, count, status } = setup();
    ingest.onUpsert(Array.from({ length: 199 }, () => msg({ conversation: 'hello there' })));
    assert.equal(count(), 0);
    ingest.onUpsert([msg({ conversation: 'one more' })]);
    assert.equal(count(), 200, 'flush at 200');
    ingest.onUpsert([msg({ conversation: 'late' }), msg({ conversation: 'x' }, { remoteJid: 'ignored@g.us' })]);
    assert.equal(count(), 200);
    mock.timers.tick(1999);
    assert.equal(count(), 200);
    mock.timers.tick(1);
    assert.equal(count(), 201, 'flush after 2 s; ignored chat dropped');
    assert.equal(status.whatsapp.lastMessageAt, 1760000000000);
  } finally {
    mock.timers.reset();
  }
});

test('edits and deletes work in the buffer and in the database', () => {
  const { ingest, store } = setup();
  const a = msg({ conversation: 'old a' });
  const b = msg({ conversation: 'old b' });
  ingest.onUpsert([a, b]);
  ingest.onUpdate([{ key: a.key, update: { message: { editedMessage: { message: { conversation: 'new a' } } } } }]);
  ingest.flush();
  const text = (id) => store.db.prepare('SELECT text FROM messages WHERE id = ?').pluck().get(id);
  assert.equal(text(a.key.id), 'new a', 'edit in buffer');
  ingest.onUpdate([{ key: b.key, update: { message: { editedMessage: { message: { extendedTextMessage: { text: 'new b' } } } } } }]);
  assert.equal(text(b.key.id), 'new b', 'edit in database');
  ingest.onUpdate([{ key: a.key, update: { message: null, messageStubType: WAMessageStubType.REVOKE } }]);
  assert.equal(text(a.key.id), undefined, 'delete in database');
  const c = msg({ conversation: 'gone' });
  ingest.onUpsert([c]);
  ingest.onDelete({ keys: [c.key] });
  ingest.flush();
  assert.equal(text(c.key.id), undefined, 'delete in buffer');
  ingest.onUpdate([{ key: b.key, update: { status: 3 } }]);
  assert.equal(text(b.key.id), 'new b', 'receipt updates are ignored');
});

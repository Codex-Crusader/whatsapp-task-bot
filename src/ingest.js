// Turns Baileys messages into compact rows, drops noise, and writes rows
// to SQLite through a buffer (one transaction every 2 s or 200 rows).
import { extractMessageContent, jidNormalizedUser, isJidGroup, isJidNewsletter, isJidStatusBroadcast, isJidBroadcast, isLidUser, toNumber, WAMessageStubType } from 'baileys';
import { LIMITS } from './config.js';

// Emoji, skin tones, joiners, variation selectors, keycap, flags, spaces.
const EMOJI_ONLY = /^[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}‍️⃣\s]+$/u;

export function isEmojiOnly(text) {
  return EMOJI_ONLY.test(text);
}

export function clipText(text) {
  if (text.length <= LIMITS.textMax) return text;
  return `${text.slice(0, LIMITS.textHead)} … ${text.slice(-LIMITS.textTail)}`;
}

// Text or caption plus contextInfo. Anything else (sticker, reaction,
// protocol, poll, media without caption) gives text = null.
export function readContent(message) {
  const c = extractMessageContent(message);
  if (!c) return { text: null, ctx: null };
  const part = c.extendedTextMessage || c.imageMessage || c.videoMessage || c.documentMessage;
  const text = c.conversation || c.extendedTextMessage?.text || part?.caption || null;
  return { text, ctx: part?.contextInfo || null };
}

const norm = (jid) => (jid ? jidNormalizedUser(jid) : null);

// The chat id for a DM prefers the phone-number form, so one person is one chat.
export function chatIdOf(key) {
  const jid = key.remoteJid;
  if (!isJidGroup(jid) && isLidUser(jid) && key.remoteJidAlt) return norm(key.remoteJidAlt);
  return norm(jid);
}

export function senderIdOf(key) {
  if (key.fromMe) return 'me';
  if (isJidGroup(key.remoteJid)) {
    const p = isLidUser(key.participant) && key.participantAlt ? key.participantAlt : key.participant;
    return norm(p);
  }
  return chatIdOf(key);
}

export function isSkippedChat(jid) {
  return !jid || isJidStatusBroadcast(jid) || isJidNewsletter(jid) || isJidBroadcast(jid);
}

// Returns a row, or null if the message must be dropped.
// meIds: Set of my normalized JIDs (phone number and LID).
export function toRow(msg, meIds) {
  const key = msg.key;
  if (!key?.id || isSkippedChat(key.remoteJid)) return null;
  const { text, ctx } = readContent(msg.message);
  if (!text || !text.trim() || isEmojiOnly(text)) return null;

  const mentions = (ctx?.mentionedJid || []).map(norm);
  const mentionsMe = mentions.some((j) => meIds.has(j));
  const others = mentions.filter((j) => !meIds.has(j));
  let quoted = null;
  if (ctx?.stanzaId && ctx.participant) {
    const q = norm(ctx.participant);
    quoted = meIds.has(q) ? 'me' : q;
  }
  const chatId = chatIdOf(key);
  return {
    id: key.id,
    chat_id: chatId,
    sender_id: senderIdOf(key),
    ts: toNumber(msg.messageTimestamp) * 1000,
    text: clipText(text.trim()),
    quoted_sender_id: quoted,
    mentions_me: mentionsMe ? 1 : 0,
    is_dm: isJidGroup(chatId) ? 0 : 1,
    mentioned: others.length ? others.join(' ') : null,
  };
}

// isIgnored(chatId) comes from the reader, which knows chat names.
export function createIngest({ store, meIds, isIgnored, status, log }) {
  let buffer = [];
  let timer = null;

  function flush() {
    clearTimeout(timer);
    timer = null;
    if (!buffer.length) return 0;
    const rows = buffer;
    buffer = [];
    try {
      return store.insertMessages(rows);
    } catch (err) {
      log.error('ingest: write failed', { rows: rows.length, err: err.message });
      throw err;
    }
  }

  function add(row) {
    buffer.push(row);
    if (buffer.length >= LIMITS.writeBufferRows) flush();
    else if (!timer) timer = setTimeout(flush, LIMITS.writeBufferMs);
  }

  function onUpsert(messages) {
    const me = meIds();
    const c = status.ingest;
    for (const msg of messages) {
      c.seen++;
      const row = toRow(msg, me);
      if (!row) { c.dropped++; continue; }
      if (isIgnored(row.chat_id)) { c.ignored++; continue; }
      c.stored++;
      add(row);
      if (row.ts > (status.whatsapp.lastMessageAt ?? 0)) status.whatsapp.lastMessageAt = row.ts;
    }
  }

  // Edits change the stored text. Deletes remove the row.
  function onUpdate(updates) {
    for (const { key, update } of updates) {
      if (!key?.id) continue;
      if (update.messageStubType === WAMessageStubType.REVOKE || update.message === null) {
        remove(key.id);
      } else if (update.message?.editedMessage) {
        const { text } = readContent(update.message);
        if (text && text.trim() && !isEmojiOnly(text)) edit(key.id, clipText(text.trim()));
      }
    }
  }

  function edit(id, text) {
    const queued = buffer.find((r) => r.id === id);
    if (queued) queued.text = text;
    else store.s.updateText.run(text, id);
  }

  function remove(id) {
    const before = buffer.length;
    buffer = buffer.filter((r) => r.id !== id);
    if (buffer.length === before) store.s.deleteMessage.run(id);
  }

  function onDelete(item) {
    for (const key of item?.keys || []) if (key?.id) remove(key.id);
  }

  return { onUpsert, onUpdate, onDelete, flush, pending: () => buffer.length };
}

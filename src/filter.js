// Rule filter (code only, no LLM). Gives each message a signal:
// me | other:<name> | everyone | candidate | none

const escape = (s) => s.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');

// One regex for aliases, "everyone" words and task words. Named groups tell
// which list matched. Word edges are Unicode-safe (letters and digits).
export function compileMatcher(config) {
  const alt = (list) => list.filter((x) => x.trim()).map(escape).join('|') || '(?!)';
  const names = [config.myName, ...config.aliases].filter(Boolean);
  const src = `(?<![\\p{L}\\p{N}])(?:(?<alias>${alt(names)})|(?<everyone>${alt(config.everyoneWords)})|(?<task>${alt(config.taskWords)}))(?![\\p{L}\\p{N}])`;
  return new RegExp(src, 'giu');
}

function scan(re, text) {
  const hit = { alias: false, everyone: false, task: false };
  for (const m of text.matchAll(re)) {
    if (m.groups.alias) hit.alias = true;
    else if (m.groups.everyone) hit.everyone = true;
    else if (m.groups.task) hit.task = true;
  }
  return hit;
}

// Returns { signal, reason }. reason tells the batcher how to set the assignee.
// selfChatId: my own chat (Message yourself); my notes there count as "me".
export function classify(row, { re, nameOf, selfChatIds }) {
  if (row.sender_id === 'me') {
    return selfChatIds.has(row.chat_id) ? { signal: 'me', reason: 'self' } : { signal: 'none', reason: 'mine' };
  }
  if (row.mentions_me) return { signal: 'me', reason: 'mention' };
  if (row.quoted_sender_id === 'me') return { signal: 'me', reason: 'quote' };
  if (row.is_dm) return { signal: 'me', reason: 'dm' };
  if (row.mentioned) {
    const first = row.mentioned.split(' ')[0];
    return { signal: `other:${nameOf(first)}`, reason: 'other' };
  }
  const hit = scan(re, row.text);
  if (hit.everyone) return { signal: 'everyone', reason: 'everyone' };
  if (hit.alias) return { signal: 'candidate', reason: 'alias' };
  if (hit.task) return { signal: 'candidate', reason: 'keyword' };
  return { signal: 'none', reason: 'none' };
}

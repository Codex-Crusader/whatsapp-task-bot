// Read-only guard. The rest of the bot gets only this wrapped socket.
// Allowlist: anything not listed here throws, so no code path can send.
// Baileys' own protocol acks happen inside Baileys and do not pass here.

const ALLOWED = new Set([
  'ev', // event emitter (read events)
  'user', // own JID and LID
  'groupMetadata', // query, no message
  'groupFetchAllParticipating', // query, no message
  'requestPairingCode', // first link only, no message
  'end', // close the connection
]);

// Named for a clear error. All of these are blocked by the allowlist too.
export const BLOCKED = [
  'sendMessage', 'relayMessage', 'readMessages', 'sendReceipt', 'sendReceipts',
  'sendPresenceUpdate', 'presenceSubscribe', 'chatModify', 'sendMessageAck',
  'sendPeerDataOperationMessage', 'updateMediaMessage', 'star', 'sendNode', 'ws',
  'sendWAMBuffer', 'query', 'newsletterReactMessage', 'groupParticipantsUpdate',
];

export class SendBlockedError extends Error {
  constructor(name) {
    super(`read-only guard: "${String(name)}" is blocked`);
    this.name = 'SendBlockedError';
  }
}

export function guardSocket(sock) {
  return new Proxy({}, {
    get(_, prop) {
      if (typeof prop === 'symbol') return undefined;
      if (!ALLOWED.has(prop)) throw new SendBlockedError(prop);
      const value = sock[prop];
      return typeof value === 'function' ? value.bind(sock) : value;
    },
    set(_, prop) { throw new SendBlockedError(`set ${String(prop)}`); },
    defineProperty(_, prop) { throw new SendBlockedError(`define ${String(prop)}`); },
    has(_, prop) { return ALLOWED.has(prop); },
    ownKeys() { return []; },
  });
}

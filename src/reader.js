// WhatsApp connection (Baileys). Read-only: the bot uses only the guarded socket.
import makeWASocket, { Browsers, DisconnectReason, jidNormalizedUser, isJidGroup, proto } from 'baileys';
import { useSqliteAuthState } from './store.js';
import { guardSocket } from './guard.js';
import { baileysLogger } from './log.js';
import { recordError } from './status.js';

const DAY = 24 * 60 * 60 * 1000;
const STOP_CODES = new Set([DisconnectReason.loggedOut, DisconnectReason.connectionReplaced, DisconnectReason.forbidden]);

// History sync: only the types that carry LID-to-phone mappings and names.
// The bot never stores history messages (it ingests messages.upsert only).
const T = proto.HistorySync.HistorySyncType;
const SYNC_TYPES = new Set([T.INITIAL_BOOTSTRAP, T.PUSH_NAME, T.NON_BLOCKING_DATA]);

export function createReader({ store, config, status, log, onUpsert, onUpdate, onDelete, pairPhone = null, onPairingCode = null, onLinkFailed = null, onStopped = null }) {
  let auth = useSqliteAuthState(store);
  // Linking in progress: { phone, onCode, onFail, onLinked }. Set by the link CLI or by link().
  let pairing = pairPhone ? { phone: pairPhone, onCode: onPairingCode, onFail: onLinkFailed } : null;
  let connGen = 0; // each connection has a number; events of an older one are ignored
  // warn by default; info while linking; BAILEYS_LOG=debug for diagnosis (text only, objects dropped)
  const blogger = baileysLogger(log, process.env.BAILEYS_LOG || (pairPhone ? 'info' : 'warn'));
  let sock = null; // always the guarded socket
  let stopped = false;
  let attempt = 0;
  let reconnectTimer = null;
  let groupTimer = null;
  let openWaiters = [];
  let offlineWaiters = [];
  const ignoreMemo = new Map();
  const knownContacts = new Map();
  const fetchQueue = new Set(); // group JIDs waiting for one metadata query
  let fetchTimer = null;
  let ignoreKey = '';
  let ignoreSet = new Set();
  const ignoreList = () => {
    const key = JSON.stringify(config.ignoredChats);
    if (key !== ignoreKey) { ignoreKey = key; ignoreSet = new Set(config.ignoredChats.map((x) => x.trim().toLowerCase())); ignoreMemo.clear(); }
    return ignoreSet;
  };

  // ---- caches ----
  function groupMeta(jid) {
    const row = store.s.getGroup.get(jid);
    return row ? JSON.parse(row.data) : undefined;
  }

  function saveGroup(meta) {
    if (!meta?.id) return;
    store.s.upsertGroup.run(meta.id, meta.subject ?? null, JSON.stringify(meta), Date.now());
    ignoreMemo.delete(meta.id);
  }

  // Merge partial updates (subject, settings) into the cache with no query.
  // Baileys also sends full metadata here after groupFetchAllParticipating.
  function mergeGroup(update) {
    if (!update?.id) return;
    const cached = groupMeta(update.id);
    if (cached) saveGroup({ ...cached, ...update });
    else if (update.participants) saveGroup(update);
    else fetchGroup(update.id);
  }

  // Queued: one query at a time, 2 s apart, so WhatsApp does not rate-limit us.
  function fetchGroup(jid) {
    fetchQueue.add(jid);
    if (!fetchTimer) fetchTimer = setTimeout(fetchNext, 0);
  }

  async function fetchNext() {
    const jid = fetchQueue.values().next().value;
    if (!jid || !sock || status.whatsapp.state !== 'open') {
      fetchTimer = null;
      return;
    }
    fetchQueue.delete(jid);
    try {
      saveGroup(await sock.groupMetadata(jid));
    } catch (err) {
      log.warn('reader: group metadata failed', { err: err.message });
    }
    fetchTimer = fetchQueue.size ? setTimeout(fetchNext, 2000) : null;
  }

  async function refreshAllGroups() {
    try {
      const all = await sock.groupFetchAllParticipating();
      store.db.transaction(() => { for (const m of Object.values(all)) saveGroup(m); })();
      store.kvSet('groupsRefreshedAt', Date.now());
      log.info('reader: group cache refreshed', { groups: Object.keys(all).length });
    } catch (err) {
      log.warn('reader: group refresh failed', { err: err.message });
    }
  }

  // WhatsApp sends "+91∙∙∙∙∙∙∙∙56" for people who hide their number. That is not a name.
  const masked = (name) => name.includes('∙');

  function noteContact(jid, name, fromAddressBook) {
    if (!jid || !name || masked(name)) return;
    jid = jidNormalizedUser(jid);
    if (knownContacts.get(jid) === name) return;
    if (fromAddressBook || !knownContacts.has(jid)) {
      if (fromAddressBook) store.s.upsertContact.run(jid, name);
      else store.s.addContactIfMissing.run(jid, name);
    }
    knownContacts.set(jid, name);
  }

  // Display name for a chat or person. Never empty.
  function nameOf(jid) {
    if (!jid) return 'unknown';
    if (jid === 'me') return config.myName || 'Me';
    if (isJidGroup(jid)) return store.s.getGroup.get(jid)?.subject || 'Unnamed group';
    const row = store.s.getContact.get(jid);
    if (row?.name && !masked(row.name)) return row.name;
    if (jid.endsWith('@lid')) {
      // LID -> phone number from Baileys' own mapping ("<lid>_reverse": "<number>").
      const pn = lidToPn(jid);
      return pn ? nameOf(pn) : 'Unknown contact';
    }
    return `+${jid.split('@')[0]}`;
  }

  function lidToPn(lid) {
    const value = store.s.authGet.get('lid-mapping', `${lid.split('@')[0]}_reverse`)?.value;
    return value ? `${JSON.parse(value)}@s.whatsapp.net` : null;
  }

  function isIgnored(chatId) {
    const list = ignoreList();
    if (!list.size) return false;
    if (ignoreMemo.has(chatId)) return ignoreMemo.get(chatId);
    if (isJidGroup(chatId) && !store.s.getGroup.get(chatId)) {
      fetchGroup(chatId); // name not known yet; decide again after the fetch
      return list.has(chatId.toLowerCase());
    }
    const hit = list.has(chatId.toLowerCase()) || list.has(nameOf(chatId).toLowerCase());
    ignoreMemo.set(chatId, hit);
    return hit;
  }

  function meIds() {
    const u = sock?.user;
    const ids = new Set();
    if (u?.id) ids.add(jidNormalizedUser(u.id));
    if (u?.lid) ids.add(jidNormalizedUser(u.lid));
    return ids;
  }

  // ---- connection ----
  function connect() {
    const gen = ++connGen;
    status.whatsapp.state = 'connecting';
    status.whatsapp.offlineDone = false;
    const raw = makeWASocket({
      auth: auth.state,
      logger: blogger,
      browser: Browsers.windows('Chrome'), // shown on the phone as "Chrome (Windows)"
      markOnlineOnConnect: false,
      syncFullHistory: false,
      shouldSyncHistoryMessage: ({ syncType }) => SYNC_TYPES.has(syncType),
      enableRecentMessageCache: false, // only used to resend own messages
      generateHighQualityLinkPreview: false,
      cachedGroupMetadata: async (jid) => groupMeta(jid),
      getMessage: async () => undefined,
    });
    sock = guardSocket(raw);
    const ev = sock.ev;
    let pairingAsked = false;

    ev.on('creds.update', auth.saveCreds);

    ev.on('connection.update', (u) => {
      if (gen !== connGen) return; // an older connection that link() replaced
      if (u.qr && pairing && !pairingAsked) {
        pairingAsked = true;
        const p = pairing;
        sock.requestPairingCode(p.phone)
          .then((code) => p.onCode?.(code))
          .catch((err) => {
            // No code: stop this attempt fully, so the setup page shows the form again.
            log.error('reader: pairing code failed', { err: err.message });
            recordError('whatsapp', err);
            pairing = null;
            stopped = true; // the close event of this socket must not reconnect
            try { sock?.end(undefined); } catch { /* already closed */ }
            freshAuth();
            setState('link failed');
            p.onFail?.('code');
          });
      }
      if (u.receivedPendingNotifications) {
        status.whatsapp.offlineDone = true;
        log.info('reader: offline messages received');
        offlineWaiters.forEach((f) => f());
        offlineWaiters = [];
      }
      if (u.connection === 'open') {
        attempt = 0;
        setState('open');
        log.info('reader: connected');
        if (pairing && auth.state.creds.account) {
          const p = pairing;
          pairing = null;
          log.info('reader: linked');
          p.onLinked?.();
        }
        openWaiters.forEach((f) => f());
        openWaiters = [];
        const last = Number(store.kvGet('groupsRefreshedAt') || 0);
        if (Date.now() - last > DAY) refreshAllGroups();
        clearInterval(groupTimer);
        groupTimer = setInterval(refreshAllGroups, DAY);
        if (fetchQueue.size && !fetchTimer) fetchTimer = setTimeout(fetchNext, 0);
      }
      if (u.connection === 'close') {
        clearInterval(groupTimer);
        const code = u.lastDisconnect?.error?.output?.statusCode;
        if (stopped) return setState('closed');
        if (pairing && !auth.state.creds.account && code !== DisconnectReason.restartRequired) {
          setState('link failed');
          log.error('reader: link not completed', { code });
          const p = pairing;
          pairing = null;
          freshAuth(); // a half-made link must not be used for a login (WhatsApp answers 401)
          return p.onFail?.(code);
        }
        if (STOP_CODES.has(code)) {
          const reason = DisconnectReason[code] || code;
          setState(code === DisconnectReason.loggedOut ? 'logged out' : `stopped (${reason})`);
          log.error('reader: connection closed, no reconnect', { code, reason });
          recordError('whatsapp', `closed: ${reason}`);
          onStopped?.(code, reason);
          return;
        }
        const delay = code === DisconnectReason.restartRequired ? 0 : Math.min(60_000, 2_000 * 2 ** attempt++);
        setState('reconnecting');
        log.warn('reader: connection closed, reconnect', { code, delayMs: delay });
        reconnectTimer = setTimeout(connect, delay);
      }
    });

    ev.on('messages.upsert', ({ messages }) => onUpsert(messages));
    ev.on('messages.update', (updates) => onUpdate(updates));
    ev.on('messages.delete', (item) => onDelete(item));

    ev.on('contacts.upsert', (list) => { for (const c of list) noteContact(c.id, c.name || c.notify || c.verifiedName, !!c.name); });
    ev.on('contacts.update', (list) => { for (const c of list) noteContact(c.id, c.name || c.notify, !!c.name); });
    // Names only. History messages in this event are not stored.
    ev.on('messaging-history.set', ({ contacts = [] }) => {
      for (const c of contacts) {
        const name = c.name || c.notify;
        for (const jid of [c.id, c.phoneNumber, c.lid]) noteContact(jid, name, !!c.name);
      }
    });

    ev.on('groups.upsert', (list) => { for (const m of list) saveGroup(m); });
    ev.on('groups.update', (list) => { for (const g of list) mergeGroup(g); });
    ev.on('group-participants.update', ({ id }) => fetchGroup(id));
  }

  function freshAuth() {
    auth.clear();
    auth = useSqliteAuthState(store); // also new in memory: the old object still has the phone number
  }

  // Link from the setup wizard. Allowed when not linked, or after WhatsApp logged the bot out.
  function link(phone, callbacks = {}) {
    if (auth.state.creds.account && status.whatsapp.state !== 'logged out') throw new Error('WhatsApp is already linked.');
    clearTimeout(reconnectTimer);
    stopped = false;
    try { sock?.end(undefined); } catch { /* not connected */ }
    sock = null;
    freshAuth();
    pairing = { phone, ...callbacks };
    connect();
  }

  function setState(state) {
    status.whatsapp.state = state;
    status.whatsapp.since = Date.now();
  }

  return {
    start: connect,
    stop() {
      stopped = true;
      clearTimeout(reconnectTimer);
      clearInterval(groupTimer);
      clearTimeout(fetchTimer);
      try { sock?.end(undefined); } catch { /* already closed */ }
    },
    waitOpen: () => (status.whatsapp.state === 'open' ? Promise.resolve() : new Promise((r) => openWaiters.push(r))),
    isOfflineDone: () => status.whatsapp.offlineDone,
    onOfflineDone: (f) => (status.whatsapp.offlineDone ? f() : offlineWaiters.push(f)),
    isLinked: () => !!auth.state.creds.account && status.whatsapp.state !== 'logged out', // account: set by WhatsApp on pair success
    isPairing: () => !!pairing,
    link,
    meIds,
    nameOf,
    isIgnored,
    refreshAllGroups,
  };
}

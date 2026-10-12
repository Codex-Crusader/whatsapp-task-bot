// First link with a pairing code: node src/link.js <phone number with country code>
import { config, DB_FILE } from './config.js';
import { openStore, useSqliteAuthState } from './store.js';
import { status } from './status.js';
import { log } from './log.js';
import { createReader } from './reader.js';
import { createIngest } from './ingest.js';

const phone = (process.argv[2] || '').replace(/\D/g, '');
if (phone.length < 8) {
  console.error('Usage: npm run link -- <phone number with country code, digits only>');
  process.exit(1);
}

const store = openStore(DB_FILE);

// A link that did not finish leaves a half-set auth state. Remove it,
// or WhatsApp sees a login for a device that does not exist (code 401).
const old = useSqliteAuthState(store);
if (old.state.creds.account) {
  console.log('This bot is already linked. To link again, delete data/bot.db first.');
  store.close();
  process.exit(0);
}
old.clear();

let reader = null;
const ingest = createIngest({ store, status, log, meIds: () => reader.meIds(), isIgnored: (id) => reader.isIgnored(id) });
reader = createReader({
  store, config, status, log,
  onUpsert: ingest.onUpsert, onUpdate: ingest.onUpdate, onDelete: ingest.onDelete,
  pairPhone: phone,
  onPairingCode: (code) => {
    console.log(`\nPairing code: ${code.slice(0, 4)}-${code.slice(4)}`);
    console.log('On the phone: WhatsApp > Linked devices > Link a device > Link with phone number instead.');
    console.log('Type the code within 2 minutes.\n');
  },
  onLinkFailed: (code) => {
    useSqliteAuthState(store).clear();
    store.close();
    console.error(`The link did not finish (code ${code}). The code expired or the phone refused it. Run the command again.`);
    process.exit(1);
  },
});

reader.start();
await reader.waitOpen();
console.log('Linked. Saving keys and contact names...');
await new Promise((r) => setTimeout(r, 30_000)); // let the first sync finish
ingest.flush();
reader.stop();
store.close();
log.info('link: done');
console.log('Done. Start the bot with: npm start');
process.exit(0);

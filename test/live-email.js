// Manual check: builds today's report from current data and emails it with [TEST].
// Saves nothing: no report row, no lastEmailDate. Run: node test/live-email.js
import { config, env, DB_FILE } from '../src/config.js';
import { openStore, localDay } from '../src/store.js';
import { status } from '../src/status.js';
import { createReader } from '../src/reader.js';
import { createExtractor } from '../src/extractor.js';
import { createReporter } from '../src/report.js';
import { createMailer } from '../src/mailer.js';

const log = { info: (m, f) => console.log(m, f ?? ''), warn: console.warn, error: console.error };
const store = openStore(DB_FILE);
const reader = createReader({ store, config, status, log, onUpsert() {}, onUpdate() {}, onDelete() {} }); // not started
const reporter = createReporter({ store, config, extractor: createExtractor({ config, status }), nameOf: reader.nameOf, log });
const day = localDay();
const data = await reporter.collect(day, Date.now() - 24 * 3600 * 1000, Date.now());
console.log('stats', data.stats, 'chats', data.chats.length);
await createMailer({ env, status, log }).sendReport(day, reporter.render(data), data.stats, { prefix: '[TEST] ' });
store.close();

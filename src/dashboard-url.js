// Prints the dashboard access link: npm run dashboard-url
// With --new it makes a new token first (if a shortcut or link leaked).
// Restart the bot after --new: the running bot still knows only the old token.
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { config, DATA_DIR } from './config.js';
import { loadOrCreateToken, loginUrl, writeShortcut } from './access.js';

if (process.argv.includes('--new')) {
  rmSync(join(DATA_DIR, 'dashboard-token'), { force: true });
  const token = loadOrCreateToken();
  writeShortcut(config.dashboardPort, token);
  console.log('New access token made. The old link and the old shortcut no longer work after a restart of the bot.');
  console.log('Restart the bot now (close its window and start it again, or restart the Task Scheduler task).\n');
  console.log(loginUrl(config.dashboardPort, token));
} else {
  console.log(loginUrl(config.dashboardPort, loadOrCreateToken()));
}

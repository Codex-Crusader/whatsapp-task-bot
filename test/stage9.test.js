import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, saveConfig, saveEnv, loadEnv, checkServiceAccount, validAppPassword, validEmail } from '../src/config.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'wabot-'));

test('settings: saveConfig applies at once, writes only allowed keys, checks values', () => {
  const dir = tmp();
  const file = join(dir, 'config.json');
  const cfg = loadConfig(file);
  saveConfig({ myName: 'Alexander Morgan', aliases: ['Alex'], emailTime: '20:30', dashboardPort: 9999, ollama: { url: 'http://evil.example' } }, cfg, file);
  assert.equal(cfg.myName, 'Alexander Morgan', 'live object changed');
  assert.equal(cfg.emailTime, '20:30');
  assert.equal(cfg.dashboardPort, 4780, 'port is not editable from the page');
  assert.equal(cfg.ollama.url, 'http://127.0.0.1:11434', 'Ollama address is not editable from the page');
  const disk = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(disk.aliases, ['Alex']);
  assert.equal(disk.dashboardPort, undefined);
  assert.throws(() => saveConfig({ emailTime: '25:00' }, cfg, file), /emailTime/);
  assert.throws(() => saveConfig({ aliases: ['a\nb'] }, cfg, file), /aliases/);
  assert.throws(() => saveConfig({ batchIntervalMinutes: 0 }, cfg, file), /batchIntervalMinutes/);
  assert.equal(cfg.emailTime, '20:30', 'a refused change leaves the config as it was');
  writeFileSync(file, JSON.stringify({ ollama: { url: 'http://192.168.1.5:11434' } }));
  assert.throws(() => loadConfig(file), /must be on this computer/, 'message text never goes to another machine');
});

test('secrets: saveEnv keeps other lines, refuses line breaks, never adds unknown keys', () => {
  const dir = tmp();
  const file = join(dir, '.env');
  writeFileSync(file, '# my notes\nOTHER=keep me\nGMAIL_USER=old@example.com\n');
  const env = loadEnv(file, {});
  saveEnv({ gmailUser: 'alex@example.com', gmailAppPassword: 'abcd efgh ijkl mnop' }, env, file);
  const text = readFileSync(file, 'utf8');
  assert.match(text, /# my notes\nOTHER=keep me\nGMAIL_USER=alex@example.com\n/);
  assert.equal(env.gmailUser, 'alex@example.com');
  assert.equal(env.gmailAppPassword, 'abcdefghijklmnop', 'spaces removed');
  assert.equal(env.reportTo, 'alex@example.com', 'report goes to the Gmail address by default');
  assert.throws(() => saveEnv({ calendarId: 'x@y.com\nGMAIL_USER=attacker@evil.com' }, env, file), /not allowed/);
  assert.throws(() => saveEnv({ PATH: 'x' }, env, file), /unknown setting/);
  assert.doesNotMatch(readFileSync(file, 'utf8'), /attacker/);
  assert.equal(validAppPassword('abcd efgh ijkl mnop'), true);
  assert.equal(validAppPassword('abcd1234efgh5678'), false);
  assert.equal(validEmail('a@b.co'), true);
  assert.equal(validEmail('a@b'), false);
});

test('key upload: only a real service account key is accepted', () => {
  const good = JSON.stringify({ type: 'service_account', client_email: 'bot@proj-1.iam.gserviceaccount.com', private_key: '-----BEGIN PRIVATE KEY-----\nAAA\n-----END PRIVATE KEY-----\n' });
  assert.equal(checkServiceAccount(good).client_email, 'bot@proj-1.iam.gserviceaccount.com');
  assert.throws(() => checkServiceAccount('{'), /not valid JSON/);
  assert.throws(() => checkServiceAccount(JSON.stringify({ type: 'authorized_user' })), /not a service account/);
  assert.throws(() => checkServiceAccount(JSON.stringify({ type: 'service_account', client_email: 'x@gmail.com', private_key: 'k' })), /client_email/);
  assert.throws(() => checkServiceAccount('x'.repeat(20000)), /too large/);
});

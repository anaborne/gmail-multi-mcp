#!/usr/bin/env node
/**
 * Asks Google who each configured token belongs to and prints the answer beside what the
 * config claims. Run it after any change to .env, and first whenever something reads or
 * replies from a mailbox you did not expect.
 *
 *   npm run accounts
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

function loadDotEnv() {
  const path = join(ROOT, '.env');
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnv();

const { AccountRegistry, configFromEnv } = await import('../dist/accounts.js');
const { describeError } = await import('../dist/errors.js');

let config;
try {
  config = configFromEnv();
} catch (err) {
  console.error(`\n  x ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}

const registry = new AccountRegistry(config);

console.log('');
let bad = 0;

for (const account of registry.list()) {
  try {
    await registry.resolve(account.label);
    console.log(`  ok       ${account.label.padEnd(12)} ${account.email}`);
  } catch (err) {
    bad += 1;
    console.log(`  BROKEN   ${account.label.padEnd(12)} ${account.email}`);
    console.log(`           ${describeError(err, account.label)}`);
  }
}

console.log('');
console.log(`  scope:   ${config.scopeProfile === 'readonly' ? 'read only (gmail.readonly)' : 'read, drafts, send, labels, trash (gmail.modify)'}`);
console.log(`  sending: ${config.allowSend ? 'ENABLED' : 'disabled, drafts only'}`);
console.log('');

process.exit(bad === 0 ? 0 : 1);

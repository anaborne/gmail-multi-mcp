import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AccountRegistry,
  configFromEnv,
  parseAllowSend,
  parseScopeProfile,
  scopeFor,
  GMAIL_MODIFY_SCOPE,
  GMAIL_READONLY_SCOPE,
} from '../dist/accounts.js';

const BASE = {
  GMAIL_CLIENT_ID: 'client-id',
  GMAIL_CLIENT_SECRET: 'client-secret',
  GMAIL_ACCOUNTS: 'personal,jobs',
  GMAIL_ACCOUNT_PERSONAL_EMAIL: 'a@gmail.com',
  GMAIL_ACCOUNT_PERSONAL_REFRESH_TOKEN: 'token-a',
  GMAIL_ACCOUNT_JOBS_EMAIL: 'b@gmail.com',
  GMAIL_ACCOUNT_JOBS_REFRESH_TOKEN: 'token-b',
};

test('parses two accounts from env', () => {
  const config = configFromEnv({ ...BASE });
  assert.equal(config.accounts.length, 2);
  assert.deepEqual(
    config.accounts.map((a) => [a.label, a.email]),
    [
      ['personal', 'a@gmail.com'],
      ['jobs', 'b@gmail.com'],
    ],
  );
  assert.equal(config.allowSend, false);
  assert.equal(config.scopeProfile, 'full');
});

test('falls back to GOOGLE_ credentials so one OAuth client can serve both servers', () => {
  const env = { ...BASE };
  delete env.GMAIL_CLIENT_ID;
  delete env.GMAIL_CLIENT_SECRET;
  env.GOOGLE_CLIENT_ID = 'shared-id';
  env.GOOGLE_CLIENT_SECRET = 'shared-secret';
  const config = configFromEnv(env);
  assert.equal(config.accounts[0].clientId, 'shared-id');
});

test('an empty GMAIL_CLIENT_ID falls back too, since that is what .env.example ships', () => {
  const env = { ...BASE, GMAIL_CLIENT_ID: '', GMAIL_CLIENT_SECRET: '' };
  env.GOOGLE_CLIENT_ID = 'shared-id';
  env.GOOGLE_CLIENT_SECRET = 'shared-secret';
  const config = configFromEnv(env);
  assert.equal(config.accounts[0].clientId, 'shared-id');
  assert.equal(config.accounts[0].clientSecret, 'shared-secret');
});

test('a per-account client overrides the shared one', () => {
  const config = configFromEnv({ ...BASE, GMAIL_ACCOUNT_JOBS_CLIENT_ID: 'other-id' });
  assert.equal(config.accounts[0].clientId, 'client-id');
  assert.equal(config.accounts[1].clientId, 'other-id');
});

test('refuses an empty roster and says what to write', () => {
  assert.throws(() => configFromEnv({}), /GMAIL_ACCOUNTS is empty/);
});

test('names the missing variable rather than failing on every later call', () => {
  const env = { ...BASE };
  delete env.GMAIL_ACCOUNT_JOBS_REFRESH_TOKEN;
  assert.throws(() => configFromEnv(env), /GMAIL_ACCOUNT_JOBS_REFRESH_TOKEN/);
});

test('refuses a duplicate label', () => {
  assert.throws(
    () => configFromEnv({ ...BASE, GMAIL_ACCOUNTS: 'personal,personal' }),
    /listed twice/,
  );
});

test('refuses two labels for one mailbox', () => {
  assert.throws(
    () => configFromEnv({ ...BASE, GMAIL_ACCOUNT_JOBS_EMAIL: 'a@gmail.com' }),
    /both declare a@gmail.com/,
  );
});

test('refuses an email address used as a label', () => {
  assert.throws(
    () => configFromEnv({ ...BASE, GMAIL_ACCOUNTS: 'a@gmail.com' }),
    /is not usable/,
  );
});

test('refuses an address that is not an address', () => {
  assert.throws(
    () => configFromEnv({ ...BASE, GMAIL_ACCOUNT_JOBS_EMAIL: 'jobs' }),
    /is not an email address/,
  );
});

test('labels are lowercased so the model cannot miss by case', () => {
  const config = configFromEnv({
    GMAIL_CLIENT_ID: 'i',
    GMAIL_CLIENT_SECRET: 's',
    GMAIL_ACCOUNTS: 'Jobs',
    GMAIL_ACCOUNT_JOBS_EMAIL: 'B@Gmail.com',
    GMAIL_ACCOUNT_JOBS_REFRESH_TOKEN: 't',
  });
  assert.equal(config.accounts[0].label, 'jobs');
  assert.equal(config.accounts[0].email, 'b@gmail.com');
});

test('true enables sending case-insensitively, and an ambiguous value is refused', () => {
  assert.equal(parseAllowSend(undefined), false);
  assert.equal(parseAllowSend(''), false);
  assert.equal(parseAllowSend('false'), false);
  assert.equal(parseAllowSend('0'), false);
  assert.equal(parseAllowSend('no'), false);
  assert.equal(parseAllowSend('true'), true);
  assert.equal(parseAllowSend('TRUE'), true);
  assert.throws(() => parseAllowSend('yes'), /not a yes or a no/);
  assert.throws(() => parseAllowSend('1'), /not a yes or a no/);
});

test('scope profiles map to the two Gmail scopes', () => {
  assert.equal(parseScopeProfile(undefined), 'full');
  assert.equal(parseScopeProfile('readonly'), 'readonly');
  assert.equal(scopeFor('full'), GMAIL_MODIFY_SCOPE);
  assert.equal(scopeFor('readonly'), GMAIL_READONLY_SCOPE);
  assert.throws(() => parseScopeProfile('write'), /not a scope profile/);
});

function registryWith(profiles, counter = { calls: 0 }) {
  const config = configFromEnv({ ...BASE });
  const registry = new AccountRegistry(config, async (account) => {
    counter.calls += 1;
    return profiles[account.config.label];
  });
  return { registry, counter };
}

test('an account resolves by label and by its own address', async () => {
  const { registry } = registryWith({ personal: 'a@gmail.com', jobs: 'b@gmail.com' });
  assert.equal((await registry.resolve('jobs')).config.email, 'b@gmail.com');
  assert.equal((await registry.resolve('B@GMAIL.COM')).config.label, 'jobs');
});

test('an unknown account names the ones that exist', async () => {
  const { registry } = registryWith({ personal: 'a@gmail.com', jobs: 'b@gmail.com' });
  await assert.rejects(() => registry.resolve('work'), /Unknown account/);
  await assert.rejects(() => registry.resolve('work'), /jobs \(b@gmail.com\)/);
});

test('a token that opens a different mailbox is refused, not used', async () => {
  const { registry } = registryWith({ personal: 'b@gmail.com', jobs: 'b@gmail.com' });
  await assert.rejects(() => registry.resolve('personal'), /authenticates as b@gmail.com/);
  await assert.rejects(() => registry.resolve('personal'), /GMAIL_ACCOUNT_PERSONAL_EMAIL says a@gmail.com/);
});

test('identity is checked once per account, not once per call', async () => {
  const counter = { calls: 0 };
  const { registry } = registryWith({ personal: 'a@gmail.com', jobs: 'b@gmail.com' }, counter);
  await registry.resolve('personal');
  await registry.resolve('personal');
  await registry.resolve('a@gmail.com');
  assert.equal(counter.calls, 1);
});

test('a failed identity check stays failed rather than retrying every call', async () => {
  const counter = { calls: 0 };
  const { registry } = registryWith({ personal: 'wrong@gmail.com', jobs: 'b@gmail.com' }, counter);
  await assert.rejects(() => registry.resolve('personal'));
  await assert.rejects(() => registry.resolve('personal'));
  assert.equal(counter.calls, 1);
});

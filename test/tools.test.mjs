import test from 'node:test';
import assert from 'node:assert/strict';

import { AccountRegistry, configFromEnv } from '../dist/accounts.js';
import { AuditLog, Session } from '../dist/session.js';
import { extractAddress, parseAddressList, registerTools } from '../dist/tools.js';

const BASE = {
  GMAIL_CLIENT_ID: 'client-id',
  GMAIL_CLIENT_SECRET: 'client-secret',
  GMAIL_ACCOUNTS: 'personal,jobs',
  GMAIL_ACCOUNT_PERSONAL_EMAIL: 'a@gmail.com',
  GMAIL_ACCOUNT_PERSONAL_REFRESH_TOKEN: 'token-a',
  GMAIL_ACCOUNT_JOBS_EMAIL: 'b@gmail.com',
  GMAIL_ACCOUNT_JOBS_REFRESH_TOKEN: 'token-b',
  GMAIL_AUDIT_LOG: 'off',
};

const ADDRESSES = { personal: 'a@gmail.com', jobs: 'b@gmail.com' };

/** Records what the server was asked to expose, which is the whole contract a client sees. */
function fakeServer() {
  const registered = new Map();
  return {
    registered,
    registerTool(name, definition, handler) {
      registered.set(name, { definition, handler });
    },
  };
}

function build(env = {}, deps = {}) {
  const config = configFromEnv({ ...BASE, ...env });
  const registry = new AccountRegistry(config, async (account) => ADDRESSES[account.config.label]);
  const session = new Session(config.activeTtlMinutes);
  const audit = new AuditLog(config.auditLogPath);
  const server = fakeServer();
  registerTools(server, registry, session, audit, {
    platform: 'linux',
    confirmSend: async () => 'unavailable',
    chooseAccount: async () => undefined,
    ...deps,
  });
  return { tools: server.registered, session, audit, config };
}

const call = async (tools, name, args = {}) => tools.get(name).handler(args);
const textOf = (result) => result.content.map((c) => c.text).join('\n');

test('sending is off by default and the send tools do not exist', () => {
  const { tools } = build();
  assert.ok(tools.has('create_draft'));
  assert.equal(tools.has('send_draft'), false);
  assert.equal(tools.has('send_message'), false);
});

test('GMAIL_ALLOW_SEND=true registers both send tools', () => {
  const { tools } = build({ GMAIL_ALLOW_SEND: 'true' });
  assert.ok(tools.has('send_draft'));
  assert.ok(tools.has('send_message'));
});

test('the readonly profile registers no tool that can change a mailbox', () => {
  const { tools } = build({ GMAIL_SCOPE_PROFILE: 'readonly', GMAIL_ALLOW_SEND: 'true' });
  for (const name of ['create_draft', 'update_draft', 'delete_draft', 'modify_labels', 'trash_thread', 'send_draft', 'send_message']) {
    assert.equal(tools.has(name), false, `${name} should not be registered under readonly`);
  }
  assert.ok(tools.has('search_messages'));
  assert.ok(tools.has('set_active_account'));
});

test('reads may inherit an account, writes must name one', () => {
  const { tools } = build({ GMAIL_ALLOW_SEND: 'true' });
  const reads = ['search_messages', 'get_thread', 'get_message', 'list_labels', 'list_drafts', 'get_draft'];
  const writes = ['create_draft', 'update_draft', 'delete_draft', 'modify_labels', 'trash_thread', 'send_draft', 'send_message'];
  for (const name of reads) {
    assert.equal(tools.get(name).definition.inputSchema.account.isOptional(), true, `${name} should inherit`);
  }
  for (const name of writes) {
    assert.equal(tools.get(name).definition.inputSchema.account.isOptional(), false, `${name} must name its account`);
  }
});

test('a read with no account and no active selection is refused, and says how to fix it', async () => {
  const { tools } = build();
  const result = await call(tools, 'search_messages', { query: 'x' });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /no active account is set/);
  assert.match(textOf(result), /personal \(a@gmail\.com\), jobs \(b@gmail\.com\)/);
});

test('set_active_account makes later reads inherit that mailbox', async () => {
  const { tools, session } = build();
  const set = await call(tools, 'set_active_account', { account: 'jobs', note: 'applying' });
  assert.match(textOf(set), /active account: jobs \(b@gmail\.com\)/);
  assert.equal(session.active().label, 'jobs');
  assert.equal(session.active().note, 'applying');
});

test('set_active_account accepts an address as well as a label', async () => {
  const { tools, session } = build();
  await call(tools, 'set_active_account', { account: 'A@GMAIL.COM' });
  assert.equal(session.active().label, 'personal');
});

test('set_active_account with an unknown account changes nothing', async () => {
  const { tools, session } = build();
  const result = await call(tools, 'set_active_account', { account: 'work' });
  assert.equal(result.isError, true);
  assert.equal(session.active(), undefined);
});

test('with no picker available, set_active_account with no argument refuses rather than choosing', async () => {
  const { tools, session } = build();
  const result = await call(tools, 'set_active_account', {});
  assert.equal(result.isError, true);
  assert.equal(session.active(), undefined);
});

test('a dismissed picker leaves the active account alone', async () => {
  const { tools, session } = build({}, { platform: 'darwin', chooseAccount: async () => undefined });
  await call(tools, 'set_active_account', { account: 'jobs' });
  const result = await call(tools, 'set_active_account', {});
  assert.match(textOf(result), /dismissed/);
  assert.equal(session.active().label, 'jobs');
});

test('the picker result selects the mailbox', async () => {
  const { tools, session } = build(
    {},
    { platform: 'darwin', chooseAccount: async () => 'jobs  (b@gmail.com)' },
  );
  await call(tools, 'set_active_account', {});
  assert.equal(session.active().label, 'jobs');
});

test('clear_active_account puts reads back to naming their mailbox', async () => {
  const { tools, session } = build();
  await call(tools, 'set_active_account', { account: 'jobs' });
  await call(tools, 'clear_active_account', {});
  assert.equal(session.active(), undefined);
  const result = await call(tools, 'search_messages', { query: 'x' });
  assert.equal(result.isError, true);
});

test('a write into a mailbox other than the active one is refused', async () => {
  const { tools } = build();
  await call(tools, 'set_active_account', { account: 'jobs' });
  const result = await call(tools, 'create_draft', {
    account: 'personal',
    to: ['x@example.com'],
    subject: 's',
    body: 'b',
  });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /Refusing create_draft on account "personal" while the active account is "jobs"/);
  assert.match(textOf(result), /confirmAccountSwitch/);
});

test('the refusal names every write tool it guards', async () => {
  const { tools } = build({ GMAIL_ALLOW_SEND: 'true' });
  await call(tools, 'set_active_account', { account: 'jobs' });
  for (const name of ['update_draft', 'delete_draft', 'modify_labels', 'trash_thread', 'send_draft', 'send_message']) {
    const result = await call(tools, name, { account: 'personal', draftId: 'd', threadId: 't' });
    assert.equal(result.isError, true, `${name} should refuse`);
    assert.match(textOf(result), new RegExp(`Refusing ${name} on account "personal"`));
  }
});

test('a write with no active account set is not treated as a divergence', async () => {
  const { tools } = build();
  const result = await call(tools, 'create_draft', { account: 'personal', to: ['x@example.com'], body: 'b' });
  assert.doesNotMatch(textOf(result), /Refusing create_draft/);
});

test('a send is refused when the confirmation cannot be shown', async () => {
  const { tools } = build({ GMAIL_ALLOW_SEND: 'true' }, { confirmSend: async () => 'unavailable' });
  const result = await call(tools, 'send_message', {
    account: 'jobs',
    to: ['dan@example.com'],
    subject: 's',
    body: 'b',
  });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /could not be shown/);
  assert.match(textOf(result), /was not sent/);
});

test('a declined or timed-out confirmation stops the send', async () => {
  for (const outcome of ['declined', 'timeout']) {
    const { tools } = build({ GMAIL_ALLOW_SEND: 'true' }, { confirmSend: async () => outcome });
    const result = await call(tools, 'send_message', { account: 'jobs', to: ['dan@example.com'], body: 'b' });
    assert.equal(result.isError, true, `${outcome} should stop the send`);
    assert.match(textOf(result), /was not sent/);
  }
});

test('a Bcc recipient reaches the confirmation dialog as well as the wire', async () => {
  const seen = [];
  const { tools } = build(
    { GMAIL_ALLOW_SEND: 'true' },
    {
      confirmSend: async (details) => {
        seen.push(details);
        return 'declined';
      },
    },
  );
  await call(tools, 'send_message', {
    account: 'jobs',
    to: ['dan@example.com'],
    cc: ['cc@example.com'],
    bcc: ['blind@example.com'],
    subject: 'Trading ops',
    body: 'hello',
  });
  assert.deepEqual(seen[0].cc, ['cc@example.com']);
  assert.deepEqual(
    seen[0].bcc,
    ['blind@example.com'],
    'a recipient the sender cannot see on the dialog is the thing the dialog exists to prevent',
  );
});

test('the confirmation is shown the account and recipient it is confirming', async () => {
  const seen = [];
  const { tools } = build(
    { GMAIL_ALLOW_SEND: 'true' },
    {
      confirmSend: async (details) => {
        seen.push(details);
        return 'declined';
      },
    },
  );
  await call(tools, 'send_message', { account: 'jobs', to: ['dan@example.com'], subject: 'Trading ops', body: 'hello' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].accountLabel, 'jobs');
  assert.equal(seen[0].from, 'b@gmail.com');
  assert.deepEqual(seen[0].to, ['dan@example.com']);
  assert.equal(seen[0].subject, 'Trading ops');
});

test('GMAIL_CONFIRM_POPUP=off skips the dialog', async () => {
  let asked = 0;
  const { tools } = build(
    { GMAIL_ALLOW_SEND: 'true', GMAIL_CONFIRM_POPUP: 'off' },
    {
      confirmSend: async () => {
        asked += 1;
        return 'declined';
      },
    },
  );
  await call(tools, 'send_message', { account: 'jobs', to: ['dan@example.com'], body: 'b' });
  assert.equal(asked, 0);
});

test('a foreign from address is refused before anything is composed', async () => {
  const { tools } = build();
  const result = await call(tools, 'create_draft', {
    account: 'jobs',
    to: ['x@example.com'],
    body: 'b',
    from: 'someone@example.com',
  });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /Refusing to use from="someone@example.com"/);
});

test('search_all_accounts needs no account and no active selection', () => {
  const { tools } = build();
  assert.equal(tools.get('search_all_accounts').definition.inputSchema.account, undefined);
  assert.ok(tools.get('search_all_accounts').definition.inputSchema.merge);
});

test('every call is written to the log when logging is on', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const path = join(mkdtempSync(join(tmpdir(), 'gmm-tools-')), 'audit.jsonl');

  const { tools, audit } = build({ GMAIL_AUDIT_LOG: path });
  await call(tools, 'set_active_account', { account: 'jobs' });
  await call(tools, 'create_draft', { account: 'personal', to: ['x@example.com'], body: 'b' });

  const records = audit.recent(10);
  assert.equal(records[0].tool, 'create_draft');
  assert.equal(records[0].outcome, 'refused');
  assert.equal(records[0].active, 'jobs');
  assert.equal(records[1].tool, 'set_active_account');
  assert.equal(records[1].account, 'jobs');
});

test('recent_activity renders the Cc and Bcc the log holds', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const path = join(mkdtempSync(join(tmpdir(), 'gmm-cc-')), 'audit.jsonl');

  const { tools, audit } = build({ GMAIL_AUDIT_LOG: path });
  audit.record({
    tool: 'send_draft',
    outcome: 'ok',
    account: 'jobs',
    to: ['dan@example.com'],
    cc: ['cc@example.com'],
    bcc: ['blind@example.com'],
    subject: 'Trading ops',
  });

  const rendered = textOf(await call(tools, 'recent_activity', {}));
  assert.match(rendered, /to dan@example\.com/);
  assert.match(rendered, /cc cc@example\.com/);
  assert.match(rendered, /bcc blind@example\.com/, 'a recipient in the log the reader never sees is not logged');
});

test('recent_activity says so plainly when logging is off', async () => {
  const { tools } = build();
  assert.match(textOf(await call(tools, 'recent_activity', {})), /Call logging is off/);
});

test('read tools are annotated read-only and send is annotated destructive', () => {
  const { tools } = build({ GMAIL_ALLOW_SEND: 'true' });
  assert.equal(tools.get('search_messages').definition.annotations.readOnlyHint, true);
  assert.equal(tools.get('create_draft').definition.annotations.readOnlyHint, false);
  assert.equal(tools.get('send_message').definition.annotations.destructiveHint, true);
  assert.equal(tools.get('recent_activity').definition.annotations.readOnlyHint, true);
});

test('extractAddress pulls the address out of a display-name From header', () => {
  assert.equal(extractAddress('Dan Roberts <dan@example.com>'), 'dan@example.com');
  assert.equal(extractAddress('dan@example.com'), 'dan@example.com');
  assert.equal(extractAddress('  dan@example.com  '), 'dan@example.com');
});

test('a comma inside a quoted display name does not become a second recipient', () => {
  assert.deepEqual(
    parseAddressList('"Roberts, Dan" <dan@example.com>, eve@example.com'),
    ['dan@example.com', 'eve@example.com'],
    'the send confirmation shows these, so a bogus recipient here is a bogus recipient on screen',
  );
  assert.deepEqual(parseAddressList('dan@example.com'), ['dan@example.com']);
  assert.deepEqual(parseAddressList('Dan <dan@example.com>, "Eve, A." <eve@example.com>'), [
    'dan@example.com',
    'eve@example.com',
  ]);
  assert.deepEqual(parseAddressList(undefined), []);
  assert.deepEqual(parseAddressList(''), []);
});

test('an unterminated quote keeps every recipient', () => {
  const parsed = parseAddressList('"Roberts, Dan <dan@example.com>, eve@example.com');
  assert.ok(parsed.includes('dan@example.com'));
  assert.ok(
    parsed.includes('eve@example.com'),
    'a header the parser cannot read must not quietly shorten the recipient list',
  );
});

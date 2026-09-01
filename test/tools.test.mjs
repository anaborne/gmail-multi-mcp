import test from 'node:test';
import assert from 'node:assert/strict';

import { AccountRegistry, configFromEnv } from '../dist/accounts.js';
import { extractAddress, registerTools } from '../dist/tools.js';

const BASE = {
  GMAIL_CLIENT_ID: 'client-id',
  GMAIL_CLIENT_SECRET: 'client-secret',
  GMAIL_ACCOUNTS: 'personal,jobs',
  GMAIL_ACCOUNT_PERSONAL_EMAIL: 'a@gmail.com',
  GMAIL_ACCOUNT_PERSONAL_REFRESH_TOKEN: 'token-a',
  GMAIL_ACCOUNT_JOBS_EMAIL: 'b@gmail.com',
  GMAIL_ACCOUNT_JOBS_REFRESH_TOKEN: 'token-b',
};

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

function surfaceFor(env) {
  const server = fakeServer();
  registerTools(server, new AccountRegistry(configFromEnv({ ...BASE, ...env }), async () => 'a@gmail.com'));
  return server.registered;
}

test('sending is off by default and the send tools do not exist', () => {
  const tools = surfaceFor({});
  assert.ok(tools.has('create_draft'));
  assert.equal(tools.has('send_draft'), false);
  assert.equal(tools.has('send_message'), false);
});

test('GMAIL_ALLOW_SEND=true registers both send tools', () => {
  const tools = surfaceFor({ GMAIL_ALLOW_SEND: 'true' });
  assert.ok(tools.has('send_draft'));
  assert.ok(tools.has('send_message'));
});

test('GMAIL_ALLOW_SEND=false is off, not truthy-on', () => {
  assert.equal(surfaceFor({ GMAIL_ALLOW_SEND: 'false' }).has('send_message'), false);
});

test('the readonly profile registers no tool that can change a mailbox', () => {
  const tools = surfaceFor({ GMAIL_SCOPE_PROFILE: 'readonly', GMAIL_ALLOW_SEND: 'true' });
  for (const name of ['create_draft', 'update_draft', 'delete_draft', 'modify_labels', 'trash_thread', 'send_draft', 'send_message']) {
    assert.equal(tools.has(name), false, `${name} should not be registered under readonly`);
  }
  assert.ok(tools.has('search_messages'));
  assert.ok(tools.has('get_thread'));
});

test('every account-scoped tool takes a required account argument', () => {
  const tools = surfaceFor({ GMAIL_ALLOW_SEND: 'true' });
  for (const [name, { definition }] of tools) {
    if (name === 'list_accounts' || name === 'search_all_accounts') continue;
    const account = definition.inputSchema?.account;
    assert.ok(account, `${name} has no account argument`);
    assert.equal(account.isOptional(), false, `${name} makes account optional`);
  }
});

test('no tool offers a way to switch or remember the current account', () => {
  const tools = surfaceFor({ GMAIL_ALLOW_SEND: 'true' });
  for (const name of tools.keys()) {
    assert.doesNotMatch(name, /switch|select|set_account|use_account/);
  }
});

test('read tools are annotated read-only and write tools are not', () => {
  const tools = surfaceFor({ GMAIL_ALLOW_SEND: 'true' });
  assert.equal(tools.get('search_messages').definition.annotations.readOnlyHint, true);
  assert.equal(tools.get('create_draft').definition.annotations.readOnlyHint, false);
  assert.equal(tools.get('send_message').definition.annotations.destructiveHint, true);
});

test('extractAddress pulls the address out of a display-name From header', () => {
  assert.equal(extractAddress('Dan Roberts <dan@example.com>'), 'dan@example.com');
  assert.equal(extractAddress('dan@example.com'), 'dan@example.com');
  assert.equal(extractAddress('  dan@example.com  '), 'dan@example.com');
});

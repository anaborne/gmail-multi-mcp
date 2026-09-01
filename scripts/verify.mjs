#!/usr/bin/env node
/**
 * End-to-end verification against the real mailboxes. The unit suite mocks the Gmail API,
 * so it says nothing about the integration; this launches the server the way an MCP client
 * would and checks the properties that matter on a multi-account server.
 *
 *   npm run verify
 *
 * It creates one draft per account, addressed to that account itself, and deletes them on
 * the way out including on failure. It never sends anything, whatever GMAIL_ALLOW_SEND says.
 */

import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const STAMP = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;

let passed = 0;
let failed = 0;

function check(label, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  \x1b[32mok\x1b[0m   ${label}`);
  } else {
    failed += 1;
    console.log(`  \x1b[31mFAIL\x1b[0m ${label}${detail ? `\n       ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

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

const { configFromEnv } = await import('../dist/accounts.js');
const config = configFromEnv();

function text(result) {
  return (result.content ?? []).map((c) => c.text ?? '').join('\n');
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(ROOT, 'dist', 'index.js')],
  env: { ...process.env },
  stderr: 'inherit',
});

const client = new Client({ name: 'gmail-multi-mcp-verify', version: '0.1.0' });
await client.connect(transport);

const created = [];

try {
  section('Server surface');

  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  check('list_accounts is registered', names.includes('list_accounts'));
  check('search_all_accounts is registered', names.includes('search_all_accounts'));
  check(
    `send tools ${config.allowSend ? 'registered' : 'absent'} for GMAIL_ALLOW_SEND=${config.allowSend}`,
    config.allowSend
      ? names.includes('send_draft') && names.includes('send_message')
      : !names.includes('send_draft') && !names.includes('send_message'),
    `tools: ${names.join(', ')}`,
  );
  check(
    'every account-scoped tool requires an account',
    tools
      .filter((t) => !['list_accounts', 'search_all_accounts'].includes(t.name))
      .every((t) => (t.inputSchema?.required ?? []).includes('account')),
  );

  section('Account identity');

  const accounts = await client.callTool({ name: 'list_accounts', arguments: {} });
  const roster = text(accounts);
  console.log(roster.split('\n').map((l) => `       ${l}`).join('\n'));
  check('no account reports UNUSABLE', !roster.includes('UNUSABLE'), roster);
  for (const account of config.accounts) {
    check(`${account.label} verified as ${account.email}`, roster.includes(`${account.label}: ${account.email} (verified)`));
  }

  const unknown = await client.callTool({ name: 'search_messages', arguments: { account: 'nope', query: 'x' } });
  check('an unknown account label is refused', unknown.isError === true, text(unknown));

  section('Per-account isolation');

  for (const account of config.accounts) {
    const search = await client.callTool({
      name: 'search_messages',
      arguments: { account: account.label, maxResults: 3 },
    });
    check(`${account.label}: search returns its own account header`, text(search).startsWith(`account: ${account.label} (${account.email})`), text(search).slice(0, 200));

    const badFrom = await client.callTool({
      name: 'create_draft',
      arguments: { account: account.label, to: [account.email], subject: 'x', body: 'x', from: 'someone@example.com' },
    });
    check(`${account.label}: a foreign from address is refused`, badFrom.isError === true, text(badFrom));

    const injection = await client.callTool({
      name: 'create_draft',
      arguments: { account: account.label, to: [account.email], subject: 'x\r\nBcc: attacker@example.com', body: 'x' },
    });
    check(`${account.label}: a newline in the subject is refused`, injection.isError === true, text(injection));

    const draft = await client.callTool({
      name: 'create_draft',
      arguments: {
        account: account.label,
        to: [account.email],
        subject: `gmail-multi-mcp verify ${STAMP}`,
        body: 'Created by npm run verify. Safe to delete.',
      },
    });
    const draftId = /draft: (\S+)/.exec(text(draft))?.[1];
    check(`${account.label}: draft created`, !!draftId, text(draft));
    if (draftId) created.push([account.label, draftId]);

    if (draftId) {
      const read = await client.callTool({ name: 'get_draft', arguments: { account: account.label, draftId } });
      check(`${account.label}: draft reads back with its body`, text(read).includes('Safe to delete.'), text(read));

      const other = config.accounts.find((a) => a.label !== account.label);
      if (other) {
        const crossed = await client.callTool({
          name: 'get_draft',
          arguments: { account: other.label, draftId },
        });
        check(`${account.label}: its draft ID is not readable from ${other.label}`, crossed.isError === true, text(crossed));
      }
    }
  }

  section('Cross-account search');

  const all = await client.callTool({
    name: 'search_all_accounts',
    arguments: { query: `subject:"gmail-multi-mcp verify ${STAMP}"`, maxResultsPerAccount: 5 },
  });
  check(
    'search_all_accounts names every account',
    config.accounts.every((a) => text(all).includes(`account: ${a.label} (${a.email})`)),
    text(all).slice(0, 400),
  );
} finally {
  section('Cleanup');
  for (const [label, draftId] of created) {
    try {
      await client.callTool({ name: 'delete_draft', arguments: { account: label, draftId } });
      console.log(`  ok   deleted draft ${draftId} in ${label}`);
    } catch (err) {
      console.log(`  FAIL could not delete draft ${draftId} in ${label}: ${err.message}`);
      failed += 1;
    }
  }
  await client.close();
}

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);

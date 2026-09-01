#!/usr/bin/env node
/**
 * Nothing but MCP protocol messages goes to stdout. stdout is the transport, and one stray
 * console.log corrupts the stream into a parse error that looks like a client bug.
 * Diagnostics go to stderr.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { AccountRegistry, configFromEnv } from './accounts.js';
import { registerTools } from './tools.js';
import { ToolError } from './errors.js';

const NAME = 'gmail-multi-mcp';
const VERSION = '0.1.0';

/** The roster goes in the instructions rather than waiting for a list_accounts call: a
 * model with no label vocabulary guesses one, and a guessed label is a wrong mailbox. */
function instructionsFor(registry: AccountRegistry): string {
  const roster = registry
    .list()
    .map((a) => `  ${a.label} = ${a.email}`)
    .join('\n');

  const sending = registry.config.allowSend
    ? 'Sending is enabled. Draft first and send the draft, so a person can read what goes out, and ' +
      'confirm the account and the recipient before you send.'
    : 'Sending is disabled on this server, deliberately. There are no send tools. A saved draft is ' +
      'the finished deliverable; the user sends it from Gmail. Do not treat this as an obstacle.';

  return (
    `Read and write several Gmail mailboxes. Accounts held here:\n${roster}\n\n` +
    'Every tool takes an "account" argument naming one of those labels. There is no current account ' +
    'and no way to switch, so a mailbox chosen for one call is never carried into the next by ' +
    'accident. Message, thread, draft, and label IDs are scoped to a ' +
    'single mailbox: an ID from one account returns 404 in another. Each label is checked against ' +
    "Google's own answer for who the token belongs to before its first use, so a result that names " +
    'an account is telling you where it really came from.\n\n' +
    `${sending}\n\n` +
    'When you report on mail, name the account the mail came from. The user has more than one for a ' +
    'reason, and "you have an email from them" is ambiguous in a way that matters to them.'
  );
}

async function main(): Promise<void> {
  let registry: AccountRegistry;
  try {
    registry = new AccountRegistry(configFromEnv());
  } catch (err) {
    if (err instanceof ToolError) {
      process.stderr.write(`${NAME}: ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  const server = new McpServer(
    { name: NAME, version: VERSION },
    { instructions: instructionsFor(registry) },
  );

  registerTools(server, registry);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const summary = registry.list().map((a) => `${a.label}=${a.email}`).join(' ');
  process.stderr.write(
    `${NAME} v${VERSION} ready on stdio. accounts: ${summary}. ` +
      `sending: ${registry.config.allowSend ? 'enabled' : 'disabled'}. ` +
      `scope: ${registry.config.scopeProfile}\n`,
  );
}

// Non-zero exit, so the client reports a startup failure instead of hanging on a half-open
// transport.
main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${NAME}: fatal: ${message}\n`);
  process.exit(1);
});

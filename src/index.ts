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
import { AuditLog, Session } from './session.js';
import { popupsPossible } from './confirm.js';
import { ToolError } from './errors.js';

const NAME = 'gmail-multi-mcp';
const VERSION = '0.2.0';

/** The roster goes in the instructions rather than waiting for a list_accounts call: a
 * model with no label vocabulary guesses one, and a guessed label is a wrong mailbox. */
function instructionsFor(registry: AccountRegistry): string {
  const roster = registry
    .list()
    .map((a) => `  ${a.label} = ${a.email}`)
    .join('\n');

  const sending = registry.config.allowSend
    ? 'Sending is enabled. Draft first and send the draft, so a person can read what goes out. ' +
      (registry.config.confirmSends
        ? 'A dialog on the user\'s desktop asks them to confirm the account, the recipient, and the ' +
          'subject, and the send is refused unless they click Send, so never describe a send as done ' +
          'until the tool has returned.'
        : 'There is no confirmation dialog, so confirm the account and the recipient in the ' +
          'conversation before you send.')
    : 'Sending is disabled on this server, deliberately. There are no send tools. A saved draft is ' +
      'the finished deliverable; the user sends it from Gmail. Do not treat this as an obstacle.';

  return (
    `Read and write several Gmail mailboxes. Accounts held here:\n${roster}\n\n` +
    'All of them are open at once. Nothing needs connecting or switching to reach a mailbox, and ' +
    'search_all_accounts queries every one of them in parallel.\n\n' +
    'set_active_account picks the mailbox that later reads use when they do not name one. Call it ' +
    'when the user says which account they are working in. It lapses on a timer, so check ' +
    'get_active_account rather than assuming a selection from earlier still stands.\n\n' +
    'A draft, a send, or any other write always names its own account and never inherits the ' +
    'active one, and is refused when the two differ unless confirmAccountSwitch is set. Message, ' +
    'thread, draft, and label IDs are scoped to a single mailbox: an ID from one account returns ' +
    '404 in another. Each label is checked against ' +
    "Google's own answer for who the token belongs to before its first use, so a result that names " +
    'an account is telling you where it really came from. Every call is written to a log that ' +
    'recent_activity reads back.\n\n' +
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

  const session = new Session(registry.config.activeTtlMinutes);
  const audit = new AuditLog(registry.config.auditLogPath);

  registerTools(server, registry, session, audit);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const summary = registry.list().map((a) => `${a.label}=${a.email}`).join(' ');
  const confirm = !registry.config.allowSend
    ? 'n/a'
    : !registry.config.confirmSends
      ? 'off'
      : popupsPossible()
        ? 'desktop dialog'
        : 'REQUIRED but unavailable on this platform, sends will be refused';

  process.stderr.write(
    `${NAME} v${VERSION} ready on stdio. accounts: ${summary}. ` +
      `sending: ${registry.config.allowSend ? 'enabled' : 'disabled'}. ` +
      `confirm: ${confirm}. ` +
      `scope: ${registry.config.scopeProfile}. ` +
      `active ttl: ${registry.config.activeTtlMinutes || 'none'}. ` +
      `log: ${registry.config.auditLogPath ?? 'off'}\n`,
  );
}

// Non-zero exit, so the client reports a startup failure instead of hanging on a half-open
// transport.
main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${NAME}: fatal: ${message}\n`);
  process.exit(1);
});

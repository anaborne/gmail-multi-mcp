/**
 * The description strings below are prompt surface, not documentation.
 *
 * Every account-scoped description states that IDs do not cross between mailboxes, which
 * prevents reading one inbox and replying out of the other. create_draft states that a
 * draft is the deliverable, which prevents a model treating a disabled send tool as an
 * obstacle to route around.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Account, AccountRegistry } from './accounts.js';
import { describeError, FromMismatchError, ToolError } from './errors.js';
import * as api from './gmail.js';
import type { MessageDraft } from './mime.js';

type TextResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

function ok(text: string): TextResult {
  return { content: [{ type: 'text', text }] };
}

function fail(err: unknown, where?: string): TextResult {
  return { content: [{ type: 'text', text: describeError(err, where) }], isError: true };
}

/** A tool that throws hands the model a protocol error it cannot reason about. isError
 * plus a sentence about what to do next is recoverable. */
async function guard(fn: () => Promise<TextResult>, where?: string): Promise<TextResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ToolError) return fail(err, where);
    return fail(err, where);
  }
}

const accountArg = z
  .string()
  .describe(
    'Which mailbox to act on: an account label from list_accounts, or that account\'s full email ' +
      'address. Required on every call. Message, thread, draft, and label IDs belong to one mailbox ' +
      'and are meaningless in another, so this must match the account an ID came from.',
  );

function line(label: string, value: string | number | undefined | null): string | null {
  return value === undefined || value === null || value === '' ? null : `${label}: ${value}`;
}

function renderSummary(m: api.MessageSummary): string {
  return [
    line('id', m.id),
    line('thread', m.threadId),
    line('date', m.date),
    line('from', m.from),
    line('to', m.to),
    line('cc', m.cc),
    line('subject', m.subject),
    line('labels', m.labelIds.join(', ')),
    line('snippet', m.snippet),
  ]
    .filter(Boolean)
    .join('\n');
}

function renderFull(m: api.FullMessage): string {
  const attachments =
    m.attachments.length > 0
      ? `attachments: ${m.attachments.map((a) => `${a.filename} (${a.mimeType}, ${a.size}b)`).join('; ')}`
      : null;
  return [
    line('id', m.id),
    line('thread', m.threadId),
    line('date', m.date),
    line('from', m.from),
    line('to', m.to),
    line('cc', m.cc),
    line('subject', m.subject),
    line('labels', m.labelIds.join(', ')),
    attachments,
    '---',
    m.body,
  ]
    .filter(Boolean)
    .join('\n');
}

function header(account: Account, rest: string): string {
  return `account: ${account.config.label} (${account.config.email})\n${rest}`;
}

function resolveFrom(account: Account, from: string | undefined): string {
  if (from === undefined) return account.config.email;
  const wanted = from.trim().toLowerCase();
  if (wanted !== account.config.email) {
    throw new FromMismatchError(account.config.label, account.config.email, from);
  }
  return account.config.email;
}

/**
 * A reply carrying only a threadId threads in Gmail and opens as a new conversation in
 * most other clients. In-Reply-To and References come from the message being replied to.
 */
async function replyContext(
  account: Account,
  replyToMessageId: string,
): Promise<{ threadId: string; subject: string; to: string[]; inReplyTo?: string; references?: string }> {
  const original = await api.getMessage(account, replyToMessageId);
  const subject = original.subject ?? '';
  const references = [original.references, original.messageIdHeader].filter(Boolean).join(' ').trim();

  return {
    threadId: original.threadId,
    subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
    to: original.from ? [extractAddress(original.from)] : [],
    inReplyTo: original.messageIdHeader,
    references: references === '' ? undefined : references,
  };
}

/** "Dan Roberts <dan@example.com>" to "dan@example.com". */
export function extractAddress(value: string): string {
  const angled = /<([^>]+)>/.exec(value);
  return (angled?.[1] ?? value).trim();
}

const bodyArgs = {
  to: z.array(z.string()).optional().describe('Primary recipients, one bare email address per entry.'),
  cc: z.array(z.string()).optional().describe('Cc recipients, one bare email address per entry.'),
  bcc: z.array(z.string()).optional().describe('Bcc recipients, one bare email address per entry.'),
  subject: z.string().optional().describe('Subject line. Ignored when replyToMessageId is set.'),
  body: z.string().optional().describe('Plain text body. Prefer this over htmlBody for correspondence.'),
  htmlBody: z
    .string()
    .optional()
    .describe('HTML body. When both are given the message carries both alternatives.'),
  from: z
    .string()
    .optional()
    .describe(
      'Optional, and only ever the account\'s own address. It exists so a caller can state which ' +
        'mailbox it believes it is writing from and be refused if it is wrong.',
    ),
  replyToMessageId: z
    .string()
    .optional()
    .describe(
      'Message ID to reply to, from the same account. Sets the thread, the Re: subject, the ' +
        'In-Reply-To and References headers, and the recipient, so the reply threads in every client.',
    ),
};

async function assembleDraft(
  account: Account,
  args: {
    to?: string[];
    cc?: string[];
    bcc?: string[];
    subject?: string;
    body?: string;
    htmlBody?: string;
    from?: string;
    replyToMessageId?: string;
  },
): Promise<{ draft: MessageDraft; threadId?: string }> {
  const from = resolveFrom(account, args.from);

  if (args.replyToMessageId) {
    const context = await replyContext(account, args.replyToMessageId);
    return {
      draft: {
        from,
        to: args.to && args.to.length > 0 ? args.to : context.to,
        cc: args.cc,
        bcc: args.bcc,
        subject: context.subject,
        text: args.body,
        html: args.htmlBody,
        inReplyTo: context.inReplyTo,
        references: context.references,
      },
      threadId: context.threadId,
    };
  }

  return {
    draft: {
      from,
      to: args.to,
      cc: args.cc,
      bcc: args.bcc,
      subject: args.subject,
      text: args.body,
      html: args.htmlBody,
    },
  };
}

export function registerTools(server: McpServer, registry: AccountRegistry): void {
  const { allowSend, scopeProfile } = registry.config;
  const writable = scopeProfile !== 'readonly';

  server.registerTool(
    'list_accounts',
    {
      title: 'List the mailboxes this server holds',
      description:
        'List every configured account: its label, its verified address, and whether this server is ' +
        'allowed to send from it. Call this first if you do not already know which label to pass as ' +
        '"account". Addresses shown here have been checked against Google, not read from a config file.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () =>
      guard(async () => {
        const rows = await Promise.all(
          registry.list().map(async (config) => {
            try {
              await registry.resolve(config.label);
              return `${config.label}: ${config.email} (verified)`;
            } catch (err) {
              return `${config.label}: ${config.email} (UNUSABLE) ${describeError(err)}`;
            }
          }),
        );
        const mode = allowSend
          ? 'sending: enabled'
          : 'sending: disabled, this server can draft but not send';
        const scope = `scope: ${scopeProfile === 'readonly' ? 'read only' : 'read, drafts, send, labels, trash'}`;
        return ok([...rows, mode, scope].join('\n'));
      }),
  );

  server.registerTool(
    'search_messages',
    {
      title: 'Search one mailbox',
      description:
        'Search one account with Gmail query syntax (from:, to:, subject:, is:unread, newer_than:7d, ' +
        'has:attachment, label:, in:sent, and the rest). Returns message summaries with IDs and ' +
        'snippets, not bodies; follow with get_thread or get_message to read one. To search every ' +
        'mailbox at once, use search_all_accounts.',
      inputSchema: {
        account: accountArg,
        query: z.string().optional().describe('Gmail query string. Omit to list the most recent messages.'),
        maxResults: z
          .number()
          .int()
          .optional()
          .describe(`How many messages to return. Default ${api.DEFAULT_RESULTS}, capped at ${api.MAX_RESULTS}.`),
        includeSpamTrash: z.boolean().optional().describe('Include spam and trash. Default false.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ account, query, maxResults, includeSpamTrash }) =>
      guard(async () => {
        const resolved = await registry.resolve(account);
        const result = await api.searchMessages(
          resolved,
          query,
          api.clampResults(maxResults),
          includeSpamTrash ?? false,
        );
        if (result.messages.length === 0) {
          return ok(header(resolved, `no messages matched ${JSON.stringify(query ?? '')}`));
        }
        const body = result.messages.map(renderSummary).join('\n\n');
        const more = result.nextPageToken ? '\n\n(more results exist)' : '';
        return ok(header(resolved, `matches: ${result.messages.length}\n\n${body}${more}`));
      }, account),
  );

  server.registerTool(
    'search_all_accounts',
    {
      title: 'Search every mailbox at once',
      description:
        'Run one Gmail query against every configured account and return the results grouped by ' +
        'account. Use this when the question is "did anyone email me about X" and you do not know ' +
        'which mailbox it landed in. Each result carries its account, and IDs are only valid within ' +
        'the account they are listed under.',
      inputSchema: {
        query: z.string().describe('Gmail query string, applied to every account.'),
        maxResultsPerAccount: z
          .number()
          .int()
          .optional()
          .describe(`Per-account cap. Default ${api.DEFAULT_RESULTS}, capped at ${api.MAX_RESULTS}.`),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, maxResultsPerAccount }) =>
      guard(async () => {
        const limit = api.clampResults(maxResultsPerAccount);
        const blocks = await Promise.all(
          registry.list().map(async (config) => {
            try {
              const resolved = await registry.resolve(config.label);
              const result = await api.searchMessages(resolved, query, limit, false);
              const body =
                result.messages.length === 0
                  ? 'no matches'
                  : result.messages.map(renderSummary).join('\n\n');
              return header(resolved, body);
            } catch (err) {
              return `account: ${config.label} (${config.email})\n${describeError(err, config.label)}`;
            }
          }),
        );
        return ok(blocks.join('\n\n===\n\n'));
      }),
  );

  server.registerTool(
    'get_thread',
    {
      title: 'Read a whole conversation',
      description:
        'Read every message in one thread, oldest first, with bodies. HTML-only messages are ' +
        'flattened to text. Prefer this over get_message when replying, so the reply answers what ' +
        'was actually said last rather than the search snippet.',
      inputSchema: {
        account: accountArg,
        threadId: z.string().describe('Thread ID from a search result in this same account.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ account, threadId }) =>
      guard(async () => {
        const resolved = await registry.resolve(account);
        const messages = await api.getThread(resolved, threadId);
        return ok(header(resolved, messages.map(renderFull).join('\n\n---\n\n')));
      }, account),
  );

  server.registerTool(
    'get_message',
    {
      title: 'Read one message',
      description: 'Read a single message in full, with its body and attachment list.',
      inputSchema: {
        account: accountArg,
        messageId: z.string().describe('Message ID from a search result in this same account.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ account, messageId }) =>
      guard(async () => {
        const resolved = await registry.resolve(account);
        return ok(header(resolved, renderFull(await api.getMessage(resolved, messageId))));
      }, account),
  );

  server.registerTool(
    'list_labels',
    {
      title: 'List labels',
      description:
        'List one account\'s labels with their IDs and unread counts. Label IDs are what Gmail queries ' +
        'and modify_labels take; display names are not interchangeable with them.',
      inputSchema: { account: accountArg },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ account }) =>
      guard(async () => {
        const resolved = await registry.resolve(account);
        const labels = await api.listLabels(resolved);
        const rows = labels
          .map((l) => `${l.id}\t${l.name}\t${l.type}${l.unread ? `\tunread ${l.unread}` : ''}`)
          .join('\n');
        return ok(header(resolved, rows));
      }, account),
  );

  server.registerTool(
    'list_drafts',
    {
      title: 'List drafts',
      description: 'List the drafts sitting in one account, newest first, with their draft IDs.',
      inputSchema: {
        account: accountArg,
        maxResults: z.number().int().optional().describe(`Default ${api.DEFAULT_RESULTS}, capped at ${api.MAX_RESULTS}.`),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ account, maxResults }) =>
      guard(async () => {
        const resolved = await registry.resolve(account);
        const drafts = await api.listDrafts(resolved, api.clampResults(maxResults));
        if (drafts.length === 0) return ok(header(resolved, 'no drafts'));
        const rows = drafts
          .map((d) =>
            [line('draft', d.draftId), line('to', d.to), line('subject', d.subject), line('snippet', d.snippet)]
              .filter(Boolean)
              .join('\n'),
          )
          .join('\n\n');
        return ok(header(resolved, rows));
      }, account),
  );

  server.registerTool(
    'get_draft',
    {
      title: 'Read a draft',
      description: 'Read one draft in full, including the body as it currently stands.',
      inputSchema: { account: accountArg, draftId: z.string().describe('Draft ID from list_drafts.') },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ account, draftId }) =>
      guard(async () => {
        const resolved = await registry.resolve(account);
        const draft = await api.getDraft(resolved, draftId);
        return ok(header(resolved, `draft: ${draft.draftId}\n${renderFull(draft)}`));
      }, account),
  );

  if (!writable) return;

  server.registerTool(
    'create_draft',
    {
      title: 'Create a draft',
      description:
        'Save a new draft in one account. The draft is the finished deliverable: it sits in Gmail ' +
        'where a person reads it and presses send. Set replyToMessageId to reply, which fills in the ' +
        'thread, the Re: subject, the recipient, and the threading headers. Say which account you ' +
        'drafted in when you report back.',
      inputSchema: { account: accountArg, ...bodyArgs },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ account, ...args }) =>
      guard(async () => {
        const resolved = await registry.resolve(account);
        const { draft, threadId } = await assembleDraft(resolved, args);
        const created = await api.createDraft(resolved, draft, threadId);
        return ok(
          header(
            resolved,
            `draft saved\ndraft: ${created.draftId}\nthread: ${created.threadId}\n` +
              `from: ${draft.from}\nto: ${(draft.to ?? []).join(', ')}\nsubject: ${draft.subject ?? ''}`,
          ),
        );
      }, account),
  );

  server.registerTool(
    'update_draft',
    {
      title: 'Replace a draft',
      description:
        'Replace the whole content of an existing draft, keeping its draft ID. Every field is ' +
        'rewritten from what you pass, so send the complete message, not only the part you changed.',
      inputSchema: {
        account: accountArg,
        draftId: z.string().describe('Draft ID to overwrite, from list_drafts.'),
        ...bodyArgs,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ account, draftId, ...args }) =>
      guard(async () => {
        const resolved = await registry.resolve(account);
        const { draft, threadId } = await assembleDraft(resolved, args);
        const updated = await api.updateDraft(resolved, draftId, draft, threadId);
        return ok(header(resolved, `draft updated\ndraft: ${updated.draftId}\nthread: ${updated.threadId}`));
      }, account),
  );

  server.registerTool(
    'delete_draft',
    {
      title: 'Delete a draft',
      description:
        'Permanently delete a draft. It does not go to the trash and cannot be recovered. Only ever ' +
        'for a draft this session created and the user has asked to discard.',
      inputSchema: { account: accountArg, draftId: z.string().describe('Draft ID to delete.') },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ account, draftId }) =>
      guard(async () => {
        const resolved = await registry.resolve(account);
        await api.deleteDraft(resolved, draftId);
        return ok(header(resolved, `draft ${draftId} deleted`));
      }, account),
  );

  server.registerTool(
    'modify_labels',
    {
      title: 'Add or remove labels on a thread',
      description:
        'Add and remove labels on a whole thread by label ID. Removing INBOX archives it; removing ' +
        'UNREAD marks it read. Get IDs from list_labels first, since names are not IDs.',
      inputSchema: {
        account: accountArg,
        threadId: z.string().describe('Thread ID in this same account.'),
        addLabelIds: z.array(z.string()).optional().describe('Label IDs to add.'),
        removeLabelIds: z.array(z.string()).optional().describe('Label IDs to remove.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ account, threadId, addLabelIds, removeLabelIds }) =>
      guard(async () => {
        const resolved = await registry.resolve(account);
        const labels = await api.modifyThreadLabels(
          resolved,
          threadId,
          addLabelIds ?? [],
          removeLabelIds ?? [],
        );
        return ok(header(resolved, `thread ${threadId} now labelled: ${labels.join(', ')}`));
      }, account),
  );

  server.registerTool(
    'trash_thread',
    {
      title: 'Move a thread to the trash',
      description:
        'Move a whole thread to the trash, where Gmail keeps it for 30 days. Reversible with ' +
        'untrash set to true. This server has no way to delete mail permanently.',
      inputSchema: {
        account: accountArg,
        threadId: z.string().describe('Thread ID in this same account.'),
        untrash: z.boolean().optional().describe('Set true to pull a thread back out of the trash.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ account, threadId, untrash }) =>
      guard(async () => {
        const resolved = await registry.resolve(account);
        if (untrash) {
          await api.untrashThread(resolved, threadId);
          return ok(header(resolved, `thread ${threadId} restored from trash`));
        }
        await api.trashThread(resolved, threadId);
        return ok(header(resolved, `thread ${threadId} moved to trash`));
      }, account),
  );

  if (!allowSend) return;

  server.registerTool(
    'send_draft',
    {
      title: 'Send an existing draft',
      description:
        'Send a draft that already exists, unchanged. This is the safer of the two send tools, ' +
        'because what goes out is exactly the text that was reviewed. Sending cannot be undone from ' +
        'here. Confirm with the user which account and which recipient before calling it.',
      inputSchema: { account: accountArg, draftId: z.string().describe('Draft ID to send.') },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ account, draftId }) =>
      guard(async () => {
        const resolved = await registry.resolve(account);
        const sent = await api.sendDraft(resolved, draftId);
        return ok(header(resolved, `sent\nmessage: ${sent.messageId}\nthread: ${sent.threadId}`));
      }, account),
  );

  server.registerTool(
    'send_message',
    {
      title: 'Compose and send in one step',
      description:
        'Compose a message and put it on the wire immediately, with no draft in between and no way ' +
        'to recall it. Prefer create_draft followed by send_draft, so there is a version a person can ' +
        'read first. Use this only when the user has approved this exact text going to this exact ' +
        'recipient from this exact account.',
      inputSchema: { account: accountArg, ...bodyArgs },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ account, ...args }) =>
      guard(async () => {
        const resolved = await registry.resolve(account);
        const { draft, threadId } = await assembleDraft(resolved, args);
        const sent = await api.sendMessage(resolved, draft, threadId);
        return ok(
          header(
            resolved,
            `sent\nmessage: ${sent.messageId}\nthread: ${sent.threadId}\n` +
              `from: ${draft.from}\nto: ${(draft.to ?? []).join(', ')}\nsubject: ${draft.subject ?? ''}`,
          ),
        );
      }, account),
  );
}

/**
 * The description strings below are prompt surface, not documentation.
 *
 * Every description states that IDs do not cross between mailboxes, which prevents reading
 * one inbox and replying out of the other. create_draft states that a draft is the
 * deliverable, which prevents a model treating a disabled send tool as an obstacle to
 * route around.
 *
 * Reads may name an account or fall back to the active one. Writes must name theirs, and
 * are refused when it differs from the active one without an explicit override. The
 * asymmetry is the point: a read of the wrong mailbox is a wasted call, a send from the
 * wrong mailbox is in somebody else's inbox.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Account, AccountRegistry } from './accounts.js';
import {
  AccountDivergenceError,
  describeError,
  FromMismatchError,
  NoActiveAccountError,
  SendNotConfirmedError,
  ToolError,
} from './errors.js';
import * as api from './gmail.js';
import type { MessageDraft } from './mime.js';
import { chooseAccount as realChooseAccount, confirmSend as realConfirmSend, popupsPossible } from './confirm.js';
import type { AuditLog, Session } from './session.js';

type TextResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

export interface ToolDeps {
  confirmSend: typeof realConfirmSend;
  chooseAccount: typeof realChooseAccount;
  platform: string;
}

const defaultDeps: ToolDeps = {
  confirmSend: realConfirmSend,
  chooseAccount: realChooseAccount,
  platform: process.platform,
};

function ok(text: string): TextResult {
  return { content: [{ type: 'text', text }] };
}

function failure(err: unknown, where?: string): TextResult {
  return { content: [{ type: 'text', text: describeError(err, where) }], isError: true };
}

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

export function registerTools(
  server: McpServer,
  registry: AccountRegistry,
  session: Session,
  audit: AuditLog,
  deps: ToolDeps = defaultDeps,
): void {
  const { allowSend, scopeProfile, confirmSends } = registry.config;
  const writable = scopeProfile !== 'readonly';

  /** Names the mailbox on every result, and says when it is not the active one, so the
   * transcript itself records which inbox a claim came from. */
  function header(account: Account, rest: string): string {
    const active = session.active();
    let status = '';
    if (active) {
      status =
        active.label === account.config.label
          ? '  [active]'
          : `  [NOT the active account, which is ${active.label}]`;
    }
    return `account: ${account.config.label} (${account.config.email})${status}\n${rest}`;
  }

  function note(
    tool: string,
    outcome: 'ok' | 'error' | 'refused',
    fields: Record<string, unknown> = {},
  ): void {
    audit.record({ tool, outcome, active: session.active()?.label, ...fields });
  }

  /** guard records failures; each handler records its own success, where it knows the
   * recipients and IDs worth keeping. */
  async function guard(tool: string, where: string | undefined, fn: () => Promise<TextResult>) {
    try {
      return await fn();
    } catch (err) {
      const refused = err instanceof ToolError;
      note(tool, refused ? 'refused' : 'error', {
        account: where,
        detail: describeError(err, where).slice(0, 300),
      });
      return failure(err, where);
    }
  }

  /** A read may name its mailbox or inherit the active one. */
  async function forRead(ref: string | undefined): Promise<Account> {
    if (ref !== undefined && ref.trim() !== '') return registry.resolve(ref);
    const active = session.active();
    if (!active) {
      throw new NoActiveAccountError(
        registry.list().map((a) => `${a.label} (${a.email})`),
        session.didLapse(),
      );
    }
    return registry.resolve(active.label);
  }

  /** A write always names its mailbox, and is refused when that is not the active one. */
  async function forWrite(tool: string, ref: string, confirmSwitch: boolean | undefined): Promise<Account> {
    const account = await registry.resolve(ref);
    const active = session.active();
    if (active && active.label !== account.config.label && confirmSwitch !== true) {
      throw new AccountDivergenceError(account.config.label, active.label, tool);
    }
    return account;
  }

  const accountRead = z
    .string()
    .optional()
    .describe(
      'Which mailbox to read: an account label from list_accounts, or its full email address. ' +
        'Omit to use the active account set by set_active_account. Message, thread, draft, and ' +
        'label IDs belong to one mailbox and are meaningless in another, so this must match the ' +
        'account an ID came from.',
    );

  const accountWrite = z
    .string()
    .describe(
      'Which mailbox to write in. Required, and never inherited from the active account, because ' +
        'this call changes a mailbox. If it differs from the active account the call is refused ' +
        'unless confirmAccountSwitch is true.',
    );

  const confirmSwitchArg = z
    .boolean()
    .optional()
    .describe(
      'Set true only when the user has said, in this conversation, that this write belongs in a ' +
        'mailbox other than the active one. Never set it to clear an error you did not understand.',
    );

  server.registerTool(
    'list_accounts',
    {
      title: 'List the mailboxes this server holds',
      description:
        'List every configured account: its label, its verified address, and whether this server ' +
        'may send from it. Call this first if you do not know which label to use. Addresses shown ' +
        'here were checked against Google, not read from a config file.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () =>
      guard('list_accounts', undefined, async () => {
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
        const active = session.active();
        const remaining = session.minutesRemaining();
        const activeLine = active
          ? `active: ${active.label}${remaining === undefined ? '' : `, lapses in ${remaining} min`}`
          : 'active: none, reads must name their account';
        const mode = allowSend
          ? `sending: enabled${confirmSends ? ', with a desktop confirmation before each send' : ', with no confirmation dialog'}`
          : 'sending: disabled, this server can draft but not send';
        const scope = `scope: ${scopeProfile === 'readonly' ? 'read only' : 'read, drafts, send, labels, trash'}`;
        note('list_accounts', 'ok');
        return ok([...rows, activeLine, mode, scope].join('\n'));
      }),
  );

  server.registerTool(
    'set_active_account',
    {
      title: 'Choose the mailbox to work in',
      description:
        'Set the mailbox that later reads use when they do not name one. Call it when the user ' +
        'says which account they are working in ("switch to my job account", "check my personal ' +
        'mail"). On macOS, calling it with no account raises a picker on the desktop and the user ' +
        'chooses. The selection lapses on a timer, and it never decides a draft or a send on its ' +
        'own: those still name their mailbox.',
      inputSchema: {
        account: z
          .string()
          .optional()
          .describe('Label or address to make active. Omit to let the user pick from a desktop dialog.'),
        note: z.string().optional().describe('Short reason, recorded in the audit log.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ account, note: reason }) =>
      guard('set_active_account', account, async () => {
        let ref = account;

        if (ref === undefined || ref.trim() === '') {
          if (!popupsPossible(deps.platform)) {
            throw new NoActiveAccountError(
              registry.list().map((a) => `${a.label} (${a.email})`),
              session.didLapse(),
            );
          }
          const picked = await deps.chooseAccount(
            registry.list().map((a) => `${a.label}  (${a.email})`),
            'Which mailbox should Claude work in?',
            deps.platform,
          );
          if (!picked) {
            note('set_active_account', 'refused', { detail: 'picker dismissed' });
            return ok('The account picker was dismissed. The active account is unchanged.');
          }
          ref = picked.split('  ')[0] ?? picked;
        }

        const resolved = await registry.resolve(ref);
        const selection = session.setActive(resolved.config.label, resolved.config.email, reason);
        const remaining = session.minutesRemaining();
        note('set_active_account', 'ok', {
          account: resolved.config.label,
          email: resolved.config.email,
          detail: selection.note,
        });
        return ok(
          `active account: ${resolved.config.label} (${resolved.config.email})\n` +
            (remaining === undefined
              ? 'it stands until the server restarts\n'
              : `it lapses in ${remaining} min, after which reads must name their account again\n`) +
            'drafts and sends still name their own mailbox and are refused if it differs from this one',
        );
      }),
  );

  server.registerTool(
    'get_active_account',
    {
      title: 'Report the active mailbox and what has been done in it',
      description:
        'Report which mailbox reads currently default to, how long that selection has left, and ' +
        'the last few calls this server made. Use it before reporting on mail if the conversation ' +
        'has run long enough that the selection may have lapsed.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () =>
      guard('get_active_account', undefined, async () => {
        const active = session.active();
        const remaining = session.minutesRemaining();
        const recent = audit.recent(5);
        const history =
          recent.length === 0
            ? audit.enabled
              ? 'no calls recorded yet'
              : 'call logging is off (GMAIL_AUDIT_LOG=off)'
            : recent
                .map((r) => `  ${r.at}  ${r.tool}  ${r.account ?? '-'}  ${r.outcome}`)
                .join('\n');
        note('get_active_account', 'ok');
        return ok(
          (active
            ? `active: ${active.label} (${active.email})${remaining === undefined ? '' : `, lapses in ${remaining} min`}` +
              (active.note ? `\nreason: ${active.note}` : '')
            : 'active: none, reads must name their account') +
            `\n\nlast calls:\n${history}`,
        );
      }),
  );

  server.registerTool(
    'clear_active_account',
    {
      title: 'Drop the active mailbox',
      description:
        'Forget the active mailbox, so every later read has to name its account again. Use it when ' +
        'the user finishes with one inbox, or whenever the conversation has moved on and you are ' +
        'not sure which mailbox is meant.',
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () =>
      guard('clear_active_account', undefined, async () => {
        session.clear();
        note('clear_active_account', 'ok');
        return ok('active account cleared, reads must name their account');
      }),
  );

  server.registerTool(
    'recent_activity',
    {
      title: 'Read the call log',
      description:
        'Read the append-only log of what this server has done: which tool, in which mailbox, ' +
        'whether that was the active one, and for drafts and sends the recipients and subject. ' +
        'Use it to answer "which account did that go out from" without guessing.',
      inputSchema: {
        limit: z.number().int().optional().describe('How many entries, newest first. Default 20.'),
        account: z.string().optional().describe('Restrict to one account label.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ limit, account }) =>
      guard('recent_activity', account, async () => {
        if (!audit.enabled) {
          return ok('Call logging is off. Set GMAIL_AUDIT_LOG to a file path to turn it on.');
        }
        const records = audit.recent(Math.max(1, Math.min(200, limit ?? 20)), account);
        note('recent_activity', 'ok', { account });
        if (records.length === 0) return ok('no matching entries');
        return ok(
          records
            .map((r) =>
              [
                r.at,
                r.tool,
                r.account ?? '-',
                r.outcome,
                r.diverged ? 'DIVERGED' : null,
                r.to ? `to ${r.to.join(',')}` : null,
                r.cc ? `cc ${r.cc.join(',')}` : null,
                r.bcc ? `bcc ${r.bcc.join(',')}` : null,
                r.subject ? `subject ${JSON.stringify(r.subject)}` : null,
                r.messageId ? `message ${r.messageId}` : null,
                r.draftId ? `draft ${r.draftId}` : null,
                r.detail ? `(${r.detail})` : null,
              ]
                .filter(Boolean)
                .join('  '),
            )
            .join('\n'),
        );
      }),
  );

  server.registerTool(
    'search_messages',
    {
      title: 'Search one mailbox',
      description:
        'Search one account with Gmail query syntax (from:, to:, subject:, is:unread, newer_than:7d, ' +
        'has:attachment, label:, in:sent). Returns summaries with IDs and snippets, not bodies; ' +
        'follow with get_thread or get_message to read one. To search every mailbox at once, use ' +
        'search_all_accounts.',
      inputSchema: {
        account: accountRead,
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
      guard('search_messages', account, async () => {
        const resolved = await forRead(account);
        const result = await api.searchMessages(
          resolved,
          query,
          api.clampResults(maxResults),
          includeSpamTrash ?? false,
        );
        note('search_messages', 'ok', {
          account: resolved.config.label,
          email: resolved.config.email,
          diverged: divergedFrom(resolved),
          detail: query,
        });
        if (result.messages.length === 0) {
          return ok(header(resolved, `no messages matched ${JSON.stringify(query ?? '')}`));
        }
        const body = result.messages.map(renderSummary).join('\n\n');
        const more = result.nextPageToken ? '\n\n(more results exist)' : '';
        return ok(header(resolved, `matches: ${result.messages.length}\n\n${body}${more}`));
      }),
  );

  function divergedFrom(account: Account): boolean {
    const active = session.active();
    return !!active && active.label !== account.config.label;
  }

  server.registerTool(
    'search_all_accounts',
    {
      title: 'Search every mailbox at once',
      description:
        'Run one Gmail query against every configured account at the same time. This does not ' +
        'switch anything and does not depend on the active account. Use it when the question is ' +
        '"did anyone email me about X" and you do not know which inbox it landed in. Set merge ' +
        'true for one list in date order across mailboxes; each result still names its account, ' +
        'and IDs are only valid in the account they are listed under.',
      inputSchema: {
        query: z.string().describe('Gmail query string, applied to every account.'),
        maxResultsPerAccount: z
          .number()
          .int()
          .optional()
          .describe(`Per-account cap. Default ${api.DEFAULT_RESULTS}, capped at ${api.MAX_RESULTS}.`),
        merge: z
          .boolean()
          .optional()
          .describe('Interleave the accounts into one date-ordered list instead of grouping by account.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, maxResultsPerAccount, merge }) =>
      guard('search_all_accounts', undefined, async () => {
        const limit = api.clampResults(maxResultsPerAccount);

        // Concurrent by construction: every mailbox is queried at once, not in turn.
        const results = await Promise.all(
          registry.list().map(async (config) => {
            try {
              const resolved = await registry.resolve(config.label);
              const found = await api.searchMessages(resolved, query, limit, false);
              return { config, messages: found.messages, error: undefined as string | undefined };
            } catch (err) {
              return { config, messages: [], error: describeError(err, config.label) };
            }
          }),
        );

        // A mailbox that could not be searched is a failure. It is reported and logged
        // as one, and it goes first, so a page of hits from the healthy accounts cannot
        // bury it.
        const failures = results.filter((r) => r.error);
        if (failures.length > 0) {
          note('search_all_accounts', 'error', {
            detail: `${query} (not searched: ${failures.map((r) => r.config.label).join(', ')})`,
          });
        } else {
          note('search_all_accounts', 'ok', { detail: query });
        }

        const answer = (text: string): TextResult =>
          failures.length > 0 ? { content: [{ type: 'text', text }], isError: true } : ok(text);

        if (merge) {
          const rows = results
            .flatMap((r) => r.messages.map((m) => ({ label: r.config.label, m })))
            .sort((a, b) => Date.parse(b.m.date ?? '') - Date.parse(a.m.date ?? ''))
            .map(({ label, m }) => `[${label}] ${renderSummary(m).split('\n').join('\n  ')}`);
          const errors = failures.map((r) => `[${r.config.label}] ${r.error}`);
          return answer([...errors, ...rows].join('\n\n') || 'no matches in any account');
        }

        return answer(
          results
            .map((r) =>
              r.error
                ? `account: ${r.config.label} (${r.config.email})\n${r.error}`
                : `account: ${r.config.label} (${r.config.email})\n` +
                  (r.messages.length === 0 ? 'no matches' : r.messages.map(renderSummary).join('\n\n')),
            )
            .join('\n\n===\n\n'),
        );
      }),
  );

  server.registerTool(
    'get_thread',
    {
      title: 'Read a whole conversation',
      description:
        'Read every message in one thread, oldest first, with bodies. HTML-only messages are ' +
        'flattened to text. Prefer this over get_message when replying, so the reply answers what ' +
        'was said last rather than a search snippet.',
      inputSchema: {
        account: accountRead,
        threadId: z.string().describe('Thread ID from a search result in this same account.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ account, threadId }) =>
      guard('get_thread', account, async () => {
        const resolved = await forRead(account);
        const messages = await api.getThread(resolved, threadId);
        note('get_thread', 'ok', {
          account: resolved.config.label,
          email: resolved.config.email,
          diverged: divergedFrom(resolved),
          detail: threadId,
        });
        return ok(header(resolved, messages.map(renderFull).join('\n\n---\n\n')));
      }),
  );

  server.registerTool(
    'get_message',
    {
      title: 'Read one message',
      description: 'Read a single message in full, with its body and attachment list.',
      inputSchema: {
        account: accountRead,
        messageId: z.string().describe('Message ID from a search result in this same account.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ account, messageId }) =>
      guard('get_message', account, async () => {
        const resolved = await forRead(account);
        const message = await api.getMessage(resolved, messageId);
        note('get_message', 'ok', {
          account: resolved.config.label,
          email: resolved.config.email,
          diverged: divergedFrom(resolved),
          detail: messageId,
        });
        return ok(header(resolved, renderFull(message)));
      }),
  );

  server.registerTool(
    'list_labels',
    {
      title: 'List labels',
      description:
        'List one account\'s labels with their IDs and unread counts. Label IDs are what Gmail ' +
        'queries and modify_labels take; display names are not interchangeable with them.',
      inputSchema: { account: accountRead },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ account }) =>
      guard('list_labels', account, async () => {
        const resolved = await forRead(account);
        const labels = await api.listLabels(resolved);
        note('list_labels', 'ok', { account: resolved.config.label, diverged: divergedFrom(resolved) });
        return ok(
          header(
            resolved,
            labels
              .map((l) => `${l.id}\t${l.name}\t${l.type}${l.unread ? `\tunread ${l.unread}` : ''}`)
              .join('\n'),
          ),
        );
      }),
  );

  server.registerTool(
    'list_drafts',
    {
      title: 'List drafts',
      description: 'List the drafts sitting in one account, newest first, with their draft IDs.',
      inputSchema: {
        account: accountRead,
        maxResults: z
          .number()
          .int()
          .optional()
          .describe(`Default ${api.DEFAULT_RESULTS}, capped at ${api.MAX_RESULTS}.`),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ account, maxResults }) =>
      guard('list_drafts', account, async () => {
        const resolved = await forRead(account);
        const drafts = await api.listDrafts(resolved, api.clampResults(maxResults));
        note('list_drafts', 'ok', { account: resolved.config.label, diverged: divergedFrom(resolved) });
        if (drafts.length === 0) return ok(header(resolved, 'no drafts'));
        return ok(
          header(
            resolved,
            drafts
              .map((d) =>
                [line('draft', d.draftId), line('to', d.to), line('subject', d.subject), line('snippet', d.snippet)]
                  .filter(Boolean)
                  .join('\n'),
              )
              .join('\n\n'),
          ),
        );
      }),
  );

  server.registerTool(
    'get_draft',
    {
      title: 'Read a draft',
      description: 'Read one draft in full, including the body as it currently stands.',
      inputSchema: { account: accountRead, draftId: z.string().describe('Draft ID from list_drafts.') },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ account, draftId }) =>
      guard('get_draft', account, async () => {
        const resolved = await forRead(account);
        const draft = await api.getDraft(resolved, draftId);
        note('get_draft', 'ok', {
          account: resolved.config.label,
          diverged: divergedFrom(resolved),
          draftId,
        });
        return ok(header(resolved, `draft: ${draft.draftId}\n${renderFull(draft)}`));
      }),
  );

  if (!writable) return;

  function resolveFrom(account: Account, from: string | undefined): string {
    if (from === undefined) return account.config.email;
    if (from.trim().toLowerCase() !== account.config.email) {
      throw new FromMismatchError(account.config.label, account.config.email, from);
    }
    return account.config.email;
  }

  /**
   * A reply carrying only a threadId threads in Gmail and opens as a new conversation in
   * most other clients. In-Reply-To and References come from the message being replied to.
   */
  async function replyContext(account: Account, replyToMessageId: string) {
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
          'In-Reply-To and References headers, and the recipient.',
      ),
  };

  type BodyArgs = {
    to?: string[];
    cc?: string[];
    bcc?: string[];
    subject?: string;
    body?: string;
    htmlBody?: string;
    from?: string;
    replyToMessageId?: string;
  };

  async function assembleDraft(
    account: Account,
    args: BodyArgs,
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

  server.registerTool(
    'create_draft',
    {
      title: 'Create a draft',
      description:
        'Save a new draft in one account. The draft is the finished deliverable: it sits in Gmail ' +
        'where a person reads it and presses send. Set replyToMessageId to reply. The account is ' +
        'required and is refused if it differs from the active account without confirmAccountSwitch. ' +
        'Name the mailbox you drafted in when you report back.',
      inputSchema: { account: accountWrite, confirmAccountSwitch: confirmSwitchArg, ...bodyArgs },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ account, confirmAccountSwitch, ...args }) =>
      guard('create_draft', account, async () => {
        const resolved = await forWrite('create_draft', account, confirmAccountSwitch);
        const { draft, threadId } = await assembleDraft(resolved, args);
        const created = await api.createDraft(resolved, draft, threadId);
        note('create_draft', 'ok', {
          account: resolved.config.label,
          email: resolved.config.email,
          diverged: divergedFrom(resolved),
          to: [...(draft.to ?? [])],
          cc: draft.cc ? [...draft.cc] : undefined,
          bcc: draft.bcc ? [...draft.bcc] : undefined,
          subject: draft.subject,
          draftId: created.draftId,
        });
        return ok(
          header(
            resolved,
            `draft saved\ndraft: ${created.draftId}\nthread: ${created.threadId}\n` +
              `from: ${draft.from}\nto: ${(draft.to ?? []).join(', ')}\nsubject: ${draft.subject ?? ''}`,
          ),
        );
      }),
  );

  server.registerTool(
    'update_draft',
    {
      title: 'Replace a draft',
      description:
        'Replace the whole content of an existing draft, keeping its draft ID. Every field is ' +
        'rewritten from what you pass, so send the complete message, not only the part you changed.',
      inputSchema: {
        account: accountWrite,
        draftId: z.string().describe('Draft ID to overwrite, from list_drafts.'),
        confirmAccountSwitch: confirmSwitchArg,
        ...bodyArgs,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ account, draftId, confirmAccountSwitch, ...args }) =>
      guard('update_draft', account, async () => {
        const resolved = await forWrite('update_draft', account, confirmAccountSwitch);
        const { draft, threadId } = await assembleDraft(resolved, args);
        const updated = await api.updateDraft(resolved, draftId, draft, threadId);
        note('update_draft', 'ok', {
          account: resolved.config.label,
          diverged: divergedFrom(resolved),
          to: [...(draft.to ?? [])],
          subject: draft.subject,
          draftId: updated.draftId,
        });
        return ok(header(resolved, `draft updated\ndraft: ${updated.draftId}\nthread: ${updated.threadId}`));
      }),
  );

  server.registerTool(
    'delete_draft',
    {
      title: 'Delete a draft',
      description:
        'Permanently delete a draft. It does not go to the trash and cannot be recovered. Only for ' +
        'a draft this session created and the user has asked to discard.',
      inputSchema: {
        account: accountWrite,
        draftId: z.string().describe('Draft ID to delete.'),
        confirmAccountSwitch: confirmSwitchArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ account, draftId, confirmAccountSwitch }) =>
      guard('delete_draft', account, async () => {
        const resolved = await forWrite('delete_draft', account, confirmAccountSwitch);
        await api.deleteDraft(resolved, draftId);
        note('delete_draft', 'ok', {
          account: resolved.config.label,
          diverged: divergedFrom(resolved),
          draftId,
        });
        return ok(header(resolved, `draft ${draftId} deleted`));
      }),
  );

  server.registerTool(
    'modify_labels',
    {
      title: 'Add or remove labels on a thread',
      description:
        'Add and remove labels on a whole thread by label ID. Removing INBOX archives it; removing ' +
        'UNREAD marks it read. Get IDs from list_labels first, since names are not IDs.',
      inputSchema: {
        account: accountWrite,
        threadId: z.string().describe('Thread ID in this same account.'),
        addLabelIds: z.array(z.string()).optional().describe('Label IDs to add.'),
        removeLabelIds: z.array(z.string()).optional().describe('Label IDs to remove.'),
        confirmAccountSwitch: confirmSwitchArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ account, threadId, addLabelIds, removeLabelIds, confirmAccountSwitch }) =>
      guard('modify_labels', account, async () => {
        const resolved = await forWrite('modify_labels', account, confirmAccountSwitch);
        const labels = await api.modifyThreadLabels(resolved, threadId, addLabelIds ?? [], removeLabelIds ?? []);
        note('modify_labels', 'ok', {
          account: resolved.config.label,
          diverged: divergedFrom(resolved),
          detail: threadId,
        });
        return ok(header(resolved, `thread ${threadId} now labelled: ${labels.join(', ')}`));
      }),
  );

  server.registerTool(
    'trash_thread',
    {
      title: 'Move a thread to the trash',
      description:
        'Move a whole thread to the trash, where Gmail keeps it for 30 days. Reversible with untrash ' +
        'set to true. This server cannot permanently delete a message or a thread.',
      inputSchema: {
        account: accountWrite,
        threadId: z.string().describe('Thread ID in this same account.'),
        untrash: z.boolean().optional().describe('Set true to pull a thread back out of the trash.'),
        confirmAccountSwitch: confirmSwitchArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ account, threadId, untrash, confirmAccountSwitch }) =>
      guard('trash_thread', account, async () => {
        const resolved = await forWrite('trash_thread', account, confirmAccountSwitch);
        if (untrash) {
          await api.untrashThread(resolved, threadId);
          note('trash_thread', 'ok', {
            account: resolved.config.label,
            diverged: divergedFrom(resolved),
            detail: `untrash ${threadId}`,
          });
          return ok(header(resolved, `thread ${threadId} restored from trash`));
        }
        await api.trashThread(resolved, threadId);
        note('trash_thread', 'ok', {
          account: resolved.config.label,
          diverged: divergedFrom(resolved),
          detail: `trash ${threadId}`,
        });
        return ok(header(resolved, `thread ${threadId} moved to trash`));
      }),
  );

  if (!allowSend) return;

  /** Fail-closed. Anything other than an explicit click on Send stops the call. */
  async function gateSend(account: Account, draft: MessageDraft): Promise<void> {
    if (!confirmSends) return;
    const outcome = await deps.confirmSend(
      {
        accountLabel: account.config.label,
        from: draft.from,
        to: [...(draft.to ?? [])],
        cc: draft.cc ? [...draft.cc] : undefined,
        bcc: draft.bcc ? [...draft.bcc] : undefined,
        subject: draft.subject ?? '',
        preview: draft.text ?? draft.html ?? '',
      },
      deps.platform,
    );
    if (outcome !== 'confirmed') {
      throw new SendNotConfirmedError(outcome, [...(draft.to ?? [])]);
    }
  }

  server.registerTool(
    'send_draft',
    {
      title: 'Send an existing draft',
      description:
        'Send a draft that already exists, unchanged. The safer of the two send tools, because what ' +
        'goes out is the text that was reviewed. A desktop dialog asks the user to confirm the ' +
        'account, the recipient, and the subject, and the send is refused unless they click Send. ' +
        'Sending cannot be undone.',
      inputSchema: {
        account: accountWrite,
        draftId: z.string().describe('Draft ID to send.'),
        confirmAccountSwitch: confirmSwitchArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ account, draftId, confirmAccountSwitch }) =>
      guard('send_draft', account, async () => {
        const resolved = await forWrite('send_draft', account, confirmAccountSwitch);
        const existing = await api.getDraft(resolved, draftId);
        // The dialog and the log both get every recipient the draft carries, Cc and Bcc
        // included, parsed the way an address list is parsed. A comma inside a quoted
        // display name is part of the name. A Bcc the sender cannot see in the dialog is
        // the thing the dialog exists to prevent.
        const recipients = parseAddressList(existing.to);
        const copies = parseAddressList(existing.cc);
        const blindCopies = parseAddressList(existing.bcc);
        await gateSend(resolved, {
          from: resolved.config.email,
          to: recipients,
          cc: copies.length > 0 ? copies : undefined,
          bcc: blindCopies.length > 0 ? blindCopies : undefined,
          subject: existing.subject ?? '',
          text: existing.body,
        });
        const sent = await api.sendDraft(resolved, draftId);
        note('send_draft', 'ok', {
          account: resolved.config.label,
          email: resolved.config.email,
          diverged: divergedFrom(resolved),
          to: recipients,
          cc: copies.length > 0 ? copies : undefined,
          bcc: blindCopies.length > 0 ? blindCopies : undefined,
          subject: existing.subject,
          draftId,
          messageId: sent.messageId,
        });
        return ok(header(resolved, `sent\nmessage: ${sent.messageId}\nthread: ${sent.threadId}`));
      }),
  );

  server.registerTool(
    'send_message',
    {
      title: 'Compose and send in one step',
      description:
        'Compose a message and put it on the wire immediately, with no draft in between and no way ' +
        'to recall it. Prefer create_draft followed by send_draft, so there is a version a person ' +
        'can read first. A desktop dialog still asks the user to confirm before it goes.',
      inputSchema: { account: accountWrite, confirmAccountSwitch: confirmSwitchArg, ...bodyArgs },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ account, confirmAccountSwitch, ...args }) =>
      guard('send_message', account, async () => {
        const resolved = await forWrite('send_message', account, confirmAccountSwitch);
        const { draft, threadId } = await assembleDraft(resolved, args);
        await gateSend(resolved, draft);
        const sent = await api.sendMessage(resolved, draft, threadId);
        note('send_message', 'ok', {
          account: resolved.config.label,
          email: resolved.config.email,
          diverged: divergedFrom(resolved),
          to: [...(draft.to ?? [])],
          cc: draft.cc ? [...draft.cc] : undefined,
          bcc: draft.bcc ? [...draft.bcc] : undefined,
          subject: draft.subject,
          messageId: sent.messageId,
        });
        return ok(
          header(
            resolved,
            `sent\nmessage: ${sent.messageId}\nthread: ${sent.threadId}\n` +
              `from: ${draft.from}\nto: ${(draft.to ?? []).join(', ')}\nsubject: ${draft.subject ?? ''}`,
          ),
        );
      }),
  );
}

/** "Dan Roberts <dan@example.com>" to "dan@example.com". */
export function extractAddress(value: string): string {
  const angled = /<([^>]+)>/.exec(value);
  return (angled?.[1] ?? value).trim();
}

/**
 * A raw To, Cc or Bcc header to the bare addresses in it. The split understands quoted
 * display names, because `"Roberts, Dan" <dan@example.com>` is one recipient and splitting
 * it on every comma produces two that do not exist. Quoting is all it understands: a comma
 * inside an RFC 5322 comment, as in `dan@example.com (Roberts, Dan)`, still splits.
 *
 * A header whose quotes never close is split on the raw commas instead, which can leave a
 * fragment of a display name in the list. The confirmation dialog and the audit log both
 * read from this, and a stray fragment a person can see beats a recipient that neither the
 * dialog nor the log ever mentions.
 */
export function parseAddressList(header: string | undefined): string[] {
  if (!header) return [];
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < header.length; i += 1) {
    const char = header[i]!;
    if (quoted && char === '\\' && i + 1 < header.length) {
      current += char + header[i + 1];
      i += 1;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      current += char;
      continue;
    }
    if (char === ',' && !quoted) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  // An unterminated quote means the quote-aware split swallowed every comma after it, and
  // every recipient those commas separated. Fall back to the raw split so none is lost.
  const split = quoted ? header.split(',') : parts;
  return split.map(extractAddress).filter((address) => address !== '');
}

/**
 * The Gmail API layer. Every function takes an already-resolved Account, so the identity
 * check in accounts.ts cannot be bypassed.
 *
 * Results are shaped for reading. A raw Schema$Message costs several hundred tokens of
 * Received headers and still requires walking a MIME tree to reach the body text.
 */

import type { gmail_v1 } from 'googleapis';
import type { Account } from './accounts.js';
import { buildRawMessage, extractBody, headerValue, type MessageDraft } from './mime.js';

/** Gmail's ceiling is 500. Lower here to bound how much of a context window one search
 * can consume. */
export const MAX_RESULTS = 50;
export const DEFAULT_RESULTS = 10;

export function clampResults(requested: number | undefined): number {
  if (requested === undefined) return DEFAULT_RESULTS;
  return Math.max(1, Math.min(MAX_RESULTS, Math.floor(requested)));
}

export interface MessageSummary {
  id: string;
  threadId: string;
  date?: string;
  from?: string;
  to?: string;
  cc?: string;
  subject?: string;
  snippet?: string;
  labelIds: string[];
}

export interface FullMessage extends MessageSummary {
  body: string;
  messageIdHeader?: string;
  references?: string;
  attachments: Array<{ filename: string; mimeType: string; attachmentId: string; size: number }>;
}

function summarize(message: gmail_v1.Schema$Message): MessageSummary {
  const headers = message.payload?.headers ?? undefined;
  return {
    id: message.id ?? '',
    threadId: message.threadId ?? '',
    date: headerValue(headers, 'Date'),
    from: headerValue(headers, 'From'),
    to: headerValue(headers, 'To'),
    cc: headerValue(headers, 'Cc'),
    subject: headerValue(headers, 'Subject'),
    snippet: message.snippet ?? undefined,
    labelIds: message.labelIds ?? [],
  };
}

function toFull(message: gmail_v1.Schema$Message): FullMessage {
  const headers = message.payload?.headers ?? undefined;
  const { text, attachments } = extractBody(message.payload ?? undefined);
  return {
    ...summarize(message),
    body: text,
    messageIdHeader: headerValue(headers, 'Message-ID') ?? headerValue(headers, 'Message-Id'),
    references: headerValue(headers, 'References'),
    attachments,
  };
}

/** Requesting only the headers that get displayed keeps a fifty-result search from
 * dragging in fifty copies of the Received chain. */
const METADATA_HEADERS = ['Date', 'From', 'To', 'Cc', 'Subject'];

export async function searchMessages(
  account: Account,
  query: string | undefined,
  maxResults: number,
  includeSpamTrash = false,
): Promise<{ messages: MessageSummary[]; nextPageToken?: string; estimate?: number }> {
  const list = await account.gmail.users.messages.list({
    userId: 'me',
    q: query,
    maxResults,
    includeSpamTrash,
  });

  const ids = (list.data.messages ?? []).map((m) => m.id).filter((id): id is string => !!id);

  const messages = await Promise.all(
    ids.map(async (id) => {
      const res = await account.gmail.users.messages.get({
        userId: 'me',
        id,
        format: 'metadata',
        metadataHeaders: METADATA_HEADERS,
      });
      return summarize(res.data);
    }),
  );

  return {
    messages,
    nextPageToken: list.data.nextPageToken ?? undefined,
    estimate: list.data.resultSizeEstimate ?? undefined,
  };
}

export async function getThread(account: Account, threadId: string): Promise<FullMessage[]> {
  const res = await account.gmail.users.threads.get({ userId: 'me', id: threadId, format: 'full' });
  return (res.data.messages ?? []).map(toFull);
}

export async function getMessage(account: Account, messageId: string): Promise<FullMessage> {
  const res = await account.gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' });
  return toFull(res.data);
}

export interface DraftSummary {
  draftId: string;
  messageId: string;
  threadId: string;
  to?: string;
  subject?: string;
  snippet?: string;
}

export async function listDrafts(account: Account, maxResults: number): Promise<DraftSummary[]> {
  const list = await account.gmail.users.drafts.list({ userId: 'me', maxResults });

  return Promise.all(
    (list.data.drafts ?? []).map(async (draft) => {
      const res = await account.gmail.users.drafts.get({
        userId: 'me',
        id: draft.id ?? '',
        format: 'metadata',
      });
      const message = res.data.message ?? {};
      const headers = message.payload?.headers ?? undefined;
      return {
        draftId: res.data.id ?? '',
        messageId: message.id ?? '',
        threadId: message.threadId ?? '',
        to: headerValue(headers, 'To'),
        subject: headerValue(headers, 'Subject'),
        snippet: message.snippet ?? undefined,
      };
    }),
  );
}

export async function getDraft(account: Account, draftId: string): Promise<FullMessage & { draftId: string }> {
  const res = await account.gmail.users.drafts.get({ userId: 'me', id: draftId, format: 'full' });
  return { draftId: res.data.id ?? draftId, ...toFull(res.data.message ?? {}) };
}

export async function createDraft(
  account: Account,
  draft: MessageDraft,
  threadId?: string,
): Promise<{ draftId: string; messageId: string; threadId: string }> {
  const res = await account.gmail.users.drafts.create({
    userId: 'me',
    requestBody: { message: { raw: buildRawMessage(draft), threadId } },
  });
  return {
    draftId: res.data.id ?? '',
    messageId: res.data.message?.id ?? '',
    threadId: res.data.message?.threadId ?? '',
  };
}

export async function updateDraft(
  account: Account,
  draftId: string,
  draft: MessageDraft,
  threadId?: string,
): Promise<{ draftId: string; messageId: string; threadId: string }> {
  const res = await account.gmail.users.drafts.update({
    userId: 'me',
    id: draftId,
    requestBody: { message: { raw: buildRawMessage(draft), threadId } },
  });
  return {
    draftId: res.data.id ?? draftId,
    messageId: res.data.message?.id ?? '',
    threadId: res.data.message?.threadId ?? '',
  };
}

export async function deleteDraft(account: Account, draftId: string): Promise<void> {
  await account.gmail.users.drafts.delete({ userId: 'me', id: draftId });
}

export async function sendDraft(
  account: Account,
  draftId: string,
): Promise<{ messageId: string; threadId: string }> {
  const res = await account.gmail.users.drafts.send({ userId: 'me', requestBody: { id: draftId } });
  return { messageId: res.data.id ?? '', threadId: res.data.threadId ?? '' };
}

export async function sendMessage(
  account: Account,
  draft: MessageDraft,
  threadId?: string,
): Promise<{ messageId: string; threadId: string }> {
  const res = await account.gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw: buildRawMessage(draft), threadId },
  });
  return { messageId: res.data.id ?? '', threadId: res.data.threadId ?? '' };
}

export interface LabelInfo {
  id: string;
  name: string;
  type: string;
  unread?: number;
  total?: number;
}

export async function listLabels(account: Account): Promise<LabelInfo[]> {
  const res = await account.gmail.users.labels.list({ userId: 'me' });
  return (res.data.labels ?? []).map((label) => ({
    id: label.id ?? '',
    name: label.name ?? '',
    type: label.type ?? 'user',
    unread: label.messagesUnread ?? undefined,
    total: label.messagesTotal ?? undefined,
  }));
}

export async function modifyThreadLabels(
  account: Account,
  threadId: string,
  addLabelIds: string[],
  removeLabelIds: string[],
): Promise<string[]> {
  const res = await account.gmail.users.threads.modify({
    userId: 'me',
    id: threadId,
    requestBody: { addLabelIds, removeLabelIds },
  });
  const messages = res.data.messages ?? [];
  return messages[0]?.labelIds ?? [];
}

export async function trashThread(account: Account, threadId: string): Promise<void> {
  await account.gmail.users.threads.trash({ userId: 'me', id: threadId });
}

export async function untrashThread(account: Account, threadId: string): Promise<void> {
  await account.gmail.users.threads.untrash({ userId: 'me', id: threadId });
}

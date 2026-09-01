/**
 * A language model reads these, so each message says what the current state is and what
 * to do next. "403 Forbidden" gives a model nothing to act on, and on a server holding
 * more than one mailbox the most valuable thing an error can say is which mailbox it was
 * talking about.
 */

export class ToolError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'ToolError';
  }
}

export class ConfigError extends ToolError {
  constructor(message: string) {
    super(message, 'CONFIG_ERROR');
  }
}

/** The account argument named a label or address that is not configured. */
export class UnknownAccountError extends ToolError {
  constructor(ref: string, known: string[]) {
    super(
      `Unknown account ${JSON.stringify(ref)}. ` +
        `This server holds ${known.length === 1 ? 'one account' : `${known.length} accounts`}: ${known.join(', ')}. ` +
        `Pass one of those labels, or the full address of one of them, as the "account" argument. ` +
        `Call list_accounts to see every account with its address.`,
      'UNKNOWN_ACCOUNT',
    );
  }
}

/**
 * The refresh token filed under a label belongs to a different mailbox. This is the
 * failure the whole design exists to prevent, so it is fatal for that account rather
 * than a warning: the alternative is reading, drafting, and sending from the wrong inbox
 * with no visible symptom.
 */
export class AccountIdentityError extends ToolError {
  constructor(label: string, declared: string, actual: string) {
    super(
      `Account "${label}" is misconfigured and will not be used. Its refresh token authenticates as ` +
        `${actual}, but GMAIL_ACCOUNT_${envSuffix(label)}_EMAIL says ${declared}. ` +
        `One of the two is wrong, most often because the tokens from two authorize runs were pasted ` +
        `under the wrong labels. Re-run \`npm run authorize -- --account ${label}\`, sign in as ` +
        `${declared}, and replace both lines it prints. Do not edit only the address to match: that ` +
        `would point the label at a mailbox you did not mean to expose.`,
      'ACCOUNT_IDENTITY_MISMATCH',
    );
  }
}

/** Sending is off. Says how to turn it on rather than implying the server is broken. */
export class SendDisabledError extends ToolError {
  constructor() {
    super(
      'Sending is disabled on this server. It can create, read, and update drafts, but it cannot ' +
        'put mail on the wire. The draft is saved in Gmail and a person can send it from there. ' +
        'To enable sending, set GMAIL_ALLOW_SEND=true in the server config and restart the client.',
      'SEND_DISABLED',
    );
  }
}

/** A from address that does not belong to the account would silently send from elsewhere. */
export class FromMismatchError extends ToolError {
  constructor(label: string, accountEmail: string, from: string) {
    super(
      `Refusing to use from="${from}" on account "${label}", which is ${accountEmail}. ` +
        `The from address must be the account's own address. Gmail rewrites or rejects a From header ` +
        `that the authenticated mailbox is not entitled to, so this would not have done what it looks ` +
        `like it does. To send as a different mailbox, pass that mailbox's account label instead.`,
      'FROM_MISMATCH',
    );
  }
}

export function envSuffix(label: string): string {
  return label.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

/**
 * Google API errors bury the useful part several levels deep, and the raw object is a
 * wall of JSON that costs tokens and explains nothing. `where` names the account, so a
 * 403 on one mailbox is never mistaken for a broken server.
 */
export function describeError(err: unknown, where?: string): string {
  if (err instanceof ToolError) return err.message;

  const anyErr = err as {
    code?: number | string;
    message?: string;
    errors?: Array<{ message?: string; reason?: string }>;
    response?: { data?: { error?: { message?: string; errors?: Array<{ reason?: string }> } } };
  };

  const apiMessage =
    anyErr?.response?.data?.error?.message ?? anyErr?.errors?.[0]?.message ?? anyErr?.message;
  const reason = anyErr?.response?.data?.error?.errors?.[0]?.reason ?? anyErr?.errors?.[0]?.reason;
  const status = anyErr?.code;
  const on = where ? ` on account "${where}"` : '';

  switch (status) {
    case 400:
      return (
        `Gmail rejected the request as malformed (400)${on}: ${apiMessage ?? 'no detail given'}. ` +
        `On drafts and sends this is usually an address that is not a bare email, or a threadId ` +
        `that does not belong to the message being replied to.`
      );
    case 401:
      return (
        `Google rejected the credentials (401)${on}. That account's refresh token is invalid, ` +
        `revoked, or was issued for a different OAuth client. Re-run ` +
        `\`npm run authorize -- --account <label>\` for it. Other accounts on this server are ` +
        `unaffected.`
      );
    case 403:
      if (reason === 'insufficientPermissions' || reason === 'forbidden') {
        return (
          `Permission denied (403)${on}. The token was granted a scope that does not cover this ` +
          `call. GMAIL_SCOPE_PROFILE=readonly cannot write; gmail.modify cannot permanently delete. ` +
          `Re-authorize that account with the scope you need.`
        );
      }
      if (reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded') {
        return `Rate limited by Gmail (403)${on}. Wait a few seconds and retry; this is transient.`;
      }
      return `Google refused the request (403)${on}: ${apiMessage ?? 'no detail given'}`;
    case 404:
      return (
        `Not found (404)${on}. Message, thread, draft, and label IDs are scoped to one mailbox: an ID ` +
        `read from one account does not exist in another. Check that the "account" argument matches ` +
        `the account the ID came from.`
      );
    case 429:
      return `Rate limited by Gmail (429)${on}. Back off and retry.`;
    default:
      break;
  }

  if (apiMessage) return `Gmail API error${status ? ` (${status})` : ''}${on}: ${apiMessage}`;
  if (err instanceof Error) return err.message;
  return String(err);
}

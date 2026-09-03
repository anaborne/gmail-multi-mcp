/**
 * The account registry. Refresh tokens rather than a service account: a service account
 * cannot reach a consumer Gmail mailbox without domain-wide delegation, a Workspace-admin
 * feature, and the mailboxes this server holds are ordinary ones.
 *
 * A label in the config is an unchecked assertion about which mailbox a token opens.
 * resolve() checks it against users.getProfile before the token is used for anything.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import type { gmail_v1 } from 'googleapis';

import { AccountIdentityError, ConfigError, UnknownAccountError, envSuffix } from './errors.js';

/** Read, drafts, send, labels, trash. Restricted in Google's terms, so an unverified app
 * must be in Testing mode with the account listed as a test user. */
export const GMAIL_MODIFY_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';

/** Read only. Also restricted. */
export const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

export type ScopeProfile = 'full' | 'readonly';

/** Loopback redirect the authorize script listens on. */
export const DEFAULT_REDIRECT_URI = 'http://localhost:4182/oauth2callback';

export interface AccountConfig {
  /** What the model passes as `account`. Lowercase, unique. */
  label: string;
  /** The address the config claims this token opens. Verified, never trusted. */
  email: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export interface ServerConfig {
  accounts: AccountConfig[];
  scopeProfile: ScopeProfile;
  allowSend: boolean;
  /** Minutes an active-account selection stays good. 0 disables expiry. */
  activeTtlMinutes: number;
  /** Where the call log is appended. undefined means logging is off. */
  auditLogPath: string | undefined;
  /** Raise a desktop dialog before a send. */
  confirmSends: boolean;
}

const LABEL_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

export function scopeFor(profile: ScopeProfile): string {
  return profile === 'readonly' ? GMAIL_READONLY_SCOPE : GMAIL_MODIFY_SCOPE;
}

export function parseScopeProfile(raw: string | undefined): ScopeProfile {
  const value = raw?.trim().toLowerCase();
  if (!value || value === 'full' || value === 'modify') return 'full';
  if (value === 'readonly' || value === 'read' || value === 'read-only') return 'readonly';
  throw new ConfigError(
    `GMAIL_SCOPE_PROFILE=${JSON.stringify(raw)} is not a scope profile. Use "full" (gmail.modify: ` +
      `read, drafts, send, labels, trash) or "readonly" (gmail.readonly).`,
  );
}

/**
 * Only "true" enables sending, case-insensitively. "false", "0", "no" and an empty value
 * mean off, and anything else is refused at startup. A truthiness check would turn
 * GMAIL_ALLOW_SEND=false, the thing a careful person writes to mean off, into on.
 */
export function parseAllowSend(raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase();
  if (value === undefined || value === '' || value === 'false' || value === '0' || value === 'no') {
    return false;
  }
  if (value === 'true') return true;
  throw new ConfigError(
    `GMAIL_ALLOW_SEND=${JSON.stringify(raw)} is not a yes or a no. Set it to "true" (any case) to enable ` +
      `sending, or leave it unset. Anything ambiguous is refused rather than guessed, because the ` +
      `wrong guess puts mail on the wire.`,
  );
}

/** Default of 60 minutes. An hour is long enough not to nag and short enough that a
 * selection made this morning does not steer a call this evening. */
export function parseActiveTtl(raw: string | undefined): number {
  const value = raw?.trim();
  if (value === undefined || value === '') return 60;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) {
    throw new ConfigError(
      `GMAIL_ACTIVE_TTL_MINUTES=${JSON.stringify(raw)} is not a whole number of minutes. Use a ` +
        `positive integer, or 0 to let an active account selection stand until the server restarts.`,
    );
  }
  return parsed;
}

export function parseAuditLogPath(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (value === 'off' || value === 'none') return undefined;
  if (!value) return join(homedir(), '.gmail-multi-mcp', 'audit.jsonl');
  return value;
}

/** Defaults on. A dialog nobody asked for is a smaller problem than mail nobody saw. */
export function parseConfirmSends(raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase();
  if (value === undefined || value === '' || value === 'send' || value === 'on' || value === 'true') {
    return true;
  }
  if (value === 'off' || value === 'false' || value === 'none') return false;
  throw new ConfigError(
    `GMAIL_CONFIRM_POPUP=${JSON.stringify(raw)} is not a setting. Use "send" (default, a desktop ` +
      `dialog before every send) or "off".`,
  );
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

/** Names the missing variable and refuses to start. A server that starts anyway and fails
 * on every call is much harder to diagnose from inside a chat client. */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const rawLabels = (env.GMAIL_ACCOUNTS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');

  if (rawLabels.length === 0) {
    throw new ConfigError(
      'GMAIL_ACCOUNTS is empty. List the account labels this server should hold, comma separated, ' +
        'for example GMAIL_ACCOUNTS=personal,work. Each label L then needs GMAIL_ACCOUNT_L_EMAIL and ' +
        'GMAIL_ACCOUNT_L_REFRESH_TOKEN. See .env.example.',
    );
  }

  // || here, because ?? keeps an empty-but-present variable, and that is the shape
  // `cp .env.example .env` leaves behind for anyone supplying GOOGLE_CLIENT_ID instead.
  const sharedId = env.GMAIL_CLIENT_ID?.trim() || env.GOOGLE_CLIENT_ID?.trim();
  const sharedSecret = env.GMAIL_CLIENT_SECRET?.trim() || env.GOOGLE_CLIENT_SECRET?.trim();

  const accounts: AccountConfig[] = [];
  const seenLabels = new Set<string>();
  const seenEmails = new Map<string, string>();

  for (const raw of rawLabels) {
    const label = raw.toLowerCase();

    if (!LABEL_PATTERN.test(label)) {
      throw new ConfigError(
        `Account label ${JSON.stringify(raw)} is not usable. A label is a short name made of letters, ` +
          `digits, hyphens, and underscores, starting with a letter or digit, for example "personal" ` +
          `or "job-search". It is not an email address; the address goes in GMAIL_ACCOUNT_L_EMAIL.`,
      );
    }
    if (seenLabels.has(label)) {
      throw new ConfigError(
        `Account label "${label}" is listed twice in GMAIL_ACCOUNTS. Labels select a mailbox, so a ` +
          `duplicate has no single answer. Give the second one a different name.`,
      );
    }
    seenLabels.add(label);

    const suffix = envSuffix(label);
    const email = env[`GMAIL_ACCOUNT_${suffix}_EMAIL`]?.trim();
    const refreshToken = env[`GMAIL_ACCOUNT_${suffix}_REFRESH_TOKEN`]?.trim();
    const clientId = env[`GMAIL_ACCOUNT_${suffix}_CLIENT_ID`]?.trim() || sharedId;
    const clientSecret = env[`GMAIL_ACCOUNT_${suffix}_CLIENT_SECRET`]?.trim() || sharedSecret;

    const missing: string[] = [];
    if (!email) missing.push(`GMAIL_ACCOUNT_${suffix}_EMAIL`);
    if (!refreshToken) missing.push(`GMAIL_ACCOUNT_${suffix}_REFRESH_TOKEN`);
    if (!clientId) missing.push(`GMAIL_CLIENT_ID (or GMAIL_ACCOUNT_${suffix}_CLIENT_ID)`);
    if (!clientSecret) missing.push(`GMAIL_CLIENT_SECRET (or GMAIL_ACCOUNT_${suffix}_CLIENT_SECRET)`);

    if (missing.length > 0) {
      throw new ConfigError(
        `Account "${label}" is incomplete. Missing: ${missing.join(', ')}. ` +
          `Run \`npm run authorize -- --account ${label}\` to mint the token and print both lines.`,
      );
    }
    if (!looksLikeEmail(email!)) {
      throw new ConfigError(
        `GMAIL_ACCOUNT_${suffix}_EMAIL=${JSON.stringify(email)} is not an email address. It must be the ` +
          `full address of the mailbox, for example name@gmail.com.`,
      );
    }

    const normalized = normalizeEmail(email!);
    const other = seenEmails.get(normalized);
    if (other) {
      throw new ConfigError(
        `Accounts "${other}" and "${label}" both declare ${normalized}. Two labels for one mailbox make ` +
          `every result ambiguous about where it came from. Keep one.`,
      );
    }
    seenEmails.set(normalized, label);

    accounts.push({
      label,
      email: normalized,
      clientId: clientId!,
      clientSecret: clientSecret!,
      refreshToken: refreshToken!,
    });
  }

  return {
    accounts,
    scopeProfile: parseScopeProfile(env.GMAIL_SCOPE_PROFILE),
    allowSend: parseAllowSend(env.GMAIL_ALLOW_SEND),
    activeTtlMinutes: parseActiveTtl(env.GMAIL_ACTIVE_TTL_MINUTES),
    auditLogPath: parseAuditLogPath(env.GMAIL_AUDIT_LOG),
    confirmSends: parseConfirmSends(env.GMAIL_CONFIRM_POPUP),
  };
}

export function createOAuthClient(
  config: AccountConfig,
  redirectUri = DEFAULT_REDIRECT_URI,
): OAuth2Client {
  const client = new google.auth.OAuth2(config.clientId, config.clientSecret, redirectUri);
  client.setCredentials({ refresh_token: config.refreshToken });
  return client;
}

export function createGmailClient(auth: OAuth2Client): gmail_v1.Gmail {
  return google.gmail({ version: 'v1', auth });
}

export interface Account {
  config: AccountConfig;
  gmail: gmail_v1.Gmail;
}

/** What getProfile returns, narrowed to the part that matters. Injectable so the identity
 * check is testable without a network. */
export type ProfileReader = (account: Account) => Promise<string>;

const liveProfileReader: ProfileReader = async (account) => {
  const res = await account.gmail.users.getProfile({ userId: 'me' });
  const address = res.data.emailAddress;
  if (!address) {
    throw new ConfigError(
      `Gmail returned no address for account "${account.config.label}", so its identity cannot be ` +
        `confirmed and it will not be used.`,
    );
  }
  return address;
};

export class AccountRegistry {
  private readonly byLabel = new Map<string, Account>();
  private readonly byEmail = new Map<string, Account>();
  private readonly verified = new Map<string, Promise<void>>();

  constructor(
    readonly config: ServerConfig,
    private readonly readProfile: ProfileReader = liveProfileReader,
  ) {
    for (const accountConfig of config.accounts) {
      const account: Account = {
        config: accountConfig,
        gmail: createGmailClient(createOAuthClient(accountConfig)),
      };
      this.byLabel.set(accountConfig.label, account);
      this.byEmail.set(accountConfig.email, account);
    }
  }

  get labels(): string[] {
    return [...this.byLabel.keys()];
  }

  list(): AccountConfig[] {
    return this.config.accounts;
  }

  /** Accepts a label or the account's full address, case-insensitively. Nothing else. */
  lookup(ref: string): Account {
    const key = ref.trim().toLowerCase();
    const found = this.byLabel.get(key) ?? this.byEmail.get(key);
    if (!found) {
      throw new UnknownAccountError(
        ref,
        this.config.accounts.map((a) => `${a.label} (${a.email})`),
      );
    }
    return found;
  }

  /**
   * Resolution and the identity check are one step, so no call site can reach a gmail
   * client with the check skipped. Cached per account per process, failures included: a
   * mismatch is a config error and will not clear mid-session.
   */
  async resolve(ref: string): Promise<Account> {
    const account = this.lookup(ref);
    let check = this.verified.get(account.config.label);
    if (!check) {
      check = this.verify(account);
      this.verified.set(account.config.label, check);
    }
    await check;
    return account;
  }

  private async verify(account: Account): Promise<void> {
    const actual = normalizeEmail(await this.readProfile(account));
    if (actual !== account.config.email) {
      throw new AccountIdentityError(account.config.label, account.config.email, actual);
    }
  }
}

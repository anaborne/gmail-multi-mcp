#!/usr/bin/env node
/**
 * Mints one account's refresh token and reports the address it actually signed in as.
 *
 *   node scripts/authorize.mjs --account personal
 *   node scripts/authorize.mjs --account jobs --write
 *
 * Plain JavaScript on purpose: this is the first thing a new user runs, and it should work
 * on any Node 18+ with no build step.
 *
 * The address is read back from Gmail rather than asked for. Running this twice and pasting
 * the second token under the first label is the one setup mistake that produces a working
 * server pointed at the wrong inbox, and asking a person to type the address they think
 * they used does nothing to catch it.
 */

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { google } from 'googleapis';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const ENV_PATH = join(ROOT, '.env');

const PORT = 4182;
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;

const MODIFY_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
const READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

function fail(message) {
  console.error(`\n  x ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { account: undefined, scope: 'full', write: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--account' || arg === '-a') args.account = argv[++i];
    else if (arg?.startsWith('--account=')) args.account = arg.slice('--account='.length);
    else if (arg === '--scope') args.scope = argv[++i];
    else if (arg?.startsWith('--scope=')) args.scope = arg.slice('--scope='.length);
    else if (arg === '--write' || arg === '-w') args.write = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
  }
  return args;
}

/** Avoids a dependency for one file read. */
function loadDotEnv() {
  if (!existsSync(ENV_PATH)) return;
  for (const rawLine of readFileSync(ENV_PATH, 'utf8').split('\n')) {
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

function envSuffix(label) {
  return label.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

/** Rewrites the two lines for this label in place, leaving every other line alone, so a
 * second run cannot bury the first account's token under a duplicate key. */
function writeEnvLines(pairs) {
  let text = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : '';
  for (const [key, value] of pairs) {
    const pattern = new RegExp(`^${key}=.*$`, 'm');
    if (pattern.test(text)) text = text.replace(pattern, `${key}=${value}`);
    else text += `${text.endsWith('\n') || text === '' ? '' : '\n'}${key}=${value}\n`;
  }
  writeFileSync(ENV_PATH, text, { mode: 0o600 });
}

/** Adds the label to GMAIL_ACCOUNTS if it is not already listed. */
function ensureAccountListed(label) {
  const text = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : '';
  const match = /^GMAIL_ACCOUNTS=(.*)$/m.exec(text);
  const current = (match?.[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (current.includes(label)) return;
  const next = [...current, label].join(',');
  if (match) writeFileSync(ENV_PATH, text.replace(/^GMAIL_ACCOUNTS=.*$/m, `GMAIL_ACCOUNTS=${next}`), { mode: 0o600 });
  else appendFileSync(ENV_PATH, `${text.endsWith('\n') || text === '' ? '' : '\n'}GMAIL_ACCOUNTS=${next}\n`);
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(`
  gmail-multi-mcp authorization

    node scripts/authorize.mjs --account <label> [--scope full|readonly] [--write]

  --account   the label the model will pass as "account", for example personal or jobs
  --scope     full (default, gmail.modify) or readonly (gmail.readonly)
  --write     update .env in place instead of only printing the lines
`);
  process.exit(0);
}

if (!args.account || !/^[a-z0-9][a-z0-9_-]*$/.test(args.account)) {
  fail(
    'Pass --account <label>, where the label is a short name made of letters, digits, hyphens\n' +
      '    and underscores, for example --account personal. It is the value the model will use to\n' +
      '    pick this mailbox. It is not an email address.',
  );
}

if (args.scope !== 'full' && args.scope !== 'readonly') {
  fail(`--scope must be "full" or "readonly", not ${JSON.stringify(args.scope)}.`);
}

loadDotEnv();

const label = args.account;
const suffix = envSuffix(label);
const scope = args.scope === 'readonly' ? READONLY_SCOPE : MODIFY_SCOPE;

// || here, because .env.example ships GMAIL_CLIENT_ID= empty and ?? would keep that
// empty string over the variable the user did set.
const clientId =
  process.env[`GMAIL_ACCOUNT_${suffix}_CLIENT_ID`]?.trim() ||
  process.env.GMAIL_CLIENT_ID?.trim() ||
  process.env.GOOGLE_CLIENT_ID?.trim();
const clientSecret =
  process.env[`GMAIL_ACCOUNT_${suffix}_CLIENT_SECRET`]?.trim() ||
  process.env.GMAIL_CLIENT_SECRET?.trim() ||
  process.env.GOOGLE_CLIENT_SECRET?.trim();

if (!clientId || !clientSecret) {
  fail(
    'GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET must be set.\n' +
      '    Create an OAuth client (type: Desktop app) in Google Cloud Console, enable the Gmail API\n' +
      '    on the same project, then put the values in .env. See the README for the walkthrough.',
  );
}

const oauth2 = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);

const authUrl = oauth2.generateAuthUrl({
  access_type: 'offline',
  scope: [scope],
  // Google returns a refresh token only on the first consent for a client/user pair.
  // Without this, the second account's run prints "undefined" and looks broken.
  prompt: 'consent',
});

console.log(`\n  gmail-multi-mcp authorization: account "${label}"\n`);
console.log(`  scope: ${scope}`);
console.log('\n  1. Open this URL in your browser:\n');
console.log(`     ${authUrl}\n`);
console.log(`  2. Sign in as the mailbox you want "${label}" to mean, and approve access.\n`);
console.log(`  Waiting for the redirect on ${REDIRECT_URI} ...\n`);

const server = createServer(async (req, res) => {
  if (!req.url?.startsWith('/oauth2callback')) {
    res.writeHead(404).end('Not found');
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const error = url.searchParams.get('error');
  const code = url.searchParams.get('code');

  if (error) {
    res.writeHead(400, { 'Content-Type': 'text/plain' }).end(`Authorization failed: ${error}`);
    server.close();

    if (error === 'access_denied') {
      fail(
        'Google refused the authorization (access_denied).\n\n' +
          '    If you did not click Cancel, this is the OAuth consent configuration rather than\n' +
          '    anything in this code. Both Gmail scopes are "restricted" in Google\'s terms, and a\n' +
          '    restricted scope is blocked unless the app is set up to allow it. Check, in Google\n' +
          '    Auth Platform:\n\n' +
          '      1. Audience -> publishing status is "Testing", not "In production". An unverified\n' +
          '         app in production cannot use restricted scopes at all.\n' +
          '      2. Audience -> Test users lists the exact account you signed in with. Every mailbox\n' +
          '         you want this server to hold has to be listed here.\n' +
          '      3. Branding -> app name, support email, and developer contact are saved.\n\n' +
          '    Changes take a few minutes to propagate.\n',
      );
      return;
    }

    fail(`Authorization was denied: ${error}`);
    return;
  }

  if (!code) {
    res.writeHead(400, { 'Content-Type': 'text/plain' }).end('No authorization code in the callback.');
    return;
  }

  try {
    const { tokens } = await oauth2.getToken(code);

    if (!tokens.refresh_token) {
      res
        .writeHead(200, { 'Content-Type': 'text/plain' })
        .end('Authorized, but Google did not return a refresh token. See the terminal.');
      server.close();
      fail(
        'Google returned no refresh token.\n' +
          '    This happens when the app was already authorized for this account. Revoke it at\n' +
          '    https://myaccount.google.com/permissions and run this again.',
      );
      return;
    }

    oauth2.setCredentials(tokens);
    const gmail = google.gmail({ version: 'v1', auth: oauth2 });
    const profile = await gmail.users.getProfile({ userId: 'me' });
    const address = profile.data.emailAddress;

    if (!address) {
      server.close();
      fail('Gmail returned no address for this token, so the account cannot be identified. Try again.');
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(
      '<!doctype html><meta charset="utf-8">' +
        '<title>Authorized</title>' +
        '<body style="font:16px system-ui;padding:3rem;max-width:34rem">' +
        `<h1 style="font-size:1.25rem">Authorized as ${address}</h1>` +
        `<p>The account label <code>${label}</code> now means this mailbox. ` +
        'The lines to add have been printed in the terminal. You can close this tab.</p>' +
        '</body>',
    );

    const emailKey = `GMAIL_ACCOUNT_${suffix}_EMAIL`;
    const tokenKey = `GMAIL_ACCOUNT_${suffix}_REFRESH_TOKEN`;

    console.log(`  Authorized as ${address}\n`);

    if (args.write) {
      writeEnvLines([
        [emailKey, address],
        [tokenKey, tokens.refresh_token],
      ]);
      ensureAccountListed(label);
      console.log(`  Written to .env:\n`);
      console.log(`  ${emailKey}=${address}`);
      console.log(`  ${tokenKey}=<written>\n`);
      console.log(`  "${label}" is listed in GMAIL_ACCOUNTS.\n`);
    } else {
      console.log('  Add these to your .env (and to your MCP client config):\n');
      console.log(`  ${emailKey}=${address}`);
      console.log(`  ${tokenKey}=${tokens.refresh_token}\n`);
      console.log(`  and make sure GMAIL_ACCOUNTS includes ${label}.\n`);
    }

    console.log('  Treat the refresh token like a password: it grants ongoing access to that mailbox.');
    console.log('  Revoke any time at https://myaccount.google.com/permissions\n');

    server.close();
    process.exit(0);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain' }).end('Token exchange failed. See the terminal.');
    server.close();
    fail(`Token exchange failed: ${err instanceof Error ? err.message : String(err)}`);
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    fail(`Port ${PORT} is already in use. Close whatever is using it and try again.`);
  }
  fail(`Could not start the local callback server: ${err.message}`);
});

server.listen(PORT);

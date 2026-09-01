# gmail-multi-mcp

An [MCP](https://modelcontextprotocol.io) server that holds more than one Gmail account at once. Every tool takes an `account` argument naming a mailbox, and the mapping from label to mailbox is checked against Google before a token is used for anything.

## The problem

A Gmail connector authenticates one Google account. Reaching a second mailbox means disconnecting and reconnecting, or forwarding one account into the other, which merges two inboxes that were kept apart on purpose. Both lose the distinction that decides what happens next: a recruiter's reply in the job-search account is not the same event as the same message in a personal one.

## Tools

Reading: `search_messages`, `search_all_accounts`, `get_thread`, `get_message`, `list_labels`
Drafts: `list_drafts`, `get_draft`, `create_draft`, `update_draft`, `delete_draft`
Organizing: `modify_labels`, `trash_thread`
Sending: `send_draft`, `send_message`, registered only when `GMAIL_ALLOW_SEND=true`
Accounts: `list_accounts`

`search_all_accounts` runs one query against every configured mailbox and groups the results by account. `create_draft` and `send_message` take a `replyToMessageId`, which fills in the thread, the `Re:` subject, the recipient, and the `In-Reply-To` and `References` headers.

## Design

Account is an argument, not a mode. There is no `switch_account` tool and no current account. A model that selects a mailbox once and carries it forward eventually reads one inbox and replies out of the other, and nothing in the transcript records which one it used. Here every call names its mailbox and every result echoes the mailbox it came from.

Labels are verified, not trusted. `GMAIL_ACCOUNT_JOBS_EMAIL` is an assertion about what a refresh token opens. On an account's first use the server calls `users.getProfile` and compares; a mismatch disables that account and names both addresses. The setup error this catches is pasting the second authorize run's token under the first label, which otherwise produces a server that works and reads the wrong inbox.

Sending is off until it is turned on. With `GMAIL_ALLOW_SEND` unset, `send_draft` and `send_message` are not registered, so the tool list a client sees contains no way to put mail on the wire. Drafts still work, and a person sends them from Gmail. Only the exact string `true` enables sending; any other value is refused at startup rather than guessed.

Header injection is refused. Subject, address, and threading values are checked for CR and LF before the message is assembled, and addresses must be bare, so text arriving in an email body cannot add its own `Bcc`.

## Setup

1. Google Cloud Console: create an OAuth client of type Desktop app, and enable the Gmail API on the same project.
2. Google Auth Platform: set publishing status to Testing and list every mailbox under Test users. Both Gmail scopes are restricted in Google's terms, and an unverified app in production cannot request them at all.
3. `cp .env.example .env`, then fill in `GMAIL_CLIENT_ID` and `GMAIL_CLIENT_SECRET`.
4. `npm install && npm run build`
5. `npm run authorize -- --account personal --write`, then again with `--account jobs`. Each run signs in, reads the address back from Gmail, and writes that label's two lines into `.env`.
6. `npm run accounts` prints what each token actually opens.

## Client config

```json
{
  "mcpServers": {
    "gmail-multi": {
      "command": "node",
      "args": ["/absolute/path/to/gmail-multi-mcp/dist/index.js"],
      "env": {
        "GMAIL_CLIENT_ID": "...",
        "GMAIL_CLIENT_SECRET": "...",
        "GMAIL_ACCOUNTS": "personal,jobs",
        "GMAIL_ACCOUNT_PERSONAL_EMAIL": "you@gmail.com",
        "GMAIL_ACCOUNT_PERSONAL_REFRESH_TOKEN": "...",
        "GMAIL_ACCOUNT_JOBS_EMAIL": "you.work@gmail.com",
        "GMAIL_ACCOUNT_JOBS_REFRESH_TOKEN": "..."
      }
    }
  }
}
```

Any number of accounts works. Add the label to `GMAIL_ACCOUNTS` and give it an `_EMAIL` and a `_REFRESH_TOKEN`. An account can carry its own `_CLIENT_ID` and `_CLIENT_SECRET` if its mailbox lives in a different Cloud project.

## Scopes

Full, the default: `gmail.modify`. Read, drafts, send, labels, trash. It cannot permanently delete mail.
Read only: `GMAIL_SCOPE_PROFILE=readonly` requests `gmail.readonly`, and the server registers only the read tools.

## Runtime and testing

38 tests, `npm test`, running in under a second from a clean clone with no network. `npm run verify` launches the server the way an MCP client does and exercises the live API on every configured account: identity, isolation of draft IDs between mailboxes, refusal of a `from` the account does not own, refusal of a newline in a subject. It creates one draft per account, deletes them on the way out including on failure, and never sends.

## Limits

Attachments are listed with their IDs and sizes, not downloaded. Nothing here deletes mail permanently. Send-as aliases cannot be read without the settings scope, so `from` must be the account's own address. There is no push or watch; searches are polled.

## License

MIT.

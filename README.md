# gmail-multi-mcp

An [MCP](https://modelcontextprotocol.io) server that holds several Gmail accounts open at the same time. Reads follow an active mailbox that a `set_active_account` call switches, writes always name their own, every call is logged, and a desktop dialog confirms each send.

## In plain English

gmail-multi-mcp connects an AI assistant to several Gmail accounts at once, each result marked by
the account it came from. A normal Gmail connection reaches one account, so someone with a personal
address and a work address has to disconnect one to reach the other, or merge them and lose track of
which message came where. The design is built around one mistake, mail leaving the wrong mailbox.
Anything that changes a mailbox has to name it, and the call is refused when that is not the account
in use unless the switch is stated. Before an account's credentials are used, the tool asks Google
which address they belong to and compares that with the address in its configuration, so a
credential filed under the wrong name is caught before it reads the wrong inbox. Sending is switched
off until someone turns it on, and while it is off the assistant is given no way to send. Every call
is written to a log the tool can read back, so which account a message went out from has an answer.

## The problem

A Gmail connector authenticates one Google account. Reaching a second mailbox means disconnecting and reconnecting, or forwarding one account into the other, which merges two inboxes that were kept apart on purpose. Both lose the distinction that decides what happens next: a recruiter's reply in the job-search account is not the same event as the same message in a personal one.

Every configured account here is open from the moment the server starts. Nothing needs connecting or switching to reach a mailbox, and `search_all_accounts` queries all of them in parallel.

## Tools

Accounts: `list_accounts`, `set_active_account`, `get_active_account`, `clear_active_account`, `recent_activity`
Reading: `search_messages`, `search_all_accounts`, `get_thread`, `get_message`, `list_labels`
Drafts: `list_drafts`, `get_draft`, `create_draft`, `update_draft`, `delete_draft`
Organizing: `modify_labels`, `trash_thread`
Sending: `send_draft`, `send_message`, registered only when `GMAIL_ALLOW_SEND=true`

`search_all_accounts` runs one query against every mailbox at once and takes `merge` for a single date-ordered list across them, each row tagged with the account it came from. `create_draft` and `send_message` take a `replyToMessageId`, which fills in the thread, the `Re:` subject, the recipient, and the `In-Reply-To` and `References` headers.

## Switching accounts

`set_active_account` sets the mailbox that later reads use when they do not name one. Called with no argument on macOS it raises a picker on the desktop and the user chooses. The selection lapses after `GMAIL_ACTIVE_TTL_MINUTES`, sixty by default, so a choice made this morning cannot steer a call this evening.

Reads may still name a different mailbox, and the result says so in its header. Writes are different. Every write names its own account, never inherits the active one, and is refused outright when the two differ unless the call also passes `confirmAccountSwitch`. The asymmetry is the point: a read of the wrong mailbox is a wasted call, a send from the wrong mailbox is in somebody else's inbox.

## What gets logged

Every call appends a JSON line to `GMAIL_AUDIT_LOG`, `~/.gmail-multi-mcp/audit.jsonl` by default: the tool, the mailbox, whether that was the active one, the outcome, and for drafts and sends the recipients, the subject, and the resulting IDs. `recent_activity` reads it back, so "which account did that go out from" has an answer that does not depend on remembering. Set `GMAIL_AUDIT_LOG=off` to turn it off. A log that cannot be written warns once on stderr and never fails a call.

## Confirming a send

With `GMAIL_ALLOW_SEND=true`, every send raises a native macOS dialog showing the account, the from address, the recipients, the subject, and the first 400 characters of the body. Anything other than a click on Send stops the call, the dialog being dismissed, timing out after two minutes, and failing to appear included. `npm run popup-test` exercises both dialogs without touching Gmail.

MCP elicitation would put this prompt in the chat instead, and Claude Code supports it. Claude Desktop does not, and the server runs on the user's machine either way, so the dialog goes on the desktop. `GMAIL_CONFIRM_POPUP=off` removes it.

## Other design decisions

Labels are verified, not trusted. `GMAIL_ACCOUNT_JOBS_EMAIL` is an assertion about what a refresh token opens. On an account's first use the server calls `users.getProfile` and compares; a mismatch disables that account and names both addresses. The setup error this catches is pasting the second authorize run's token under the first label, which otherwise produces a server that works and reads the wrong inbox.

Sending is off until it is turned on. With `GMAIL_ALLOW_SEND` unset, the send tools are not registered, so the tool list a client sees contains no way to put mail on the wire. Only `true` enables sending, case-insensitively; `false`, `0`, `no` and an empty value mean off, and anything else fails at startup with an error naming the variable.

Header injection is refused. Subject, address, and threading values are checked for CR and LF before the message is assembled, and addresses must be bare, so text arriving in an email body cannot add its own `Bcc`. Dialog text reaches AppleScript through `on run argv`, never string interpolation, for the same reason.

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

Full, the default: `gmail.modify`. Read, drafts, send, labels, trash. It cannot permanently delete a message or a thread; `delete_draft` and `update_draft` are the two calls that destroy mail without a trash step.
Read only: `GMAIL_SCOPE_PROFILE=readonly` requests `gmail.readonly`, and the server registers only the read tools.

## Runtime and testing

73 tests, `npm test`, run from a clean clone with no network and no credentials. CI runs them on Node 18, 20, and 22. `npm run verify` launches the server the way an MCP client does and exercises the live API on every configured account: identity, inheritance of the active mailbox, refusal of a divergent write, the `confirmAccountSwitch` override, isolation of draft IDs between mailboxes, refusal of a `from` the account does not own, refusal of a newline in a subject, and the audit records for all of it. It creates one draft per account, deletes them on the way out including on failure, and never sends.

The two desktop dialogs are the one part not covered by the unit suite, since osascript needs macOS and a logged-in window server. `npm run popup-test` covers them by hand.

## Limits

Attachments are listed with their filenames, types, and sizes, not downloaded. Nothing here permanently deletes a received message; `trash_thread` is reversible; `delete_draft`, `update_draft` and the two send tools cannot be undone. Send-as aliases cannot be read without the settings scope, so `from` must be the account's own address. There is no push or watch; searches are polled. The dialogs are macOS only, and on any other platform a send is refused while `GMAIL_CONFIRM_POPUP` is on.

## License

MIT.

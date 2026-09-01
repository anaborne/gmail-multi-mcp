/**
 * Native macOS dialogs, for the two moments where a person should see what is about to
 * happen: a send, and a change of active mailbox.
 *
 * Claude Desktop does not implement MCP elicitation, so a server cannot raise a prompt
 * inside the chat. It does run on the user's machine, so it can raise one on the desktop.
 *
 * Every value reaches AppleScript through `on run argv` rather than string interpolation.
 * A subject line containing a quote would otherwise end the literal, and a subject line is
 * attacker-supplied whenever the draft is a reply to mail somebody else sent.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Longer than the dialog's own giving-up, so the timeout is the dialog's, not the pipe's. */
const EXEC_TIMEOUT_MS = 140_000;
const DIALOG_TIMEOUT_SECONDS = 120;

export type ConfirmOutcome = 'confirmed' | 'declined' | 'timeout' | 'unavailable';

export function popupsPossible(platform: string = process.platform): boolean {
  return platform === 'darwin';
}

/**
 * Attaching to the frontmost application puts the dialog in front without the accessibility
 * permission that `tell application "System Events"` needs.
 */
const CONFIRM_SCRIPT = [
  'on run argv',
  '  tell application (path to frontmost application as text)',
  '    set r to display dialog (item 1 of argv) with title (item 2 of argv) ' +
    'buttons {"Cancel", item 3 of argv} default button "Cancel" with icon caution ' +
    `giving up after ${DIALOG_TIMEOUT_SECONDS}`,
  '  end tell',
  '  if gave up of r then',
  '    return "TIMEOUT"',
  '  else if button returned of r is (item 3 of argv) then',
  '    return "CONFIRM"',
  '  else',
  '    return "CANCEL"',
  '  end if',
  'end run',
].join('\n');

const CHOOSE_SCRIPT = [
  'on run argv',
  '  set opts to {}',
  '  repeat with i from 2 to count of argv',
  '    set end of opts to item i of argv',
  '  end repeat',
  '  tell application (path to frontmost application as text)',
  '    set r to choose from list opts with title "gmail-multi-mcp" with prompt (item 1 of argv) ' +
    'default items {item 2 of argv}',
  '  end tell',
  '  if r is false then',
  '    return "CANCEL"',
  '  else',
  '    return item 1 of r',
  '  end if',
  'end run',
].join('\n');

async function osascript(script: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  try {
    const { stdout } = await run('osascript', ['-e', script, '--', ...args], {
      timeout: EXEC_TIMEOUT_MS,
    });
    return { ok: true, out: stdout.trim() };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // -128 is AppleScript's "user canceled", raised by a button literally named Cancel.
    if (message.includes('-128') || message.includes('User canceled')) {
      return { ok: true, out: 'CANCEL' };
    }
    return { ok: false, out: message };
  }
}

export interface SendConfirmation {
  accountLabel: string;
  from: string;
  to: string[];
  cc?: string[];
  subject: string;
  preview: string;
}

/**
 * Fail-closed by contract: every path that is not an explicit click on Send returns
 * something other than 'confirmed', and the caller refuses on anything but 'confirmed'.
 */
export async function confirmSend(
  details: SendConfirmation,
  platform: string = process.platform,
): Promise<ConfirmOutcome> {
  if (!popupsPossible(platform)) return 'unavailable';

  const preview = details.preview.length > 400 ? `${details.preview.slice(0, 400)}...` : details.preview;
  const message = [
    'Send this email?',
    '',
    `Account: ${details.accountLabel}`,
    `From: ${details.from}`,
    `To: ${details.to.join(', ') || '(none)'}`,
    ...(details.cc && details.cc.length > 0 ? [`Cc: ${details.cc.join(', ')}`] : []),
    `Subject: ${details.subject || '(none)'}`,
    '',
    preview,
  ].join('\n');

  const result = await osascript(CONFIRM_SCRIPT, [message, 'gmail-multi-mcp', 'Send']);
  if (!result.ok) return 'unavailable';
  if (result.out === 'CONFIRM') return 'confirmed';
  if (result.out === 'TIMEOUT') return 'timeout';
  return 'declined';
}

/** Returns the chosen label, or undefined if the picker was dismissed or is unavailable. */
export async function chooseAccount(
  labels: string[],
  prompt: string,
  platform: string = process.platform,
): Promise<string | undefined> {
  if (!popupsPossible(platform) || labels.length === 0) return undefined;
  const result = await osascript(CHOOSE_SCRIPT, [prompt, ...labels]);
  if (!result.ok || result.out === 'CANCEL' || result.out === '') return undefined;
  return labels.includes(result.out) ? result.out : undefined;
}

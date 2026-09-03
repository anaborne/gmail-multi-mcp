#!/usr/bin/env node
/**
 * Exercises the two desktop dialogs without touching Gmail.
 *
 *   npm run popup-test
 *
 * Worth running once on the machine that will host the server. The dialogs are the only
 * part of this codebase that cannot be covered by the unit suite, because osascript exists
 * only on macOS and only where a user is logged into a window server.
 */

import { chooseAccount, confirmSend, popupsPossible } from '../dist/confirm.js';

if (!popupsPossible()) {
  console.error(`\n  x This platform is ${process.platform}. The dialogs are macOS only.`);
  console.error('    With GMAIL_CONFIRM_POPUP left at its default, sends are refused here.\n');
  process.exit(1);
}

console.log('\n  1/2  A picker should appear. Choose either entry, or dismiss it.\n');
const picked = await chooseAccount(['personal  (you@gmail.com)', 'jobs  (you.work@gmail.com)'], 'Which mailbox?');
console.log(`       result: ${picked ?? 'dismissed'}\n`);

console.log('  2/2  A send confirmation should appear. Click either button, or wait it out.\n');
const outcome = await confirmSend({
  accountLabel: 'jobs',
  from: 'you.work@gmail.com',
  to: ['nobody@example.com'],
  subject: 'gmail-multi-mcp popup test',
  preview: 'Nothing is sent by this script. It only checks that the dialog can be shown.',
});
console.log(`       result: ${outcome}\n`);

if (outcome === 'unavailable') {
  console.error('  The dialog could not be shown. Sends will be refused while that is true.');
  console.error('  Check that osascript runs: osascript -e \'display dialog "hi"\'\n');
  process.exit(1);
}

console.log('  Dialogs work. Sends will be gated by the confirmation.\n');

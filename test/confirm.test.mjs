import test from 'node:test';
import assert from 'node:assert/strict';

import { chooseAccount, confirmSend, popupsPossible } from '../dist/confirm.js';

test('dialogs are macOS only', () => {
  assert.equal(popupsPossible('darwin'), true);
  assert.equal(popupsPossible('linux'), false);
  assert.equal(popupsPossible('win32'), false);
});

test('a send on a platform with no dialog reports unavailable, never confirmed', async () => {
  const outcome = await confirmSend(
    { accountLabel: 'jobs', from: 'a@b.com', to: ['c@d.com'], subject: 's', preview: 'p' },
    'linux',
  );
  assert.equal(outcome, 'unavailable');
  assert.notEqual(outcome, 'confirmed');
});

test('the picker yields nothing off macOS rather than picking for the user', async () => {
  assert.equal(await chooseAccount(['personal', 'jobs'], 'which?', 'linux'), undefined);
  assert.equal(await chooseAccount([], 'which?', 'darwin'), undefined);
});

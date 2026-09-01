import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRawMessage,
  encodeHeaderValue,
  extractBody,
  fromBase64Url,
  headerValue,
  htmlToText,
  toBase64Url,
} from '../dist/mime.js';

function decode(raw) {
  return fromBase64Url(raw);
}

test('builds a message with the headers a client needs', () => {
  const message = decode(
    buildRawMessage({
      from: 'me@gmail.com',
      to: ['you@example.com', 'them@example.com'],
      cc: ['cc@example.com'],
      subject: 'Trading operations',
      text: 'Hello.',
    }),
  );
  assert.match(message, /^From: me@gmail\.com\r\n/);
  assert.match(message, /\r\nTo: you@example\.com, them@example\.com\r\n/);
  assert.match(message, /\r\nCc: cc@example\.com\r\n/);
  assert.match(message, /\r\nSubject: Trading operations\r\n/);
  assert.match(message, /Content-Type: text\/plain; charset="UTF-8"/);
});

test('a non-ASCII subject is RFC 2047 encoded', () => {
  assert.equal(encodeHeaderValue('plain'), 'plain');
  const encoded = encodeHeaderValue('Curaçao');
  assert.match(encoded, /^=\?UTF-8\?B\?/);
  assert.equal(Buffer.from(encoded.slice(10, -2), 'base64').toString('utf8'), 'Curaçao');
});

test('a line break in the subject is refused', () => {
  assert.throws(
    () =>
      buildRawMessage({
        from: 'me@gmail.com',
        to: ['you@example.com'],
        subject: 'hi\r\nBcc: attacker@example.com',
        text: 'x',
      }),
    /contains a line break/,
  );
});

test('a line break in a recipient is refused', () => {
  assert.throws(
    () => buildRawMessage({ from: 'me@gmail.com', to: ['you@example.com\nBcc: x@y.com'], text: 'x' }),
    /contains a line break/,
  );
});

test('a display-name address is refused rather than silently mangled', () => {
  assert.throws(
    () => buildRawMessage({ from: 'me@gmail.com', to: ['Dan <dan@example.com>'], text: 'x' }),
    /not a plain email address/,
  );
});

test('text plus html produces a multipart/alternative with both parts', () => {
  const message = decode(
    buildRawMessage({
      from: 'me@gmail.com',
      to: ['you@example.com'],
      subject: 's',
      text: 'plain version',
      html: '<p>html version</p>',
    }),
  );
  const boundary = /boundary="([^"]+)"/.exec(message)?.[1];
  assert.ok(boundary);
  assert.equal(message.split(`--${boundary}`).length - 1, 3);
  assert.match(message, /Content-Type: text\/plain/);
  assert.match(message, /Content-Type: text\/html/);
  assert.ok(message.includes(Buffer.from('plain version', 'utf8').toString('base64')));
});

test('reply headers are carried so other clients thread it too', () => {
  const message = decode(
    buildRawMessage({
      from: 'me@gmail.com',
      to: ['you@example.com'],
      subject: 'Re: hello',
      text: 'x',
      inReplyTo: '<abc@mail.example.com>',
      references: '<root@mail.example.com> <abc@mail.example.com>',
    }),
  );
  assert.match(message, /\r\nIn-Reply-To: <abc@mail\.example\.com>\r\n/);
  assert.match(message, /\r\nReferences: <root@mail\.example\.com> <abc@mail\.example\.com>\r\n/);
});

test('base64url round trips', () => {
  const value = 'subject with ünïcode and / and +';
  assert.equal(fromBase64Url(toBase64Url(value)), value);
  assert.doesNotMatch(toBase64Url(value), /[+/=]/);
});

test('headerValue is case insensitive, as headers are', () => {
  const headers = [{ name: 'Message-ID', value: '<x@y>' }];
  assert.equal(headerValue(headers, 'message-id'), '<x@y>');
  assert.equal(headerValue(headers, 'Subject'), undefined);
  assert.equal(headerValue(undefined, 'Subject'), undefined);
});

test('extractBody finds text/plain inside a nested tree', () => {
  const payload = {
    mimeType: 'multipart/mixed',
    parts: [
      {
        mimeType: 'multipart/alternative',
        parts: [
          { mimeType: 'text/plain', body: { data: toBase64Url('the plain part') } },
          { mimeType: 'text/html', body: { data: toBase64Url('<p>the html part</p>') } },
        ],
      },
      {
        mimeType: 'application/pdf',
        filename: 'resume.pdf',
        body: { attachmentId: 'att-1', size: 1234 },
      },
    ],
  };
  const { text, attachments } = extractBody(payload);
  assert.equal(text, 'the plain part');
  assert.deepEqual(attachments, [
    { filename: 'resume.pdf', mimeType: 'application/pdf', attachmentId: 'att-1', size: 1234 },
  ]);
});

test('an html-only message is flattened rather than returned empty', () => {
  const payload = {
    mimeType: 'text/html',
    body: { data: toBase64Url('<div>line one</div><div>line two</div>') },
  };
  assert.equal(extractBody(payload).text, 'line one\nline two');
});

test('htmlToText drops script and style and decodes the common entities', () => {
  const html = '<style>p{color:red}</style><script>alert(1)</script><p>Kalshi &amp; Polymarket</p>';
  assert.equal(htmlToText(html), 'Kalshi & Polymarket');
});

test('an empty payload yields an empty body rather than throwing', () => {
  assert.deepEqual(extractBody(undefined), { text: '', attachments: [] });
});

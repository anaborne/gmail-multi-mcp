/**
 * Gmail's send and draft endpoints take a whole RFC 5322 message, base64url encoded. This
 * file builds one from subject/body arguments and extracts readable text back out of the
 * multipart tree Gmail returns.
 *
 * Header values are checked for CR and LF first. A newline inside a subject or an address
 * ends that header and begins another, so text arriving from an email body could otherwise
 * add its own Bcc.
 */

import { randomBytes } from 'node:crypto';
import type { gmail_v1 } from 'googleapis';
import { ToolError } from './errors.js';

export class HeaderInjectionError extends ToolError {
  constructor(field: string) {
    super(
      `The ${field} value contains a line break, so it was refused. A newline inside a header value ` +
        `ends that header and begins another, which would let text that came from an email body add ` +
        `its own recipients. Strip the line breaks and try again.`,
      'HEADER_INJECTION',
    );
  }
}

export class AddressError extends ToolError {
  constructor(field: string, value: string) {
    super(
      `${JSON.stringify(value)} in "${field}" is not a plain email address. Pass bare addresses like ` +
        `name@example.com, one per array entry, without display names or angle brackets.`,
      'BAD_ADDRESS',
    );
  }
}

const ADDRESS_PATTERN = /^[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]+$/;

export function assertNoLineBreaks(field: string, value: string): void {
  if (/[\r\n]/.test(value)) throw new HeaderInjectionError(field);
}

export function assertAddresses(field: string, values: readonly string[]): string[] {
  return values.map((raw) => {
    const value = raw.trim();
    assertNoLineBreaks(field, value);
    if (!ADDRESS_PATTERN.test(value)) throw new AddressError(field, raw);
    return value;
  });
}

/** RFC 2047. A non-ASCII subject sent raw arrives as mojibake in most clients. */
export function encodeHeaderValue(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

export function toBase64Url(value: string | Buffer): string {
  const buf = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(value: string): string {
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

export interface MessageDraft {
  from: string;
  to?: readonly string[];
  cc?: readonly string[];
  bcc?: readonly string[];
  subject?: string;
  text?: string;
  html?: string;
  /** Message-ID header of the message being replied to, so clients thread it. */
  inReplyTo?: string;
  references?: string;
}

/** Bodies are base64 encoded rather than sent as 8bit, so a long line, a lone CR, or a
 * line that begins with "From " cannot corrupt the message. */
function part(contentType: string, body: string): string {
  const encoded = Buffer.from(body, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
  return [
    `Content-Type: ${contentType}; charset="UTF-8"`,
    'Content-Transfer-Encoding: base64',
    '',
    encoded,
  ].join('\r\n');
}

export function buildRawMessage(draft: MessageDraft): string {
  const from = assertAddresses('from', [draft.from])[0]!;
  const to = assertAddresses('to', draft.to ?? []);
  const cc = assertAddresses('cc', draft.cc ?? []);
  const bcc = assertAddresses('bcc', draft.bcc ?? []);

  const subject = draft.subject ?? '';
  assertNoLineBreaks('subject', subject);
  if (draft.inReplyTo) assertNoLineBreaks('inReplyTo', draft.inReplyTo);
  if (draft.references) assertNoLineBreaks('references', draft.references);

  const headers: string[] = [`From: ${from}`];
  if (to.length > 0) headers.push(`To: ${to.join(', ')}`);
  if (cc.length > 0) headers.push(`Cc: ${cc.join(', ')}`);
  if (bcc.length > 0) headers.push(`Bcc: ${bcc.join(', ')}`);
  headers.push(`Subject: ${encodeHeaderValue(subject)}`);
  if (draft.inReplyTo) headers.push(`In-Reply-To: ${draft.inReplyTo}`);
  if (draft.references) headers.push(`References: ${draft.references}`);
  headers.push('MIME-Version: 1.0');

  const text = draft.text;
  const html = draft.html;

  let body: string;
  if (text !== undefined && html !== undefined) {
    const boundary = `==_gmm_${randomBytes(12).toString('hex')}`;
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    body = [
      '',
      `--${boundary}`,
      part('text/plain', text),
      `--${boundary}`,
      part('text/html', html),
      `--${boundary}--`,
      '',
    ].join('\r\n');
  } else if (html !== undefined) {
    headers.push('Content-Type: text/html; charset="UTF-8"');
    headers.push('Content-Transfer-Encoding: base64');
    body = `\r\n${Buffer.from(html, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n')}\r\n`;
  } else {
    headers.push('Content-Type: text/plain; charset="UTF-8"');
    headers.push('Content-Transfer-Encoding: base64');
    body = `\r\n${Buffer.from(text ?? '', 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n')}\r\n`;
  }

  return toBase64Url(`${headers.join('\r\n')}\r\n${body}`);
}

export function headerValue(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
  name: string,
): string | undefined {
  const wanted = name.toLowerCase();
  return headers?.find((h) => h.name?.toLowerCase() === wanted)?.value ?? undefined;
}

/** Crude, and deliberately so: this exists to make an HTML-only email readable to a model,
 * not to render it. Tags out, entities for the handful that matter, whitespace collapsed. */
export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Walks the MIME tree for the first text/plain, falling back to a flattened text/html.
 * Attachments have a filename and no inline body, and are reported separately. */
export function extractBody(payload: gmail_v1.Schema$MessagePart | undefined): {
  text: string;
  attachments: Array<{ filename: string; mimeType: string; attachmentId: string; size: number }>;
} {
  const attachments: Array<{
    filename: string;
    mimeType: string;
    attachmentId: string;
    size: number;
  }> = [];
  let plain: string | undefined;
  let html: string | undefined;

  const walk = (partNode: gmail_v1.Schema$MessagePart | undefined): void => {
    if (!partNode) return;

    const mimeType = partNode.mimeType ?? '';
    const filename = partNode.filename ?? '';
    const data = partNode.body?.data;

    if (filename !== '' && partNode.body?.attachmentId) {
      attachments.push({
        filename,
        mimeType,
        attachmentId: partNode.body.attachmentId,
        size: partNode.body.size ?? 0,
      });
    } else if (data) {
      if (mimeType === 'text/plain' && plain === undefined) plain = fromBase64Url(data);
      else if (mimeType === 'text/html' && html === undefined) html = fromBase64Url(data);
    }

    for (const child of partNode.parts ?? []) walk(child);
  };

  walk(payload);

  const text = plain ?? (html !== undefined ? htmlToText(html) : '');
  return { text, attachments };
}

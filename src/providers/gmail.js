import { google } from 'googleapis';
import { retry } from '../lib/retry.js';
import { log } from '../lib/log.js';

/**
 * Gmail API on the secondary sending domain. Outreach and the digest use the same
 * credentials; only the recipient differs.
 */
export function createGmailClient({
  clientId = process.env.GMAIL_CLIENT_ID,
  clientSecret = process.env.GMAIL_CLIENT_SECRET,
  refreshToken = process.env.GMAIL_REFRESH_TOKEN,
  from = process.env.GMAIL_FROM,
} = {}) {
  const missing = Object.entries({ GMAIL_CLIENT_ID: clientId, GMAIL_CLIENT_SECRET: clientSecret, GMAIL_REFRESH_TOKEN: refreshToken, GMAIL_FROM: from })
    .filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw new Error(`Gmail is not configured: ${missing.join(', ')} not set`);

  const auth = new google.auth.OAuth2(clientId, clientSecret);
  auth.setCredentials({ refresh_token: refreshToken });
  return new GmailSender(google.gmail({ version: 'v1', auth }), from);
}

/** RFC 2047 for anything outside ASCII, so accented names do not arrive as mojibake. */
export function encodeHeader(value) {
  const text = String(value ?? '');
  if (/^[\x20-\x7E]*$/.test(text)) return text;
  return `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`;
}

export function buildRawMessage({ to, from, subject, body, replyTo }) {
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    replyTo ? `Reply-To: ${replyTo}` : null,
    `Subject: ${encodeHeader(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
  ].filter(Boolean);

  const encoded = Buffer.from(String(body ?? ''), 'utf8').toString('base64');
  const mime = `${headers.join('\r\n')}\r\n\r\n${encoded.replace(/(.{76})/g, '$1\r\n')}`;
  return Buffer.from(mime, 'utf8').toString('base64url');
}

export class GmailSender {
  constructor(api, from) {
    this.api = api;
    this.from = from;
  }

  async send({ to, subject, body, replyTo }) {
    if (!to) throw new Error('No recipient');
    const raw = buildRawMessage({ to, from: this.from, subject, body, replyTo });
    const res = await retry(
      () => this.api.users.messages.send({ userId: 'me', requestBody: { raw } }),
      { attempts: 3, baseMs: 1500, label: 'gmail:send' },
    );
    log.info('email sent', { to, message_id: res.data.id });
    return { messageId: res.data.id, threadId: res.data.threadId };
  }
}

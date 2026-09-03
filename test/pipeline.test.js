import { describe, it, expect, vi } from 'vitest';

import { eligibleRows, sendApproved, sendPatches } from '../src/pipeline/send.js';
import { decideChannel, enrichLeads } from '../src/pipeline/enrich.js';
import { sanitize, wordCount } from '../src/pipeline/draft.js';
import { buildDigest, sheetRowLink } from '../src/pipeline/digest.js';
import { interpret } from '../src/providers/debounce.js';
import { guessDomain, getProvider } from '../src/providers/enrichment/index.js';
import { buildRawMessage, encodeHeader } from '../src/providers/gmail.js';
import { columnLetter, coerce, isChecked } from '../src/sheets/client.js';
import { CHANNEL, EMAIL_STATUS, TRACK } from '../src/sheets/schema.js';

const row = (over = {}) => ({
  _row: 2, post_id: 'p1', track: TRACK.APPLICATION, channel: CHANNEL.EMAIL,
  to_email: 'ops@example.com', subject: 'Subject', body: 'Body',
  APPROVE: true, sent_at: '', message_id: '', error: '', ...over,
});

describe('the approval gate', () => {
  it('sends only a row that is approved, email, unsent and addressed', () => {
    const { eligible } = eligibleRows([row()], { maxSends: 10 });
    expect(eligible).toHaveLength(1);
  });

  it('holds an unchecked row', () => {
    const { eligible, skipped } = eligibleRows([row({ APPROVE: false })], { maxSends: 10 });
    expect(eligible).toHaveLength(0);
    expect(skipped.unapproved).toBe(1);
  });

  it('accepts the string TRUE the sheet returns as well as a real boolean', () => {
    expect(eligibleRows([row({ APPROVE: 'TRUE' })], { maxSends: 10 }).eligible).toHaveLength(1);
    expect(eligibleRows([row({ APPROVE: 'FALSE' })], { maxSends: 10 }).eligible).toHaveLength(0);
  });

  it('never resends a row that already has sent_at, even while still checked', () => {
    const { eligible, skipped } = eligibleRows([row({ sent_at: '2026-09-01T00:00:00Z' })], { maxSends: 10 });
    expect(eligible).toHaveLength(0);
    expect(skipped.already_sent).toBe(1);
  });

  it('ignores manual channels', () => {
    const rows = [row({ channel: CHANNEL.MANUAL_DM }), row({ channel: CHANNEL.MANUAL_APPLY })];
    expect(eligibleRows(rows, { maxSends: 10 }).skipped.manual).toBe(2);
  });

  it('does not retry a row carrying an error', () => {
    const { eligible, skipped } = eligibleRows([row({ error: 'mailbox full' })], { maxSends: 10 });
    expect(eligible).toHaveLength(0);
    expect(skipped.errored).toBe(1);
  });

  it('skips an approved row with no recipient', () => {
    expect(eligibleRows([row({ to_email: '' })], { maxSends: 10 }).skipped.no_recipient).toBe(1);
  });

  it('caps at max_sends_per_day and reports the remainder', () => {
    const rows = Array.from({ length: 20 }, (_, i) => row({ _row: i + 2, post_id: `p${i}` }));
    const { eligible, deferred } = eligibleRows(rows, { maxSends: 15 });
    expect(eligible).toHaveLength(15);
    expect(deferred).toBe(5);
  });

  it('sends nothing when maxSends is zero', () => {
    expect(eligibleRows([row()], { maxSends: 0 }).eligible).toHaveLength(0);
  });
});

describe('sendApproved', () => {
  const gmail = () => ({ send: vi.fn().mockResolvedValue({ messageId: 'msg-1' }) });

  it('does everything except send when Config.pause is TRUE', async () => {
    const client = gmail();
    const result = await sendApproved([row()], { gmail: client, config: { pause: true, max_sends_per_day: 10 } });
    expect(client.send).not.toHaveBeenCalled();
    expect(result.paused).toBe(true);
    expect(result.sent).toHaveLength(0);
  });

  it('sends exactly one email per approved row and records the message id', async () => {
    const client = gmail();
    const result = await sendApproved([row()], { gmail: client, config: { pause: false, max_sends_per_day: 10 } });
    expect(client.send).toHaveBeenCalledTimes(1);
    expect(result.sent[0].messageId).toBe('msg-1');

    const [patch] = sendPatches(result);
    expect(patch.row).toBe(2);
    expect(patch.patch.message_id).toBe('msg-1');
    expect(patch.patch.sent_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('records a failure on the row instead of throwing', async () => {
    const client = { send: vi.fn().mockRejectedValue(new Error('550 rejected')) };
    const result = await sendApproved([row()], { gmail: client, config: { pause: false, max_sends_per_day: 10 } });
    expect(result.sent).toHaveLength(0);
    expect(sendPatches(result)[0].patch.error).toContain('550 rejected');
  });

  it('keeps going after one row fails', async () => {
    const client = {
      send: vi.fn()
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce({ messageId: 'msg-2' }),
    };
    const rows = [row({ _row: 2 }), row({ _row: 3, post_id: 'p2' })];
    const result = await sendApproved(rows, { gmail: client, config: { pause: false, max_sends_per_day: 10 } });
    expect(result.sent).toHaveLength(1);
    expect(result.failed).toHaveLength(1);
  });

  it('touches only sent_at, message_id and error, never the checkbox or the body', () => {
    const patches = sendPatches({ sent: [{ row: row(), messageId: 'm', sentAt: 'now' }], failed: [] });
    expect(Object.keys(patches[0].patch).sort()).toEqual(['error', 'message_id', 'sent_at']);
  });
});

describe('channel assignment', () => {
  it('emails a verified address', () => {
    expect(decideChannel({ email: 'a@b.com', emailStatus: EMAIL_STATUS.VERIFIED })).toBe(CHANNEL.EMAIL);
  });

  it('emails a found-but-unverified address', () => {
    expect(decideChannel({ email: 'a@b.com', emailStatus: EMAIL_STATUS.FOUND })).toBe(CHANNEL.EMAIL);
  });

  it('falls back to a DM when there is a profile url but no email', () => {
    expect(decideChannel({ email: null, dmUrl: 'https://linkedin.com/jobs/1' })).toBe(CHANNEL.MANUAL_DM);
  });

  it('falls back to manual apply when there is neither', () => {
    expect(decideChannel({ email: null, dmUrl: null })).toBe(CHANNEL.MANUAL_APPLY);
  });
});

describe('enrichLeads with the stub provider', () => {
  const lead = (over = {}) => ({
    post_id: 'p1', title: 'Ops Manager', company: 'Acme Co',
    dm_url: 'https://indeed.com/viewjob?jk=1', track: TRACK.APPLICATION, ...over,
  });

  it('produces no email, so nothing becomes sendable before a vendor is chosen', async () => {
    const { enriched } = await enrichLeads([lead()], { config: { max_enrichments_per_run: 25 } });
    expect(enriched[0].email).toBeNull();
    expect(enriched[0].email_status).toBe(EMAIL_STATUS.NOT_FOUND);
    expect(enriched[0].channel).toBe(CHANNEL.MANUAL_DM);
  });

  it('sends an Upwork lead with no company or profile straight to manual apply', async () => {
    const { enriched, lookups } = await enrichLeads(
      [lead({ company: null, dm_url: null })], { config: { max_enrichments_per_run: 25 } });
    expect(enriched[0].channel).toBe(CHANNEL.MANUAL_APPLY);
    expect(enriched[0].skipped).toContain('no company');
    expect(lookups).toBe(0);
  });

  it('never re-looks-up a lead that already has an email', async () => {
    const existing = new Map([['p1', {
      email: 'known@acme.com', email_status: EMAIL_STATUS.VERIFIED,
      contact_name: 'Dana', enrichment_provider: 'stub',
    }]]);
    const { enriched, lookups } = await enrichLeads([lead()], { config: { max_enrichments_per_run: 25 }, existingLeads: existing });
    expect(enriched[0].email).toBe('known@acme.com');
    expect(enriched[0].channel).toBe(CHANNEL.EMAIL);
    expect(lookups).toBe(0);
  });

  it('stops looking up once the per-run cap is hit', async () => {
    const leads = Array.from({ length: 5 }, (_, i) => lead({ post_id: `p${i}` }));
    const { enriched, lookups } = await enrichLeads(leads, { config: { max_enrichments_per_run: 2 } });
    expect(lookups).toBe(2);
    expect(enriched.filter((l) => l.skipped?.includes('cap')).length).toBe(3);
  });
});

describe('enrichment provider interface', () => {
  it('defaults to the stub', () => {
    expect(getProvider().name).toBe('stub');
  });

  it('names the fix when an unknown provider is configured', () => {
    expect(() => getProvider('clearbit')).toThrow(/Unknown ENRICHMENT_PROVIDER "clearbit"/);
    expect(() => getProvider('clearbit')).toThrow(/src\/providers\/enrichment\/clearbit\.js/);
  });

  it('guesses a domain from a company name', () => {
    expect(guessDomain('Acme Consulting LLC')).toBe('acme.com');
    expect(guessDomain(null)).toBeNull();
  });
});

describe('debounce interpretation', () => {
  it('treats only Safe as verified and blocks Invalid', () => {
    expect(interpret({ debounce: { result: 'Safe', code: '5' } })).toBe(EMAIL_STATUS.VERIFIED);
    expect(interpret({ debounce: { result: 'Invalid', code: '6' } })).toBe(EMAIL_STATUS.INVALID);
  });

  it('leaves Risky and Unknown at found rather than guessing', () => {
    expect(interpret({ debounce: { result: 'Risky', code: '4' } })).toBe(EMAIL_STATUS.FOUND);
    expect(interpret({})).toBe(EMAIL_STATUS.FOUND);
  });
});

describe('draft sanitizer', () => {
  it('removes em and en dashes, the most reliable machine-written tell', () => {
    const { body } = sanitize({ subject: 'a', body: 'Your funnel works — the routing does not – yet.' });
    expect(body).not.toMatch(/[—–]/);
    expect(body).toBe('Your funnel works, the routing does not, yet.');
  });

  it('straightens curly quotes', () => {
    expect(sanitize({ subject: '', body: '“ops” and ‘systems’' }).body).toBe('"ops" and \'systems\'');
  });

  it('counts words for the length check', () => {
    expect(wordCount('one two three')).toBe(3);
    expect(wordCount('')).toBe(0);
  });
});

describe('gmail message construction', () => {
  it('builds a base64url MIME message carrying the headers', () => {
    const raw = buildRawMessage({ to: 'a@b.com', from: 'me@x.com', subject: 'Hello', body: 'Body text' });
    const decoded = Buffer.from(raw, 'base64url').toString('utf8');
    expect(decoded).toContain('To: a@b.com');
    expect(decoded).toContain('From: me@x.com');
    expect(decoded).toContain('Subject: Hello');
    expect(decoded).toContain('charset="UTF-8"');
    expect(raw).not.toMatch(/[+/=]/);
  });

  it('encodes a non-ascii subject rather than mangling it', () => {
    expect(encodeHeader('Café ops')).toMatch(/^=\?UTF-8\?B\?/);
    expect(encodeHeader('plain ascii')).toBe('plain ascii');
  });
});

describe('digest', () => {
  const base = {
    runId: 'run-1', startedAt: '2026-09-03T13:00:00Z', finishedAt: '2026-09-03T13:12:00Z',
    sourceStats: { upwork: { posts: 12 }, linkedin: { posts: 8 }, indeed: { failed: true } },
    counts: { new_posts: 20, classified: 20, gated: 3, enriched: 2, drafted: 3, sent: 1 },
    costUsd: 1.42, spreadsheetId: 'sheet123', sheetIds: { Posts: 0 },
  };

  it('names a failed source so a silent short day is impossible to miss', () => {
    const { body } = buildDigest(base);
    expect(body).toContain('indeed FAILED');
    expect(body).toContain('upwork 12');
  });

  it('is still worth sending when nothing was found', () => {
    const { body, subject } = buildDigest({ ...base, newLeads: [], sentRows: [] });
    expect(body).toContain('NEW LEADS: none passed the gate today.');
    expect(subject).toContain('0 new');
  });

  it('lists leads with a deep link to the sheet row', () => {
    const { body } = buildDigest({
      ...base,
      newLeads: [{ _row: 7, title: 'Ops Manager', company: 'Acme', url: 'https://x.com/1', source: 'indeed', fit_score: 8.4, comp_type: 'salary', comp_min: 130000, comp_max: 160000, track: 'application' }],
    });
    expect(body).toContain('8.4  Ops Manager');
    expect(body).toContain('salary $130,000-$160,000');
    expect(body).toContain('range=A7');
  });

  it('says so when the cost guard stopped the run', () => {
    expect(buildDigest({ ...base, costGuardTripped: true }).body).toContain('COST GUARD TRIPPED');
  });

  it('says so when sending is paused', () => {
    expect(buildDigest({ ...base, paused: true }).body).toContain('PAUSED');
  });

  it('builds a row link only when it has the ids', () => {
    expect(sheetRowLink('abc', 0, 5)).toContain('gid=0&range=A5');
    expect(sheetRowLink(null, 0, 5)).toBe('');
  });
});

describe('sheet value handling', () => {
  it('maps column indexes past Z', () => {
    expect([0, 25, 26, 51].map(columnLetter)).toEqual(['A', 'Z', 'AA', 'AZ']);
  });

  it('coerces the strings a sheet returns back into types', () => {
    expect(coerce('TRUE')).toBe(true);
    expect(coerce('120000')).toBe(120000);
    expect(coerce('7.5')).toBe(7.5);
    expect(coerce('')).toBe('');
    expect(coerce('sales ops')).toBe('sales ops');
  });

  it('reads a checkbox whether it arrives as a boolean or a string', () => {
    expect([true, 'TRUE', 'true'].every(isChecked)).toBe(true);
    expect([false, 'FALSE', '', null].some(isChecked)).toBe(false);
  });
});

import { CHANNEL } from '../sheets/schema.js';
import { isChecked } from '../sheets/client.js';
import { log } from '../lib/log.js';

/**
 * The approval gate. A row is eligible only when all four hold:
 *   APPROVE is checked, channel is email, sent_at is empty, and there is a recipient.
 *
 * sent_at is what makes this idempotent and what makes unchecking the box after the
 * fact harmless: once a row has a timestamp it is never eligible again, whatever the
 * checkbox says afterwards.
 *
 * A row carrying an error is not retried automatically. It stays visible with the
 * error text so a real failure gets looked at rather than hammered.
 */
export function eligibleRows(outreachRows, { maxSends }) {
  const eligible = [];
  const skipped = { unapproved: 0, already_sent: 0, manual: 0, errored: 0, no_recipient: 0 };

  for (const row of outreachRows) {
    if (String(row.channel) !== CHANNEL.EMAIL) { skipped.manual += 1; continue; }
    if (String(row.sent_at ?? '').trim()) { skipped.already_sent += 1; continue; }
    if (!isChecked(row.APPROVE)) { skipped.unapproved += 1; continue; }
    if (String(row.error ?? '').trim()) { skipped.errored += 1; continue; }
    if (!String(row.to_email ?? '').trim()) { skipped.no_recipient += 1; continue; }
    eligible.push(row);
  }

  const capped = eligible.slice(0, Math.max(0, Number(maxSends) || 0));
  return { eligible: capped, deferred: eligible.length - capped.length, skipped };
}

export async function sendApproved(outreachRows, { gmail, config, dryRun = false }) {
  // Off by default. Automated sending needs a Workspace seat on a secondary domain,
  // and at this volume it buys little over copying a draft you already approved.
  // The path stays intact so turning it on later is one Config value, not a rebuild.
  if (config?.sending_enabled !== true) {
    const ready = outreachRows.filter(
      (r) => String(r.channel) === CHANNEL.EMAIL && !String(r.sent_at ?? '').trim() && String(r.to_email ?? '').trim());
    log.info('sending disabled', { rows_with_addresses: ready.length });
    return {
      sent: [], failed: [], deferred: 0, paused: false, disabled: true,
      readyToCopy: ready.length, skipped: null,
    };
  }

  if (config?.pause === true) {
    log.warn('sending paused by Config.pause');
    return { sent: [], failed: [], deferred: 0, paused: true, disabled: false, skipped: null };
  }

  const { eligible, deferred, skipped } = eligibleRows(outreachRows, { maxSends: config?.max_sends_per_day ?? 0 });
  const sent = [];
  const failed = [];

  for (const row of eligible) {
    if (dryRun) {
      sent.push({ row, messageId: 'dry-run', sentAt: new Date().toISOString() });
      continue;
    }
    try {
      const { messageId } = await gmail.send({
        to: String(row.to_email).trim(),
        subject: String(row.subject ?? ''),
        body: String(row.body ?? ''),
      });
      sent.push({ row, messageId, sentAt: new Date().toISOString() });
    } catch (error) {
      failed.push({ row, message: error.message });
      log.error('send failed', { post_id: row.post_id, to: row.to_email, error: error.message });
    }
  }

  log.info('send complete', { eligible: eligible.length, sent: sent.length, failed: failed.length, deferred });
  return { sent, failed, deferred, paused: false, disabled: false, skipped };
}

/** Cell patches recording the outcome. Only these three columns are ever touched. */
export function sendPatches({ sent, failed }) {
  return [
    ...sent.map(({ row, messageId, sentAt }) => ({
      row: row._row,
      patch: { sent_at: sentAt, message_id: messageId, error: '' },
    })),
    ...failed.map(({ row, message }) => ({
      row: row._row,
      patch: { error: message.slice(0, 2000) },
    })),
  ];
}

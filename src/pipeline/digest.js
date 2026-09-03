import { log } from '../lib/log.js';

/**
 * Plain text, no tables. Sent on every run including empty ones, so silence in the
 * inbox means the job did not run rather than the job found nothing.
 */

export function sheetRowLink(spreadsheetId, sheetId, row) {
  if (!spreadsheetId || sheetId === undefined || sheetId === null) return '';
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit#gid=${sheetId}&range=A${row}`;
}

const money = (post) => {
  if (!post.comp_type || post.comp_type === 'unknown') return 'comp not stated';
  const fmt = (n) => (n === null || n === undefined || n === '' ? '?' : `$${Number(n).toLocaleString('en-US')}`);
  const range = post.comp_min === post.comp_max ? fmt(post.comp_max) : `${fmt(post.comp_min)}-${fmt(post.comp_max)}`;
  return `${post.comp_type} ${range}`;
};

export function buildDigest({
  runId,
  startedAt,
  finishedAt,
  sourceStats = {},
  newLeads = [],
  awaitingApproval = [],
  sentRows = [],
  failedSends = [],
  counts = {},
  costUsd = 0,
  costGuardTripped = false,
  paused = false,
  errors = [],
  warnings = [],
  spreadsheetId,
  sheetIds = {},
}) {
  const lines = [];
  const minutes = startedAt && finishedAt
    ? ((Date.parse(finishedAt) - Date.parse(startedAt)) / 60000).toFixed(1)
    : '?';

  lines.push(`Opportunity Finder run ${runId}`);
  lines.push(`${startedAt} to ${finishedAt} (${minutes} min)`);
  lines.push('');

  const sourceLine = Object.entries(sourceStats)
    .map(([name, s]) => `${name} ${s.failed ? 'FAILED' : s.posts}`)
    .join(', ');
  lines.push(`SOURCES: ${sourceLine || 'none ran'}`);
  lines.push(
    `PIPELINE: ${counts.new_posts ?? 0} new posts, ${counts.classified ?? 0} classified, ` +
    `${counts.gated ?? 0} passed the gate, ${counts.enriched ?? 0} enriched, ${counts.drafted ?? 0} drafted, ` +
    `${counts.sent ?? 0} sent`);
  lines.push(`COST: $${Number(costUsd).toFixed(2)} estimated`);
  if (costGuardTripped) lines.push('COST GUARD TRIPPED: the run stopped before enrichment. Nothing was enriched, drafted or sent.');
  if (paused) lines.push('PAUSED: Config.pause is TRUE. Everything ran except sending.');
  lines.push('');

  if (newLeads.length) {
    lines.push(`NEW LEADS (${newLeads.length})`);
    for (const lead of newLeads) {
      lines.push(`  ${lead.fit_score}  ${lead.title}`);
      lines.push(`     ${lead.company ?? 'company not stated'} | ${money(lead)} | ${lead.track} | ${lead.source}`);
      lines.push(`     ${lead.url}`);
      const link = sheetRowLink(spreadsheetId, sheetIds.Posts, lead._row);
      if (link) lines.push(`     ${link}`);
    }
  } else {
    lines.push('NEW LEADS: none passed the gate today.');
  }
  lines.push('');

  if (sentRows.length) {
    lines.push(`SENT (${sentRows.length})`);
    for (const s of sentRows) lines.push(`  ${s.to_email} | ${s.subject}`);
  } else {
    lines.push('SENT: nothing. Either no row was approved or sending is paused.');
  }
  lines.push('');

  lines.push(`AWAITING APPROVAL: ${awaitingApproval.length}`);
  for (const row of awaitingApproval.slice(0, 25)) {
    lines.push(`  ${row.channel} | ${row.title ?? row.post_id} | ${row.to_email || 'no email'}`);
  }
  if (awaitingApproval.length > 25) lines.push(`  ...and ${awaitingApproval.length - 25} more`);
  lines.push('');

  if (failedSends.length) {
    lines.push(`SEND FAILURES (${failedSends.length}). These are not retried automatically.`);
    for (const f of failedSends) lines.push(`  ${f.to_email}: ${f.message}`);
    lines.push('');
  }

  if (warnings.length) {
    lines.push(`WARNINGS (${warnings.length})`);
    for (const w of warnings) lines.push(`  ${w}`);
    lines.push('');
  }

  if (errors.length) {
    lines.push(`ERRORS (${errors.length})`);
    for (const e of errors) lines.push(`  ${e}`);
    lines.push('');
  }

  if (spreadsheetId) lines.push(`Sheet: https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`);

  return {
    subject: `Opportunity Finder: ${newLeads.length} new, ${awaitingApproval.length} awaiting, ${counts.sent ?? 0} sent`,
    body: lines.join('\n'),
  };
}

export async function sendDigest(gmail, digest, { to = process.env.DIGEST_TO } = {}) {
  if (!to) {
    log.warn('DIGEST_TO is not set; digest written to stdout instead');
    process.stdout.write(`\n${digest.subject}\n\n${digest.body}\n`);
    return { messageId: null, skipped: 'DIGEST_TO not set' };
  }
  return gmail.send({ to, subject: digest.subject, body: digest.body });
}

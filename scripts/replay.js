#!/usr/bin/env node
import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createSheetsClient } from '../src/sheets/client.js';
import { STATUS } from '../src/sheets/schema.js';
import { createAnthropic, CostMeter } from '../src/providers/anthropic.js';
import { classifyAll } from '../src/pipeline/classify.js';
import { scorePost } from '../src/pipeline/score.js';
import { log } from '../src/lib/log.js';

/**
 * Re-classifies Posts rows against the current config/profile.md and scoring floors
 * without re-scraping anything. This is the loop for tuning the rubric.
 *
 * It writes to the Posts tab only. Leads and Outreach are never created, modified or
 * deleted here, so nothing that has already been drafted or sent is disturbed. Rows
 * whose outreach has already gone out are re-scored and reported, because seeing
 * that the tuned rubric would now reject them is the point of a replay.
 *
 *   npm run replay                      re-classify every scored row
 *   npm run replay -- --status rejected only the rejected ones
 *   npm run replay -- --limit 25        cap the spend while iterating
 *   npm run replay -- --dry-run         score and report, write nothing
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (argv[i + 1] ?? true);
};
const dryRun = argv.includes('--dry-run');
const statusFilter = flag('status');
const limit = Number(flag('limit', Infinity));

const [profile, scoring] = await Promise.all([
  readFile(join(ROOT, 'config/profile.md'), 'utf8'),
  readFile(join(ROOT, 'config/scoring.json'), 'utf8').then(JSON.parse),
]);

const store = await createSheetsClient();
const config = await store.loadConfig(scoring);
const [posts, rawTab, outreach] = await Promise.all([
  store.loadKeyed('Posts'),
  store.loadKeyed('PostsRaw'),
  store.loadKeyed('Outreach'),
]);

const descriptions = new Map(rawTab.rows.map((r) => [String(r.post_id), String(r.description ?? '')]));
const sentPostIds = new Set(
  outreach.rows.filter((r) => String(r.sent_at ?? '').trim()).map((r) => String(r.post_id)));

const candidates = posts.rows
  .filter((r) => String(r.status) !== STATUS.DUPLICATE)
  .filter((r) => !statusFilter || String(r.status) === statusFilter)
  .filter((r) => descriptions.has(String(r.post_id)))
  .slice(0, limit);

const missingText = posts.rows.filter((r) => !descriptions.has(String(r.post_id)) && String(r.status) !== STATUS.DUPLICATE);
if (missingText.length) {
  log.warn('rows skipped: no stored description', {
    count: missingText.length,
    note: 'These predate the PostsRaw tab and cannot be replayed without re-scraping.',
  });
}

if (!candidates.length) {
  process.stdout.write('Nothing to replay.\n');
  process.exit(0);
}

log.info('replaying', { rows: candidates.length, dry_run: dryRun, status_filter: statusFilter ?? 'any' });

const queue = candidates.map((row) => ({
  _row: row._row,
  post_id: String(row.post_id),
  source: String(row.source),
  url: String(row.url),
  title: String(row.title),
  company: row.company || null,
  location: null,
  remote: null,
  posted_at: row.posted_at || null,
  comp_type: String(row.comp_type || 'unknown'),
  comp_min: numberOrNull(row.comp_min),
  comp_max: numberOrNull(row.comp_max),
  est_hours: numberOrNull(row.est_hours),
  description: descriptions.get(String(row.post_id)) ?? '',
  _previousStatus: String(row.status ?? ''),
  _previousScore: row.fit_score,
}));

const meter = new CostMeter();
const anthropic = createAnthropic();
const { results, failures } = await classifyAll(anthropic, queue, profile, { concurrency: 5, meter });

const updates = [];
const changes = [];
const replayId = `replay-${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}`;

for (const post of queue) {
  const classification = results.get(post.post_id);
  if (!classification) continue;
  const verdict = scorePost(post, classification, config);

  if (verdict.status !== post._previousStatus || Number(verdict.fit_score) !== Number(post._previousScore)) {
    changes.push({
      title: post.title,
      from: `${post._previousStatus} ${post._previousScore}`,
      to: `${verdict.status} ${verdict.fit_score}`,
      already_sent: sentPostIds.has(post.post_id),
    });
  }

  updates.push({
    row: post._row,
    patch: {
      signal_type: classification.signal_type,
      fit_score: verdict.fit_score,
      fit_reasons: verdict.reasons.join(' | ').slice(0, 4000),
      hard_out_reason: verdict.hard_out_reason || '',
      niche: classification.niche ?? '',
      tools_mentioned: (classification.tools_mentioned ?? []).join('; '),
      status: verdict.status,
      last_classified_run: replayId,
      comp_flags: verdict.comp_flags.join('; '),
    },
  });
}

if (!dryRun && updates.length) await store.update('Posts', updates);

process.stdout.write(`\nReplayed ${updates.length} rows${dryRun ? ' (dry run, nothing written)' : ''}.\n`);
process.stdout.write(`Cost: $${meter.total.toFixed(2)}. Failures: ${failures.length}.\n\n`);

if (!changes.length) {
  process.stdout.write('No verdicts changed.\n');
} else {
  process.stdout.write(`${changes.length} verdicts changed:\n`);
  for (const c of changes) {
    process.stdout.write(`  ${c.from} -> ${c.to}  ${c.title}${c.already_sent ? '   [outreach already sent]' : ''}\n`);
  }
  const sentAndFlipped = changes.filter((c) => c.already_sent).length;
  if (sentAndFlipped) {
    process.stdout.write(
      `\n${sentAndFlipped} of these already had outreach sent. Their Leads and Outreach rows were left alone.\n`);
  }
}

for (const f of failures) process.stderr.write(`classify failed: ${f.post_id} ${f.message}\n`);

function numberOrNull(value) {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

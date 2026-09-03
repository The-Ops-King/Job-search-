import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createSheetsClient, LockHeldError } from './sheets/client.js';
import { STATUS, EMAIL_STATUS, CHANNEL } from './sheets/schema.js';
import { createApifyClient } from './lib/apify.js';
import { CostMeter } from './providers/anthropic.js';
import { getLlm } from './providers/llm/index.js';
import { createGmailClient } from './providers/gmail.js';
import { runId as makeRunId } from './lib/hash.js';
import { RunBudget, dayIndex } from './lib/budget.js';
import { log, ErrorCollector } from './lib/log.js';

import * as upwork from './sources/upwork.js';
import * as linkedin from './sources/linkedin.js';
import * as indeed from './sources/indeed.js';

import { dedupe, crossPostAnnotations, duplicateRows } from './pipeline/dedupe.js';
import { classifyAll } from './pipeline/classify.js';
import { prefilter, prefilterPatches } from './pipeline/prefilter.js';
import { scorePost } from './pipeline/score.js';
import { enrichLeads } from './pipeline/enrich.js';
import { draftAll } from './pipeline/draft.js';
import { sendApproved, sendPatches } from './pipeline/send.js';
import { buildDigest, sendDigest } from './pipeline/digest.js';
import { summarizeSpend } from './pipeline/spend.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCES = { upwork, linkedin, indeed };

const REQUIRED_ENV = ['APIFY_TOKEN', 'GOOGLE_SERVICE_ACCOUNT_JSON', 'SHEET_ID'];

/**
 * Checked before anything is written. A missing key found halfway through leaves
 * posts in the sheet and no Runs row explaining why the run stopped.
 *
 * Which model credential is required depends on the backend: the subscription route
 * needs a Claude Code token, the API route needs an API key.
 */
export function preflight(env = process.env) {
  const backend = env.LLM_BACKEND || 'claude_code';
  const modelKey = backend === 'api' ? 'ANTHROPIC_API_KEY' : 'CLAUDE_CODE_OAUTH_TOKEN';
  const missing = [...REQUIRED_ENV, modelKey].filter((key) => !env[key]);
  if (missing.length) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(', ')}. ` +
      `See .env.example. Nothing was run.`);
  }
  const optional = ['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN', 'GMAIL_FROM']
    .filter((key) => !env[key]);
  return { backend, gmailConfigured: optional.length === 0, missingOptional: optional };
}

export async function loadConfigFiles(root = ROOT) {
  const [profile, queries, actors, scoring] = await Promise.all([
    readFile(join(root, 'config/profile.md'), 'utf8'),
    readFile(join(root, 'config/queries.json'), 'utf8').then(JSON.parse),
    readFile(join(root, 'config/actors.json'), 'utf8').then(JSON.parse),
    readFile(join(root, 'config/scoring.json'), 'utf8').then(JSON.parse),
  ]);
  return { profile, queries, actors, scoring };
}

/**
 * Runs the pipeline end to end.
 *
 * Every stage reads its inputs from the sheet and writes its outputs back before the
 * next one starts, so a crash halfway leaves the sheet consistent and the next run
 * resumes from it. Nothing important lives only in memory.
 */
export async function run({ dryRun = false, skipSend = false, root = ROOT } = {}) {
  const runIdValue = makeRunId();
  const startedAt = new Date().toISOString();
  const errors = new ErrorCollector();
  const warnings = [];
  const meter = new CostMeter(backend);
  const counts = { new_posts: 0, prefiltered: 0, classified: 0, gated: 0, enriched: 0, drafted: 0, sent: 0 };
  const sourceStats = {};

  const { backend, gmailConfigured, missingOptional } = preflight();
  if (!gmailConfigured) {
    warnings.push(
      `Gmail is not configured (${missingOptional.join(', ')} not set). Nothing will be sent ` +
      `and the digest will be written to stdout instead of emailed.`);
  }

  const files = await loadConfigFiles(root);
  const store = await createSheetsClient();
  const config = await store.loadConfig(files.scoring);

  let release = async () => {};
  try {
    release = await store.acquireLock(runIdValue);
  } catch (error) {
    if (error instanceof LockHeldError) {
      log.warn('run skipped', { reason: error.message });
      return { skipped: true, reason: error.message, runId: runIdValue };
    }
    throw error;
  }

  let costGuardTripped = false;
  let paused = false;

  // Hoisted so the report below still has something to say when a stage throws.
  let sendResult = { sent: [], failed: [], deferred: 0, paused: false };
  let gmail = null;
  let currentOutreach = { rows: [] };
  let newLeadCandidates = [];
  let enrichedLeads = [];
  let fatal = null;
  let collectedRaw = 0;
  let budget = null;

  try {
    try {
      const [posts, leads, outreach, rawTab] = await Promise.all([
        store.loadKeyed('Posts'),
        store.loadKeyed('Leads'),
        store.loadKeyed('Outreach'),
        store.loadKeyed('PostsRaw'),
      ]);

      const firstRun = posts.rows.length === 0;
      const lookbackDays = firstRun
        ? Number(config.first_run_lookback_days ?? 14)
        : Number(config.lookback_days ?? 2);
      log.info('run started', { run_id: runIdValue, first_run: firstRun, lookback_days: lookbackDays });

      // --- ingest ---------------------------------------------------------
      const apify = createApifyClient();
      const collected = [];

      // A hard ceiling checked before every query. Apify bills per result, so a cap
      // applied after ingest is a cap applied after paying.
      budget = new RunBudget({
        capUsd: Number(config.max_apify_cost_per_run ?? 0.6),
        assumedCostPer1k: Number(config.assumed_cost_per_1k_results ?? 3.0),
        maxItemsPerQuery: Number(config.max_items_per_query ?? 20),
      });
      const rotation = dayIndex();
      log.info('apify budget', { cap_usd: budget.capUsd, rotation });

      for (const [name, source] of Object.entries(SOURCES)) {
        const actorConfig = files.actors[name];
        try {
          if (!actorConfig?.actorId) throw new Error(`config/actors.json has no actorId for ${name}`);
          const result = await source.fetch({
            client: apify,
            actorConfig,
            queryConfig: files.queries,
            options: {
              maxItems: Number(config.max_items_per_query ?? 20),
              lookbackDays,
              timeoutSecs: Number(config.actor_timeout_secs ?? 300),
            },
            budget,
            rotation,
          });
          collected.push(...result.posts);
          warnings.push(...result.warnings);
          meter.addExternal(`apify:${name}`, result.meta.costUsd);
          sourceStats[name] = { posts: result.posts.length, failed: false, ...result.meta };
          log.info('source complete', { source: name, posts: result.posts.length, actor: result.meta.actorId });
        } catch (error) {
          // One dead actor never stops the run.
          sourceStats[name] = { posts: 0, failed: true, error: error.message };
          errors.add(`source:${name}`, error, { actor: actorConfig?.actorId ?? 'unset' });
        }
      }

      // --- dedupe ---------------------------------------------------------
      const { fresh, exactDuplicates, nearDuplicates } = dedupe(collected, posts.rows, {
        nearDupeSources: config.near_dupe_sources ?? files.scoring.near_dupe_sources,
      });
      counts.new_posts = fresh.length;
      collectedRaw = collected.length;
      log.info('dedupe complete', {
        collected: collected.length, fresh: fresh.length,
        exact_duplicates: exactDuplicates.length, cross_posts: nearDuplicates.length,
      });

      if (fresh.length) {
        await store.append('Posts', fresh.map((p) => toPostRow(p, runIdValue)));
        await store.append('PostsRaw', fresh.map((p) => ({
          post_id: p.post_id, description: p.description, raw: p.raw, captured_at: startedAt,
        })));
      }
      if (nearDuplicates.length) {
        await store.append('Posts', duplicateRows(nearDuplicates, runIdValue));
        const annotations = crossPostAnnotations(nearDuplicates, posts.rows);
        if (annotations.length) await store.update('Posts', annotations);
      }

      // --- classify -------------------------------------------------------
      // Newly written rows plus anything still pending from a prior run, so a post that
      // failed classification yesterday gets picked up today.
      const reloaded = fresh.length || nearDuplicates.length ? await store.loadKeyed('Posts') : posts;
      const pendingRows = reloaded.rows.filter((r) => String(r.status ?? '') === STATUS.PENDING || String(r.status ?? '') === '');
      const descriptions = new Map(rawTab.rows.map((r) => [String(r.post_id), String(r.description ?? '')]));
      for (const p of fresh) descriptions.set(p.post_id, p.description);

      const queue = pendingRows.map((row) => ({
        _row: row._row,
        post_id: String(row.post_id),
        source: String(row.source),
        url: String(row.url),
        title: String(row.title),
        company: row.company || null,
        location: row.location || null,
        remote: null,
        posted_at: row.posted_at || null,
        comp_type: String(row.comp_type || 'unknown'),
        comp_min: numberOrNull(row.comp_min),
        comp_max: numberOrNull(row.comp_max),
        est_hours: numberOrNull(row.est_hours),
        description: descriptions.get(String(row.post_id)) ?? '',
      }));

      // Reject on money and on obviously-unrelated titles before spending a call.
      // The compensation half of this is the same function scorePost uses, so a post
      // dropped here gets the identical verdict it would have got afterwards.
      // Config.prefilter_enabled = FALSE sends everything to the model. Useful for
      // proving the pre-filter is not the reason a lead went missing.
      const { keep: toClassify, rejected: prefiltered } = config.prefilter_enabled === false
        ? { keep: queue, rejected: [] }
        : prefilter(queue, config);
      counts.prefiltered = prefiltered.length;
      if (prefiltered.length) {
        await store.update('Posts', prefilterPatches(prefiltered, runIdValue));
        warnings.push(
          `Pre-filter rejected ${prefiltered.length} of ${queue.length} posts before ` +
          `classification, saving that many model calls.`);
      }

      const llm = getLlm(backend);
      const { results: classifications, failures: classifyFailures, deferred: classifyDeferred, rateLimited } =
        await classifyAll(llm, toClassify, files.profile, { meter });
      counts.classified = classifications.size;
      for (const f of classifyFailures) errors.add('classify', new Error(f.message), { post_id: f.post_id });

      if (rateLimited) {
        warnings.push(
          `Claude usage limit reached during classification. ${classifyDeferred.length} posts ` +
          `were left unclassified; they stay pending and are picked up on the next run. ` +
          `Nothing was lost.`);
      }

      // --- score ----------------------------------------------------------
      const postUpdates = [];

      for (const post of toClassify) {
        const classification = classifications.get(post.post_id);
        if (!classification) continue; // stays pending, retried next run

        const verdict = scorePost(post, classification, config);
        postUpdates.push({
          row: post._row,
          patch: {
            signal_type: classification.signal_type,
            fit_score: verdict.fit_score,
            fit_reasons: verdict.reasons.join(' | ').slice(0, 4000),
            hard_out_reason: verdict.hard_out_reason || '',
            niche: classification.niche ?? '',
            tools_mentioned: (classification.tools_mentioned ?? []).join('; '),
            status: verdict.status,
            last_classified_run: runIdValue,
            comp_flags: verdict.comp_flags.join('; '),
          },
        });

        if (verdict.status === STATUS.LEAD) {
          newLeadCandidates.push({ post, classification, verdict });
        }
      }
      if (postUpdates.length) await store.update('Posts', postUpdates);
      counts.gated = newLeadCandidates.length;

      // --- cost guard -----------------------------------------------------
      const maxDailyCost = Number(config.max_daily_cost ?? 12);
      if (meter.total > maxDailyCost) {
        costGuardTripped = true;
        const unit = backend === 'claude_code' ? 'quota-equivalent' : 'spent';
        warnings.push(
          `Cost guard: $${meter.total.toFixed(2)} ${unit} this run exceeds max_daily_cost of ` +
          `$${maxDailyCost.toFixed(2)}. Stopped before enrichment. Posts and scores were written; ` +
          `nothing was enriched, drafted or sent.`);
        log.warn('cost guard tripped', { spent: meter.total, cap: maxDailyCost, backend });
      }

      // --- enrich ---------------------------------------------------------
      if (!costGuardTripped) {
        const toEnrich = newLeadCandidates
          .filter(({ post }) => !leads.byKey.has(post.post_id))
          .map(({ post, classification, verdict }) => ({
            post_id: post.post_id,
            title: post.title,
            company: post.company,
            contact_name: null,
            contact_role: null,
            company_domain: null,
            email: null,
            dm_url: post.source === 'upwork' ? null : post.url,
            track: verdict.track,
            created_run: runIdValue,
            _post: post,
            _classification: classification,
          }));

        const enrichment = await enrichLeads(toEnrich, { config, meter, existingLeads: leads.byKey });
        enrichedLeads = enrichment.enriched;
        counts.enriched = enrichment.lookups;
        for (const f of enrichment.failures) errors.add('enrich', new Error(f.message), { post_id: f.post_id });

        if (enrichedLeads.length) {
          await store.append('Leads', enrichedLeads.map((l) => ({
            post_id: l.post_id,
            title: l.title,
            company: l.company ?? '',
            contact_name: l.contact_name ?? '',
            contact_role: l.contact_role ?? '',
            company_domain: l.company_domain ?? '',
            email: l.email ?? '',
            email_status: l.email_status ?? EMAIL_STATUS.NOT_FOUND,
            enrichment_provider: l.enrichment_provider ?? '',
            enrichment_cost: l.enrichment_cost ?? 0,
            dm_url: l.dm_url ?? '',
            track: l.track,
            created_run: runIdValue,
          })));
        }
      }

      // --- draft ----------------------------------------------------------
      if (!costGuardTripped) {
        const needDrafts = enrichedLeads
          .filter((l) => !outreach.byKey.has(l.post_id))
          .map((l) => ({
            post: {
              ...l._post,
              niche: l._classification?.niche,
              tools_mentioned: (l._classification?.tools_mentioned ?? []).join(', '),
            },
            lead: l,
            track: l.track,
            channel: l.channel ?? CHANNEL.MANUAL_APPLY,
          }));

        const { drafts, failures: draftFailures, rateLimited: draftLimited } =
          await draftAll(llm, needDrafts, files.profile, { meter });
        counts.drafted = drafts.size;
        for (const f of draftFailures) errors.add('draft', new Error(f.message), { post_id: f.post_id });
        if (draftLimited) {
          warnings.push(
            'Claude usage limit reached during drafting. Leads without a draft get one ' +
            'on the next run; their Leads rows are already written.');
        }

        const outreachRows = needDrafts
          .filter((item) => drafts.has(item.post.post_id))
          .map((item) => {
            const draft = drafts.get(item.post.post_id);
            return {
              post_id: item.post.post_id,
              track: item.track,
              channel: item.channel,
              to_email: item.channel === CHANNEL.EMAIL ? (item.lead.email ?? '') : '',
              subject: draft.subject,
              body: draft.body,
              APPROVE: false,
              sent_at: '',
              message_id: '',
              error: '',
            };
          });
        if (outreachRows.length) await store.append('Outreach', outreachRows);
      }

      // --- send -----------------------------------------------------------
      try {
        gmail = createGmailClient();
      } catch (error) {
        errors.add('gmail', error);
      }

      currentOutreach = await store.loadKeyed('Outreach');
      if (gmail && !skipSend && !costGuardTripped) {
        sendResult = await sendApproved(currentOutreach.rows, { gmail, config, dryRun });
        paused = sendResult.paused;
        counts.sent = sendResult.sent.length;
        const patches = sendPatches(sendResult);
        if (patches.length) await store.update('Outreach', patches);
        for (const f of sendResult.failed) errors.add('send', new Error(f.message), { post_id: f.row.post_id });
      } else if (costGuardTripped) {
        warnings.push('Sending skipped because the cost guard tripped.');
      } else if (skipSend) {
        warnings.push('Sending skipped: --skip-send was passed.');
      }

    } catch (error) {
      // A stage blew up. The remaining stages are skipped, but the Runs row and the
      // digest still go out: they are the only signal that the job ran at all, and
      // silence is supposed to mean the job did not run.
      fatal = error;
      errors.add('fatal', error);
    }

    // --- report ---------------------------------------------------------
    const finishedAt = new Date().toISOString();
    const finalPosts = await store.loadKeyed('Posts').catch(() => ({ rows: [] }));
    const leadPostIds = new Set(newLeadCandidates.map(({ post }) => post.post_id));

    const digestLeads = finalPosts.rows
      .filter((r) => leadPostIds.has(String(r.post_id)))
      .map((r) => ({
        _row: r._row,
        title: r.title,
        company: r.company || null,
        url: r.url,
        source: r.source,
        fit_score: r.fit_score,
        comp_type: r.comp_type,
        comp_min: r.comp_min,
        comp_max: r.comp_max,
        track: enrichedLeads.find((l) => l.post_id === String(r.post_id))?.track ?? '',
      }))
      .sort((a, b) => Number(b.fit_score) - Number(a.fit_score));

    const titles = new Map(finalPosts.rows.map((r) => [String(r.post_id), r.title]));
    const awaiting = currentOutreach.rows
      .filter((r) => !String(r.sent_at ?? '').trim())
      .map((r) => ({ ...r, title: titles.get(String(r.post_id)) }));

    await store.append('Runs', [{
      run_id: runIdValue,
      started_at: startedAt,
      finished_at: finishedAt,
      upwork_count: sourceStats.upwork?.posts ?? 0,
      linkedin_count: sourceStats.linkedin?.posts ?? 0,
      indeed_count: sourceStats.indeed?.posts ?? 0,
      classified: counts.classified,
      gated: counts.gated,
      enriched: counts.enriched,
      drafted: counts.drafted,
      sent: counts.sent,
      api_cost_estimate: meter.total,
      errors: [...errors.toLines(), ...warnings].join('\n').slice(0, 45000),
    }]).catch((error) => errors.add('runs-row', error));

    const digest = buildDigest({
      runId: runIdValue,
      startedAt,
      finishedAt,
      sourceStats,
      newLeads: digestLeads,
      awaitingApproval: awaiting,
      sentRows: sendResult.sent.map((s) => ({ to_email: s.row.to_email, subject: s.row.subject })),
      failedSends: sendResult.failed.map((f) => ({ to_email: f.row.to_email, message: f.message })),
      counts,
      costUsd: meter.total,
      costGuardTripped,
      paused,
      errors: errors.toLines(),
      warnings,
      spreadsheetId: store.spreadsheetId,
      sheetIds: await store.sheetIds(),
    });

    if (gmail) {
      try {
        await sendDigest(gmail, digest);
      } catch (error) {
        errors.add('digest', error);
        process.stdout.write(`\n${digest.body}\n`);
      }
    } else {
      process.stdout.write(`\n${digest.body}\n`);
    }

    log.info('run finished', { run_id: runIdValue, ...counts, cost_usd: meter.total, errors: errors.length, fatal: Boolean(fatal) });
    if (fatal) throw fatal;
    return { runId: runIdValue, counts, costUsd: meter.total, errors: errors.toLines(), warnings, digest };
  } finally {
    await release().catch((error) => log.error('failed to release lock', { error: error.message }));
  }
}

function toPostRow(post, runIdValue) {
  return {
    post_id: post.post_id,
    source: post.source,
    url: post.url,
    title: post.title,
    company: post.company ?? '',
    posted_at: post.posted_at ?? '',
    comp_type: post.comp_type,
    comp_min: post.comp_min,
    comp_max: post.comp_max,
    est_hours: post.est_hours,
    first_seen_run: runIdValue,
    signal_type: '',
    fit_score: '',
    fit_reasons: '',
    hard_out_reason: '',
    niche: '',
    tools_mentioned: '',
    status: STATUS.PENDING,
    dupe_hash: post.dupe_hash,
    last_classified_run: '',
    comp_flags: '',
  };
}

function numberOrNull(value) {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

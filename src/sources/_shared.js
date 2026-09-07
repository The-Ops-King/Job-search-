import { runActor } from '../lib/apify.js';
import { normalizeAll, filterByRecency } from './normalize.js';
import { rotateQueries } from '../lib/budget.js';
import { log } from '../lib/log.js';

/**
 * Builds an actor input from the canonical knobs in config/actors.json. A knob
 * mapped to null means the actor cannot express it; the caller filters client-side
 * where that is possible (recency) and accepts the looser result where it is not.
 */
export function buildInput(actorConfig, { query, maxItems, remote, postedWithinDays }) {
  const { template = {}, fields = {}, remoteValue, postedWithinDaysFormat } = actorConfig.input ?? {};
  const input = { ...template };

  if (fields.query) input[fields.query] = query;
  if (fields.maxItems) {
    // Upwork's actor 400s on maxItems below 20, so the floor belongs to the actor,
    // not to our config.
    const floor = Number(actorConfig.input?.minItems ?? 0);
    input[fields.maxItems] = Math.max(maxItems, floor);
  }
  if (fields.remote && remote) input[fields.remote] = remoteValue ?? true;
  if (fields.postedWithinDays && postedWithinDays) {
    input[fields.postedWithinDays] = postedWithinDaysFormat
      ? postedWithinDaysFormat.replace('{seconds}', String(postedWithinDays * 86400))
                              .replace('{days}', String(postedWithinDays))
      : postedWithinDays;
  }
  return input;
}

/**
 * Runs every query for one source and returns normalized posts. A single failed
 * query is recorded and skipped; the source only fails outright when every query
 * fails or when the actor output no longer matches the mapping.
 */
export async function collect({ source, client, actorConfig, queries, options, now = new Date(), budget = null, rotation = 0 }) {
  const { maxItems, lookbackDays, remote = true, timeoutSecs } = options;
  const rawItems = [];
  const queryErrors = [];
  const metas = [];
  const queryStats = [];
  const skippedForBudget = [];

  // Rotated so a budget cut-off does not starve the same tail queries every day.
  const ordered = rotateQueries(queries, rotation);

  for (const query of ordered) {
    // Checked before the call, because Apify bills on results returned. Checking
    // afterwards, which is what the old cost guard did, is checking after paying.
    if (budget && !budget.canAfford()) {
      budget.skip();
      skippedForBudget.push(query);
      continue;
    }

    const input = buildInput(actorConfig, { query, maxItems, remote, postedWithinDays: lookbackDays });
    try {
      const { items, meta } = await runActor(client, actorConfig.actorId, input, { timeoutSecs });
      rawItems.push(...items);
      metas.push(meta);

      // The live probe came back with usageTotalUsd of 0 from a run that plainly
      // consumed results. Trusting that number would leave the budget cap reading
      // zero spend forever and never firing, so fall back to the assumed per-result
      // rate whenever the actor reports nothing. The cap is worthless otherwise.
      const reported = Number(meta.costUsd ?? 0);
      // Rates differ per actor: Indeed is about $3/1k, the LinkedIn replacement about
      // $6. A single global assumption would under-count the expensive one by half.
      const ratePer1k = Number(actorConfig.costPer1kResults ?? budget?.assumedCostPer1k ?? 3.0);
      const estimated = (items.length / 1000) * ratePer1k;
      const billed = reported > 0 ? reported : estimated;
      meta.costUsd = billed;
      meta.costEstimated = reported <= 0;
      budget?.record(billed, { source, query });

      // Apify bills per result, per query, and dedupe runs afterwards. A posting
      // matching several queries is paid for several times, so knowing what each
      // query actually returned is the only way to tell which ones earn their cost.
      queryStats.push({
        query,
        items: items.length,
        costUsd: billed,
        costEstimated: meta.costEstimated,
        cappedOut: items.length >= maxItems,
      });
    } catch (error) {
      queryErrors.push({ query, message: error.message });
      log.warn('query failed', { source, query, error: error.message });
    }
  }

  const attempted = ordered.length - skippedForBudget.length;
  if (attempted > 0 && queryErrors.length === attempted) {
    throw new Error(
      `${source}: all ${queries.length} queries failed against ${actorConfig.actorId}. ` +
      `First error: ${queryErrors[0].message}`);
  }

  const { posts, warnings, inventory, dropped } = normalizeAll(rawItems, { source, actorConfig, now });
  const { kept, dropped: stale } = filterByRecency(posts, lookbackDays, now);

  return {
    source,
    posts: kept,
    meta: {
      actorId: actorConfig.actorId,
      actorVersions: [...new Set(metas.map((m) => m.actorVersion))],
      apifyRuns: metas.map((m) => m.runId),
      costUsd: metas.reduce((sum, m) => sum + m.costUsd, 0),
      rawItems: rawItems.length,
      droppedMalformed: dropped,
      droppedStale: stale,
      queriesRun: attempted - queryErrors.length,
      queriesFailed: queryErrors.length,
      queriesSkippedForBudget: skippedForBudget.length,
      queryStats,
      inventory,
    },
    warnings: [
      ...warnings,
      ...queryErrors.map((e) => `${source}: query "${e.query}" failed: ${e.message}`),
      ...(skippedForBudget.length
        ? [`${source}: ${skippedForBudget.length} queries skipped, Apify budget for this run is spent. ` +
           `Query order rotates daily, so these run first next time.`]
        : []),
    ],
  };
}

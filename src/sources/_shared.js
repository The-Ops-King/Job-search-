import { runActor } from '../lib/apify.js';
import { normalizeAll, filterByRecency } from './normalize.js';
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
  if (fields.maxItems) input[fields.maxItems] = maxItems;
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
export async function collect({ source, client, actorConfig, queries, options, now = new Date() }) {
  const { maxItems, lookbackDays, remote = true, timeoutSecs } = options;
  const rawItems = [];
  const queryErrors = [];
  const metas = [];

  for (const query of queries) {
    const input = buildInput(actorConfig, { query, maxItems, remote, postedWithinDays: lookbackDays });
    try {
      const { items, meta } = await runActor(client, actorConfig.actorId, input, { timeoutSecs });
      rawItems.push(...items);
      metas.push(meta);
    } catch (error) {
      queryErrors.push({ query, message: error.message });
      log.warn('query failed', { source, query, error: error.message });
    }
  }

  if (queryErrors.length === queries.length && queries.length > 0) {
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
      queriesRun: queries.length - queryErrors.length,
      queriesFailed: queryErrors.length,
      inventory,
    },
    warnings: [
      ...warnings,
      ...queryErrors.map((e) => `${source}: query "${e.query}" failed: ${e.message}`),
    ],
  };
}

import { ApifyClient } from 'apify-client';
import { retry } from './retry.js';
import { log } from './log.js';

/**
 * Shared Apify run mechanics. The three files under src/sources only build inputs;
 * everything about calling an actor, waiting on it, reading its dataset and
 * recording what it cost lives here.
 */

export function createApifyClient(token = process.env.APIFY_TOKEN) {
  if (!token) throw new Error('APIFY_TOKEN is not set');
  return new ApifyClient({ token });
}

export class ActorRunError extends Error {
  constructor(message, { actorId, status } = {}) {
    super(message);
    this.name = 'ActorRunError';
    this.actorId = actorId;
    this.status = status;
  }
}

/**
 * Runs one actor to completion and returns its dataset items plus the run metadata
 * the Runs tab and the cost guard need. `timeoutSecs` bounds a single query so one
 * wedged actor cannot eat the whole job.
 */
export async function runActor(client, actorId, input, { timeoutSecs = 300, memoryMbytes } = {}) {
  const started = Date.now();
  const run = await retry(
    () => client.actor(actorId).call(input, { timeout: timeoutSecs, memory: memoryMbytes, waitSecs: timeoutSecs }),
    { attempts: 2, baseMs: 3000, maxMs: 15000, label: `apify:${actorId}` },
  );

  if (run.status !== 'SUCCEEDED') {
    throw new ActorRunError(`Actor ${actorId} finished with status ${run.status}`, { actorId, status: run.status });
  }

  const { items } = await retry(
    () => client.dataset(run.defaultDatasetId).listItems(),
    { attempts: 3, baseMs: 1000, label: `apify:dataset:${actorId}` },
  );

  const meta = {
    actorId,
    runId: run.id,
    buildNumber: run.buildNumber ?? null,
    actorVersion: run.buildNumber ?? run.meta?.buildNumber ?? 'unknown',
    status: run.status,
    itemCount: items.length,
    costUsd: Number(run.usageTotalUsd ?? 0),
    elapsedMs: Date.now() - started,
  };

  log.info('actor run complete', meta);
  return { items, meta };
}
